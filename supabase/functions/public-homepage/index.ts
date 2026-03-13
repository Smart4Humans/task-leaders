// TaskLeaders — Edge Function: public-homepage
// Contract: GET /public-homepage?city=vancouver
// Returns populated categories (count > 0) for the given city.

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
  if (req.method === "OPTIONS") return json({ ok: true, data: {} }, 200);
  if (req.method !== "GET") {
    return json(
      {
        ok: false,
        error: { code: "bad_request", message: "Method not allowed", details: { method: req.method } },
      },
      405,
    );
  }

  const url = new URL(req.url);
  const city = (url.searchParams.get("city") || "vancouver").trim().toLowerCase();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return json(
      {
        ok: false,
        error: {
          code: "server_error",
          message: "Missing server configuration",
          details: { missing: [!supabaseUrl ? "SUPABASE_URL" : null, !serviceRoleKey ? "TASKLEADERS_SERVICE_ROLE_KEY" : null].filter(Boolean) },
        },
      },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Resolve city display name (kept minimal for homepage)
  const { data: cityRow, error: cityErr } = await supabase
    .from("cities")
    .select("slug,name")
    .eq("slug", city)
    .maybeSingle();

  if (cityErr) {
    return json({ ok: false, error: { code: "server_error", message: "Failed to load city", details: { supabase: cityErr } } }, 500);
  }
  if (!cityRow) {
    return json({ ok: false, error: { code: "not_found", message: "Unknown city", details: { city } } }, 404);
  }

  const { data: rows, error: rpcErr } = await supabase.rpc("get_homepage_category_supply", { p_city_slug: city });

  if (rpcErr) {
    return json(
      {
        ok: false,
        error: { code: "server_error", message: "Failed to load category supply", details: { supabase: rpcErr } },
      },
      500,
    );
  }

  const categories = (rows || []).map((r: any) => ({
    id: r.category_slug,
    name: r.display_name,
    icon: r.icon,
    count: Number(r.provider_count || 0),
    href: `category.html?city=${encodeURIComponent(city)}&category=${encodeURIComponent(r.category_slug)}`,
  }));

  return json({
    ok: true,
    data: {
      city: { slug: cityRow.slug, name: cityRow.name },
      categories,
      generated_at: new Date().toISOString(),
    },
  });
});
