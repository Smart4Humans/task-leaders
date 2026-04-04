// TaskLeaders — Edge Function: public-homepage
// Contract: GET /public-homepage?city=vancouver
// Returns populated categories (count > 0) for the given city.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Canonical category metadata — used to surface categories not yet in the DB categories table.
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

  // Count active providers per category by scanning service_rates JSONB keys.
  // Identical source and logic to public-category — guarantees homepage counts
  // match the leaderboard exactly, and works for any category (e.g. HVAC) without
  // requiring a DB categories-table row.
  const { data: acctRows, error: acctErr } = await supabase
    .from("provider_accounts")
    .select("service_rates")
    .eq("status", "active");

  if (acctErr) {
    return json({ ok: false, error: { code: "server_error", message: "Failed to load providers", details: { supabase: acctErr } } }, 500);
  }

  const counts: Record<string, number> = {};
  for (const a of (acctRows || [])) {
    if (a.service_rates && typeof a.service_rates === "object" && !Array.isArray(a.service_rates)) {
      for (const slug of Object.keys(a.service_rates)) {
        counts[slug] = (counts[slug] || 0) + 1;
      }
    }
  }

  const categories = Object.entries(counts)
    .filter(([slug, count]) => count > 0 && Boolean(CATEGORY_META[slug]))
    .map(([slug, count]) => ({
      id: slug,
      name: CATEGORY_META[slug].display_name,
      icon: CATEGORY_META[slug].icon,
      count,
      href: `category.html?city=${encodeURIComponent(city)}&category=${encodeURIComponent(slug)}`,
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
