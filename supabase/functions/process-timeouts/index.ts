// TaskLeaders — Edge Function: process-timeouts
// Contract: POST /process-timeouts
// Called by pg_cron (via pg_net) every minute.
// Reads open admin_alerts queued by check_payment_timeouts() and sends
// WT-6 (payment warning) or WT-7 (lead released) to the relevant provider.
//
// Also runs check_payment_timeouts() via RPC before processing alerts,
// ensuring the queue is always fresh within the same minute window.
//
// Auth: x-cron-secret header must match INTERNAL_CRON_SECRET env var.
//
// PAYMENT TIMING (locked): 10-minute window, WT-6 at 5 minutes remaining.
// WT-7 fires when the full 10-minute window expires without payment.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage, buildWT6, buildWT7,
} from "../_shared/twilio.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const UPDATE_CARD_URL = "https://task-leaders.com/v0.5/provider-profile.html";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const cronSecret     = Deno.env.get("INTERNAL_CRON_SECRET");
  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Missing configuration" }, 500);
  }

  // Auth: cron secret header required
  const incomingSecret = req.headers.get("x-cron-secret");
  if (!cronSecret || incomingSecret !== cronSecret) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Step 1: Run check_payment_timeouts() to queue any new alerts
  const { data: checkResult } = await supabase.rpc("check_payment_timeouts");

  // Step 2: Fetch open payment-related alerts
  const { data: alerts, error: alertErr } = await supabase
    .from("admin_alerts")
    .select("id, alert_type, job_id, provider_slug, description")
    .in("alert_type", ["payment_warning", "payment_released"])
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(50);

  if (alertErr) {
    return json({ ok: false, error: alertErr.message }, 500);
  }

  if (!alerts || alerts.length === 0) {
    return json({ ok: true, data: { processed: 0, check_result: checkResult } });
  }

  const twilioEnv = getTwilioEnv();
  let processed = 0;

  for (const alert of alerts) {
    if (!alert.job_id || !alert.provider_slug) continue;

    // Load job + provider details
    const [{ data: job }, { data: provider }, { data: paymentRec }] = await Promise.all([
      supabase
        .from("jobs")
        .select("job_id, address")
        .eq("job_id", alert.job_id)
        .single(),
      supabase
        .from("provider_accounts")
        .select("whatsapp_number")
        .eq("slug", alert.provider_slug)
        .single(),
      supabase
        .from("payment_records")
        .select("stripe_payment_link_url")
        .eq("job_id", alert.job_id)
        .eq("provider_slug", alert.provider_slug)
        .order("payment_initiated_at", { ascending: false })
        .limit(1)
        .single(),
    ]);

    if (!job || !provider?.whatsapp_number) {
      // Can't send — mark acknowledged to prevent re-processing
      await supabase.from("admin_alerts")
        .update({ status: "acknowledged" })
        .eq("id", alert.id);
      continue;
    }

    const address    = job.address ?? "address on file";
    const paymentUrl = paymentRec?.stripe_payment_link_url ?? UPDATE_CARD_URL;

    let msgBody: string;
    let templateName: string;

    if (alert.alert_type === "payment_warning") {
      msgBody      = buildWT6(alert.job_id, address, paymentUrl);
      templateName = "WT-6";
    } else {
      // payment_released
      msgBody      = buildWT7(alert.job_id, address, UPDATE_CARD_URL);
      templateName = "WT-7";
    }

    let sendOk = false;
    if (twilioEnv) {
      const result = await sendWhatsApp(twilioEnv, provider.whatsapp_number, msgBody);
      sendOk       = result.ok;
      logMessage({
        supabaseUrl, serviceRoleKey,
        direction: "outbound",
        jobId:     alert.job_id,
        participantWhatsapp: provider.whatsapp_number,
        templateName,
        body:   msgBody,
        status: result.ok ? "sent" : "failed",
      });
    }

    // Mark alert resolved
    await supabase.from("admin_alerts")
      .update({
        status:        "resolved",
        whatsapp_sent: sendOk,
        resolved_at:   new Date().toISOString(),
      })
      .eq("id", alert.id);

    processed++;
  }

  // Step 3: Send email for any open non-payment alerts (escalation + risk_flag)
  // For Phase 2: just flag them — full email escalation is Phase 4.
  const { data: escalations } = await supabase
    .from("admin_alerts")
    .select("id, alert_type, job_id, provider_slug, participant_whatsapp, description, priority")
    .in("alert_type", ["escalation", "ambiguous_reply", "risk_flag", "no_match", "no_provider_response"])
    .eq("status", "open")
    .eq("email_sent", false)
    .limit(20);

  // Mark as acknowledged (email pipeline is Phase 4)
  if (escalations && escalations.length > 0) {
    const ids = escalations.map((e) => e.id);
    await supabase.from("admin_alerts")
      .update({ status: "acknowledged" })
      .in("id", ids);
  }

  return json({
    ok: true,
    data: {
      processed,
      check_result:       checkResult,
      escalations_queued: escalations?.length ?? 0,
    },
  });
});
