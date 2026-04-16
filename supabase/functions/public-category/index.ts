// TaskLeaders — Edge Function: public-category
// Contract: GET /public-category?city=vancouver&category=handyman
// Returns approved + active providers for a given city + category.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Hardcoded category metadata — no DB categories table lookup required.
// Add new categories here to enable them; existing DB rows are not needed.
const CATEGORY_META: Record<string, { display_name: string; icon: string }> = {
  handyman:    { display_name: "Handyman",          icon: "🔧" },
  cleaning:    { display_name: "Cleaning",           icon: "🧹" },
  painting:    { display_name: "Painting",           icon: "🖌️" },
  electrical:  { display_name: "Electrical",         icon: "⚡" },
  plumbing:    { display_name: "Plumbing",           icon: "🔧" },
  "yard-work": { display_name: "Yard Work",          icon: "🌿" },
  hvac:        { display_name: "HVAC",               icon: "❄️" },
  moving:      { display_name: "Moving / Transport", icon: "📦" },
};

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
    .select("id,slug,name,is_active")
    .eq("slug", city)
    .maybeSingle();

  if (cityErr) {
    return json({ ok: false, error: { code: "server_error", message: "Failed to load city", details: { supabase: cityErr } } }, 500);
  }
  if (!cityRow || cityRow.is_active !== true) {
    return json({ ok: false, error: { code: "not_found", message: "Unknown city", details: { city } } }, 404);
  }

  const categoryMeta = CATEGORY_META[category];
  if (!categoryMeta) {
    return json({ ok: false, error: { code: "not_found", message: "Unknown category", details: { category } } }, 404);
  }

  // ── IDENTICAL FILTER LOGIC TO public-homepage ────────────────────────────
  // Query provider_accounts WHERE status='active' AND suspended=false.
  // suspended=false is the deactivation gate — deactivate() never changes status,
  // so status='active' alone is not sufficient. Both filters must be kept in sync
  // with public-homepage. Do not add other filters without updating both functions.
  const [accountsRes, metricsRes] = await Promise.all([
    supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, business_name, display_name_type, service_rates, base_rate, service_area, primary_service, profile_photo")
      .eq("status", "active")
      .eq("suspended", false),
    supabase
      .from("providers")
      .select("provider_slug, response_time_minutes, reliability_percent, rank, is_featured")
      .eq("city_id", cityRow.id)
      .eq("is_active", true),
  ]);

  if (accountsRes.error) {
    return json({ ok: false, error: { code: "server_error", message: "Failed to load providers", details: { supabase: accountsRes.error } } }, 500);
  }

  // Build metrics lookup by provider_slug
  const metricsMap: Record<string, any> = {};
  for (const pub of (metricsRes.data || [])) {
    metricsMap[pub.provider_slug] = pub;
  }

  // Filter to providers who have this category as a key in service_rates
  const filtered = (accountsRes.data || []).filter((p: any) =>
    p.service_rates &&
    typeof p.service_rates === "object" &&
    !Array.isArray(p.service_rates) &&
    Object.prototype.hasOwnProperty.call(p.service_rates, category)
  );

  const providers = filtered.map((p: any) => {
    // Rate shown is the provider's rate for this specific category
    const categoryRateRaw = p.service_rates[category];
    const categoryRate = Number(categoryRateRaw);
    const hourlyRateCents = Number.isFinite(categoryRate) && categoryRate > 0 ? Math.round(categoryRate * 100) : null;

    const displayName = (p.display_name_type === "business" && p.business_name)
      ? String(p.business_name).trim()
      : [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || "Provider";

    const metrics = metricsMap[p.slug] || {};

    return {
      provider_slug: p.slug,
      display_name: displayName,
      profile_photo: p.profile_photo || null,
      service_area: p.service_area || null,
      response_time_minutes: metrics.response_time_minutes != null ? Number(metrics.response_time_minutes) : null,
      reliability_percent: metrics.reliability_percent != null ? Number(metrics.reliability_percent) : null,
      hourly_rate_cents: hourlyRateCents,
      currency: "CAD",
      rank: metrics.rank != null ? Number(metrics.rank) : null,
      is_featured: Boolean(metrics.is_featured),
    };
  });

  return json({
    ok: true,
    data: {
      city: { slug: cityRow.slug, name: cityRow.name },
      category: { slug: category, name: categoryMeta.display_name, icon: categoryMeta.icon },
      providers,
      generated_at: new Date().toISOString(),
    },
  });
});
