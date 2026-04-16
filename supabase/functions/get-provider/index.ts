// TaskLeaders — Edge Function: get-provider
// Contract: GET /get-provider?slug=marco-a3x9[&admin_password=...]
// Returns the provider record for the given slug.
// Used by the welcome flow, profile-setup pre-population, and admin profile review.
//
// Deactivation gate:
//   Public callers (no admin_password): suspended=true → 404. Deactivated TaskLeaders
//   cannot access their welcome link or pre-populate the onboarding form.
//   Admin callers (valid admin_password query param): suspended check is skipped so
//   admin profile-review.html can load deactivated providers for review.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "GET, OPTIONS",
    },
  });
}

function error(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} });
  if (req.method !== "GET") {
    return error("bad_request", "Method not allowed", 405);
  }

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const adminPassword  = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD");
  if (!supabaseUrl || !serviceRoleKey) {
    return error("server_error", "Missing server configuration", 500);
  }

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug")?.trim().toLowerCase();

  // Admin callers may pass admin_password to bypass the suspended gate.
  // This allows admin/profile-review.html to view deactivated providers.
  // Public callers (welcome flow, onboarding) never send a password.
  const isAdmin = adminPassword && url.searchParams.get("admin_password") === adminPassword;

  if (!slug) {
    return error("bad_request", "Missing required parameter: slug");
  }

  // Basic slug format validation: lowercase alphanum + hyphens, 4–40 chars
  if (!/^[a-z0-9-]{4,40}$/.test(slug)) {
    return error("not_found", "Provider not found", 404);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data, error: dbError } = await supabase
    .from("provider_accounts")
    .select(
      "slug, status, suspended, first_name, last_name, business_name, email, whatsapp_number, service_area, primary_service, short_description, profile_photo, base_rate, service_rates, created_at, onboarded_at, display_name_type, backup_phone, address_line1, address_line2, city, province, postal_code, service_cities, additional_services, work_photos"
    )
    .eq("slug", slug)
    .single();

  if (dbError || !data) {
    return error("not_found", "Provider not found", 404);
  }

  // Deactivated providers must not access the welcome/onboarding flow.
  // Admin callers (verified above) bypass this check for profile review.
  if (data.suspended === true && !isAdmin) {
    return error("not_found", "Provider not found", 404);
  }

  return json({ ok: true, data });
});
