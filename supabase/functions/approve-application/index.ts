// TaskLeaders — Edge Function: approve-application
// Contract: POST /approve-application
// Body: { application_id: string, admin_password: string }
// Creates a providers record from an application, generates a slug, returns the welcome URL.
// Also accepts GET /approve-application?admin_password=... to list pipeline data.
// Actions:
//   POST { action: "approve",                application_id, admin_password } — approve application
//   POST { action: "activate",               slug,           admin_password } — activate provider (→ marketplace)
//   POST { action: "approve_concierge_client", client_id,    admin_password } — approve concierge client

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

/** Generate a base slug: lowercase first-last. Returns "provider" if both names are empty. */
function buildBaseSlug(firstName: string, lastName: string): string {
  const f = firstName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const l = lastName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (f && l) return `${f}-${l}`;
  if (f) return f;
  if (l) return l;
  return "provider";
}

/** Send an email via Resend (fire-and-forget). */
function sendEmail(resendKey: string, from: string, to: string, subject: string, html: string, text: string) {
  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  }).catch(() => {}); // non-blocking
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} });

  const supabaseUrl     = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey  = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const adminPassword   = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD");

  if (!supabaseUrl || !serviceRoleKey || !adminPassword) {
    return error("server_error", "Missing server configuration", 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ── GET: list pipeline data ──────────────────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const pw  = url.searchParams.get("admin_password");
    if (pw !== adminPassword) return error("unauthorized", "Invalid admin password", 401);

    const [pendingRes, approvedRes, conciergeRes] = await Promise.all([
      supabase
        .from("applications")
        .select("id, created_at, contact_name, business_name, email, whatsapp_e164, service_area, category_slug, description, status")
        .eq("status", "submitted")
        .order("created_at", { ascending: false }),

      supabase
        .from("provider_accounts")
        .select("slug, first_name, last_name, business_name, email, whatsapp_number, service_area, primary_service, short_description, status, created_at")
        .order("created_at", { ascending: false })
        .limit(200),

      supabase
        .from("concierge_clients")
        .select("id, name, email, whatsapp, company, role, status, approved_date, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    return json({
      ok: true,
      data: {
        pending:           pendingRes.data  ?? [],
        approved:          approvedRes.data ?? [],
        concierge_clients: conciergeRes.data ?? [],
      },
    });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method !== "POST") return error("bad_request", "Method not allowed", 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("bad_request", "Invalid JSON body");
  }

  const pw = String(body.admin_password ?? "");
  if (pw !== adminPassword) return error("unauthorized", "Invalid admin password", 401);

  const action = String(body.action ?? "approve");

  // ── Action: activate TaskLeader ──────────────────────────────────────────
  if (action === "activate") {
    const slug = String(body.slug ?? "").trim();
    if (!slug) return error("bad_request", "Missing required field: slug");

    const { data: acct, error: fetchErr } = await supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, email, business_name, display_name_type, primary_service, service_area, service_cities, whatsapp_number, short_description, profile_photo, base_rate, service_rates, status")
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

    // Send welcome email via Resend
    // TODO: Also send a WhatsApp welcome message once Twilio integration is complete.
    //       In the interim, the operator should send this WhatsApp message manually.
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "TaskLeaders <info@task-leaders.com>";

    if (resendKey && acct.email) {
      const firstName  = acct.first_name || "there";
      const profileUrl = `https://task-leaders.com/v0.5/profile.html?slug=${slug}`;
      const html = [
        "<html><head><meta charset=\"utf-8\"></head>",
        `<body style="font-family:sans-serif;font-size:16px;color:#000000;line-height:1.6;">`,
        `<p>Hi ${firstName},</p>`,
        "<p>Your TaskLeaders profile has been reviewed and is now live on the marketplace.</p>",
        `<p>Clients can find you here: <a href="${profileUrl}">${profileUrl}</a></p>`,
        "<p>Welcome to the network!</p>",
        "<p>— The TaskLeaders Team</p>",
        "</body></html>",
      ].join("\n");

      sendEmail(
        resendKey, fromEmail, acct.email,
        "You're Live on TaskLeaders",
        html,
        `Hi ${firstName},\n\nYour TaskLeaders profile has been reviewed and is now live on the marketplace.\n\nClients can find you here: ${profileUrl}\n\nWelcome to the network!\n\n— The TaskLeaders Team`,
      );
    }

    // Sync into public.providers (marketplace table)
    const citySlug     = "vancouver";
    const categorySlug = (acct.primary_service || "").toLowerCase().trim();

    const [cityRes, catRes] = await Promise.all([
      supabase.from("cities").select("id").eq("slug", citySlug).eq("is_active", true).single(),
      supabase.from("categories").select("id").eq("slug", categorySlug).eq("is_active", true).maybeSingle(),
    ]);

    if (!cityRes.data) {
      return json({ ok: true, data: { slug, status: "active", marketplace_synced: false, reason: "city not found" } });
    }

    const displayName = (acct.display_name_type === "business" && acct.business_name)
      ? acct.business_name
      : `${acct.first_name || ""} ${acct.last_name || ""}`.trim();

    const rateNum          = parseFloat(String(acct.base_rate || "").replace(/[^0-9.]/g, ""));
    const hourlyRateCents  = Number.isFinite(rateNum) && rateNum > 0 ? Math.round(rateNum * 100) : null;
    const serviceAreas     = Array.isArray(acct.service_cities) && acct.service_cities.length > 0
      ? acct.service_cities
      : (acct.service_area ? [acct.service_area] : []);

    const upsertPayload: Record<string, unknown> = {
      provider_slug:    slug,
      display_name:     displayName,
      status:           "approved",
      is_active:        true,
      city_id:          cityRes.data.id,
      whatsapp_e164:    acct.whatsapp_number ?? null,
      about_text:       acct.short_description ?? null,
      hero_photo_url:   acct.profile_photo ?? null,
      hourly_rate_cents: hourlyRateCents,
      service_areas:    serviceAreas,
      service_rates:    acct.service_rates ?? null,
    };
    if (catRes.data?.id) upsertPayload.category_id = catRes.data.id;

    const { error: upsertErr } = await supabase
      .from("providers")
      .upsert(upsertPayload, { onConflict: "provider_slug" });

    if (upsertErr) {
      return json({ ok: true, data: { slug, status: "active", marketplace_synced: false, reason: upsertErr.message } });
    }

    return json({ ok: true, data: { slug, status: "active", marketplace_synced: true } });
  }

  // ── Action: approve concierge client ────────────────────────────────────
  if (action === "approve_concierge_client") {
    const clientId = String(body.client_id ?? "").trim();
    if (!clientId) return error("bad_request", "Missing required field: client_id");

    const { data: client, error: fetchErr } = await supabase
      .from("concierge_clients")
      .select("id, name, email, status")
      .eq("id", clientId)
      .single();

    if (fetchErr || !client) return error("not_found", "Concierge client not found", 404);
    if (client.status === "active") return error("conflict", "Client is already active", 409);

    const { error: updateErr } = await supabase
      .from("concierge_clients")
      .update({ status: "active", approved_date: new Date().toISOString() })
      .eq("id", clientId);

    if (updateErr) return error("server_error", updateErr.message, 500);

    // Send welcome email via Resend
    // TODO: Also send a WhatsApp welcome message once Twilio integration is complete.
    //       In the interim, the operator should send this WhatsApp message manually.
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "TaskLeaders <info@task-leaders.com>";

    if (resendKey && client.email) {
      const firstName = (client.name || "").split(" ")[0] || "there";
      const html = [
        "<html><head><meta charset=\"utf-8\"></head>",
        `<body style="font-family:sans-serif;font-size:16px;color:#000000;line-height:1.6;">`,
        `<p>Hi ${firstName},</p>`,
        "<p>Your access to the TaskLeaders Concierge service has been approved.</p>",
        "<p>Save this WhatsApp number: <strong>[TASKLEADERS_WHATSAPP_NUMBER]</strong></p>",
        "<p>When you need a service provider, just send us a message and we'll handle the rest.</p>",
        "<p>— The TaskLeaders Team</p>",
        "</body></html>",
      ].join("\n");

      sendEmail(
        resendKey, fromEmail, client.email,
        "You're In — TaskLeaders Concierge Access",
        html,
        `Hi ${firstName},\n\nYour access to the TaskLeaders Concierge service has been approved.\n\nSave this WhatsApp number: [TASKLEADERS_WHATSAPP_NUMBER]\n\nWhen you need a service provider, just send us a message and we'll handle the rest.\n\n— The TaskLeaders Team`,
      );
    }

    return json({ ok: true, data: { id: clientId, status: "active" } });
  }

  // ── Action: approve application (default) ───────────────────────────────
  const applicationId = String(body.application_id ?? "").trim();
  if (!applicationId) return error("bad_request", "Missing required field: application_id");

  const { data: app, error: appError } = await supabase
    .from("applications")
    .select("*")
    .eq("id", applicationId)
    .single();

  if (appError || !app) return error("not_found", "Application not found", 404);
  if (app.status !== "submitted") return error("conflict", `Application is already ${app.status}`, 409);

  // Idempotency: return existing slug if already approved
  const { data: existing } = await supabase
    .from("provider_accounts")
    .select("slug")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (existing) {
    return json({
      ok: true,
      data: { slug: existing.slug, welcome_url: `welcome.html?slug=${existing.slug}`, already_existed: true },
    });
  }

  // Parse first/last name
  const meta: Record<string, string> = (app.meta as Record<string, string>) ?? {};
  const firstName = (meta.first_name || app.contact_name?.split(" ")[0] || "Provider").trim();
  const lastName  = (meta.last_name  || app.contact_name?.split(" ").slice(1).join(" ") || "").trim();

  // Generate unique slug
  const baseSlug = buildBaseSlug(firstName, lastName);
  let slug = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    const { data: collision } = await supabase
      .from("provider_accounts").select("slug").eq("slug", candidate).maybeSingle();
    if (!collision) { slug = candidate; break; }
  }

  if (!slug) return error("server_error", "Failed to generate a unique slug. Please try again.", 500);

  const { data: provider, error: insertError } = await supabase
    .from("provider_accounts")
    .insert({
      slug,
      status:            "pending_onboarding",
      first_name:        firstName,
      last_name:         lastName,
      business_name:     app.business_name ?? meta.business_name ?? null,
      email:             app.email,
      whatsapp_number:   app.whatsapp_e164,
      service_area:      app.service_area,
      primary_service:   app.category_slug,
      short_description: app.description ?? null,
      application_id:    applicationId,
    })
    .select("slug")
    .single();

  if (insertError || !provider) {
    return error("server_error", insertError?.message ?? "Failed to create provider", 500);
  }

  await supabase
    .from("applications")
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", applicationId);

  return json({
    ok: true,
    data: { slug: provider.slug, welcome_url: `welcome.html?slug=${provider.slug}` },
  });
});
