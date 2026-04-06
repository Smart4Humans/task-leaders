// TaskLeaders — Edge Function: create-job
// Contract: POST /create-job
// Body: { city_code, category_code, category_name, client_id?, address?, description? }
// Calls generate_job_id() to get the next sequential ID, inserts into jobs, returns full record.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function error(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

const VALID_CITY_CODES     = new Set(["VAN", "VIC", "YYC", "YEG", "YYZ", "MTL"]);
const VALID_CATEGORY_CODES = new Set(["PLM", "CLN", "HND", "ELC", "PLT", "HVC", "MVG", "YRD"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} });
  if (req.method !== "POST") return error("bad_request", "Method not allowed", 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return error("server_error", "Missing server configuration", 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("bad_request", "Invalid JSON body");
  }

  const cityCode     = String(body.city_code     ?? "").trim().toUpperCase();
  const categoryCode = String(body.category_code ?? "").trim().toUpperCase();
  const categoryName = String(body.category_name ?? "").trim();
  const clientId     = body.client_id ? String(body.client_id).trim() : null;
  const address      = body.address   ? String(body.address).trim()   : null;
  const description  = body.description ? String(body.description).trim() : null;

  if (!cityCode)                          return error("validation_error", "city_code is required");
  if (!VALID_CITY_CODES.has(cityCode))    return error("validation_error", `Invalid city_code: ${cityCode}`);
  if (!categoryCode)                      return error("validation_error", "category_code is required");
  if (!VALID_CATEGORY_CODES.has(categoryCode)) return error("validation_error", `Invalid category_code: ${categoryCode}`);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

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
      job_id:        jobId,
      city_code:     cityCode,
      category_code: categoryCode,
      category_name: categoryName || null,
      status:        "pending",
      client_id:     clientId,
      address,
      description,
    })
    .select("*")
    .single();

  if (insertError || !job) {
    return error("server_error", "Failed to create job: " + (insertError?.message ?? "unknown error"), 500);
  }

  return json({ ok: true, data: job });
});
