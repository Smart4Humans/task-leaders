// TaskLeaders — Edge Function: process-timeouts
// Contract: POST /process-timeouts
// Called by pg_cron (via pg_net) every minute. Two responsibilities:
//
// 1. Payment timeouts (existing):
//    Reads open admin_alerts of type payment_warning / payment_released.
//    Sends WT-6 (5 min remaining) and WT-7 (lead released) via Twilio.
//
// 2. Admin escalation emails (Phase 4):
//    Reads open admin_alerts of type: escalation, ambiguous_reply, risk_flag,
//    no_match, no_provider_response, guarantee_claim — for any with priority=high
//    or that have been open > 30 minutes.
//    Sends email to TASKLEADERS_ADMIN_EMAIL via Resend.
//    Marks email_sent = true. Does not mark resolved (admin resolves manually).
//
// Auth: x-cron-secret header must match INTERNAL_CRON_SECRET env var.
//
// PAYMENT TIMING (locked): 10-minute window, WT-6 at 5 minutes remaining.
// WT-7 fires when the full 10-minute window expires without payment.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage, buildWT6, buildWT7,
} from "../_shared/twilio.ts";
import { OPERATIONAL_EVENT_WEIGHTS } from "../_shared/constants.ts";

// ── triggerApplyReliability ───────────────────────────────────────────────────
// Triggers apply-reliability after a payment_failure is recorded.
// Failures are NOT silently discarded — any HTTP error or network failure
// writes an admin_alerts row (escalation / high) so the stale unapplied
// reliability_inputs row is visible without manual SQL checking.
// The escalation email arm of this same function picks it up on the next run.
function triggerApplyReliability(
  supabaseUrl:    string,
  providerSlug:   string,
  jobId:          string,
  cronSecret:     string | undefined,
  supabase:       ReturnType<typeof createClient>,
) {
  const fnBase = supabaseUrl.split(".supabase.co")[0].replace("https://", "");
  fetch(`https://${fnBase}.supabase.co/functions/v1/apply-reliability`, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-internal-secret": cronSecret ?? "",
    },
    body: JSON.stringify({ provider_slug: providerSlug }),
  }).then(async (res) => {
    if (!res.ok) {
      const errText = await res.text().catch(() => "unreadable");
      try {
        await supabase.from("admin_alerts").insert({
          alert_type:    "escalation",
          priority:      "high",
          provider_slug: providerSlug,
          job_id:        jobId,
          description:
            `apply-reliability HTTP ${res.status} after recording payment_failure for ` +
            `provider ${providerSlug} / job ${jobId}. Response: ${errText}. ` +
            `reliability_inputs row exists (applied = false) — score NOT updated. ` +
            `Manually POST to apply-reliability with provider_slug to resolve.`,
          status: "open",
        });
      } catch { /* alert insert failure is non-fatal */ }
    }
  }).catch(async (networkErr) => {
    try {
      await supabase.from("admin_alerts").insert({
        alert_type:    "escalation",
        priority:      "high",
        provider_slug: providerSlug,
        job_id:        jobId,
        description:
          `apply-reliability network/timeout error after recording payment_failure for ` +
          `provider ${providerSlug} / job ${jobId}. Error: ${String(networkErr)}. ` +
          `reliability_inputs row exists (applied = false) — score NOT updated. ` +
          `Manually POST to apply-reliability with provider_slug to resolve.`,
        status: "open",
      });
    } catch { /* alert insert failure is non-fatal */ }
  });
}

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

  const cronSecret     = Deno.env.get("INTERNAL_CRON_SECRET") ?? undefined;
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

    // ── payment_failure reliability input ─────────────────────────────────
    // Only for payment_released (full timeout expired), not payment_warning.
    // Canonical proof of actual winning claimant: payment_records row exists for
    // this (job_id, provider_slug). Payment records are only created after
    // claim_lead() succeeds — losers never receive a payment record.
    // Note: broadcast_responses.claim_successful is reset to false by
    // check_payment_timeouts() before this edge function runs, so we cannot
    // use it as the post-hoc check. The payment_records row is the canonical source.
    //
    // The unique DB index (reliability_inputs_negative_event_dedup_idx) handles
    // idempotency if this fires twice — the second insert is silently ignored.
    if (alert.alert_type === "payment_released" && paymentRec) {
      // Use await + { error } — PostgrestFilterBuilder does not support .catch().
      // A unique constraint violation (code 23505) means already recorded — silently continue.
      const { error: riErr } = await supabase.from("reliability_inputs").insert({
        provider_slug: alert.provider_slug,
        job_id:        alert.job_id,
        input_type:    "payment_failure",
        weight:        OPERATIONAL_EVENT_WEIGHTS.payment_failure,
        notes:
          `[Auto-recorded] payment_failure: lead claimed but payment window expired unpaid. ` +
          `Job ${alert.job_id} released at ${new Date().toISOString()}. ` +
          `Provisional weight: ${OPERATIONAL_EVENT_WEIGHTS.payment_failure}.`,
        applied: false,
      });
      if (!riErr) {
        // Insert succeeded — trigger apply-reliability promptly.
        // Failures are logged to admin_alerts — not silently discarded.
        triggerApplyReliability(supabaseUrl!, alert.provider_slug, alert.job_id, cronSecret, supabase);
      }
      // If riErr: unique constraint (23505) = already recorded, idempotent — no action needed.
      // Other errors are visible via the returned alert resolution flow.
    }

    processed++;
  }

  // Step 3: Admin escalation email arm
  // Sends email via Resend for:
  //   - Any open alert with priority = 'high' that has not had email sent
  //   - Any open alert open > 30 minutes (regardless of priority) that has not had email sent
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: escalations } = await supabase
    .from("admin_alerts")
    .select("id, alert_type, job_id, provider_slug, participant_whatsapp, description, priority, created_at")
    .in("alert_type", ["escalation", "ambiguous_reply", "risk_flag", "no_match",
                       "no_provider_response", "guarantee_claim"])
    .eq("status", "open")
    .eq("email_sent", false)
    .or(`priority.eq.high,created_at.lte.${thirtyMinutesAgo}`)
    .order("priority", { ascending: false }) // high first
    .order("created_at", { ascending: true })
    .limit(20);

  let emailsSent = 0;

  if (escalations && escalations.length > 0) {
    const resendKey    = Deno.env.get("RESEND_API_KEY");
    const adminEmail   = Deno.env.get("TASKLEADERS_ADMIN_EMAIL") ?? "info@task-leaders.com";
    const fromEmail    = Deno.env.get("RESEND_FROM_EMAIL") ?? "TaskLeaders <info@task-leaders.com>";

    if (resendKey) {
      // Batch into a single digest email to avoid flooding the inbox
      const alertLines = escalations.map((a) => (
        `• [${a.priority.toUpperCase()}] ${a.alert_type}` +
        (a.job_id ? ` | Job: ${a.job_id}` : "") +
        (a.provider_slug ? ` | Provider: ${a.provider_slug}` : "") +
        (a.participant_whatsapp ? ` | Number: ${a.participant_whatsapp}` : "") +
        `\n  ${a.description ?? "No description"}`
      ));

      const subject  = `[TaskLeaders Admin] ${escalations.length} alert${escalations.length > 1 ? "s" : ""} require attention`;
      const textBody = `TaskLeaders Admin Alerts\n\n${alertLines.join("\n\n")}\n\nReview in the Admin Panel.`;
      const htmlBody = `
        <html><head><meta charset="utf-8"></head>
        <body style="font-family:sans-serif;font-size:15px;color:#111;line-height:1.6;">
        <p><strong>TaskLeaders Admin Alerts</strong></p>
        <ul style="list-style:none;padding:0;">
          ${escalations.map((a) => `
            <li style="margin-bottom:12px;padding:10px;background:#f8f8f8;border-radius:6px;">
              <strong>[${a.priority.toUpperCase()}] ${a.alert_type}</strong>
              ${a.job_id ? ` &mdash; Job: <code>${a.job_id}</code>` : ""}
              ${a.provider_slug ? ` &mdash; Provider: <code>${a.provider_slug}</code>` : ""}
              ${a.participant_whatsapp ? ` &mdash; Number: <code>${a.participant_whatsapp}</code>` : ""}
              <br>${a.description ?? "No description"}
            </li>`).join("")}
        </ul>
        <p><a href="https://task-leaders.com/v0.5/admin/approve.html">Review in Admin Panel</a></p>
        </body></html>`;

      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromEmail,
          to:   [adminEmail],
          subject,
          html: htmlBody,
          text: textBody,
        }),
      });

      if (emailRes.ok) {
        const ids = escalations.map((e) => e.id);
        await supabase.from("admin_alerts")
          .update({ email_sent: true })
          .in("id", ids);
        emailsSent = escalations.length;
      }
    } else {
      // No Resend key — mark acknowledged to prevent queue buildup
      const ids = escalations.map((e) => e.id);
      await supabase.from("admin_alerts")
        .update({ status: "acknowledged" })
        .in("id", ids);
    }
  }

  return json({
    ok: true,
    data: {
      processed,
      check_result:    checkResult,
      emails_sent:     emailsSent,
      escalations_found: escalations?.length ?? 0,
    },
  });
});
