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
  })
  .then(async (r) => {
    const body = await r.text().catch(() => "(unreadable)");
    if (!r.ok) {
      console.error(`[sendEmail] Resend rejected (${r.status}) sending to ${to}: ${body}`);
    } else {
      console.log(`[sendEmail] Sent to ${to}: "${subject}"`);
    }
  })
  .catch((e: unknown) => {
    console.error(`[sendEmail] Network error sending to ${to}: ${(e as Error)?.message ?? String(e)}`);
  });
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

    const [pendingRes, approvedRes, conciergeRes, jobsRes, pendingOnboardingRes] = await Promise.all([
      supabase
        .from("applications")
        .select("id, created_at, contact_name, business_name, email, whatsapp_e164, service_area, category_slug, description, status")
        .eq("status", "submitted")
        .order("created_at", { ascending: false }),

      // Pipeline shows providers who are past the onboarding stage (pending_approval or active).
      // Providers in pending_onboarding are tracked exclusively in the Onboarding Queue
      // (returned as pending_onboarding below) to prevent duplication.
      // suspended is included so the frontend can render the Deactivated badge and
      // suppress action buttons for deactivated TaskLeaders.
      supabase
        .from("provider_accounts")
        .select("slug, first_name, last_name, business_name, email, whatsapp_number, service_area, primary_service, short_description, status, suspended, created_at")
        .neq("status", "pending_onboarding")
        .order("created_at", { ascending: false })
        .limit(200),

      supabase
        .from("concierge_clients")
        .select("id, first_name, last_name, name, email, whatsapp, company, role, status, suspended, approved_date, created_at")
        .order("created_at", { ascending: false })
        .limit(200),

      supabase
        .from("jobs")
        .select("id, job_id, city_code, category_code, category_name, status, client_id, address, description, created_at, assigned_at, completed_at")
        .order("created_at", { ascending: false })
        .limit(500),

      // Providers who have been approved (link sent) but have not yet completed
      // onboarding. These appear in the Onboarding Queue alongside submitted
      // applications so the admin can track them without a full page reload.
      // They leave the Queue automatically once the provider completes onboarding
      // (status advances to pending_approval via complete-onboarding), OR when
      // the admin clicks Deactivate (suspended = true removes them from this query).
      supabase
        .from("provider_accounts")
        .select("slug, first_name, last_name, email, whatsapp_number, service_area, primary_service, status, created_at")
        .eq("status", "pending_onboarding")
        .eq("suspended", false)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    return json({
      ok: true,
      data: {
        pending:             pendingRes.data          ?? [],
        pending_onboarding:  pendingOnboardingRes.data ?? [],
        approved:            approvedRes.data          ?? [],
        concierge_clients:   conciergeRes.data         ?? [],
        jobs:                jobsRes.data              ?? [],
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

    // Set status active in provider_accounts.
    // concierge_eligible is set to true here so the provider immediately
    // qualifies for Concierge lead broadcasts via job-dispatch.
    // Without this, the provider is active on the Marketplace but silently
    // excluded from all Concierge dispatch queries.
    const { error: updateError } = await supabase
      .from("provider_accounts")
      .update({ status: "active", concierge_eligible: true })
      .eq("slug", slug);

    if (updateError) return error("server_error", updateError.message, 500);

    // Send WT-1 WhatsApp welcome to provider
    // Template WT-1: TaskLeader profile activation / Concierge welcome
    // Only sent if the provider is concierge_eligible; Marketplace-only providers
    // receive a different email-only welcome for now.
    const twilioAccountSid   = Deno.env.get("TWILIO_ACCOUNT_SID");
    const twilioAuthToken    = Deno.env.get("TWILIO_AUTH_TOKEN");
    const twilioWaNumber     = Deno.env.get("TWILIO_WHATSAPP_NUMBER");
    const internalSecret     = Deno.env.get("INTERNAL_CRON_SECRET");
    const supabaseUrlForFn   = Deno.env.get("SUPABASE_URL") ?? "";
    const fnProject          = supabaseUrlForFn.replace("https://", "").split(".supabase.co")[0];

    if (acct.whatsapp_number && twilioAccountSid && twilioAuthToken && twilioWaNumber) {
      const firstName = acct.first_name || "there";
      // WT-1 body (all 11 templates defined in _shared/twilio.ts)
      const wt1Body = (
        `Hi ${firstName} — welcome to TaskLeaders Concierge.\n\n` +
        `Your profile is now active.\n\n` +
        `When a matching Concierge lead comes in, we'll message you here. ` +
        `The first qualified TaskLeader to accept and complete lead fee payment gets the job.\n\n` +
        `Reply HELP any time if you need support.`
      );
      const twilioMsgUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
      fetch(twilioMsgUrl, {
        method: "POST",
        headers: {
          "Content-Type":  "application/x-www-form-urlencoded",
          "Authorization": "Basic " + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
        },
        body: new URLSearchParams({
          From: `whatsapp:${twilioWaNumber}`,
          To:   `whatsapp:${acct.whatsapp_number}`,
          Body: wt1Body,
        }),
      }).catch(() => {}); // fire-and-forget

      // Log to message_log via send-whatsapp (also fire-and-forget)
      if (fnProject && internalSecret) {
        fetch(`https://${fnProject}.supabase.co/functions/v1/send-whatsapp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-secret": internalSecret },
          body: JSON.stringify({ to: acct.whatsapp_number, body: wt1Body }),
        }).catch(() => {});
      }
    }

    // Send welcome email via Resend
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "TaskLeaders <info@task-leaders.com>";

    if (resendKey && acct.email) {
      const firstName  = acct.first_name || "there";
      const html = [
        "<html><head><meta charset=\"utf-8\"></head>",
        `<body style="font-family:sans-serif;font-size:16px;color:#000000;line-height:1.6;">`,
        `<p>Hi ${firstName},</p>`,
        "<p>You're now active on <strong>TaskLeaders Concierge</strong>.</p>",
        "<p>Here's how it works:</p>",
        "<ul>",
        "<li>When a matching client request comes in, we'll message you on WhatsApp.</li>",
        "<li>Reply <strong>ACCEPT</strong> to claim the job or <strong>PASS</strong> to skip it.</li>",
        "<li>The first TaskLeader to accept and complete the lead fee payment gets the job.</li>",
        "<li>Once confirmed, we'll connect you directly with the client through our WhatsApp number.</li>",
        "</ul>",
        "<p>Save our WhatsApp number — that's where all your Concierge leads and client threads will come through.</p>",
        "<p>Reply HELP any time if you need support.</p>",
        "<p>— The TaskLeaders Team</p>",
        "</body></html>",
      ].join("\n");

      sendEmail(
        resendKey, fromEmail, acct.email,
        "You're active on TaskLeaders Concierge",
        html,
        `Hi ${firstName},\n\nYou're now active on TaskLeaders Concierge.\n\nHere's how it works:\n- When a matching client request comes in, we'll message you on WhatsApp.\n- Reply ACCEPT to claim the job or PASS to skip it.\n- The first TaskLeader to accept and complete the lead fee payment gets the job.\n- Once confirmed, we'll connect you directly with the client through our WhatsApp number.\n\nSave our WhatsApp number — that's where all your Concierge leads and client threads will come through.\n\nReply HELP any time if you need support.\n\n— The TaskLeaders Team`,
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

  // ── Action: deactivate TaskLeader ───────────────────────────────────────
  // Sets suspended = true and concierge_eligible = false.
  // Does NOT delete the record or change status — preserves history.
  // Effect:
  //   • job-dispatch eligibility query (.eq("suspended", false)) immediately excludes them
  //   • concierge_eligible = false adds a second broadcast gate
  //   • pending_onboarding Queue query (.eq("suspended", false)) removes them from Queue
  //   • Pipeline shows them with a Deactivated badge (suspended field in select)
  // Reactivate (future): set suspended = false, concierge_eligible = true.
  if (action === "deactivate") {
    const slug = String(body.slug ?? "").trim();
    if (!slug) return error("bad_request", "Missing required field: slug");

    const { data: acct, error: fetchErr } = await supabase
      .from("provider_accounts")
      .select("slug, status, suspended")
      .eq("slug", slug)
      .single();

    if (fetchErr || !acct) return error("not_found", "Provider account not found", 404);
    if (acct.suspended === true) return error("conflict", "TaskLeader is already deactivated", 409);

    const { error: updateErr } = await supabase
      .from("provider_accounts")
      .update({ suspended: true, concierge_eligible: false })
      .eq("slug", slug);

    if (updateErr) return error("server_error", updateErr.message, 500);
    return json({ ok: true, data: { slug, deactivated: true } });
  }

  // ── Action: deactivate Concierge client ─────────────────────────────────
  // Sets suspended = true on concierge_clients. Does not delete the record.
  // The client is preserved for history. Re-activation is a future action.
  if (action === "deactivate_concierge_client") {
    const clientId = String(body.client_id ?? "").trim();
    if (!clientId) return error("bad_request", "Missing required field: client_id");

    const { data: client, error: fetchErr } = await supabase
      .from("concierge_clients")
      .select("id, status, suspended")
      .eq("id", clientId)
      .single();

    if (fetchErr || !client) return error("not_found", "Concierge client not found", 404);
    if (client.suspended === true) return error("conflict", "Client is already deactivated", 409);

    const { error: updateErr } = await supabase
      .from("concierge_clients")
      .update({ suspended: true })
      .eq("id", clientId);

    if (updateErr) return error("server_error", updateErr.message, 500);
    return json({ ok: true, data: { id: clientId, deactivated: true } });
  }

  // ── Action: approve concierge client ────────────────────────────────────
  if (action === "approve_concierge_client") {
    const clientId = String(body.client_id ?? "").trim();
    if (!clientId) return error("bad_request", "Missing required field: client_id");

    const { data: client, error: fetchErr } = await supabase
      .from("concierge_clients")
      .select("id, first_name, last_name, name, email, status")
      .eq("id", clientId)
      .single();

    if (fetchErr || !client) return error("not_found", "Concierge client not found", 404);
    if (client.status === "active") return error("conflict", "Client is already active", 409);

    const { error: updateErr } = await supabase
      .from("concierge_clients")
      .update({ status: "active", approved_date: new Date().toISOString() })
      .eq("id", clientId);

    if (updateErr) return error("server_error", updateErr.message, 500);

    // Send WC-1 WhatsApp welcome to approved Concierge client
    // Template WC-1: Client welcome / Concierge approval
    const twilioAccountSid2  = Deno.env.get("TWILIO_ACCOUNT_SID");
    const twilioAuthToken2   = Deno.env.get("TWILIO_AUTH_TOKEN");
    const twilioWaNumber2    = Deno.env.get("TWILIO_WHATSAPP_NUMBER");

    // Concierge clients table stores WhatsApp number in the `whatsapp` column
    const clientWhatsapp = (client as Record<string, unknown>).whatsapp as string | undefined;
    if (clientWhatsapp && twilioAccountSid2 && twilioAuthToken2 && twilioWaNumber2) {
      const firstName2 = client.first_name || (client.name || "").split(" ")[0] || "there";
      // WC-1 body
      const wc1Body = (
        `Hi ${firstName2} — you're approved for TaskLeaders Concierge.\n\n` +
        `Save this number. When you need help, just message us here and we'll take it from there.\n\n` +
        `No login. No account setup each time. Just send your request with details when you need a TaskLeader.\n\n` +
        `— TaskLeaders Concierge`
      );
      const twilioMsgUrl2 = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid2}/Messages.json`;
      fetch(twilioMsgUrl2, {
        method: "POST",
        headers: {
          "Content-Type":  "application/x-www-form-urlencoded",
          "Authorization": "Basic " + btoa(`${twilioAccountSid2}:${twilioAuthToken2}`),
        },
        body: new URLSearchParams({
          From: `whatsapp:${twilioWaNumber2}`,
          To:   `whatsapp:${clientWhatsapp}`,
          Body: wc1Body,
        }),
      }).catch(() => {}); // fire-and-forget
    }

    // Send welcome email via Resend
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "TaskLeaders <info@task-leaders.com>";

    if (resendKey && client.email) {
      const firstName = client.first_name || (client.name || "").split(" ")[0] || "there";
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
