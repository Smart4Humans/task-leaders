// TaskLeaders — Edge Function: create-payment-link
// Contract: POST /create-payment-link
// Creates a Stripe payment for a lead fee after a provider claims a job.
//
// Flow:
//   1. Load job + provider. Verify job.state = 'claim_received'.
//   2. Calculate lead fee: base + 5% GST. Stored as separate components (locked rule).
//   3. If provider has card_on_file: auto-charge via PaymentIntent.
//   4. If no card on file: create a Stripe Payment Link for manual payment.
//   5. Insert payment_records row with 10-minute timeout.
//   6. Transition job.state → 'autocharge_pending' or 'payment_link_sent'.
//
// Payment window: 10 minutes total. pg_cron calls check_payment_timeouts() every
// minute and queues WT-6 (warning at 5 min remaining) and WT-7 (release at timeout).
//
// Body: { job_id: string, provider_slug: string, admin_password?: string }
// Also accepts x-internal-secret header for internal calls.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CATEGORY_LEAD_FEES_CENTS, calcGst, CATEGORY_NAMES,
  PAYMENT_WINDOW_MS,
} from "../_shared/constants.ts";
import { toPublicJobId } from "../_shared/job-ids.ts";
import { getTwilioEnv, sendWhatsApp, logMessage, buildWT6 } from "../_shared/twilio.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type, x-internal-secret",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}
function err(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return err("bad_request", "Method not allowed", 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const adminPassword  = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD");
  const cronSecret     = Deno.env.get("INTERNAL_CRON_SECRET");
  const stripeKey      = Deno.env.get("STRIPE_SECRET_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return err("server_error", "Missing server configuration", 500);
  }
  if (!stripeKey) {
    return err("server_error", "Stripe not configured", 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", "Invalid JSON body");
  }

  const internalHeader = req.headers.get("x-internal-secret");
  const isInternal = cronSecret && internalHeader === cronSecret;
  const isAdmin    = adminPassword && String(body.admin_password ?? "") === adminPassword;
  if (!isInternal && !isAdmin) return err("unauthorized", "Unauthorized", 401);

  const jobId       = String(body.job_id       ?? "").trim();
  const provSlug    = String(body.provider_slug ?? "").trim();
  if (!jobId)    return err("validation_error", "job_id is required");
  if (!provSlug) return err("validation_error", "provider_slug is required");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Load job ─────────────────────────────────────────────────────────────
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("job_id, category_code, state, address, assigned_provider_slug, lead_fee_cents, gst_cents")
    .eq("job_id", jobId)
    .single();

  if (jobErr || !job) return err("not_found", "Job not found", 404);
  if (job.state !== "claim_received") {
    return err("conflict", `Job is in state '${job.state}' — expected claim_received`, 409);
  }
  if (job.assigned_provider_slug !== provSlug) {
    return err("conflict", "This provider did not claim this job", 409);
  }

  // ── Load provider ─────────────────────────────────────────────────────────
  const { data: provider, error: provErr } = await supabase
    .from("provider_accounts")
    .select("slug, first_name, whatsapp_number, stripe_customer_id, stripe_payment_method_id, card_on_file")
    .eq("slug", provSlug)
    .single();

  if (provErr || !provider) return err("not_found", "Provider not found", 404);

  // ── Calculate fee ─────────────────────────────────────────────────────────
  const baseFee = job.lead_fee_cents ?? CATEGORY_LEAD_FEES_CENTS[job.category_code] ?? 0;
  const gst     = job.gst_cents      ?? calcGst(baseFee);
  const total   = baseFee + gst;

  const timeoutAt = new Date(Date.now() + PAYMENT_WINDOW_MS).toISOString();

  // ── Payment path ──────────────────────────────────────────────────────────
  let paymentIntentId:  string | null = null;
  let paymentLinkId:    string | null = null;
  let paymentLinkUrl:   string | null = null;
  let paymentMethod:    string;
  let nextState:        string;

  const stripeBase  = "https://api.stripe.com/v1";
  const stripeAuth  = "Basic " + btoa(`${stripeKey}:`);
  const publicJobId = toPublicJobId(job.job_id);
  const categoryName = CATEGORY_NAMES[job.category_code] ?? job.category_code;
  const description  = `TaskLeaders lead fee — ${categoryName} job ${publicJobId}`;

  if (provider.card_on_file && provider.stripe_customer_id && provider.stripe_payment_method_id) {
    // ── Auto-charge path ───────────────────────────────────────────────────
    const piParams = new URLSearchParams({
      amount:               String(total),
      currency:             "cad",
      customer:             provider.stripe_customer_id,
      payment_method:       provider.stripe_payment_method_id,
      description,
      confirm:              "true",
      "metadata[job_id]":       job.job_id,
      "metadata[provider_slug]": provSlug,
    });

    const piRes  = await fetch(`${stripeBase}/payment_intents`, {
      method: "POST",
      headers: { "Authorization": stripeAuth, "Content-Type": "application/x-www-form-urlencoded" },
      body: piParams,
    });
    const piData = await piRes.json();

    if (!piRes.ok) {
      return err("stripe_error", piData.error?.message ?? "PaymentIntent creation failed", 502);
    }

    paymentIntentId = piData.id;
    paymentMethod   = "card_on_file";
    nextState       = "autocharge_pending";

  } else {
    // ── Payment link path ──────────────────────────────────────────────────
    // Step 1: Create a Price object
    const priceParams = new URLSearchParams({
      unit_amount:            String(total),
      currency:               "cad",
      "product_data[name]":   description,
    });

    const priceRes  = await fetch(`${stripeBase}/prices`, {
      method: "POST",
      headers: { "Authorization": stripeAuth, "Content-Type": "application/x-www-form-urlencoded" },
      body: priceParams,
    });
    const priceData = await priceRes.json();

    if (!priceRes.ok) {
      return err("stripe_error", priceData.error?.message ?? "Price creation failed", 502);
    }

    // Step 2: Create Payment Link
    const plParams = new URLSearchParams({
      "line_items[0][price]":    priceData.id,
      "line_items[0][quantity]": "1",
      "metadata[job_id]":        job.job_id,
      "metadata[provider_slug]": provSlug,
    });

    const plRes  = await fetch(`${stripeBase}/payment_links`, {
      method: "POST",
      headers: { "Authorization": stripeAuth, "Content-Type": "application/x-www-form-urlencoded" },
      body: plParams,
    });
    const plData = await plRes.json();

    if (!plRes.ok) {
      return err("stripe_error", plData.error?.message ?? "Payment link creation failed", 502);
    }

    paymentLinkId  = plData.id;
    paymentLinkUrl = plData.url;
    paymentMethod  = "payment_link";
    nextState      = "payment_link_sent";
  }

  // ── Insert payment_records ────────────────────────────────────────────────
  const { error: prInsertErr } = await supabase.from("payment_records").insert({
    job_id:                  job.job_id,
    provider_slug:           provSlug,
    base_fee_cents:          baseFee,
    gst_cents:               gst,
    total_charged_cents:     total,
    payment_method:          paymentMethod,
    stripe_payment_intent_id: paymentIntentId,
    stripe_payment_link_id:  paymentLinkId,
    stripe_payment_link_url: paymentLinkUrl,
    payment_status:          "pending",
    payment_initiated_at:    new Date().toISOString(),
    payment_timeout_at:      timeoutAt,
  });

  if (prInsertErr) {
    return err("server_error", "Failed to record payment: " + prInsertErr.message, 500);
  }

  // ── Advance job state ─────────────────────────────────────────────────────
  await supabase
    .from("jobs")
    .update({
      state:               nextState,
      lead_fee_cents:      baseFee,
      gst_cents:           gst,
      total_charged_cents: total,
      payment_status:      "pending",
    })
    .eq("job_id", jobId);

  // ── For payment_link path: send WT-6-style prompt to provider ─────────────
  // Note: this is the initial payment link notification, not the warning.
  // The 5-min-remaining warning (WT-6) fires from check_payment_timeouts() / process-timeouts.
  if (paymentMethod === "payment_link" && paymentLinkUrl && provider.whatsapp_number) {
    const twilioEnv = getTwilioEnv();
    if (twilioEnv) {
      const address = job.address ?? "address on file";
      const promptBody = (
        `[Job #${publicJobId} | ${address}] You've claimed this ${categoryName} job.\n\n` +
        `Please complete your lead fee payment of $${(baseFee / 100).toFixed(2)} + GST within 10 minutes to confirm your assignment.\n\n` +
        `Pay here: ${paymentLinkUrl}`
      );
      const result = await sendWhatsApp(twilioEnv, provider.whatsapp_number, promptBody);
      logMessage({
        supabaseUrl, serviceRoleKey,
        direction: "outbound", jobId: job.job_id,
        participantWhatsapp: provider.whatsapp_number,
        templateName: "PAYMENT_LINK_PROMPT",
        body: promptBody, status: result.ok ? "sent" : "failed",
      });
    }
  }

  return json({
    ok: true,
    data: {
      job_id:              publicJobId,
      provider_slug:       provSlug,
      payment_method:      paymentMethod,
      base_fee_cents:      baseFee,
      gst_cents:           gst,
      total_charged_cents: total,
      payment_link_url:    paymentLinkUrl,
      payment_intent_id:   paymentIntentId,
      payment_timeout_at:  timeoutAt,
      state:               nextState,
    },
  });
});
