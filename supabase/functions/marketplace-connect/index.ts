// TaskLeaders — Edge Function: marketplace-connect
// Contract: POST /marketplace-connect
// Handles the Connect form submission from a public TaskLeader profile page.
//
// Flow:
//   1. Client submits Connect form (name, WhatsApp, description, provider, city)
//   2. Validate provider is active in marketplace
//   3. Create a job record (source = 'marketplace')
//   4. Send MKT-1 WhatsApp notification to the targeted provider
//   5. Set 24-hour response deadline on job
//   6. Create conversation_sessions entry for provider (awaiting_accept)
//   7. Optionally log a lead_event
//   8. Return job reference and confirmation to caller
//
// The provider then replies ACCEPT or DECLINE via the standard twilio-webhook.
// ACCEPT → no payment path; job goes straight to thread_live via stripe-webhook bypass.
// DECLINE or no-response → client notified; job closed.
//
// ROUTING NOTE: All communication routes through the TaskLeaders number.
// No direct number exchange. Routed thread model applies to Marketplace.
//
// Body: {
//   provider_slug: string,
//   city:          string,        // city slug from profile URL
//   client_name:   string,
//   client_whatsapp: string,      // E.164 required for routed thread
//   description:   string,
//   consent:       boolean        // client has accepted Terms
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage, buildMKT1, buildWC2,
} from "../_shared/twilio.ts";
import {
  CATEGORY_NAMES, SLUG_TO_CATEGORY_CODE, VALID_CITY_CODES,
  MARKETPLACE_RESPONSE_TIMEOUT_HOURS,
  MUNICIPALITY_NAMES,
  extractMunicipalityFromAddress,
} from "../_shared/constants.ts";
import { getCategoryLeadFee } from "../_shared/fees.ts";
import { toPublicJobId } from "../_shared/job-ids.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}
function err(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

// City slug → city code (reverse of city_slug used in profile URLs)
const CITY_SLUG_TO_CODE: Record<string, string> = {
  "vancouver": "VAN",
  "victoria":  "VIC",
  "calgary":   "YYC",
  "edmonton":  "YEG",
  "toronto":   "YYZ",
  "montreal":  "MTL",
};

Deno.serve(async (req) => {
  // ── Diagnostic stage tracker ──────────────────────────────────────────────
  // Updated as the handler progresses through each section. On unhandled throw
  // the top-level catch returns this label in the user-visible error so we can
  // pinpoint the failing section without exposing exception internals. The full
  // exception goes only to console.error (Supabase function logs).
  // The label namespace is closed and operator-controlled — never reveals data.
  let stage = "init";

  try {
    stage = "options";
    if (req.method === "OPTIONS") return json({ ok: true });
    if (req.method !== "POST") return err("bad_request", "Method not allowed", 405);

    stage = "env";
    const supabaseUrl    = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return err("server_error", "Missing server configuration", 500);
    }

    stage = "parse_body";
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return err("bad_request", "Invalid JSON body");
    }

    stage = "validate_inputs";
    const providerSlug    = String(body.provider_slug   ?? "").trim().toLowerCase();
    const citySlug        = String(body.city            ?? "").trim().toLowerCase();
    const clientName      = String(body.client_name     ?? "").trim();
    const clientWhatsapp  = String(body.client_whatsapp ?? "").trim();
    const description     = String(body.description     ?? "").trim();
    const consent         = body.consent === true;

    if (!providerSlug)   return err("validation_error", "provider_slug is required");
    if (!citySlug)       return err("validation_error", "city is required");
    if (!clientName)     return err("validation_error", "client_name is required");
    if (!clientWhatsapp) return err("validation_error", "client_whatsapp is required");
    if (!description)    return err("validation_error", "description is required");
    if (!consent)        return err("validation_error", "Client consent is required");

    stage = "validate_municipality";
    const municipalityCode = String(body.municipality_code ?? "").trim().toUpperCase();
    if (!municipalityCode) {
      return err("validation_error", "municipality_code is required");
    }
    const municipalityName = MUNICIPALITY_NAMES[municipalityCode];
    if (!municipalityName) {
      return err("validation_error", `Unknown municipality_code: ${municipalityCode}`);
    }

    stage = "normalize_whatsapp";
    // Strict normalization to canonical +E.164. The previous logic preserved
    // user input verbatim for any shape other than exactly-10-digits, which
    // produced unroutable rows when the user typed e.g. "16045517633" with no
    // leading + (observed live on VAN-HVC-00024). We now strip all non-digit
    // characters first, then apply NANP (10/11-digit) and generic international
    // (8-15 digit) rules. Anything else is rejected at submission so no
    // malformed phone strings ever reach jobs / conversation_sessions /
    // job_participants.
    const digits = clientWhatsapp.replace(/\D/g, "");
    let normalizedWhatsapp: string;
    if (digits.length === 10) {
      normalizedWhatsapp = `+1${digits}`;                          // NANP, no country code (e.g. "6045517633" or "(604) 551-7633")
    } else if (digits.length === 11 && digits.startsWith("1")) {
      normalizedWhatsapp = `+${digits}`;                           // NANP with country code (e.g. "16045517633" or "+1 604-551-7633")
    } else if (digits.length >= 8 && digits.length <= 15) {
      normalizedWhatsapp = `+${digits}`;                           // Generic international fallback
    } else {
      return err(
        "validation_error",
        "Please enter a valid WhatsApp number (e.g. +1 604 555 1234).",
      );
    }

    stage = "city_code";
    const cityCode = CITY_SLUG_TO_CODE[citySlug];
    if (!cityCode) return err("validation_error", `Unknown city: ${citySlug}`);

    stage = "supabase_client";
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    stage = "load_provider";
    const { data: provider, error: provErr } = await supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, business_name, display_name_type, status, suspended, whatsapp_number, primary_service, service_cities, service_area, municipality_codes")
      .eq("slug", providerSlug)
      .single();

    if (provErr || !provider) return err("not_found", "Provider not found", 404);
    if (provider.status !== "active") return err("conflict", "Provider is not currently active", 409);
    if (provider.suspended)           return err("conflict", "Provider is not available", 409);
    if (!provider.whatsapp_number)    return err("conflict", "Provider cannot receive requests at this time", 409);

    stage = "validate_provider_coverage";
    // Provider-coverage gate (P2). The submitted municipality_code has already
    // been validated against the global registry above; here we additionally
    // verify the selected provider actually serves that municipality. Source
    // priority mirrors the frontend dropdown's buildMunicipalityDropdown:
    //   1. provider.municipality_codes (canonical, populated post-backfill)
    //   2. provider.service_cities[] aliased via extractMunicipalityFromAddress
    //   3. last-resort fallback: allow all 18 (mirrors Concierge dispatch's
    //      legacy behavior for providers with no coverage data at all)
    {
      const providerCodes = Array.isArray(provider.municipality_codes)
        ? provider.municipality_codes
        : [];
      let coverage: Set<string>;
      if (providerCodes.length > 0) {
        coverage = new Set(providerCodes);
      } else {
        const cities = Array.isArray(provider.service_cities) ? provider.service_cities : [];
        const aliased = new Set<string>();
        for (const city of cities) {
          const hit = extractMunicipalityFromAddress(String(city ?? ""));
          if (hit) aliased.add(hit.code);
        }
        coverage = aliased.size > 0
          ? aliased
          : new Set(Object.keys(MUNICIPALITY_NAMES));
      }

      if (!coverage.has(municipalityCode)) {
        const providerDisplay = (provider.display_name_type === "business" && provider.business_name)
          ? String(provider.business_name).trim()
          : `${provider.first_name ?? ""} ${provider.last_name ?? ""}`.trim() || "This TaskLeader";
        return err(
          "validation_error",
          `${providerDisplay} doesn't currently serve ${municipalityName}. Please choose another service area.`,
        );
      }
    }

    stage = "resolve_category";
    const primarySlug  = (provider.primary_service ?? "").toLowerCase().trim();
    const categoryCode = SLUG_TO_CATEGORY_CODE[primarySlug] ?? null;
    const categoryName = categoryCode ? (CATEGORY_NAMES[categoryCode] ?? provider.primary_service) : (provider.primary_service ?? "General");

    stage = "generate_job_id";
    const { data: jobIdData, error: rpcError } = await supabase
      .rpc("generate_job_id", {
        p_city_code:     cityCode,
        p_category_code: categoryCode ?? "HND",
      });

    if (rpcError || !jobIdData) {
      return err("server_error", "Failed to generate job ID", 500);
    }

    const jobId       = String(jobIdData);
    const publicJobId = toPublicJobId(jobId);

    const notifiedAt  = new Date();
    const deadlineAt  = new Date(notifiedAt.getTime() + MARKETPLACE_RESPONSE_TIMEOUT_HOURS * 60 * 60 * 1000);

    stage = "insert_job";
    const { data: job, error: jobErr } = await supabase
      .from("jobs")
      .insert({
        job_id:                            jobId,
        city_code:                         cityCode,
        market_code:                       cityCode,
        category_code:                     categoryCode ?? "HND",
        category_name:                     categoryName,
        status:                            "pending",
        state:                             "sent_to_provider",
        source:                            "marketplace",
        client_whatsapp:                   normalizedWhatsapp,
        address:                           null,
        description,
        municipality_code:                 municipalityCode,
        municipality_name:                 municipalityName,
        marketplace_provider_slug:         providerSlug,
        marketplace_notified_at:           notifiedAt.toISOString(),
        marketplace_response_deadline_at:  deadlineAt.toISOString(),
        lead_fee_cents:                    0,
        gst_cents:                         0,
        total_charged_cents:               0,
      })
      .select("job_id, state")
      .single();

    if (jobErr || !job) {
      return err("server_error", "Failed to create job", 500);
    }

    stage = "twilio_env";
    const twilioEnv = getTwilioEnv();
    if (!twilioEnv) {
      return err("server_error", "Twilio not configured", 500);
    }

    stage = "send_mkt1";
    const address    = "address TBD";
    const msgBody    = buildMKT1(jobId, address, clientName, categoryName, description);
    const sendResult = await sendWhatsApp(twilioEnv, provider.whatsapp_number, msgBody);

    stage = "log_mkt1";
    logMessage({
      supabaseUrl, serviceRoleKey,
      direction:           "outbound",
      jobId:               job.job_id,
      participantWhatsapp: provider.whatsapp_number,
      messageSid:          sendResult.messageSid,
      templateName:        "MKT-1",
      body:                msgBody,
      status:              sendResult.ok ? "sent" : "failed",
    });

    // ── MKT-1 dispatch failure path: cancel the draft job, alert ops, return error.
    // Strict success contract: ok:true is only emitted after the provider has been
    // successfully notified. If Twilio rejected the send, we mark the just-created
    // job cancelled and return a 502 so the frontend shows a real error rather
    // than a misleading green confirmation.
    if (!sendResult.ok) {
      stage = "mkt1_failure_cleanup";
      await supabase.from("jobs")
        .update({ state: "cancelled", status: "completed" })
        .eq("job_id", job.job_id);
      await supabase.from("admin_alerts").insert({
        alert_type:    "escalation",
        priority:      "high",
        job_id:        job.job_id,
        provider_slug: providerSlug,
        description:   `MKT-1 send failed: ${sendResult.error}`,
        status:        "open",
      });
      return err(
        "provider_notify_failed",
        "We couldn't notify your TaskLeader right now. Please try again in a moment.",
        502,
      );
    }

    // Recipient-only events: neither participant has WhatsApp-inbounded at this
    // point. The provider is being notified for the first time via MKT-1; the
    // client only submitted the public HTTP form. Do not stamp last_activity_at
    // on either upsert — that field must reflect inbound participant activity
    // only, so the 24-hour-window heuristic stays meaningful.
    stage = "upsert_provider_session";
    await supabase.from("conversation_sessions")
      .upsert({
        whatsapp_e164:   provider.whatsapp_number,
        sender_type:     "provider",
        session_state:   "awaiting_accept",
        current_job_id:  job.job_id,
        last_prompt:     msgBody,
      }, { onConflict: "whatsapp_e164" });

    stage = "upsert_client_session";
    await supabase.from("conversation_sessions")
      .upsert({
        whatsapp_e164:   normalizedWhatsapp,
        sender_type:     "client",
        session_state:   "idle",
        current_job_id:  job.job_id,
      }, { onConflict: "whatsapp_e164" });

    stage = "log_lead_event";
    // Fire-and-forget — not critical path. The .catch shields against the rare
    // case where supabase-js's builder doesn't expose .catch the way we expect;
    // we wrap in a try just to be safe.
    try {
      supabase.from("lead_events").insert({
        event_type:      "connect_submit_attempted",
        source:          "marketplace",
        page:            "profile.html",
        session_id:      `mktsub-${job.job_id}`,
        city_slug:       citySlug,
        category_slug:   CATEGORY_CODE_TO_SLUG[categoryCode ?? "HND"] ?? "handyman",
        provider_slug:   providerSlug,
        consent_checked: true,
        handoff_channel: "whatsapp",
        handoff_mode:    "routed",
      }).catch(() => {});
    } catch { /* non-fatal: lead_events log must not break the response */ }

    stage = "build_response";
    return json({
      ok: true,
      data: {
        job_id:        publicJobId,
        provider_slug: providerSlug,
        category:      categoryName,
        status:        "sent_to_provider",
        message:       "Your request has been sent. We'll follow up once the TaskLeader responds.",
        response_deadline_at: deadlineAt.toISOString(),
      },
    });
  } catch (e) {
    // Top-level catch: prevents Supabase's CORS-less generic 500 fallback by
    // routing every uncaught throw through err()/json() so the response always
    // carries access-control-allow-origin. The full exception is logged to
    // Supabase function logs (console.error) for operator inspection. The
    // user-facing message exposes only the closed-namespace stage label —
    // never raw exception details.
    const label = (e instanceof Error) ? `${e.name}: ${e.message}` : String(e);
    console.error(`marketplace-connect FATAL @ stage=${stage}:`, label, e);
    return err(
      "internal_error",
      `Internal error at stage: ${stage}. Please try again in a moment.`,
      500,
    );
  }
});

// Re-import for lead_event logging (not exported from constants.ts directly)
const CATEGORY_CODE_TO_SLUG: Record<string, string> = {
  PLM: "plumbing", CLN: "cleaning", HND: "handyman", ELC: "electrical",
  PLT: "painting", HVC: "hvac",     MVG: "moving",   YRD: "yard-work",
};
