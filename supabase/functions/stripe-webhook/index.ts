// TaskLeaders — Edge Function: stripe-webhook
// Contract: POST /stripe-webhook
// Receives and processes Stripe payment events.
//
// Handled events:
//   payment_intent.succeeded        — auto-charge confirmed
//   payment_intent.payment_failed   — auto-charge failed
//   checkout.session.completed      — payment link paid
//
// On payment confirmed:
//   - Marks payment_records.payment_status = 'paid'
//   - Advances job.state → 'confirmed_assigned'
//   - Adds client + provider to job_participants
//   - Sends WC-2 to client (assignment confirmed)
//   - Updates conversation sessions for both participants
//
// On payment failed:
//   - Logs to admin_alerts
//   - Optionally notifies provider

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage, buildWC2,
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

  if (!supabaseUrl || !serviceRoleKey || !webhookSecret) {
    return json({ ok: false, error: "Missing configuration" }, 500);
  }

  const rawBody  = await req.text();
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
    const jobId       = String((obj.metadata as Record<string,string>)?.job_id ?? "");
    const provSlug    = String((obj.metadata as Record<string,string>)?.provider_slug ?? "");
    const piId        = String(obj.id ?? "");

    if (!jobId || !provSlug) {
      return json({ ok: true, skipped: "no job metadata" });
    }

    await handlePaymentConfirmed(supabase, supabaseUrl, serviceRoleKey, jobId, provSlug, piId, null);
  }

  // ─── checkout.session.completed (payment link) ─────────────────────────────
  else if (eventType === "checkout.session.completed") {
    const jobId    = String((obj.metadata as Record<string,string>)?.job_id ?? "");
    const provSlug = String((obj.metadata as Record<string,string>)?.provider_slug ?? "");
    const plId     = String(obj.payment_link ?? "");

    if (!jobId || !provSlug) {
      return json({ ok: true, skipped: "no job metadata" });
    }

    await handlePaymentConfirmed(supabase, supabaseUrl, serviceRoleKey, jobId, provSlug, null, plId);
  }

  // ─── payment_intent.payment_failed ────────────────────────────────────────
  else if (eventType === "payment_intent.payment_failed") {
    const jobId       = String((obj.metadata as Record<string,string>)?.job_id ?? "");
    const provSlug    = String((obj.metadata as Record<string,string>)?.provider_slug ?? "");
    const failureMsg  = String((obj.last_payment_error as Record<string,string>)?.message ?? "Unknown error");

    if (jobId) {
      await supabase.from("admin_alerts").insert({
        alert_type:   "escalation",
        priority:     "high",
        job_id:       jobId,
        provider_slug: provSlug || null,
        description:  `Stripe payment failed: ${failureMsg}`,
        status:       "open",
      });
    }
  }

  return json({ ok: true });
});

// ─── handlePaymentConfirmed ───────────────────────────────────────────────────

async function handlePaymentConfirmed(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceRoleKey: string,
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

  // Advance job state
  await supabase.from("jobs")
    .update({
      state:          "confirmed_assigned",
      status:         "assigned",
      payment_status: "paid",
      assigned_at:    new Date().toISOString(),
    })
    .eq("job_id", jobId);

  // Load provider
  const { data: provider } = await supabase
    .from("provider_accounts")
    .select("slug, first_name, last_name, business_name, display_name_type, whatsapp_number")
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
    const result  = await sendWhatsApp(twilioEnv, job.client_whatsapp, msgBody);
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
        whatsapp_e164:   job.client_whatsapp,
        sender_type:     "client",
        session_state:   "open",
        current_job_id:  job.job_id,
        last_activity_at: new Date().toISOString(),
      }, { onConflict: "whatsapp_e164" });
  }

  // Update provider session: thread now live
  if (provider.whatsapp_number) {
    await supabase.from("conversation_sessions")
      .upsert({
        whatsapp_e164:   provider.whatsapp_number,
        sender_type:     "provider",
        session_state:   "open",
        current_job_id:  job.job_id,
        last_activity_at: new Date().toISOString(),
      }, { onConflict: "whatsapp_e164" });
  }

  // Advance broadcast_responses for winner
  await supabase.from("broadcast_responses")
    .update({ claim_successful: true })
    .eq("job_id", jobId)
    .eq("provider_slug", provSlug);

  // Advance job state to thread_live
  await supabase.from("jobs")
    .update({ state: "thread_live" })
    .eq("job_id", jobId);
}
