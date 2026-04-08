// TaskLeaders — Edge Function: record-operational-event
// Contract: POST /record-operational-event
//
// Admin-authenticated endpoint for recording confirmed factual operational
// events into the reliability pipeline.
//
// ── Policy (locked for v1) ───────────────────────────────────────────────────
// Admin CONFIRMS whether an event occurred.
// Admin does NOT set or vary weights — weights are predefined in constants.
// This enforces structured, non-arbitrary reliability impact.
//
// ── Approved event types for this endpoint ───────────────────────────────────
//   accepted_no_proceed — provider accepted and failed to proceed before any
//                         real appointment/commitment was established
//   no_show             — provider had progressed to an actual appointment
//                         commitment and then failed to appear
//   poor_eta            — ETA reminder was sent (eta_reminder_sent_at IS NOT NULL);
//                         admin confirms provider failed to provide ETA
//
// NOT handled here (separate paths):
//   payment_failure   — auto-recorded by process-timeouts on timeout expiry
//   survey            — auto-recorded from survey pipeline via apply_survey_to_reliability
//   manual_positive   — internal-only; admin input via a separate path; excluded from public score
//   manual_negative   — internal-only; admin input via a separate path; excluded from public score
//
// ── Mutual exclusivity ────────────────────────────────────────────────────────
// accepted_no_proceed and no_show are mutually exclusive per provider/job.
// Enforced at both application layer (below) and DB layer
// (reliability_inputs_mutually_exclusive_events_idx).
//
// ── Scoring impact ────────────────────────────────────────────────────────────
// Events are written to reliability_inputs with applied = false.
// Score is NOT updated immediately — picked up at the next apply-reliability call.
// Weights are provisional (from OPERATIONAL_EVENT_WEIGHTS in constants.ts).
//
// ── Validation guards per event type ────────────────────────────────────────
// accepted_no_proceed:
//   • job.assigned_provider_slug = provider_slug
//   • job.payment_status = 'paid'
//   • job.completion_signaled_at IS NULL
//   • no existing no_show for same provider/job
//
// no_show:
//   • job.assigned_provider_slug = provider_slug
//   • job.payment_status = 'paid'
//   • job.completion_signaled_at IS NULL
//   • no existing accepted_no_proceed for same provider/job
//
// poor_eta:
//   • job.assigned_provider_slug = provider_slug
//   • job.eta_reminder_sent_at IS NOT NULL
//     (proves reminder was sent; admin confirms provider failed to provide ETA)
//
// Body: { job_id, provider_slug, event_type, notes?, admin_password }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  OPERATIONAL_EVENT_WEIGHTS,
  MUTUALLY_EXCLUSIVE_NEGATIVE_EVENTS,
} from "../_shared/constants.ts";

