// TaskLeaders — Edge Function: stripe-webhook
// Contract: POST /stripe-webhook
// Receives and processes Stripe payment events.
//
// Handled events:
//   payment_intent.succeeded        — auto-charge confirmed
//   payment_intent.payment_failed   — auto-charge failed
//   checkout.session.completed      — payment link paid (mode=payment) OR card saved (mode=setup)
//
// On payment confirmed (payment link path only):
//   - Marks payment_records.payment_status = 'paid'
//   - Advances job.state → 'confirmed_assigned' → 'thread_live'
//   - Adds client + provider to job_participants
//   - Sends WC-2 to client (assignment confirmed)
//   - Updates conversation sessions for both participants
//   - Creates Stripe Checkout Session (mode=setup) and sends card-save invite to provider
//     (only when paid via payment link — auto-charge providers already have a card on file)
//
// On payment confirmed (auto-charge path):
//   - Same as above, minus card-save invite (card is already on file)
//
// On payment failed:
//   - Logs to admin_alerts
//
// On card-save setup complete (mode=setup):
//   - Retrieves SetupIntent to get the confirmed payment_method
//   - Writes card_on_file=true, stripe_customer_id, stripe_payment_method_id to provider_accounts
//   - Sends WhatsApp confirmation to provider
//   - All failures write to admin_alerts (no silent failures)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, sendTemplateWhatsApp, logMessage, buildWC2, buildWT8,
  jobHeader,
} from "../_shared/twilio.ts";
import { CATEGORY_NAMES } from "../_shared/constants.ts";
import { toPublicJobId } from "../_shared/job-ids.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Verify Stripe webhook signature using HMAC-SHA256. */
async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  webhookSecret: string,
): Promise<boolean> {
  try {
    const parts     = sigHeader.split(",").reduce((acc, part) => {
      const [k, v] = part.split("=");
      acc[k]       = v;
      return acc;
    }, {} as Record<string, string>);

    const timestamp = parts["t"];
    const v1        = parts["v1"];
    if (!timestamp || !v1) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const enc           = new TextEncoder();
    const key           = await crypto.subtle.importKey(
      "raw", enc.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["sign"],
    );
    const sig     = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
    const computed = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    return computed === v1;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const webhookSecret  = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const stripeKey      = Deno.env.get("STRIPE_SECRET_KEY");
  const adminPassword  = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD") ?? "";

  // Base config required by every path (including simulation).
  // STRIPE_WEBHOOK_SECRET is only required for the real Stripe event path and
  // is checked after the simulation branch below so that the simulation path
  // is not blocked when the secret is not yet configured.
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Missing configuration" }, 500);
  }

  // ── Admin payment simulation path ─────────────────────────────────────────
  // FOR TESTING ONLY. Bypasses Stripe signature verification.
  // Gate: x-admin-simulate header must equal TASKLEADERS_ADMIN_PASSWORD.
  // Body: { job_id: string, provider_slug: string }
  //
  // Exercises the exact same handlePaymentConfirmed() code path as a real
  // Stripe payment — no mock, no duplication. Safe to call repeatedly with
  // no real Stripe charges (only the card-save invite makes a Stripe API call;
  // pass skip_card_save: true in the body to suppress it during testing).
  //
  // Prerequisites before calling:
  //   • jobs row exists with state = 'claim_received' or 'payment_link_sent'
  //   • payment_records row exists with payment_status = 'pending'
  //   • provider_accounts row exists for provider_slug
  //
  // Usage:
  //   curl -X POST https://iwgoafvemlsswkjroyhl.supabase.co/functions/v1/stripe-webhook \
  //     -H "x-admin-simulate: YOUR_ADMIN_PW" \
  //     -H "Content-Type: application/json" \
  //     -d '{"job_id":"VAN-CLN-00022","provider_slug":"hayley-bieber","skip_card_save":true}'
  //
  // To remove later: delete this entire block and the adminPassword variable above.
  const simHeader = req.headers.get("x-admin-simulate") ?? "";
  if (simHeader && adminPassword && simHeader === adminPassword) {
    let simBody: Record<string, unknown>;
    try { simBody = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const jobId      = String(simBody.job_id       ?? "").trim();
    const provSlug   = String(simBody.provider_slug ?? "").trim();
    const skipCard   = Boolean(simBody.skip_card_save ?? false);
    if (!jobId || !provSlug) {
      return json({ ok: false, error: "job_id and provider_slug required" }, 400);
    }

    // Verify payment_records row is in a pending state before simulating.
    const supabaseSim = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: pr } = await supabaseSim
      .from("payment_records")
      .select("payment_status")
      .eq("job_id", jobId)
      .eq("provider_slug", provSlug)
      .maybeSingle();

    if (!pr) {
      return json({ ok: false, error: `No payment_records row found for job_id=${jobId} provider_slug=${provSlug}` }, 404);
    }
    if (pr.payment_status === "paid") {
      return json({ ok: false, error: "Payment is already marked paid — nothing to simulate" }, 409);
    }
    // Also block on 'released': a timed-out record (payment_status='released',
    // assigned_provider_slug cleared by check_payment_timeouts) should not be
    // re-simulated without first re-running the ACCEPT flow. Proceeding would
    // create a confirmed_assigned job with a stale/wrong provider assignment.
    if (pr.payment_status === "released") {
      return json({ ok: false, error: "Payment record was released due to timeout — re-run the ACCEPT flow before simulating payment" }, 409);
    }

    // paymentLinkId=null skips the card-save invite; pass skip_card_save: false
    // in the body if you want to include the card-save invite in the test.
    await handlePaymentConfirmed(
      supabaseSim, supabaseUrl, serviceRoleKey, skipCard ? null : (stripeKey ?? null),
      jobId, provSlug, null, skipCard ? null : "simulate",
    );

    return json({ ok: true, simulated: true, job_id: jobId, provider_slug: provSlug, card_save_skipped: skipCard });
  }

  // Real Stripe event path — webhook secret required from this point on.
  if (!webhookSecret) {
    return json({ ok: false, error: "Missing configuration" }, 500);
  }

  const rawBody   = await req.text();
  const sigHeader = req.headers.get("stripe-signature") ?? "";

  const validSig = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!validSig) {
    return json({ ok: false, error: "Invalid signature" }, 400);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const eventType = String(event.type ?? "");
  const eventData = event.data as { object: Record<string, unknown> };
  const obj       = eventData?.object ?? {};

  // ─── payment_intent.succeeded ──────────────────────────────────────────────
  if (eventType === "payment_intent.succeeded") {
    const jobId    = String((obj.metadata as Record<string, string>)?.job_id ?? "");
    const provSlug = String((obj.metadata as Record<string, string>)?.provider_slug ?? "");
    const piId     = String(obj.id ?? "");

    if (!jobId || !provSlug) {
      return json({ ok: true, skipped: "no job metadata" });
    }

    await handlePaymentConfirmed(
      supabase, supabaseUrl, serviceRoleKey, stripeKey ?? null,
      jobId, provSlug, piId, null,
    );
  }

  // ─── checkout.session.completed ────────────────────────────────────────────
  // Two sub-modes:
  //   mode=payment  — provider paid via payment link → confirm assignment + send card-save invite
  //   mode=setup    — provider saved card via setup flow → write card_on_file to DB + confirm via WhatsApp
  else if (eventType === "checkout.session.completed") {
    const mode     = String(obj.mode ?? "");
    const metadata = (obj.metadata as Record<string, string>) ?? {};
    const provSlug = String(metadata.provider_slug ?? "");

    if (mode === "setup") {
      // Card-save setup complete — handled separately from payment confirmation.
      if (!provSlug) {
        // No provider slug in metadata: escalate so it isn't lost silently.
        await supabase.from("admin_alerts").insert({
          alert_type:  "escalation",
          priority:    "normal",
          description: `checkout.session.completed mode=setup missing provider_slug in metadata. session_id=${String(obj.id ?? "")}`,
          status:      "open",
        });
      } else {
        await handleCardSaveSetupComplete(supabase, supabaseUrl, serviceRoleKey, stripeKey ?? null, obj);
      }
    } else {
      // mode=payment (payment link paid)
      // Primary: dynamic payment links embed job_id + provider_slug in metadata at creation.
      // Fallback: static payment links (STRIPE_PAYMENT_LINK_{CODE} env) have no runtime
      // metadata. create-payment-link appends ?client_reference_id={job_id}___{provider_slug}
      // to the URL; Stripe passes it through to obj.client_reference_id here.
      let jobId    = String(metadata.job_id ?? "");
      let provSlug = String(metadata.provider_slug ?? "");

      if ((!jobId || !provSlug) && obj.client_reference_id) {
        const ref   = String(obj.client_reference_id);
        const parts = ref.split("___");
        if (parts.length === 2 && parts[0] && parts[1]) {
          if (!jobId)    jobId    = parts[0];
          if (!provSlug) provSlug = parts[1];
        }
      }

      if (!jobId || !provSlug) {
        return json({ ok: true, skipped: "no job metadata" });
      }
      const plId = String(obj.payment_link ?? "");
      await handlePaymentConfirmed(
        supabase, supabaseUrl, serviceRoleKey, stripeKey ?? null,
        jobId, provSlug, null, plId,
      );
    }
  }

  // ─── payment_intent.payment_failed ────────────────────────────────────────
  else if (eventType === "payment_intent.payment_failed") {
    const jobId      = String((obj.metadata as Record<string, string>)?.job_id ?? "");
    const provSlug   = String((obj.metadata as Record<string, string>)?.provider_slug ?? "");
    const failureMsg = String((obj.last_payment_error as Record<string, string>)?.message ?? "Unknown error");

    if (jobId) {
      await supabase.from("admin_alerts").insert({
        alert_type:    "escalation",
        priority:      "high",
        job_id:        jobId,
        provider_slug: provSlug || null,
        description:   `Stripe payment failed: ${failureMsg}`,
        status:        "open",
      });
    }
  }

  return json({ ok: true });
});

