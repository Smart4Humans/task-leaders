// TaskLeaders — Edge Function: job-dispatch
// Contract: POST /job-dispatch
// Broadcasts a confirmed Concierge job to all eligible Concierge TaskLeaders.
//
// ── Eligibility rules (all four must pass) ───────────────────────────────────
// 1. provider_accounts.concierge_eligible = true   (explicit Tier 1 flag)
//    Marketplace-only providers are NEVER included regardless of other criteria.
// 2. provider_accounts.status = 'active' AND suspended = false
// 3. Category participation: provider's primary_service OR any value in
//    additional_services normalizes (via normalizeToCategoryCode) to the
//    job's category_code. Handles slugs, display names, codes, and partials.
// 4. City coverage: providerCoversCity() checks service_cities against known
//    aliases. Falls back to service_area substring check if service_cities
//    is empty. Uses min-5-char alias rule to prevent false positives.
//
// Lead fee: resolved DB-first from category_fee_config, falls back to constants.
//
// Body: { job_id: string, admin_password?: string }
// Also accepts x-internal-secret header for internal calls.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage, buildWT2, buildWC4,
} from "../_shared/twilio.ts";
import {
  CATEGORY_NAMES, normalizeToCategoryCode, providerCoversCity,
  CITY_CODE_TO_NAMES, providerCoversMunicipality,
} from "../_shared/constants.ts";
import { getCategoryLeadFee } from "../_shared/fees.ts";
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

/**
 * Returns true if a provider participates in the required category.
 * Checks primary_service first, then each value in additional_services.
 * Uses normalizeToCategoryCode() to handle all known input formats from
 * the profile form (slugs, display names, codes, mixed case, partials).
 */
function providerHasCategory(
  primaryService: string | null | undefined,
  additionalServices: unknown[] | null | undefined,
  requiredCode: string,
): boolean {
  // Check primary service
  if (primaryService) {
    const code = normalizeToCategoryCode(primaryService);
    if (code === requiredCode) return true;
  }

  // Check additional services
  if (Array.isArray(additionalServices)) {
    for (const svc of additionalServices) {
      if (typeof svc !== "string" || !svc.trim()) continue;
      const code = normalizeToCategoryCode(svc);
      if (code === requiredCode) return true;
    }
  }

  return false;
}

/**
 * Returns true if the provider covers the job city.
 * Primary check: service_cities array via providerCoversCity().
 * Fallback: service_area text field (substring match against city code aliases).
 * A provider with NEITHER populated is excluded — do not assume coverage.
 */
