// TaskLeaders — Edge Function: approve-application
// Contract: POST /approve-application
// Body: { application_id: string, admin_password: string }
// Creates a providers record from an application, generates a slug, returns the welcome URL.
// Also accepts GET /approve-application/list?admin_password=... to list pending applications.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function error(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

/** Generate a base slug: lowercase first-last. Returns empty string if both names empty. */
function buildBaseSlug(firstName: string, lastName: string): string {
  const f = firstName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const l = lastName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (f && l) return `${f}-${l}`;
  if (f) return f;
  if (l) return l;
  return "provider";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const adminPassword = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD");

  if (!supabaseUrl || !serviceRoleKey || !adminPassword) {
    return error("server_error", "Missing server configuration", 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ── GET: list pending applications ──────────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const pw = url.searchParams.get("admin_password");
    if (pw !== adminPassword) {
      return error("unauthorized", "Invalid admin password", 401);
    }

    const { data, error: dbError } = await supabase
      .from("applications")
      .select("id, created_at, contact_name, business_name, email, whatsapp_e164, service_area, category_slug, description, status")
      .eq("status", "submitted")
      .order("created_at", { ascending: false });

    if (dbError) {
      return error("server_error", dbError.message, 500);
    }

    // Also pull already-approved ones so the admin can see generated links
    const { data: approved } = await supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, business_name, email, whatsapp_number, service_area, primary_service, short_description, status, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    return json({ ok: true, data: { pending: data ?? [], approved: approved ?? [] } });
  }

  // ── POST: approve an application ────────────────────────────────────────
  if (req.method !== "POST") {
    return error("bad_request", "Method not allowed", 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("bad_request", "Invalid JSON body");
  }

  const pw = String(body.admin_password ?? "");
  if (pw !== adminPassword) {
    return error("unauthorized", "Invalid admin password", 401);
  }

  // ── Activate action ───────────────────────────────────────────────────────
  const action = String(body.action ?? "approve");
  if (action === "activate") {
    const slug = String(body.slug ?? "").trim();
    if (!slug) return error("bad_request", "Missing required field: slug");

    // Fetch full provider_accounts record for marketplace sync
    const { data: acct, error: fetchErr } = await supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, business_name, display_name_type, primary_service, service_area, service_cities, whatsapp_number, short_description, profile_photo, base_rate, service_rates, status")
      .eq("slug", slug)
      .single();

    if (fetchErr || !acct) return error("not_found", "Provider account not found", 404);
    if (acct.status !== "pending_approval") {
      return error("conflict", `Provider is already ${acct.status}`, 409);
    }

    // Set status active in provider_accounts
    const { error: updateError } = await supabase
      .from("provider_accounts")
      .update({ status: "active" })
      .eq("slug", slug);

    if (updateError) return error("server_error", updateError.message, 500);

    // Sync into public.providers (marketplace table) so the provider appears in category pages
    // Look up city_id and category_id
    const citySlug = "vancouver";
    const categorySlug = (acct.primary_service || "").toLowerCase().trim();

    const [cityRes, catRes] = await Promise.all([
      supabase.from("cities").select("id").eq("slug", citySlug).eq("is_active", true).single(),
      // category_id is best-effort — categories like hvac/yard-work may not be in the DB
      // categories table yet. The leaderboard (public-category) queries provider_accounts
      // directly so a null category_id in providers is fine.
      supabase.from("categories").select("id").eq("slug", categorySlug).eq("is_active", true).maybeSingle(),
    ]);

    if (!cityRes.data) {
      // City is required for the providers record; category is optional.
      return json({ ok: true, data: { slug, status: "active", marketplace_synced: false, reason: "city not found" } });
    }

    // Compute display name based on provider's preference
    const displayName = (acct.display_name_type === "business" && acct.business_name)
      ? acct.business_name
      : `${acct.first_name || ""} ${acct.last_name || ""}`.trim();

    // base_rate is stored as text (e.g. "100" or "$100/hr") — extract numeric part for cents
    const rateNum = parseFloat(String(acct.base_rate || "").replace(/[^0-9.]/g, ""));
    const hourlyRateCents = Number.isFinite(rateNum) && rateNum > 0 ? Math.round(rateNum * 100) : null;

    // Use service_cities array for service_areas; fall back to single service_area
    const serviceAreas = Array.isArray(acct.service_cities) && acct.service_cities.length > 0
      ? acct.service_cities
      : (acct.service_area ? [acct.service_area] : []);

    const upsertPayload: Record<string, unknown> = {
      provider_slug: slug,
      display_name: displayName,
      status: "approved",
      is_active: true,
      city_id: cityRes.data.id,
      whatsapp_e164: acct.whatsapp_number ?? null,
      about_text: acct.short_description ?? null,
      hero_photo_url: acct.profile_photo ?? null,
      hourly_rate_cents: hourlyRateCents,
      service_areas: serviceAreas,
      service_rates: acct.service_rates ?? null,
    };
    // Only set category_id when the DB category exists; otherwise leave it null/unset
    if (catRes.data?.id) upsertPayload.category_id = catRes.data.id;

    const { error: upsertErr } = await supabase
      .from("providers")
      .upsert(upsertPayload, { onConflict: "provider_slug" });

    if (upsertErr) {
      return json({ ok: true, data: { slug, status: "active", marketplace_synced: false, reason: upsertErr.message } });
    }

    return json({ ok: true, data: { slug, status: "active", marketplace_synced: true } });
  }

  const applicationId = String(body.application_id ?? "").trim();
  if (!applicationId) {
    return error("bad_request", "Missing required field: application_id");
  }

  // Fetch the application
  const { data: app, error: appError } = await supabase
    .from("applications")
    .select("*")
    .eq("id", applicationId)
    .single();

  if (appError || !app) {
    return error("not_found", "Application not found", 404);
  }

  if (app.status !== "submitted") {
    return error("conflict", `Application is already ${app.status}`, 409);
  }

  // Check if a provider record already exists for this application
  const { data: existing } = await supabase
    .from("provider_accounts")
    .select("slug")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (existing) {
    // Idempotent: return the existing slug
    return json({
      ok: true,
      data: {
        slug: existing.slug,
        welcome_url: `welcome.html?slug=${existing.slug}`,
        already_existed: true,
      },
    });
  }

  // Parse first_name / last_name from contact_name (stored as single field in applications)
  // The applications table uses contact_name; providers table stores first_name + last_name separately.
  // The Become a TaskLeader form now sends first_name + last_name in meta.
  const meta: Record<string, string> = (app.meta as Record<string, string>) ?? {};
  const firstName = (meta.first_name || app.contact_name?.split(" ")[0] || "Provider").trim();
  const lastName = (meta.last_name || app.contact_name?.split(" ").slice(1).join(" ") || "").trim();

  // Generate a unique slug: firstname-lastname, falling back to firstname-lastname-2, -3, etc.
  const baseSlug = buildBaseSlug(firstName, lastName);
  let slug = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    const { data: collision } = await supabase
      .from("provider_accounts")
      .select("slug")
      .eq("slug", candidate)
      .maybeSingle();
    if (!collision) {
      slug = candidate;
      break;
    }
  }

  if (!slug) {
    return error("server_error", "Failed to generate a unique slug. Please try again.", 500);
  }

  // Create the provider record
  const { data: provider, error: insertError } = await supabase
    .from("provider_accounts")
    .insert({
      slug,
      status: "pending_onboarding",
      first_name: firstName,
      last_name: lastName,
      business_name: app.business_name ?? meta.business_name ?? null,
      email: app.email,
      whatsapp_number: app.whatsapp_e164,
      service_area: app.service_area,
      primary_service: app.category_slug,
      short_description: app.description ?? null,
      application_id: applicationId,
    })
    .select("slug")
    .single();

  if (insertError || !provider) {
    return error("server_error", insertError?.message ?? "Failed to create provider", 500);
  }

  // Mark the application as approved
  await supabase
    .from("applications")
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", applicationId);

  return json({
    ok: true,
    data: {
      slug: provider.slug,
      welcome_url: `welcome.html?slug=${provider.slug}`,
    },
  });
});
