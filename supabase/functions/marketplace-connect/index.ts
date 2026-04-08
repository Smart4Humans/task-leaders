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
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return err("bad_request", "Method not allowed", 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return err("server_error", "Missing server configuration", 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", "Invalid JSON body");
  }

  // ── Validate required fields ───────────────────────────────────────────────
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

  // Normalize client WhatsApp to E.164 (add +1 if North American and no country code)
  const normalizedWhatsapp = clientWhatsapp.startsWith("+")
    ? clientWhatsapp
    : clientWhatsapp.replace(/\D/g, "").length === 10
      ? `+1${clientWhatsapp.replace(/\D/g, "")}`
      : clientWhatsapp;

  const cityCode = CITY_SLUG_TO_CODE[citySlug];
  if (!cityCode) return err("validation_error", `Unknown city: ${citySlug}`);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Load provider ──────────────────────────────────────────────────────────
  const { data: provider, error: provErr } = await supabase
    .from("provider_accounts")
    .select("slug, first_name, last_name, business_name, display_name_type, status, suspended, whatsapp_number, primary_service, service_cities, service_area")
    .eq("slug", providerSlug)
    .single();

  if (provErr || !provider) return err("not_found", "Provider not found", 404);
  if (provider.status !== "active") return err("conflict", "Provider is not currently active", 409);
  if (provider.suspended)           return err("conflict", "Provider is not available", 409);
  if (!provider.whatsapp_number)    return err("conflict", "Provider cannot receive requests at this time", 409);

  // ── Resolve category ───────────────────────────────────────────────────────
  const primarySlug  = (provider.primary_service ?? "").toLowerCase().trim();
  const categoryCode = SLUG_TO_CATEGORY_CODE[primarySlug] ?? null;
  const categoryName = categoryCode ? (CATEGORY_NAMES[categoryCode] ?? provider.primary_service) : (provider.primary_service ?? "General");

  // ── Generate job ID ────────────────────────────────────────────────────────
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

  // ── Set response deadline (24 hours) ──────────────────────────────────────
  const notifiedAt  = new Date();
  const deadlineAt  = new Date(notifiedAt.getTime() + MARKETPLACE_RESPONSE_TIMEOUT_HOURS * 60 * 60 * 1000);

  // ── Create job record ──────────────────────────────────────────────────────
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      job_id:                            jobId,
      city_code:                         cityCode,
      category_code:                     categoryCode ?? "HND",
      category_name:                     categoryName,
      status:                            "pending",
      state:                             "sent_to_provider",
      source:                            "marketplace",
      client_whatsapp:                   normalizedWhatsapp,
      address:                           null, // not collected on Connect form; collected in thread
      description,
      marketplace_provider_slug:         providerSlug,
      marketplace_notified_at:           notifiedAt.toISOString(),
      marketplace_response_deadline_at:  deadlineAt.toISOString(),
      // Marketplace jobs do not have a lead fee in Phase 3
      lead_fee_cents:                    0,
      gst_cents:                         0,
      total_charged_cents:               0,
    })
    .select("job_id, state")
    .single();

  if (jobErr || !job) {
    return err("server_error", "Failed to create job", 500);
  }

  // ── Send MKT-1 to provider ─────────────────────────────────────────────────
  const twilioEnv = getTwilioEnv();
  if (!twilioEnv) {
    return err("server_error", "Twilio not configured", 500);
  }

  const address     = "address TBD";  // collected during thread; placeholder for header
  const msgBody     = buildMKT1(jobId, address, clientName, categoryName, description);
  const sendResult  = await sendWhatsApp(twilioEnv, provider.whatsapp_number, msgBody);

  logMessage({
    supabaseUrl, serviceRoleKey,
    direction:           "outbound",
    jobId:               job.job_id,
    participantWhatsapp: provider.whatsapp_number,
    templateName:        "MKT-1",
    body:                msgBody,
    status:              sendResult.ok ? "sent" : "failed",
  });

  if (!sendResult.ok) {
    // Log failure but don't block — job is created, admin can follow up
    await supabase.from("admin_alerts").insert({
      alert_type:   "escalation",
      priority:     "high",
      job_id:       job.job_id,
      provider_slug: providerSlug,
      description:  `MKT-1 send failed: ${sendResult.error}`,
      status:       "open",
    });
  }

  // ── Update provider's conversation session ─────────────────────────────────
  await supabase.from("conversation_sessions")
    .upsert({
      whatsapp_e164:   provider.whatsapp_number,
      sender_type:     "provider",
      session_state:   "awaiting_accept",
      current_job_id:  job.job_id,
      last_prompt:     msgBody,
      last_activity_at: new Date().toISOString(),
    }, { onConflict: "whatsapp_e164" });

  // ── Add client to conversation_sessions (idle — waiting for thread) ────────
  await supabase.from("conversation_sessions")
    .upsert({
      whatsapp_e164:   normalizedWhatsapp,
      sender_type:     "client",
      session_state:   "idle",
      current_job_id:  job.job_id,
      last_activity_at: new Date().toISOString(),
    }, { onConflict: "whatsapp_e164" });

  // ── Log lead_event ─────────────────────────────────────────────────────────
  // Fire-and-forget — not critical path
  supabase.from("lead_events").insert({
    event_type:     "connect_submit_attempted",
    source:         "marketplace",
    page:           "profile.html",
    session_id:     `mktsub-${job.job_id}`,
    city_slug:      citySlug,
    category_slug:  CATEGORY_CODE_TO_SLUG[categoryCode ?? "HND"] ?? "handyman",
    provider_slug:  providerSlug,
    consent_checked: true,
    handoff_channel: "whatsapp",
    handoff_mode:   "routed",
  }).catch(() => {});

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
});

// Re-import for lead_event logging (not exported from constants.ts directly)
const CATEGORY_CODE_TO_SLUG: Record<string, string> = {
  PLM: "plumbing", CLN: "cleaning", HND: "handyman", ELC: "electrical",
  PLT: "painting", HVC: "hvac",     MVG: "moving",   YRD: "yard-work",
};
