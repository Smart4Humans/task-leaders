// TaskLeaders — Edge Function: trigger-survey
// Contract: POST /trigger-survey
// Admin endpoint with two actions:
//
//   action: "survey"
//     Sends WC-3 (post-job survey) to the client and WT-5 (notification) to the
//     provider for a completed or closing job.
//     Preconditions checked server-side:
//       - Job must have an assigned_provider_slug
//       - Job must have a client_whatsapp
//       - Job must NOT already have survey_sent_at set (idempotent guard)
//     On success: sets job.state = 'survey_pending', job.survey_sent_at
//     After WC-3 is sent, the client's conversation_sessions is updated to
//     awaiting_survey_q1 — the twilio-webhook then handles the 3-question capture.
//
//   action: "eta_reminder"
//     Sends WT-3 (day-of ETA reminder) to the assigned provider.
//     WT-3 is CONDITIONAL — this endpoint checks:
//       - Job is in thread_live or active_coordination state
//       - eta_reminder_sent_at IS NULL (not already sent)
//       - No recent message from provider in message_log (within last 2 hours)
//         (heuristic — avoids sending WT-3 if provider is already communicating)
//     If any condition fails, returns 409 with the reason. No message is sent.
//     Admin must review and re-trigger if appropriate.
//
// Auth: admin_password in body.
//
// RELIABILITY NOTE: sending WT-3 does NOT create a reliability input.
// Failure to respond to WT-3 MAY generate a reliability input later (admin/Phase 5).
// Response time and reliability are kept strictly separate.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage,
  buildWC3, buildWT5, buildWT3, SURVEY_QUESTIONS,
} from "../_shared/twilio.ts";
import { CATEGORY_NAMES } from "../_shared/constants.ts";

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

  const action = String(body.action ?? "survey");
  const jobId  = String(body.job_id ?? "").trim();
  if (!jobId) return err("validation_error", "job_id is required");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Load job ───────────────────────────────────────────────────────────────
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("job_id, state, category_code, category_name, address, client_whatsapp, assigned_provider_slug, survey_sent_at, eta_reminder_sent_at, source")
    .eq("job_id", jobId)
    .single();

  if (jobErr || !job) return err("not_found", "Job not found", 404);

  const twilioEnv   = getTwilioEnv();
  if (!twilioEnv)   return err("server_error", "Twilio not configured", 500);

  const categoryName = CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code;
  const address      = job.address ?? "address on file";

  // ── Action: survey ─────────────────────────────────────────────────────────
  if (action === "survey") {
    // Idempotency: do not re-send survey
    if (job.survey_sent_at) {
      return err("conflict", "Survey already sent for this job", 409);
    }
    if (!job.client_whatsapp) {
      return err("conflict", "No client WhatsApp on record for this job", 409);
    }
    if (!job.assigned_provider_slug) {
      return err("conflict", "No assigned provider on record for this job", 409);
    }

    // Load provider for name
    const { data: provider } = await supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, business_name, display_name_type")
      .eq("slug", job.assigned_provider_slug)
      .single();

    const providerName = provider
      ? (provider.display_name_type === "business" && provider.business_name)
          ? provider.business_name
          : `${provider.first_name ?? ""} ${provider.last_name ?? ""}`.trim()
      : "your TaskLeader";

    // Load client name for WT-5 (uses first portion of their number context)
    // Client name is not stored directly — use a placeholder for Phase 4
    const clientLabel = "your client";

    // Send WC-3 to client
    const wc3Body = buildWC3(job.job_id, address, providerName, categoryName);
    const wc3Result = await sendWhatsApp(twilioEnv, job.client_whatsapp, wc3Body);
    logMessage({
      supabaseUrl, serviceRoleKey, direction: "outbound", jobId: job.job_id,
      participantWhatsapp: job.client_whatsapp,
      templateName: "WC-3", body: wc3Body, status: wc3Result.ok ? "sent" : "failed",
    });

    if (!wc3Result.ok) {
      return err("twilio_error", `WC-3 send failed: ${wc3Result.error}`, 502);
    }

    // Send first survey question immediately after WC-3
    const q1Result = await sendWhatsApp(twilioEnv, job.client_whatsapp, SURVEY_QUESTIONS.q1);
    logMessage({
      supabaseUrl, serviceRoleKey, direction: "outbound", jobId: job.job_id,
      participantWhatsapp: job.client_whatsapp,
      templateName: "SURVEY_Q1", body: SURVEY_QUESTIONS.q1,
      status: q1Result.ok ? "sent" : "failed",
    });

    // Update client session to awaiting_survey_q1
    // twilio-webhook handles subsequent answers and state transitions
    await supabase.from("conversation_sessions").upsert({
      whatsapp_e164:   job.client_whatsapp,
      sender_type:     "client",
      session_state:   "awaiting_survey_q1",
      current_job_id:  job.job_id,
      last_prompt:     SURVEY_QUESTIONS.q1,
      last_activity_at: new Date().toISOString(),
    }, { onConflict: "whatsapp_e164" });

    // Create survey_responses row (started)
    await supabase.from("survey_responses").upsert({
      job_id:            job.job_id,
      client_whatsapp:   job.client_whatsapp,
      provider_slug:     job.assigned_provider_slug,
      survey_started_at: new Date().toISOString(),
    }, { onConflict: "job_id,client_whatsapp" });

    // Send WT-5 to provider (notification that survey was sent)
    // Load provider WhatsApp
    const { data: providerAcct } = await supabase
      .from("provider_accounts")
      .select("whatsapp_number")
      .eq("slug", job.assigned_provider_slug)
      .maybeSingle();

    if (providerAcct?.whatsapp_number) {
      const wt5Body = buildWT5(job.job_id, address, clientLabel, categoryName);
      const wt5Result = await sendWhatsApp(twilioEnv, providerAcct.whatsapp_number, wt5Body);
      logMessage({
        supabaseUrl, serviceRoleKey, direction: "outbound", jobId: job.job_id,
        participantWhatsapp: providerAcct.whatsapp_number,
        templateName: "WT-5", body: wt5Body, status: wt5Result.ok ? "sent" : "failed",
      });
    }

    // Advance job state
    await supabase.from("jobs").update({
      state:          "survey_pending",
      survey_sent_at: new Date().toISOString(),
    }).eq("job_id", jobId);

    return json({
      ok: true,
      data: { job_id: jobId, action: "survey", wc3_sent: wc3Result.ok, state: "survey_pending" },
    });
  }

  // ── Action: eta_reminder ───────────────────────────────────────────────────
  if (action === "eta_reminder") {
    // Condition 1: Job must be in an active thread state
    const activeStates = ["thread_live", "active_coordination", "confirmed_assigned"];
    if (!activeStates.includes(job.state)) {
      return err("conflict", `Job is in state '${job.state}' — WT-3 only sent for active thread states`, 409);
    }

    // Condition 2: ETA reminder not already sent (idempotency)
    if (job.eta_reminder_sent_at) {
      return err("conflict", "ETA reminder already sent for this job", 409);
    }

    if (!job.assigned_provider_slug) {
      return err("conflict", "No assigned provider on record for this job", 409);
    }

    // Load provider
    const { data: provAcct } = await supabase
      .from("provider_accounts")
      .select("whatsapp_number, first_name, last_name")
      .eq("slug", job.assigned_provider_slug)
      .single();

    if (!provAcct?.whatsapp_number) {
      return err("conflict", "Provider WhatsApp not available", 409);
    }

    // Condition 3: No meaningful recent communication from provider (last 2 hours)
    // Heuristic: check message_log for inbound messages from this provider in last 2 hours.
    // If provider has sent any message recently, they're already communicating → skip WT-3.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: recentMsgs } = await supabase
      .from("message_log")
      .select("id")
      .eq("job_id", job.job_id)
      .eq("participant_whatsapp", provAcct.whatsapp_number)
      .eq("direction", "inbound")
      .gte("created_at", twoHoursAgo)
      .limit(1);

    if (recentMsgs && recentMsgs.length > 0) {
      return err("conflict",
        "Provider has recent activity in this thread — ETA reminder not sent. " +
        "Provider appears to be communicating. Override manually if needed.", 409);
    }

    // All conditions met — send WT-3
    // client_name for WT-3: use a placeholder (Phase 5: derive from concierge_clients or intake)
    const clientLabel = "the client";
    const wt3Body     = buildWT3(job.job_id, address, categoryName, clientLabel);
    const wt3Result   = await sendWhatsApp(twilioEnv, provAcct.whatsapp_number, wt3Body);
    logMessage({
      supabaseUrl, serviceRoleKey, direction: "outbound", jobId: job.job_id,
      participantWhatsapp: provAcct.whatsapp_number,
      templateName: "WT-3", body: wt3Body, status: wt3Result.ok ? "sent" : "failed",
    });

    if (!wt3Result.ok) {
      return err("twilio_error", `WT-3 send failed: ${wt3Result.error}`, 502);
    }

    // Mark reminder sent
    await supabase.from("jobs")
      .update({ eta_reminder_sent_at: new Date().toISOString() })
      .eq("job_id", jobId);

    return json({
      ok: true,
      data: { job_id: jobId, action: "eta_reminder", wt3_sent: true },
    });
  }

  return err("validation_error", `Unknown action: ${action}. Valid: survey | eta_reminder`);
});
