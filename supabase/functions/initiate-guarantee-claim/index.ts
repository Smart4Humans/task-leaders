// TaskLeaders — Edge Function: initiate-guarantee-claim
// Contract: POST /initiate-guarantee-claim
//
// Admin-authenticated. Initiates a Lead Guarantee claim by:
//   1. Validating no active claim already exists for this provider/job
//   2. Inserting into the existing guarantee_claims table
//   3. Sending WT-4 (guarantee claim confirmation) to the client via WhatsApp
//   4. Setting the client's conversation_sessions state to awaiting_guarantee_confirm
//      so the twilio-webhook correctly routes their YES/NO reply
//
// ── Workflow (locked for v1) ─────────────────────────────────────────────────
// Claim initiation is admin-triggered only — NOT auto-triggered from thread language.
// Client confirmation is requested in WhatsApp (WT-4 template).
// twilio-webhook handles the YES/NO reply in handleGuaranteeConfirmation().
// Admin adjudicates the outcome after client responds.
//
// ── Duplicate initiation guard ───────────────────────────────────────────────
// If a guarantee_claims row already exists for this job/provider in an active state
// (any state other than 'closed', 'denied', 'approved'), this endpoint returns
// the existing claim state rather than inserting a duplicate.
//
// ── guarantee_claims table ───────────────────────────────────────────────────
// This table was created in Phase 2 (messaging_engine migration).
// Do NOT create a new/parallel claims table. Extend the existing one.
//
// Body: { job_id, provider_slug, admin_notes?, admin_password }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage, buildWT4,
} from "../_shared/twilio.ts";

const TERMINAL_CLAIM_STATES = new Set(["closed", "denied", "approved"]);

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
  const jobId        = String(body.job_id        ?? "").trim();
  const providerSlug = String(body.provider_slug ?? "").trim();
  const adminNotes   = body.admin_notes ? String(body.admin_notes).trim() : null;

  if (!jobId)        return err("validation_error", "job_id is required");
  if (!providerSlug) return err("validation_error", "provider_slug is required");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Load job ──────────────────────────────────────────────────────────────
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("job_id, address, client_whatsapp, assigned_provider_slug, state, payment_status")
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

  // ── Guard: client WhatsApp must be on record ──────────────────────────────
  if (!job.client_whatsapp) {
    return err(
      "validation_error",
      `Job ${jobId} has no client_whatsapp on record. Cannot send guarantee claim confirmation.`,
      422,
    );
  }

  // ── Duplicate initiation guard ────────────────────────────────────────────
  // Only one active claim per (job, provider). Terminal states allow re-initiation.
  const { data: existingClaim } = await supabase
    .from("guarantee_claims")
    .select("id, claim_state, created_at")
    .eq("job_id", jobId)
    .eq("provider_slug", providerSlug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingClaim && !TERMINAL_CLAIM_STATES.has(existingClaim.claim_state)) {
    return err(
      "conflict",
      `An active guarantee claim already exists for job ${jobId} / provider ${providerSlug}. ` +
      `Current state: '${existingClaim.claim_state}' (claim ID: ${existingClaim.id}). ` +
      `Re-initiation is only allowed after a claim reaches a terminal state (closed/denied/approved).`,
      409,
    );
  }

  // ── Load provider name for WT-4 ───────────────────────────────────────────
  const { data: provider } = await supabase
    .from("provider_accounts")
    .select("first_name, last_name")
    .eq("slug", providerSlug)
    .maybeSingle();

  const providerName = provider
    ? `${provider.first_name ?? ""} ${provider.last_name ?? ""}`.trim()
    : providerSlug;

  // ── Insert guarantee claim ────────────────────────────────────────────────
  const { data: claim, error: claimErr } = await supabase
    .from("guarantee_claims")
    .insert({
      job_id:         jobId,
      provider_slug:  providerSlug,
      initiated_by:   "admin",
      claim_state:    "client_confirmation_sent",
      client_whatsapp: job.client_whatsapp,
      admin_notes:    adminNotes,
    })
    .select("id, claim_state, created_at")
    .single();

  if (claimErr) return err("server_error", "Failed to create claim: " + claimErr.message, 500);

  // ── Send WT-4 to client ───────────────────────────────────────────────────
  const wt4Body    = buildWT4(jobId, job.address ?? "address on file", providerName);
  const twilioEnv  = getTwilioEnv();
  let   messageSent = false;

  if (twilioEnv) {
    const result = await sendWhatsApp(twilioEnv, job.client_whatsapp, wt4Body);
    messageSent = result.ok;
    logMessage({
      supabaseUrl,
      serviceRoleKey,
      direction:           "outbound",
      jobId,
      participantWhatsapp: job.client_whatsapp,
      messageSid:          result.messageSid,
      templateName:        "WT-4",
      body:                wt4Body,
      status:              result.ok ? "sent" : "failed",
    });
  }

  // ── Set client conversation session to awaiting_guarantee_confirm ─────────
  // This ensures the twilio-webhook routes the client's YES/NO reply correctly
  // via handleGuaranteeConfirmation() rather than treating it as a relay message.
  await supabase.from("conversation_sessions").upsert(
    {
      whatsapp_e164:   job.client_whatsapp,
      session_state:   "awaiting_guarantee_confirm",
      current_job_id:  jobId,
      sender_type:     "client",
      last_prompt:     wt4Body,
      last_activity_at: new Date().toISOString(),
    },
    { onConflict: "whatsapp_e164" },
  );

  // ── Admin alert for audit trail ───────────────────────────────────────────
  await supabase.from("admin_alerts").insert({
    alert_type:           "guarantee_claim",
    priority:             "high",
    job_id:               jobId,
    provider_slug:        providerSlug,
    participant_whatsapp: job.client_whatsapp,
    description:
      `Guarantee claim initiated by admin for provider ${providerSlug}. ` +
      `WT-4 ${messageSent ? "sent" : "FAILED to send"} to client ${job.client_whatsapp}. ` +
      `Client session set to awaiting_guarantee_confirm. ` +
      (adminNotes ? `Notes: ${adminNotes}` : ""),
    status: "open",
  }).catch(() => {});

  return json({
    ok: true,
    data: {
      claim_id:          claim.id,
      claim_state:       claim.claim_state,
      job_id:            jobId,
      provider_slug:     providerSlug,
      client_whatsapp:   job.client_whatsapp,
      wt4_sent:          messageSent,
      session_updated:   true,
      note:
        "Client conversation session set to awaiting_guarantee_confirm. " +
        "Reply YES/NO will be routed by twilio-webhook to handleGuaranteeConfirmation().",
    },
  });
});