// ─── handlePaymentConfirmed ───────────────────────────────────────────────────
// Called for both payment_intent.succeeded (auto-charge) and
// checkout.session.completed mode=payment (payment link).
// paymentLinkId is non-null only for the payment-link path, which is used
// to decide whether to send the card-save invite.

async function handlePaymentConfirmed(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceRoleKey: string,
  stripeKey: string | null,
  jobId: string,
  provSlug: string,
  paymentIntentId: string | null,
  paymentLinkId: string | null,
) {
  // Update payment_records
  await supabase.from("payment_records")
    .update({
      payment_status:       "paid",
      payment_completed_at: new Date().toISOString(),
    })
    .eq("job_id", jobId)
    .eq("provider_slug", provSlug);

  // Load job
  const { data: job } = await supabase
    .from("jobs")
    .select("job_id, category_code, category_name, address, client_id, client_whatsapp, assigned_provider_slug")
    .eq("job_id", jobId)
    .single();

  if (!job) return;

  // Advance job state.
  // assigned_provider_slug is set here authoritatively — this ensures it is
  // correct even if check_payment_timeouts() cleared it between claim and
  // payment confirmation (e.g. slow payment link or admin simulation delay).
  await supabase.from("jobs")
    .update({
      state:                  "confirmed_assigned",
      status:                 "assigned",
      payment_status:         "paid",
      assigned_at:            new Date().toISOString(),
      assigned_provider_slug: provSlug,
    })
    .eq("job_id", jobId);

  // Load provider — include stripe_customer_id and card_on_file for the card-save invite decision
  const { data: provider } = await supabase
    .from("provider_accounts")
    .select("slug, first_name, last_name, business_name, display_name_type, whatsapp_number, stripe_customer_id, card_on_file")
    .eq("slug", provSlug)
    .single();

  if (!provider) return;

  const providerName = (provider.display_name_type === "business" && provider.business_name)
    ? provider.business_name
    : `${provider.first_name ?? ""} ${provider.last_name ?? ""}`.trim();

  const categoryName = CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code;
  const address      = job.address ?? "address on file";

  // Add job_participants (client + provider for routed thread)
  const participants = [];
  if (job.client_whatsapp) {
    participants.push({
      job_id:           job.job_id,
      participant_type: "client",
      whatsapp_e164:    job.client_whatsapp,
      client_id:        job.client_id ?? null,
    });
  }
  if (provider.whatsapp_number) {
    participants.push({
      job_id:           job.job_id,
      participant_type: "provider",
      whatsapp_e164:    provider.whatsapp_number,
      provider_slug:    provSlug,
    });
  }
  if (participants.length > 0) {
    await supabase.from("job_participants")
      .upsert(participants, { onConflict: "job_id,whatsapp_e164" });
  }

  // Send WC-2 to client
  const twilioEnv = getTwilioEnv();
  if (twilioEnv && job.client_whatsapp) {
    const msgBody = buildWC2(job.job_id, address, providerName, categoryName);
    const wc2Sid  = Deno.env.get("TWILIO_TEMPLATE_SID_WC2");
    const result  = await sendTemplateWhatsApp(
      twilioEnv, job.client_whatsapp,
      // Template body uses {{1}} for the provider name and {{2}} for the job
      // header. {{3}} is retained in the param map for backward compatibility
      // with any future template revision that references categoryName.
      wc2Sid, { "1": providerName, "2": jobHeader(job.job_id, address), "3": categoryName },
      msgBody,
    );
    logMessage({
      supabaseUrl, serviceRoleKey,
      direction: "outbound", jobId: job.job_id,
      participantWhatsapp: job.client_whatsapp,
      templateName: "WC-2", body: msgBody,
      status: result.ok ? "sent" : "failed",
    });

    // Update client session: thread now live
    await supabase.from("conversation_sessions")
      .upsert({
        whatsapp_e164:    job.client_whatsapp,
        sender_type:      "client",
        session_state:    "open",
        current_job_id:   job.job_id,
        last_activity_at: new Date().toISOString(),
      }, { onConflict: "whatsapp_e164" });
  }

  // Update provider session: thread now live
  if (provider.whatsapp_number) {
    await supabase.from("conversation_sessions")
      .upsert({
        whatsapp_e164:    provider.whatsapp_number,
        sender_type:      "provider",
        session_state:    "open",
        current_job_id:   job.job_id,
        last_activity_at: new Date().toISOString(),
      }, { onConflict: "whatsapp_e164" });
  }

  // Send WT-8 to provider: payment confirmed / thread now live.
  // Sent unconditionally — independent of skip_card_save or card_on_file.
  // The card-save invite (below) is a separate follow-up, not the confirmation.
  if (twilioEnv && provider.whatsapp_number) {
    // Look up the client's first name so the WT-8 call-to-action can address
    // the provider by the client's name. Falls back to "the Client" inside
    // buildWT8 when the lookup returns null/empty. Lookup rules:
    //   1. Prefer the direct id match, filtered to status='active' AND suspended=false
    //      so a stale client_id reference pointing at a deactivated row does not
    //      leak a wrong name into the message.
    //   2. Fall back to whatsapp lookup with the same active/non-suspended filter.
    //      Tolerates both +E.164 and digits-only storage formats (matching the
    //      twilio-webhook sender-lookup pattern).
    //   3. If more than one active row shares the whatsapp number, pick the most
    //      recently created active row deterministically (`created_at DESC`).
    //   4. Any network/DB failure is swallowed — WT-8 must not block thread open.
    let clientFirstName: string | null = null;
    if (job.client_id) {
      try {
        const { data } = await supabase
          .from("concierge_clients")
          .select("first_name")
          .eq("id", job.client_id)
          .eq("status", "active")
          .eq("suspended", false)
          .maybeSingle();
        clientFirstName = (data?.first_name ?? null) as string | null;
      } catch { /* non-fatal: fall through to whatsapp lookup */ }
    }
    if (!clientFirstName && job.client_whatsapp) {
      try {
        const wa       = String(job.client_whatsapp);
        const waDigits = wa.replace(/^\+/, "");
        const { data } = await supabase
          .from("concierge_clients")
          .select("first_name, created_at")
          .in("whatsapp", [wa, waDigits])
          .eq("status", "active")
          .eq("suspended", false)
          .order("created_at", { ascending: false })
          .limit(1);
        const rows = (data ?? []) as Array<{ first_name: string | null }>;
        clientFirstName = rows[0]?.first_name ?? null;
      } catch { /* non-fatal: buildWT8 falls back to "the Client" */ }
    }

    const wt8Body   = buildWT8(job.job_id, address, categoryName, clientFirstName);
    const wt8Result = await sendWhatsApp(twilioEnv, provider.whatsapp_number, wt8Body);
    logMessage({
      supabaseUrl, serviceRoleKey,
      direction: "outbound", jobId: job.job_id,
      participantWhatsapp: provider.whatsapp_number,
      templateName: "WT-8", body: wt8Body,
      status: wt8Result.ok ? "sent" : "failed",
    });
  }

  // Advance broadcast_responses for winner
  await supabase.from("broadcast_responses")
    .update({ claim_successful: true })
    .eq("job_id", jobId)
    .eq("provider_slug", provSlug);

  // Clear awaiting_accept sessions for providers who did not win this job.
  // Payment confirmed = job is closed to new claims. These providers' sessions
  // are stale. If they later reply ACCEPT, claim_lead() rejects them cleanly
  // with "already claimed" regardless — but clearing here avoids indefinitely
  // stale state accumulating across jobs.
  // Guard: skip if provider.whatsapp_number is null (edge case; also prevents
  // accidentally clearing the winner if somehow still awaiting_accept).
  if (provider.whatsapp_number) {
    await supabase.from("conversation_sessions")
      .update({
        session_state:    "idle",
        current_job_id:   null,
        last_activity_at: new Date().toISOString(),
      })
      .eq("current_job_id", jobId)
      .eq("session_state",   "awaiting_accept")
      .neq("whatsapp_e164",  provider.whatsapp_number);
  }

  // Advance job state to thread_live
  await supabase.from("jobs")
    .update({ state: "thread_live" })
    .eq("job_id", jobId);

  // ── Card-save invite ────────────────────────────────────────────────────────
  // Only for the payment-link path (paymentLinkId non-null) and only when the
  // provider does not already have a card on file. Auto-charge providers are
  // excluded by definition: they already have a saved card.
  const paidViaLink = paymentLinkId !== null;
  const alreadyHasCard = Boolean(provider.card_on_file);

  if (paidViaLink && !alreadyHasCard && provider.whatsapp_number && stripeKey) {
    await handleCardSaveInvite(
      supabase, supabaseUrl, serviceRoleKey,
      provSlug, provider.whatsapp_number,
      provider.stripe_customer_id as string | null,
      stripeKey,
    );
  }
}

