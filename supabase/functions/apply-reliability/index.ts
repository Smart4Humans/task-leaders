// TaskLeaders — Edge Function: apply-reliability
// Contract: POST /apply-reliability
//
// Processes pending reliability_inputs for a provider and updates
// providers.reliability_percent.
//
// ── Metric separation (locked rule) ─────────────────────────────────────────
// This function handles RELIABILITY only.
// Response time (response_time_minutes) is updated separately in twilio-webhook
// via the record_response_time() Postgres function.
// Do NOT update response_time_minutes here.
//
// ── Approved input types ─────────────────────────────────────────────────────
// Only these types may be written to reliability_inputs and processed here:
//   survey           — from completed survey_responses (3-question avg)
//   payment_failure  — provider claimed, payment timed out or failed
//   accepted_no_proceed — provider accepted, then disengaged
//   no_show          — provider did not appear for confirmed job
//   poor_eta         — provider failed to send ETA (admin-flagged)
//   manual_positive  — admin-added positive note
//   manual_negative  — admin-added negative note
//
// ── Score calculation ─────────────────────────────────────────────────────────
// Base: 80 (represents a neutral/average provider with no history)
// Survey inputs: each survey adds a weight in range [-40, +40] (see migration)
// Negative inputs: each reduces score by its weight (negative values)
// Result clamped to [0, 100].
//
// PROVISIONAL: weights and base score are not locked business rules.
// They must be reviewed and approved before treating as authoritative.
// The formula is designed to be easy to recalibrate without schema changes.
//
// ── Trigger ───────────────────────────────────────────────────────────────────
// Called by twilio-webhook after survey_completed_at is set.
// Also callable by admin for manual recomputation.
//
// Body: { provider_slug: string, job_id?: string, admin_password?: string }
// Also accepts x-internal-secret header for internal calls.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// Base score for a provider with no history.
// PROVISIONAL — adjust with product approval.
const BASE_RELIABILITY_SCORE = 80;

// Approved negative input types and their provisional weights.
// Positive = improves score. Negative = reduces score.
// Do NOT add new types here without product approval.
const APPROVED_INPUT_WEIGHTS: Record<string, number> = {
  // Survey inputs are stored with individual weights in the DB (see migration).
  // survey: <from DB>

  // Negative inputs (approved from Guidelines):
  payment_failure:      -10,  // claimed lead, did not pay within window
  accepted_no_proceed:  -15,  // accepted job, then disengaged
  no_show:              -20,  // confirmed job, did not appear
  poor_eta:              -5,  // failed to send ETA (admin-flagged)

  // Manual admin inputs — weight comes from DB, no override here
  // manual_positive: <from DB>
  // manual_negative: <from DB>
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return err("bad_request", "Method not allowed", 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const adminPassword  = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD");
  const cronSecret     = Deno.env.get("INTERNAL_CRON_SECRET");

  if (!supabaseUrl || !serviceRoleKey) {
    return err("server_error", "Missing configuration", 500);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return err("bad_request", "Invalid JSON body"); }

  const internalHeader = req.headers.get("x-internal-secret");
  const isInternal = cronSecret && internalHeader === cronSecret;
  const isAdmin    = adminPassword && String(body.admin_password ?? "") === adminPassword;
  if (!isInternal && !isAdmin) return err("unauthorized", "Unauthorized", 401);

  const providerSlug = String(body.provider_slug ?? "").trim();
  const jobId        = body.job_id ? String(body.job_id).trim() : null;
  if (!providerSlug) return err("validation_error", "provider_slug is required");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Step 1: Convert completed survey to reliability_input if needed ────────
  if (jobId) {
    await supabase.rpc("apply_survey_to_reliability", { p_job_id: jobId });
  }

  // ── Step 2: Load all unapplied reliability_inputs for this provider ────────
  const { data: inputs, error: inputErr } = await supabase
    .from("reliability_inputs")
    .select("id, input_type, weight, notes")
    .eq("provider_slug", providerSlug)
    .eq("applied", false)
    .order("created_at", { ascending: true });

  if (inputErr) return err("server_error", inputErr.message, 500);

  if (!inputs || inputs.length === 0) {
    return json({ ok: true, data: { provider_slug: providerSlug, inputs_processed: 0, unchanged: true } });
  }

  // ── Step 3: Load current reliability_percent as starting point ───────────
  const { data: providerRow } = await supabase
    .from("providers")
    .select("reliability_percent")
    .eq("provider_slug", providerSlug)
    .maybeSingle();

  // If provider has no existing score, start from BASE_RELIABILITY_SCORE.
  // If they do, start from their current score and apply delta.
  const currentScore = providerRow?.reliability_percent ?? BASE_RELIABILITY_SCORE;

  // ── Step 4: Calculate delta from pending inputs ────────────────────────────
  let delta = 0;
  const appliedIds: string[] = [];
  const inputLog: string[]   = [];

  for (const input of inputs) {
    let weight: number;

    if (input.input_type === "survey" || input.input_type === "manual_positive" || input.input_type === "manual_negative") {
      // Weight is stored per-record in the DB (set at recording time)
      weight = Number(input.weight);
    } else if (Object.prototype.hasOwnProperty.call(APPROVED_INPUT_WEIGHTS, input.input_type)) {
      // Use the provisionally defined weight for this type
      weight = APPROVED_INPUT_WEIGHTS[input.input_type];
    } else {
      // Unknown input type — log and skip (do not silently apply unknown rules)
      inputLog.push(`SKIPPED unknown input_type: ${input.input_type}`);
      continue;
    }

    delta += weight;
    appliedIds.push(input.id);
    inputLog.push(`${input.input_type}: ${weight > 0 ? "+" : ""}${weight}`);
  }

  if (appliedIds.length === 0) {
    return json({ ok: true, data: { provider_slug: providerSlug, inputs_processed: 0, unchanged: true, log: inputLog } });
  }

  // ── Step 5: Apply and clamp ────────────────────────────────────────────────
  const rawScore = currentScore + delta;
  const newScore  = Math.min(100, Math.max(0, Math.round(rawScore)));

  // ── Step 6: Write to providers table ──────────────────────────────────────
  // RELIABILITY ONLY — do not touch response_time_minutes here.
  const { error: updateErr } = await supabase
    .from("providers")
    .update({
      reliability_percent: newScore,
      updated_at:          new Date().toISOString(),
    })
    .eq("provider_slug", providerSlug);

  if (updateErr) {
    return err("server_error", "Failed to update providers: " + updateErr.message, 500);
  }

  // ── Step 7: Mark inputs as applied ────────────────────────────────────────
  await supabase
    .from("reliability_inputs")
    .update({ applied: true, applied_at: new Date().toISOString() })
    .in("id", appliedIds);

  return json({
    ok: true,
    data: {
      provider_slug:     providerSlug,
      inputs_processed:  appliedIds.length,
      previous_score:    currentScore,
      delta,
      new_score:         newScore,
      log:               inputLog,
      note:              "Weights are provisional — not locked business rules.",
    },
  });
});
