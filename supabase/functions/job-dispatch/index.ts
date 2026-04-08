// TaskLeaders — Edge Function: job-dispatch
// Contract: POST /job-dispatch
// Broadcasts a confirmed Concierge job to all eligible Concierge TaskLeaders.
//
// Eligibility rules (locked):
//   1. provider_accounts.concierge_eligible = true  (explicit Tier 1 flag)
//   2. provider_accounts.status = 'active'
//   3. provider_accounts.suspended = false
//   4. Provider participates in the requested category
//      (primary_service slug matches category_code, or category_code in additional_services)
//   5. Provider's service_cities includes the job's city (or service_area matches)
//
// Does NOT broadcast to Marketplace-only providers.
//
// Body: { job_id: string, admin_password: string }
//
// State transition: job.state → 'broadcast_sent'
// Creates one broadcast_responses row per provider messaged.
// Sends WT-2 to each eligible provider.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage, buildWT2,
} from "../_shared/twilio.ts";
import {
  CATEGORY_NAMES, CATEGORY_CODE_TO_SLUG, SLUG_TO_CATEGORY_CODE,
  CATEGORY_LEAD_FEES_CENTS, calcGst, providerCoversCity,
} from "../_shared/constants.ts";
import { toPublicJobId } from "../_shared/job-ids.ts";

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
    return err("server_error", "Missing server configuration", 500);
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

  const jobId = String(body.job_id ?? "").trim();
  if (!jobId) return err("validation_error", "job_id is required");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Load job ─────────────────────────────────────────────────────────────
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("job_id, city_code, category_code, category_name, state, address, description, client_id, client_whatsapp, lead_fee_cents, gst_cents")
    .eq("job_id", jobId)
    .single();

  if (jobErr || !job) return err("not_found", "Job not found", 404);
  if (!["intake_confirmed", "no_match", "pending"].includes(job.state)) {
    return err("conflict", `Job is in state '${job.state}' — cannot broadcast`, 409);
  }

  // ── Determine lead fee ────────────────────────────────────────────────────
  const baseFee = job.lead_fee_cents ?? CATEGORY_LEAD_FEES_CENTS[job.category_code] ?? 0;
  const gst     = job.gst_cents      ?? calcGst(baseFee);
  const feeDollars = (baseFee / 100).toFixed(2);

  // ── Find eligible providers ───────────────────────────────────────────────
  // Tier 1 = concierge_eligible = true, active, not suspended,
  // matching category and city.
  const categorySlug = CATEGORY_CODE_TO_SLUG[job.category_code] ?? "";

  const { data: providers, error: provErr } = await supabase
    .from("provider_accounts")
    .select("slug, first_name, last_name, whatsapp_number, primary_service, additional_services, service_cities, service_area")
    .eq("concierge_eligible", true)
    .eq("status", "active")
    .eq("suspended", false);

  if (provErr) return err("server_error", provErr.message, 500);
  if (!providers || providers.length === 0) {
    // No eligible providers — transition job to no_match, notify client
    await supabase
      .from("jobs")
      .update({ state: "no_match", status: "pending" })
      .eq("job_id", jobId);

    if (job.client_whatsapp) {
      const twilioEnv = getTwilioEnv();
      if (twilioEnv) {
        const msgBody = buildWC4(job.job_id, job.address ?? "address on file",
          CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code);
        await sendWhatsApp(twilioEnv, job.client_whatsapp, msgBody);
        logMessage({
          supabaseUrl, serviceRoleKey,
          direction: "outbound", jobId: job.job_id,
          participantWhatsapp: job.client_whatsapp,
          templateName: "WC-4", body: msgBody, status: "sent",
        });
        // Update client session state
        await supabase.from("conversation_sessions")
          .upsert({
            whatsapp_e164: job.client_whatsapp,
            session_state: "awaiting_no_match_decision",
            current_job_id: job.job_id,
            last_prompt: msgBody,
            last_activity_at: new Date().toISOString(),
          }, { onConflict: "whatsapp_e164" });
      }
    }

    return json({ ok: true, data: { broadcast_count: 0, state: "no_match" } });
  }

  // Filter by category + city
  const eligible = providers.filter((p) => {
    // Category check: primary_service slug OR additional_services array
    const primaryCode = SLUG_TO_CATEGORY_CODE[p.primary_service?.toLowerCase() ?? ""];
    const additionalCodes = (p.additional_services ?? []).map(
      (s: string) => SLUG_TO_CATEGORY_CODE[s.toLowerCase()] ?? s.toUpperCase(),
    );
    const hasCategory =
      primaryCode === job.category_code ||
      additionalCodes.includes(job.category_code);

    // City check: service_cities array or service_area fallback
    const coversCity =
      providerCoversCity(p.service_cities, job.city_code) ||
      (p.service_area ?? "").toLowerCase().includes(
        (job.city_code ?? "").toLowerCase(),
      );

    return hasCategory && coversCity && p.whatsapp_number;
  });

  if (eligible.length === 0) {
    await supabase
      .from("jobs")
      .update({ state: "no_match", status: "pending" })
      .eq("job_id", jobId);

    if (job.client_whatsapp) {
      const twilioEnv = getTwilioEnv();
      if (twilioEnv) {
        const msgBody = buildWC4(job.job_id, job.address ?? "address on file",
          CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code);
        await sendWhatsApp(twilioEnv, job.client_whatsapp, msgBody);
        logMessage({
          supabaseUrl, serviceRoleKey,
          direction: "outbound", jobId: job.job_id,
          participantWhatsapp: job.client_whatsapp,
          templateName: "WC-4", body: msgBody, status: "sent",
        });
        await supabase.from("conversation_sessions")
          .upsert({
            whatsapp_e164: job.client_whatsapp,
            session_state: "awaiting_no_match_decision",
            current_job_id: job.job_id,
            last_prompt: msgBody,
            last_activity_at: new Date().toISOString(),
          }, { onConflict: "whatsapp_e164" });
      }
    }

    return json({ ok: true, data: { broadcast_count: 0, state: "no_match" } });
  }

  // ── Send WT-2 to each eligible provider ───────────────────────────────────
  const twilioEnv = getTwilioEnv();
  if (!twilioEnv) return err("server_error", "Twilio not configured", 500);

  const publicJobId    = toPublicJobId(job.job_id);
  const address        = job.address ?? "address on file";
  const categoryName   = CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code;
  const timing         = (job.description ?? "").split("\n")[0] || "Contact client for timing";
  const description    = job.description ?? "Details provided by client";

  const broadcastRows: Record<string, unknown>[] = [];
  let sentCount = 0;

  for (const provider of eligible) {
    const msgBody = buildWT2(
      job.job_id, address, categoryName, timing, description, feeDollars,
    );

    const result = await sendWhatsApp(twilioEnv, provider.whatsapp_number, msgBody);

    broadcastRows.push({
      job_id:           job.job_id,
      provider_slug:    provider.slug,
      whatsapp_e164:    provider.whatsapp_number,
      broadcast_sent_at: new Date().toISOString(),
    });

    logMessage({
      supabaseUrl, serviceRoleKey,
      direction: "outbound", jobId: job.job_id,
      participantWhatsapp: provider.whatsapp_number,
      templateName: "WT-2", body: msgBody,
      status: result.ok ? "sent" : "failed",
    });

    // Update provider's conversation session to awaiting_accept
    await supabase.from("conversation_sessions")
      .upsert({
        whatsapp_e164:   provider.whatsapp_number,
        sender_type:     "provider",
        current_job_id:  job.job_id,
        session_state:   "awaiting_accept",
        last_prompt:     msgBody,
        last_activity_at: new Date().toISOString(),
      }, { onConflict: "whatsapp_e164" });

    if (result.ok) sentCount++;
  }

  // Insert broadcast_responses rows
  if (broadcastRows.length > 0) {
    await supabase.from("broadcast_responses").upsert(broadcastRows, {
      onConflict: "job_id,provider_slug",
    });
  }

  // ── Advance job state ─────────────────────────────────────────────────────
  await supabase
    .from("jobs")
    .update({
      state:            "broadcast_sent",
      lead_fee_cents:   baseFee,
      gst_cents:        gst,
      broadcast_sent_at: new Date().toISOString(),
    })
    .eq("job_id", jobId);

  return json({
    ok: true,
    data: {
      job_id:        publicJobId,
      broadcast_count: sentCount,
      eligible_count:  eligible.length,
      state:         "broadcast_sent",
    },
  });
});
