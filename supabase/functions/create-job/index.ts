// TaskLeaders — Edge Function: create-job
// Contract: POST /create-job
// Body: {
//   city_code, category_code, category_name,
//   source?,        — 'concierge' (default) | 'marketplace'
//   client_id?,     — UUID from concierge_clients (if concierge source)
//   address?,
//   description?,
//   admin_password? — required for admin-created jobs; internal calls use x-internal-secret
// }
//
// On insert:
//   - Generates sequential job ID via generate_job_id() RPC
//   - Sets lead_fee_cents + gst_cents from locked category fee table
//   - Denormalizes client_whatsapp from concierge_clients for fast webhook routing
//   - Sets state = 'intake_confirmed' (ready for dispatch)
//
// Public-facing job ID format: PLM-00001 (city prefix suppressed in all responses).
// Internal DB stores full format: VAN-PLM-00001.

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

function error(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

// Locked category lead fees (flat, in cents). Source: TaskLeaders Guidelines 2026-04-08.
const CATEGORY_LEAD_FEES_CENTS: Record<string, number> = {
  CLN: 1500,
  YRD: 1500,
  HND: 2000,
  MVG: 2500,
  PLT: 4000,
  PLM: 5000,
  ELC: 5000,
  HVC: 6000,
};

const GST_RATE = 0.05;

const VALID_CITY_CODES     = new Set(["VAN", "VIC", "YYC", "YEG", "YYZ", "MTL"]);
const VALID_CATEGORY_CODES = new Set(["PLM", "CLN", "HND", "ELC", "PLT", "HVC", "MVG", "YRD"]);

/** Strips city prefix for public-facing responses: VAN-PLM-00001 → PLM-00001 */
function toPublicJobId(jobId: string): string {
  const parts = jobId.split("-");
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : jobId;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} });
  if (req.method !== "POST") return error("bad_request", "Method not allowed", 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const adminPassword  = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD");
  const cronSecret     = Deno.env.get("INTERNAL_CRON_SECRET");

  if (!supabaseUrl || !serviceRoleKey) {
    return error("server_error", "Missing server configuration", 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("bad_request", "Invalid JSON body");
  }

  // Auth: admin password OR internal secret header
  const internalHeader = req.headers.get("x-internal-secret");
  const isInternal = cronSecret && internalHeader === cronSecret;
  const isAdmin    = adminPassword && String(body.admin_password ?? "") === adminPassword;
  if (!isInternal && !isAdmin) {
    return error("unauthorized", "Admin password or internal secret required", 401);
  }

  const cityCode     = String(body.city_code     ?? "").trim().toUpperCase();
  const categoryCode = String(body.category_code ?? "").trim().toUpperCase();
  const categoryName = String(body.category_name ?? "").trim();
  const source       = String(body.source        ?? "concierge").trim();
  const clientId     = body.client_id   ? String(body.client_id).trim()   : null;
  const address      = body.address     ? String(body.address).trim()     : null;
  const description  = body.description ? String(body.description).trim() : null;

  if (!cityCode)                               return error("validation_error", "city_code is required");
  if (!VALID_CITY_CODES.has(cityCode))         return error("validation_error", `Invalid city_code: ${cityCode}`);
  if (!categoryCode)                           return error("validation_error", "category_code is required");
  if (!VALID_CATEGORY_CODES.has(categoryCode)) return error("validation_error", `Invalid category_code: ${categoryCode}`);
  if (!["concierge", "marketplace"].includes(source)) {
    return error("validation_error", `Invalid source: ${source}. Must be 'concierge' or 'marketplace'.`);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Resolve client_whatsapp for fast webhook routing (concierge only)
  let clientWhatsapp: string | null = null;
  if (clientId && source === "concierge") {
    const { data: clientRecord } = await supabase
      .from("concierge_clients")
      .select("whatsapp")
      .eq("id", clientId)
      .maybeSingle();
    clientWhatsapp = clientRecord?.whatsapp ?? null;
  }

  // Calculate lead fee from locked category table
  const baseFee = CATEGORY_LEAD_FEES_CENTS[categoryCode] ?? 0;
  const gst     = Math.round(baseFee * GST_RATE);
  const total   = baseFee + gst;

  // Generate the next Job ID atomically
  const { data: jobIdData, error: rpcError } = await supabase
    .rpc("generate_job_id", { p_city_code: cityCode, p_category_code: categoryCode });

  if (rpcError || !jobIdData) {
    return error("server_error", "Failed to generate job ID: " + (rpcError?.message ?? "unknown error"), 500);
  }

  const jobId = String(jobIdData);

  // Insert the job record
  const { data: job, error: insertError } = await supabase
    .from("jobs")
    .insert({
      job_id:               jobId,
      city_code:            cityCode,
      category_code:        categoryCode,
      category_name:        categoryName || null,
      status:               "pending",
      state:                "intake_confirmed",
      source,
      client_id:            clientId,
      client_whatsapp:      clientWhatsapp,
      address,
      description,
      lead_fee_cents:       baseFee,
      gst_cents:            gst,
      total_charged_cents:  total,
    })
    .select("*")
    .single();

  if (insertError || !job) {
    return error("server_error", "Failed to create job: " + (insertError?.message ?? "unknown error"), 500);
  }

  // Return with public job ID (city prefix suppressed)
  return json({
    ok: true,
    data: {
      ...job,
      public_job_id: toPublicJobId(job.job_id),
    },
  });
});
