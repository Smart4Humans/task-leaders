// TaskLeaders — Edge Function: public-profile
// Contract: GET /public-profile?city=vancouver&provider=sam-fixit
// Returns approved + active provider profile data for the given city + provider.
// IMPORTANT: Connect handoff remains gated for MVP until consent/Terms/Privacy checkpoint is finalized.

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
  const provider = (url.searchParams.get("provider") || "").trim().toLowerCase();

  if (!provider) {
    return json({ ok: false, error: { code: "bad_request", message: "Missing provider", details: { required: ["provider"] } } }, 400);
  }

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

  const { data: rows, error: rpcErr } = await supabase.rpc("get_public_profile", {
    p_city_slug: city,
    p_provider_slug: provider,
  });

  if (rpcErr) {
    return json(
      {
        ok: false,
        error: { code: "server_error", message: "Failed to load profile", details: { supabase: rpcErr } },
      },
      500,
    );
  }

  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    return json(
      {
        ok: false,
        error: { code: "not_found", message: "Provider not found", details: { city, provider } },
      },
      404,
    );
  }

  const serviceAreas: string[] = Array.isArray(row.service_areas) ? row.service_areas.filter(Boolean) : [];

  return json({
    ok: true,
    data: {
      city: { slug: row.city_slug, name: row.city_name },
      provider: {
        provider_slug: row.provider_slug,
        display_name: row.display_name,
        category: {
          slug: row.category_slug,
          name: row.category_name,
          icon: row.category_icon,
        },
        base_city: { slug: row.city_slug, name: row.city_name },
        service_areas: serviceAreas,
        about: row.about_text,
        response_time_minutes: row.response_time_minutes === null ? null : Number(row.response_time_minutes),
        reliability_percent: row.reliability_percent === null ? null : Number(row.reliability_percent),
        hourly_rate_cents: row.hourly_rate_cents === null ? null : Number(row.hourly_rate_cents),
        currency: row.currency,
        hero_photo_url: row.hero_photo_url,
      },
      connect: {
        status: "gated",
        requires_consent: true,
        handoff: {
          channel: "whatsapp",
          whatsapp_e164: row.whatsapp_e164,
          deeplink_url: null,
        },
        message:
          "Direct WhatsApp connect is not enabled yet. We’re finalizing the consent / Terms / Privacy checkpoint for launch.",
      },
      generated_at: new Date().toISOString(),
    },
  });
});