const ALLOWED_EVENT_TYPES = new Set([
  "accepted_no_proceed",
  "no_show",
  "poor_eta",
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}
function err(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return err("method_not_allowed", "POST required", 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const adminPassword  = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD");

  if (!supabaseUrl || !serviceRoleKey || !adminPassword) {
    return err("server_error", "Missing configuration", 500);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return err("bad_request", "Invalid JSON body"); }

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (String(body.admin_password ?? "") !== adminPassword) {
    return err("unauthorized", "Unauthorized", 401);
  }

  // ── Input validation ──────────────────────────────────────────────────────
  const jobId       = String(body.job_id       ?? "").trim();
  const providerSlug = String(body.provider_slug ?? "").trim();
  const eventType   = String(body.event_type   ?? "").trim();
  const notes       = body.notes ? String(body.notes).trim() : null;

  if (!jobId)        return err("validation_error", "job_id is required");
  if (!providerSlug) return err("validation_error", "provider_slug is required");
  if (!eventType)    return err("validation_error", "event_type is required");

  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    return err(
      "validation_error",
      `event_type must be one of: ${[...ALLOWED_EVENT_TYPES].join(", ")}. ` +
      `payment_failure is auto-recorded. manual_positive/manual_negative use a separate path.`,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Load job record ───────────────────────────────────────────────────────
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select(
      "job_id, address, assigned_provider_slug, payment_status, " +
      "completion_signaled_at, eta_reminder_sent_at, state, category_name",
    )
    .eq("job_id", jobId)
    .maybeSingle();

  if (jobErr) return err("server_error", jobErr.message, 500);
  if (!job)   return err("not_found", `Job ${jobId} not found`, 404);

  // ── Guard: provider must be the assigned provider ─────────────────────────
  if (job.assigned_provider_slug !== providerSlug) {
    return err(
      "validation_error",
      `Provider ${providerSlug} is not the assigned provider for job ${jobId}. ` +
      `Assigned: ${job.assigned_provider_slug ?? "none"}.`,
      422,
    );
  }

  // ── Event-type-specific validation guards ────────────────────────────────

  if (eventType === "poor_eta") {
    // Guard: ETA reminder must have been sent for this job.
    // eta_reminder_sent_at IS NOT NULL proves the conditional reminder was triggered.
    // Without it, no ETA was requested, so a poor_eta event is invalid.
    if (!job.eta_reminder_sent_at) {
      return err(
        "validation_error",
        `Cannot record poor_eta for job ${jobId}: eta_reminder_sent_at is null. ` +
        `The ETA reminder was not sent for this job (conditional reminder was not triggered). ` +
        `No ETA was requested, so poor_eta does not apply.`,
        422,
      );
    }
  }

  if (eventType === "accepted_no_proceed" || eventType === "no_show") {
    // Guard: payment must have been confirmed.
    // Both events require the provider to have paid and been actively engaged.
    if (job.payment_status !== "paid") {
      return err(
        "validation_error",
        `Cannot record ${eventType} for job ${jobId}: payment_status is '${job.payment_status}'. ` +
        `Payment must be confirmed ('paid') before recording this event. ` +
        `For an unpaid timeout, record payment_failure instead (auto-recorded by process-timeouts).`,
        422,
      );
    }

    // Guard: job must not already be completed.
    if (job.completion_signaled_at) {
      return err(
        "validation_error",
        `Cannot record ${eventType} for job ${jobId}: job is already marked complete ` +
        `(completion_signaled_at: ${job.completion_signaled_at}).`,
        422,
      );
    }

    // Guard: mutual exclusivity check.
    // accepted_no_proceed and no_show cannot both be recorded for the same provider/job.
    // The DB constraint is the final guard, but we check here for a clear error message.
    if (MUTUALLY_EXCLUSIVE_NEGATIVE_EVENTS.has(eventType)) {
      const otherType = eventType === "accepted_no_proceed" ? "no_show" : "accepted_no_proceed";

      const { data: existing } = await supabase
        .from("reliability_inputs")
        .select("id, input_type, created_at")
        .eq("provider_slug", providerSlug)
        .eq("job_id", jobId)
        .eq("input_type", otherType)
        .maybeSingle();

      if (existing) {
        return err(
          "conflict",
          `Cannot record ${eventType} for job ${jobId}: a mutually exclusive event ` +
          `'${otherType}' was already recorded for this provider/job on ${existing.created_at}. ` +
          `accepted_no_proceed (failed before appointment) and no_show (failed to appear at appointment) ` +
          `are mutually exclusive. Only one applies per provider/job.`,
          409,
        );
      }
    }
  }

  // ── Idempotency: check for existing event of same type ───────────────────
  // The DB unique index enforces this as well, but checking here gives a clean error.
  const { data: dupe } = await supabase
    .from("reliability_inputs")
    .select("id, created_at")
    .eq("provider_slug", providerSlug)
    .eq("job_id", jobId)
    .eq("input_type", eventType)
    .maybeSingle();

  if (dupe) {
    return err(
      "conflict",
      `A '${eventType}' event was already recorded for provider ${providerSlug} ` +
      `on job ${jobId} (recorded at ${dupe.created_at}). Duplicate events are not permitted.`,
      409,
    );
  }

  // ── Record the reliability input ──────────────────────────────────────────
  // Weight is predefined — admin cannot set or vary it.
  const weight = OPERATIONAL_EVENT_WEIGHTS[eventType] ?? 0;

  const { data: inputRow, error: insertErr } = await supabase
    .from("reliability_inputs")
    .insert({
      provider_slug: providerSlug,
      job_id:        jobId,
      input_type:    eventType,
      weight,
      notes:         notes
        ? `[Admin confirmed] ${notes}`
        : `[Admin confirmed] ${eventType} recorded for job ${jobId}.`,
      applied:       false,
    })
    .select("id, input_type, weight, created_at")
    .single();

  if (insertErr) {
    // Handle DB-level unique/exclusivity constraint violations defensively
    if (insertErr.code === "23505") {
      return err(
        "conflict",
        `DB constraint prevented recording '${eventType}' for provider ${providerSlug} / ` +
        `job ${jobId}. Either a duplicate event or a mutually exclusive event already exists.`,
        409,
      );
    }
    return err("server_error", insertErr.message, 500);
  }

  // ── Trigger apply-reliability promptly ───────────────────────────────────
  // Operational events should not sit unapplied waiting for an unrelated
  // survey or admin call. We fire-and-forget apply-reliability immediately
  // after recording so the score stays current.
  // Async — does not block this response.
  const cronSecret = Deno.env.get("INTERNAL_CRON_SECRET");
  const fnBase     = (supabaseUrl ?? "").split(".supabase.co")[0].replace("https://", "");
  fetch(`https://${fnBase}.supabase.co/functions/v1/apply-reliability`, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-internal-secret": cronSecret ?? "",
    },
    body: JSON.stringify({ provider_slug: providerSlug }),
  }).catch(() => {}); // fire-and-forget; apply failure should not fail event recording

  // ── Audit trail: admin_alert for this event ───────────────────────────────
  // Records the event in admin_alerts for visibility and audit.
  // Does not require admin action — informational only.
  await supabase.from("admin_alerts").insert({
    alert_type:           "risk_flag",
    priority:             "normal",
    job_id:               jobId,
    provider_slug:        providerSlug,
    description:
      `[Operational event recorded] ${eventType} — ` +
      (notes ?? `admin confirmed for job ${jobId}`) +
      `. Reliability input recorded (applied = false). ` +
      `Provisional weight: ${weight}. apply-reliability triggered asynchronously.`,
    status:               "acknowledged", // informational — no action needed
  }).catch(() => {}); // fire-and-forget; audit log failure should not fail the response

  return json({
    ok: true,
    data: {
      event_id:      inputRow.id,
      event_type:    inputRow.input_type,
      provider_slug: providerSlug,
      job_id:        jobId,
      weight,
      applied:       false,
      recorded_at:   inputRow.created_at,
      note:
        "Reliability input recorded. apply-reliability triggered asynchronously — " +
        "score update is in progress. Weights are provisional — not locked business rules.",
    },
  });
});
