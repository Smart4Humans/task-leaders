// TaskLeaders — Edge Function: get-provider-private
// Contract: GET /get-provider-private?slug=xxx
//
// Returns all provider_accounts fields needed to pre-fill the private
// management page (provider-profile.html). Distinct from get-provider,
// which returns only public-facing fields for the public profile display.
//
// Auth: slug = identity. The slug is the private key shared via MagicLink
// or WT-7 WhatsApp link. Page is noindex. Consistent with complete-onboarding.
//
// Does NOT return: stripe_customer_id, stripe_payment_method_id, risk_flags,
// suspended. Returns card_on_file boolean only.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Missing server configuration" }, 500);
  }

  const slug = new URL(req.url).searchParams.get("slug")?.trim().toLowerCase() ?? "";
  if (!slug) return json({ ok: false, error: "slug is required" }, 400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase
    .from("provider_accounts")
    .select(`
      slug,
      status,
      first_name,
      last_name,
      business_name,
      display_name_type,
      email,
      whatsapp_number,
      backup_phone,
      address_line1,
      address_line2,
      city,
      province,
      postal_code,
      service_area,
      service_cities,
      primary_service,
      base_rate,
      additional_services,
      service_rates,
      short_description,
      profile_photo,
      work_photos,
      card_on_file,
      concierge_eligible
    `)
    .eq("slug", slug)
    .single();

  if (error || !data) {
    return json({ ok: false, error: "Provider not found" }, 404);
  }

  return json({ ok: true, data });
});
