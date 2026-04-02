// TaskLeaders — Edge Function: complete-onboarding
// Contract: POST /complete-onboarding
// Body: { slug: string, ...profile fields }
// Updates the providers record with profile setup data, sets status → active, timestamps onboarded_at.
// Called on profile-setup form submission when a slug is present in the URL.

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

function cleanString(v: unknown): string {
  return String(v ?? "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} });
  if (req.method !== "POST") {
    return error("bad_request", "Method not allowed", 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
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

  const slug = cleanString(body.slug).toLowerCase();
  if (!slug) {
    return error("bad_request", "Missing required field: slug");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Verify the provider exists and is in the right state
  const { data: existing, error: fetchError } = await supabase
    .from("providers")
    .select("id, status")
    .eq("slug", slug)
    .single();

  if (fetchError || !existing) {
    return error("not_found", "Provider not found", 404);
  }

  // Build the update payload — only include non-empty overrides
  const updates: Record<string, unknown> = {
    status: "active",
    onboarded_at: new Date().toISOString(),
  };

  if (cleanString(body.firstName))    updates.first_name = cleanString(body.firstName);
  if (cleanString(body.lastName))     updates.last_name  = cleanString(body.lastName);
  if (cleanString(body.businessName)) updates.business_name = cleanString(body.businessName);
  if (cleanString(body.email))        updates.email = cleanString(body.email).toLowerCase();
  if (cleanString(body.whatsapp))     updates.whatsapp_number = cleanString(body.whatsapp);
  if (cleanString(body.baseCity))     updates.service_area = cleanString(body.baseCity);
  if (cleanString(body.primaryService)) updates.primary_service = cleanString(body.primaryService);
  if (cleanString(body.bio))          updates.short_description = cleanString(body.bio);
  if (cleanString(body.hourlyRate))   updates.base_rate = cleanString(body.hourlyRate);
  if (cleanString(body.profilePhoto)) updates.profile_photo = cleanString(body.profilePhoto);

  const { error: updateError } = await supabase
    .from("providers")
    .update(updates)
    .eq("slug", slug);

  if (updateError) {
    return error("server_error", updateError.message, 500);
  }

  return json({ ok: true, data: { slug, status: "active" } });
});
