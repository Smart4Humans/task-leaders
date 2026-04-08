// TaskLeaders — Edge Function: send-whatsapp
// Contract: POST /send-whatsapp
// Internal admin-triggered WhatsApp send endpoint.
// Also used by other edge functions that need to send template messages.
//
// Auth: requires x-internal-secret header matching INTERNAL_CRON_SECRET env var,
//       OR admin_password in body for admin panel use.
//
// Body (template send):
//   { to: string, template: "WC-1"|"WT-1"|..., params: string[], job_id?: string }
//
// Body (free-form send):
//   { to: string, body: string, job_id?: string }
//
// ROUTING NOTE: All messages originate from the TaskLeaders WhatsApp number.
// No direct number release to clients or providers.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTwilioEnv, sendWhatsApp, logMessage,
  buildWC1, buildWC2, buildWC3, buildWC4,
  buildWT1, buildWT2, buildWT3, buildWT4, buildWT5, buildWT6, buildWT7,
  SURVEY_QUESTIONS,
} from "../_shared/twilio.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type, x-internal-secret",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}
function err(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

type TemplateName =
  | "WC-1" | "WC-2" | "WC-3" | "WC-4"
  | "WT-1" | "WT-2" | "WT-3" | "WT-4" | "WT-5" | "WT-6" | "WT-7"
  | "SURVEY_Q1" | "SURVEY_Q2" | "SURVEY_Q3";

function buildBody(template: TemplateName, params: string[]): string | null {
  const p = params;
  switch (template) {
    case "WC-1":      return buildWC1(p[0]);
    case "WC-2":      return buildWC2(p[0], p[1], p[2], p[3]);
    case "WC-3":      return buildWC3(p[0], p[1], p[2], p[3]);
    case "WC-4":      return buildWC4(p[0], p[1], p[2]);
    case "WT-1":      return buildWT1(p[0]);
    case "WT-2":      return buildWT2(p[0], p[1], p[2], p[3], p[4], p[5]);
    case "WT-3":      return buildWT3(p[0], p[1], p[2], p[3]);
    case "WT-4":      return buildWT4(p[0], p[1], p[2]);
    case "WT-5":      return buildWT5(p[0], p[1], p[2], p[3]);
    case "WT-6":      return buildWT6(p[0], p[1], p[2]);
    case "WT-7":      return buildWT7(p[0], p[1], p[2]);
    case "SURVEY_Q1": return SURVEY_QUESTIONS.q1;
    case "SURVEY_Q2": return SURVEY_QUESTIONS.q2;
    case "SURVEY_Q3": return SURVEY_QUESTIONS.q3;
    default:          return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return err("bad_request", "Method not allowed", 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const adminPassword  = Deno.env.get("TASKLEADERS_ADMIN_PASSWORD");
  const cronSecret     = Deno.env.get("INTERNAL_CRON_SECRET");

  if (!supabaseUrl || !serviceRoleKey) {
    return err("server_error", "Missing server configuration", 500);
  }

  // Auth: internal secret header OR admin password in body
  const internalHeader = req.headers.get("x-internal-secret");
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", "Invalid JSON body");
  }

  const isInternal = cronSecret && internalHeader === cronSecret;
  const isAdmin    = adminPassword && String(body.admin_password ?? "") === adminPassword;
  if (!isInternal && !isAdmin) {
    return err("unauthorized", "Unauthorized", 401);
  }

  const twilioEnv = getTwilioEnv();
  if (!twilioEnv) return err("server_error", "Twilio not configured", 500);

  const to    = String(body.to ?? "").trim();
  const jobId = body.job_id ? String(body.job_id) : null;
  if (!to) return err("validation_error", "to is required");

  let messageBody: string;
  let templateName: string | null = null;

  if (body.template) {
    const template = String(body.template) as TemplateName;
    const params   = Array.isArray(body.params) ? body.params.map(String) : [];
    const built    = buildBody(template, params);
    if (!built) return err("validation_error", `Unknown template: ${template}`);
    messageBody  = built;
    templateName = template;
  } else if (body.body) {
    messageBody = String(body.body);
  } else {
    return err("validation_error", "Either template+params or body is required");
  }

  const result = await sendWhatsApp(twilioEnv, to, messageBody);

  // Log to message_log (fire-and-forget)
  logMessage({
    supabaseUrl, serviceRoleKey,
    direction:           "outbound",
    jobId,
    participantWhatsapp: to,
    messageSid:          result.messageSid,
    templateName,
    body:                messageBody,
    status:              result.ok ? "sent" : "failed",
  });

  if (!result.ok) {
    return err("twilio_error", result.error ?? "Send failed", 502);
  }

  return json({ ok: true, data: { messageSid: result.messageSid } });
});
