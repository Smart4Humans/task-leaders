// TaskLeaders — Edge Function: get-provider
// Contract: GET /get-provider?slug=marco-a3x9
// Returns the provider record for the given slug.
// Used by the welcome flow and profile-setup pre-population.
// Only returns non-sensitive fields (no internal IDs beyond what's needed).

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return error("server_error", "Missing server configuration", 500);
  }

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug")?.trim().toLowerCase();

  if (!slug) {
    return error("bad_request", "Missing required parameter: slug");
  }

  // Basic slug format validation: lowercase alphanum + hyphens, 4–40 chars
  if (!/^[a-z0-9-]{4,40}$/.test(slug)) {
    return error("not_found", "Provider not found", 404);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data, error: dbError } = await supabase
    .from("providers")
    .select(
      "slug, status, first_name, last_name, business_name, email, whatsapp_number, service_area, primary_service, short_description, profile_photo, base_rate"
    )
    .eq("slug", slug)
    .single();

  if (dbError || !data) {
    return error("not_found", "Provider not found", 404);
  }

  return json({ ok: true, data });
});