function providerCoversCityWithFallback(
  serviceCities: string[] | null | undefined,
  serviceArea: string | null | undefined,
  cityCode: string,
): boolean {
  // Primary: service_cities array
  if (Array.isArray(serviceCities) && serviceCities.length > 0) {
    return providerCoversCity(serviceCities, cityCode);
  }

  // Fallback: service_area text (only if service_cities is empty/null)
  if (serviceArea) {
    const areaLower   = serviceArea.toLowerCase();
    const aliases     = CITY_CODE_TO_NAMES[cityCode] ?? [];
    // Only match aliases >= 4 chars in fallback text search
    return aliases.some((a) => a.length >= 4 && areaLower.includes(a.toLowerCase()));
  }

  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST")    return err("bad_request", "Method not allowed", 405);

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

  // ── Load job ───────────────────────────────────────────────────────────────
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("job_id, city_code, market_code, municipality_code, category_code, category_name, state, address, description, client_id, client_whatsapp, lead_fee_cents, gst_cents, source")
    .eq("job_id", jobId)
    .single();

  if (jobErr || !job) return err("not_found", "Job not found", 404);
  if (job.source !== "concierge") {
    return err("conflict", "job-dispatch is for Concierge jobs only. Marketplace uses marketplace-connect.", 409);
  }
  if (!["intake_confirmed", "no_match", "pending"].includes(job.state)) {
    return err("conflict", `Job is in state '${job.state}' — cannot broadcast`, 409);
  }

  // ── Resolve lead fee (DB-first) ────────────────────────────────────────────
  const feeBreakdown = await getCategoryLeadFee(supabase, job.category_code);
  const baseFee      = feeBreakdown?.baseFee ?? job.lead_fee_cents ?? 0;
  const gst          = feeBreakdown?.gst     ?? job.gst_cents      ?? 0;
  const feeDollars   = (baseFee / 100).toFixed(2);

  const categoryName = CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code;
  const address      = job.address ?? "address on file";

  // ── Query Concierge-eligible providers ────────────────────────────────────
  // Only concierge_eligible = true providers are fetched.
  // Category and city filtering is applied post-query with full normalization.
  const { data: candidateProviders, error: provErr } = await supabase
    .from("provider_accounts")
    .select("slug, first_name, last_name, whatsapp_number, primary_service, additional_services, service_cities, service_area, municipality_codes")
    .eq("concierge_eligible", true)
    .eq("status", "active")
    .eq("suspended", false)
    .not("whatsapp_number", "is", null);

  if (provErr) return err("server_error", provErr.message, 500);

  // ── Apply eligibility filter ───────────────────────────────────────────────
  //
  // Geography matching — two-tier with full backward compatibility:
  //
  //   Tier 1 (municipality): if the job has a municipality_code (populated from
  //   the client's address), check whether the provider explicitly covers that
  //   municipality via municipality_codes[] (structured) or service_cities[]
  //   alias matching (free-text compat). A match at this tier is sufficient.
  //
  //   Tier 2 (market fallback): if Tier 1 didn't match — OR if the job has no
  //   municipality_code (all pre-refactor jobs) — fall back to the existing
  //   market-level city_code / service_cities alias logic. This ensures:
  //     • Existing jobs are unaffected (no municipality_code → pure market match)
  //     • Broad-coverage providers (e.g. "Metro Vancouver") always match within VAN
  //     • No provider that previously matched is excluded during transition
  //
  // Long-term: once provider profiles carry municipality_codes[], and all jobs
  // have municipality_code from address parsing, the market fallback can be
  // restricted or removed — but that is a separate, later migration.
  const marketCode = String(job.market_code ?? job.city_code ?? "");

  const eligible = (candidateProviders ?? []).filter((p) => {
    const hasCategory = providerHasCategory(
      p.primary_service,
      p.additional_services,
      job.category_code,
    );
    if (!hasCategory) return false;

    // Tier 1: municipality match (only possible when job has municipality_code)
    if (job.municipality_code) {
      const munMatch = providerCoversMunicipality(
        p.municipality_codes,
        p.service_cities,
        job.municipality_code,
      );
      if (munMatch) return true;
    }

    // Tier 2: market-level fallback (existing logic — always evaluated)
    return providerCoversCityWithFallback(
      p.service_cities,
      p.service_area,
      marketCode,
    );
  });

  // ── No-match path ─────────────────────────────────────────────────────────
  if (eligible.length === 0) {
    await supabase.from("jobs")
      .update({ state: "no_match", status: "pending" })
      .eq("job_id", jobId);

    if (job.client_whatsapp) {
      const twilioEnv = getTwilioEnv();
      if (twilioEnv) {
        const msgBody = buildWC4(job.job_id, address, categoryName);
        await sendWhatsApp(twilioEnv, job.client_whatsapp, msgBody);
        logMessage({
          supabaseUrl, serviceRoleKey, direction: "outbound",
          jobId: job.job_id, participantWhatsapp: job.client_whatsapp,
          templateName: "WC-4", body: msgBody, status: "sent",
        });
        await supabase.from("conversation_sessions").upsert({
          whatsapp_e164:   job.client_whatsapp,
          session_state:   "awaiting_no_match_decision",
          current_job_id:  job.job_id,
          last_prompt:     msgBody,
          last_activity_at: new Date().toISOString(),
        }, { onConflict: "whatsapp_e164" });
      }
    }

    // Admin alert so operator knows a no-match occurred
    await supabase.from("admin_alerts").insert({
      alert_type:  "no_match",
      priority:    "normal",
      job_id:      job.job_id,
      description: `No eligible Concierge providers for ${categoryName} in ${job.city_code}.`,
      status:      "open",
    });

    return json({ ok: true, data: { broadcast_count: 0, state: "no_match" } });
  }

  // ── Send WT-2 to each eligible provider ───────────────────────────────────
  const twilioEnv = getTwilioEnv();
  if (!twilioEnv) return err("server_error", "Twilio not configured", 500);

  const timing     = job.description
    ? job.description.split("\n")[0].substring(0, 100)
    : "Contact client for timing";
  const desc       = job.description ?? "Details provided by client";

  const broadcastRows: Record<string, unknown>[] = [];
  let sentCount = 0;

  for (const provider of eligible) {
    const msgBody = buildWT2(
      job.job_id, address, categoryName, timing, desc, feeDollars,
    );

    const result = await sendWhatsApp(twilioEnv, provider.whatsapp_number, msgBody);

    broadcastRows.push({
      job_id:            job.job_id,
      provider_slug:     provider.slug,
      whatsapp_e164:     provider.whatsapp_number,
      broadcast_sent_at: new Date().toISOString(),
    });

    logMessage({
      supabaseUrl, serviceRoleKey, direction: "outbound",
      jobId: job.job_id, participantWhatsapp: provider.whatsapp_number,
      templateName: "WT-2", body: msgBody,
      status: result.ok ? "sent" : "failed",
    });

    // Provider session: awaiting_accept for this job
    await supabase.from("conversation_sessions").upsert({
      whatsapp_e164:   provider.whatsapp_number,
      sender_type:     "provider",
      session_state:   "awaiting_accept",
      current_job_id:  job.job_id,
      last_prompt:     msgBody,
      last_activity_at: new Date().toISOString(),
    }, { onConflict: "whatsapp_e164" });

    if (result.ok) sentCount++;
  }

  // Upsert broadcast_responses (idempotent re-dispatch safe)
  if (broadcastRows.length > 0) {
    await supabase.from("broadcast_responses")
      .upsert(broadcastRows, { onConflict: "job_id,provider_slug" });
  }

  // Advance job state
  await supabase.from("jobs").update({
    state:             "broadcast_sent",
    lead_fee_cents:    baseFee,
    gst_cents:         gst,
    broadcast_sent_at: new Date().toISOString(),
  }).eq("job_id", jobId);

  return json({
    ok: true,
    data: {
      job_id:          toPublicJobId(job.job_id),
      broadcast_count: sentCount,
      eligible_count:  eligible.length,
      state:           "broadcast_sent",
    },
  });
});