// ─── handleCardSaveInvite ─────────────────────────────────────────────────────
// Creates a Stripe Checkout Session in setup mode and sends a WhatsApp invite
// to the provider. Failures escalate to admin_alerts — nothing is silent.

async function handleCardSaveInvite(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceRoleKey: string,
  provSlug: string,
  providerWhatsapp: string,
  existingStripeCustomerId: string | null,
  stripeKey: string,
) {
  const stripeBase = "https://api.stripe.com/v1";
  const stripeAuth = "Basic " + btoa(`${stripeKey}:`);
  const successUrl = `https://task-leaders.com/v0.5/provider-profile.html?slug=${encodeURIComponent(provSlug)}&card_saved=1`;
  const cancelUrl  = `https://task-leaders.com/v0.5/provider-profile.html?slug=${encodeURIComponent(provSlug)}`;

  const params = new URLSearchParams({
    mode:                       "setup",
    "payment_method_types[]":   "card",
    "metadata[provider_slug]":  provSlug,
    success_url:                successUrl,
    cancel_url:                 cancelUrl,
  });

  if (existingStripeCustomerId) {
    params.set("customer", existingStripeCustomerId);
  } else {
    params.set("customer_creation", "always");
  }

  let setupUrl: string;
  try {
    const res  = await fetch(`${stripeBase}/checkout/sessions`, {
      method: "POST",
      headers: { "Authorization": stripeAuth, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const data = await res.json();

    if (!res.ok || !data.url) {
      await supabase.from("admin_alerts").insert({
        alert_type:    "escalation",
        priority:      "high",
        provider_slug: provSlug,
        description:   `Failed to create card-save Checkout Session for provider ${provSlug}: ${data.error?.message ?? "no URL in response"}`,
        status:        "open",
      });
      return;
    }

    setupUrl = String(data.url);
  } catch (e) {
    await supabase.from("admin_alerts").insert({
      alert_type:    "escalation",
      priority:      "high",
      provider_slug: provSlug,
      description:   `card-save Checkout Session fetch threw for provider ${provSlug}: ${String(e)}`,
      status:        "open",
    });
    return;
  }

  // Send WhatsApp invite to provider
  const msgBody = (
    `Payment received — you're confirmed on this job.\n\n` +
    `Save a card on file to skip manual payment next time. Future lead fees will be charged automatically the moment you accept a job — no link, no wait.\n\n` +
    `Save your card here: ${setupUrl}`
  );

  const twilioEnv = getTwilioEnv();
  if (twilioEnv) {
    const result = await sendWhatsApp(twilioEnv, providerWhatsapp, msgBody);
    logMessage({
      supabaseUrl, serviceRoleKey,
      direction: "outbound",
      participantWhatsapp: providerWhatsapp,
      templateName: "CARD_SAVE_INVITE",
      body: msgBody, status: result.ok ? "sent" : "failed",
    });

    if (!result.ok) {
      await supabase.from("admin_alerts").insert({
        alert_type:    "escalation",
        priority:      "normal",
        provider_slug: provSlug,
        description:   `Card-save invite WhatsApp delivery failed for provider ${provSlug} (${providerWhatsapp})`,
        status:        "open",
      });
    }
  }
}

// ─── handleCardSaveSetupComplete ──────────────────────────────────────────────
// Called when checkout.session.completed fires with mode=setup.
// Retrieves the SetupIntent to get the confirmed payment_method, then writes
// card_on_file=true, stripe_customer_id, and stripe_payment_method_id to
// provider_accounts. Sends a WhatsApp confirmation to the provider.
// All failure paths write to admin_alerts.

async function handleCardSaveSetupComplete(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceRoleKey: string,
  stripeKey: string | null,
  session: Record<string, unknown>,
) {
  const metadata      = (session.metadata as Record<string, string>) ?? {};
  const provSlug      = String(metadata.provider_slug ?? "");
  const custId        = String(session.customer ?? "");
  const setupIntentId = String(session.setup_intent ?? "");

  if (!provSlug || !custId || !setupIntentId) {
    await supabase.from("admin_alerts").insert({
      alert_type:    "escalation",
      priority:      "normal",
      provider_slug: provSlug || null,
      description:   `card-save setup.completed missing required fields — provider_slug=${provSlug}, customer=${custId}, setup_intent=${setupIntentId}. session_id=${String(session.id ?? "")}`,
      status:        "open",
    });
    return;
  }

  if (!stripeKey) {
    await supabase.from("admin_alerts").insert({
      alert_type:    "escalation",
      priority:      "high",
      provider_slug: provSlug,
      description:   `STRIPE_SECRET_KEY missing — cannot retrieve SetupIntent ${setupIntentId} for provider ${provSlug}`,
      status:        "open",
    });
    return;
  }

  const stripeAuth = "Basic " + btoa(`${stripeKey}:`);

  // Retrieve SetupIntent to get the confirmed payment_method ID
  let pmId: string;
  try {
    const siRes  = await fetch(`https://api.stripe.com/v1/setup_intents/${setupIntentId}`, {
      headers: { "Authorization": stripeAuth },
    });
    const siData = await siRes.json();
    pmId = String(siData.payment_method ?? "");

    if (!pmId) {
      await supabase.from("admin_alerts").insert({
        alert_type:    "escalation",
        priority:      "high",
        provider_slug: provSlug,
        description:   `SetupIntent ${setupIntentId} returned no payment_method for provider ${provSlug}`,
        status:        "open",
      });
      return;
    }
  } catch (e) {
    await supabase.from("admin_alerts").insert({
      alert_type:    "escalation",
      priority:      "high",
      provider_slug: provSlug,
      description:   `Failed to retrieve SetupIntent ${setupIntentId} for provider ${provSlug}: ${String(e)}`,
      status:        "open",
    });
    return;
  }

  // Write card-on-file fields to provider_accounts
  const { error: updateErr } = await supabase
    .from("provider_accounts")
    .update({
      card_on_file:             true,
      stripe_customer_id:       custId,
      stripe_payment_method_id: pmId,
    })
    .eq("slug", provSlug);

  if (updateErr) {
    await supabase.from("admin_alerts").insert({
      alert_type:    "escalation",
      priority:      "high",
      provider_slug: provSlug,
      description:   `Failed to write card_on_file for provider ${provSlug}: ${updateErr.message}`,
      status:        "open",
    });
    return;
  }

  // Load provider's WhatsApp number for confirmation message
  const { data: provider } = await supabase
    .from("provider_accounts")
    .select("whatsapp_number")
    .eq("slug", provSlug)
    .single();

  if (!provider?.whatsapp_number) return;

  // Send WhatsApp confirmation to provider
  const msgBody = (
    `Your card has been saved.\n\n` +
    `Future lead fees will be charged automatically when you accept a job — no payment link needed.`
  );

  const twilioEnv = getTwilioEnv();
  if (twilioEnv) {
    const result = await sendWhatsApp(twilioEnv, provider.whatsapp_number, msgBody);
    logMessage({
      supabaseUrl, serviceRoleKey,
      direction: "outbound",
      participantWhatsapp: provider.whatsapp_number,
      templateName: "CARD_SAVE_CONFIRMED",
      body: msgBody, status: result.ok ? "sent" : "failed",
    });
  }
}
