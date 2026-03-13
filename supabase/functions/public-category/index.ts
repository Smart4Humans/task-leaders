// TaskLeaders — Edge Function: public-category
// Contract: GET /public-category?city=vancouver&category=handyman
// Returns approved + active providers for a given city + category.

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
  const category = (url.searchParams.get("category") || "handyman").trim().toLowerCase();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return json(
      {
        ok: false,
        error: {
          code: "server_error",
          message: "Missing server configuration",
          details: {
            missing: [!supabaseUrl ? "SUPABASE_URL" : null, !serviceRoleKey ? "TASKLEADERS_SERVICE_ROLE_KEY" : null].filter(Boolean),
          },
        },
      },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Resolve city + category (minimal display payload)
  const { data: cityRow, error: cityErr } = await supabase
    .from("cities")
    .select("slug,name,is_active")
    .eq("slug", city)
    .maybeSingle();

  if (cityErr) {
    return json({ ok: false, error: { code: "server_error", message: "Failed to load city", details: { supabase: cityErr } } }, 500);
  }
  if (!cityRow || cityRow.is_active !== true) {
    return json({ ok: false, error: { code: "not_found", message: "Unknown city", details: { city } } }, 404);
  }

  const { data: categoryRow, error: categoryErr } = await supabase
    .from("categories")
    .select("slug,display_name,icon,is_active")
    .eq("slug", category)
    .maybeSingle();

  if (categoryErr) {
    return json({ ok: false, error: { code: "server_error", message: "Failed to load category", details: { supabase: categoryErr } } }, 500);
  }
  if (!categoryRow || categoryRow.is_active !== true) {
    return json({ ok: false, error: { code: "not_found", message: "Unknown category", details: { category } } }, 404);
  }

  const { data: rows, error: rpcErr } = await supabase.rpc("get_public_category_providers", {
    p_city_slug: city,
    p_category_slug: category,
  });

  if (rpcErr) {
    return json(
      {
        ok: false,
        error: { code: "server_error", message: "Failed to load providers", details: { supabase: rpcErr } },
      },
      500,
    );
  }

  const providers = (rows || []).map((r: any) => ({
    provider_slug: r.provider_slug,
    display_name: r.display_name,
    response_time_minutes: r.response_time_minutes === null ? null : Number(r.response_time_minutes),
    reliability_percent: r.reliability_percent === null ? null : Number(r.reliability_percent),
    hourly_rate_cents: r.hourly_rate_cents === null ? null : Number(r.hourly_rate_cents),
    currency: r.currency,
    rank: r.rank === null ? null : Number(r.rank),
    is_featured: Boolean(r.is_featured),
  }));

  return json({
    ok: true,
    data: {
      city: { slug: cityRow.slug, name: cityRow.name },
      category: { slug: categoryRow.slug, name: categoryRow.display_name, icon: categoryRow.icon },
      providers,
      generated_at: new Date().toISOString(),
    },
  });
});
