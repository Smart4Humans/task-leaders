// TaskLeaders — Edge Function: lead-event
// Contract: POST /lead-event
// Minimal best-effort event logging for Connect instrumentation.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function invalidPayload() {
  return json({ ok: false, error: "invalid_payload" }, 400);
}

function isNonEmptyString(v: unknown) {
  return typeof v === "string" && v.trim().length > 0;
}

const ALLOWED_EVENTS = new Set(["connect_modal_opened", "connect_submit_attempted"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} }, 200);
  if (req.method !== "POST") return invalidPayload();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    // Keep response shape stable; treat as insert failure (best-effort)
    return json({ ok: false, error: "insert_failed" }, 200);
  }

  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return invalidPayload();
  }

  const eventType = body?.event_type;
  if (!isNonEmptyString(eventType) || !ALLOWED_EVENTS.has(eventType)) return invalidPayload();

  if (!isNonEmptyString(body?.source)) return invalidPayload();
  if (!isNonEmptyString(body?.page)) return invalidPayload();
  if (!isNonEmptyString(body?.session_id)) return invalidPayload();
  if (!isNonEmptyString(body?.city_slug)) return invalidPayload();

  // Event-specific validation
  let consentChecked: boolean | null = null;
  if (eventType === "connect_submit_attempted") {
    if (typeof body?.consent_checked !== "boolean") return invalidPayload();
    consentChecked = body.consent_checked;
  }

  const row = {
    event_type: eventType,
    source: String(body.source).trim(),
    page: String(body.page).trim(),
    session_id: String(body.session_id).trim(),

    city_slug: String(body.city_slug).trim().toLowerCase(),
    category_slug: isNonEmptyString(body?.category_slug) ? String(body.category_slug).trim().toLowerCase() : null,
    provider_slug: isNonEmptyString(body?.provider_slug) ? String(body.provider_slug).trim().toLowerCase() : null,

    consent_checked: consentChecked,
    handoff_channel: isNonEmptyString(body?.handoff_channel) ? String(body.handoff_channel).trim().toLowerCase() : null,
    handoff_mode: isNonEmptyString(body?.handoff_mode) ? String(body.handoff_mode).trim().toLowerCase() : null,

    meta: body?.meta && typeof body.meta === "object" ? body.meta : null,
  };

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { error: insErr } = await supabase.from("lead_events").insert(row);

  if (insErr) {
    return json({ ok: false, error: "insert_failed" }, 200);
  }

  return json({ ok: true }, 200);
});
