// TaskLeaders — Edge Function: twilio-status-callback
// Contract: POST /twilio-status-callback (Twilio form-encoded delivery status)
//
// Phase 0.5 observability: ingests Twilio Programmable Messaging status
// callbacks and updates message_log.status to reflect post-API delivery
// state (delivered / read / undelivered / failed). API-time observability
// (status="sent" written by sendAndLog at send time) was verified in Phase 0
// but does not catch asynchronous WhatsApp delivery failures (e.g. closed
// 24-hour session window → Twilio API returns 200 + SID, then WhatsApp
// rejects delivery downstream and Twilio updates the message resource to
// "undelivered" with ErrorCode 21211 — invisible without this handler).
//
// ── What it does ─────────────────────────────────────────────────────────────
// 1. Validates the X-Twilio-Signature against TWILIO_STATUS_CALLBACK_URL
//    (mirrors twilio-webhook signature posture; TWILIO_SKIP_SIG=true bypasses
//    in dev/sandbox).
// 2. Parses MessageSid / MessageStatus / ErrorCode / ErrorMessage / To / From.
// 3. For "queued" / "sent" / "accepted" / "scheduled": acknowledges 200 OK,
//    no DB write (we already have status="sent" from the API response).
// 4. For "delivered" / "read": updates message_log.status by twilio_message_sid.
// 5. For "undelivered" / "failed": updates message_log.status + error_code AND
//    inserts a single admin_alerts row — only if the UPDATE actually changed a
//    row (idempotency guard against Twilio callback retries).
//
// ── Idempotency ──────────────────────────────────────────────────────────────
// The UPDATE is gated by `WHERE twilio_message_sid = $sid AND status != $new`,
// and the alert insert is conditional on the UPDATE returning a row. Twilio
// callback retries for the same status are no-ops at both the message_log and
// admin_alerts layers.
//
// ── Safety ───────────────────────────────────────────────────────────────────
// - Missing MessageSid: return 200 OK, no write, no alert.
// - SID with no matching message_log row (e.g. Console test message): return
//   200 OK, no alert.
// - DB UPDATE error: log to console.error (Supabase function logs), return
//   200 OK so Twilio doesn't enter perpetual retry.
// - admin_alerts insert failure: non-fatal — return 200 OK regardless.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateTwilioSignature } from "../_shared/twilio.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST")    return new Response("Method not allowed", { status: 405 });

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const twilioToken    = Deno.env.get("TWILIO_AUTH_TOKEN");
  const callbackUrl    = Deno.env.get("TWILIO_STATUS_CALLBACK_URL");

  if (!supabaseUrl || !serviceRoleKey || !twilioToken) {
    return new Response("Missing configuration", { status: 500 });
  }

  const rawBody = await req.text();
  const params  = Object.fromEntries(new URLSearchParams(rawBody).entries());

  // Validate Twilio signature against the configured callback URL.
  // Mirrors twilio-webhook posture: TWILIO_SKIP_SIG=true bypasses in dev,
  // and an unset callbackUrl skips validation (same as twilio-webhook with
  // an unset TWILIO_WEBHOOK_URL). Twilio will not call this endpoint until
  // the dependent functions are redeployed with the StatusCallback param,
  // so the brief Stage-A window with the env var unset has no inbound traffic.
  if (Deno.env.get("TWILIO_SKIP_SIG") !== "true" && callbackUrl) {
    const sig   = req.headers.get("x-twilio-signature") ?? "";
    const valid = await validateTwilioSignature(twilioToken, callbackUrl, params, sig);
    if (!valid) return new Response("Invalid signature", { status: 403 });
  }

  const messageSid    = params["MessageSid"]    ?? "";
  const messageStatus = (params["MessageStatus"] ?? "").toLowerCase();
  const errorCode     = params["ErrorCode"]     ?? null;
  const errorMessage  = params["ErrorMessage"]  ?? null;
  const toRaw         = params["To"]            ?? "";
  const fromRaw       = params["From"]          ?? "";

  // Defensive: missing SID — never 500, never write
  if (!messageSid) {
    return new Response("ok", { status: 200 });
  }

  // Status taxonomy:
  //   ignored: queued | sent | accepted | scheduled  (we already wrote 'sent' from the API response)
  //   updateOnly: delivered | read                   (advance message_log.status)
  //   failure:    undelivered | failed               (advance status + error_code + admin_alert)
  const updateOnly = messageStatus === "delivered" || messageStatus === "read";
  const failure    = messageStatus === "undelivered" || messageStatus === "failed";

  if (!updateOnly && !failure) {
    return new Response("ok", { status: 200 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Idempotent UPDATE: skips when status already matches (callback retry of
  // the same status is a no-op). RETURNING is used to gate the admin_alert
  // insert so retries do not produce duplicate alerts.
  const patch: Record<string, unknown> = { status: messageStatus };
  if (failure) {
    patch.error_code = errorCode;
  }

  const { data: updated, error: updateErr } = await supabase
    .from("message_log")
    .update(patch)
    .eq("twilio_message_sid", messageSid)
    .neq("status", messageStatus)
    .select("id, job_id, participant_whatsapp, template_name, body")
    .maybeSingle();

  if (updateErr) {
    console.error(
      `twilio-status-callback UPDATE failed. SID=${messageSid} status=${messageStatus} err=${updateErr.message}`,
    );
    return new Response("ok", { status: 200 });
  }

  // No matching row (unknown SID — e.g. Twilio Console test message, or a
  // send predating Phase 0.5 deploy with no StatusCallback param attached).
  if (!updated) {
    return new Response("ok", { status: 200 });
  }

  // Failure terminal — raise one admin_alert. Description prefix is distinct
  // from Phase 0's "sendWhatsApp FAILED ..." so operators can immediately
  // distinguish API-time vs delivery-time failures during triage.
  if (failure) {
    const toClean   = toRaw.replace(/^whatsapp:/, "");
    const fromClean = fromRaw.replace(/^whatsapp:/, "");
    const tmplLabel = updated.template_name ?? "(none)";
    const bodyPrev  = (updated.body ?? "").substring(0, 100);
    const description =
      `WhatsApp delivery ${messageStatus.toUpperCase()}. ` +
      `SID: ${messageSid}. ` +
      `To: ${toClean || "(unknown)"}. ` +
      `From: ${fromClean || "(unknown)"}. ` +
      `ErrorCode: ${errorCode ?? "(none)"}. ` +
      `ErrorMessage: ${errorMessage ?? "(none)"}. ` +
      `Template: ${tmplLabel}. ` +
      `Body preview: ${bodyPrev}.`;

    try {
      await supabase.from("admin_alerts").insert({
        alert_type:           "escalation",
        priority:             "high",
        job_id:               updated.job_id ?? null,
        participant_whatsapp: toClean || (updated.participant_whatsapp ?? null),
        description,
        status:               "open",
      });
    } catch (e) {
      console.error(
        `twilio-status-callback admin_alert insert failed. SID=${messageSid} err=${String(e)}`,
      );
    }
  }

  return new Response("ok", { status: 200 });
});
