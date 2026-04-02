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

/** Generate a slug: lowercase first name + hyphen + 4 random alphanumeric chars */
function generateSlug(firstName: string): string {
  const base = firstName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20) || "provider";
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let rand = "";
  for (let i = 0; i < 4; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${base}-${rand}`;
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
      .from("providers")
      .select("slug, first_name, last_name, email, status, created_at")
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
    .from("providers")
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

  // Generate a unique slug (retry up to 5 times on collision)
  let slug = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateSlug(firstName);
    const { data: collision } = await supabase
      .from("providers")
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
    .from("providers")
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
