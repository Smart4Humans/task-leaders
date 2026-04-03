// TaskLeaders — Edge Function: apply
// Contract: POST /apply
// Accepts provider application submissions from Become a TaskLeader.

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

function cleanString(v: unknown) {
  return String(v ?? "").trim();
}

function normalizeEmail(email: string) {
  return cleanString(email).toLowerCase();
}

function normalizeWhatsAppE164(raw: string) {
  const digits = cleanString(raw).replace(/\D/g, "");
  // MVP rule: assume North America if 10 digits
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && raw.trim().startsWith("+")) return `+${digits}`;
  // fallback: return +digits if it looks plausible
  if (digits.length >= 11) return `+${digits}`;
  return "";
}

function error(code: string, message: string, details?: unknown, status = 400) {
  return json({ ok: false, error: { code, message, details } }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} }, 200);
  if (req.method !== "POST") {
    return error("bad_request", "Method not allowed", { method: req.method }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return error(
      "server_error",
      "Missing server configuration",
      {
        missing: [!supabaseUrl ? "SUPABASE_URL" : null, !serviceRoleKey ? "TASKLEADERS_SERVICE_ROLE_KEY" : null].filter(Boolean),
      },
      500,
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return error("bad_request", "Invalid JSON body");
  }

  const firstName = cleanString(body.first_name);
  const lastName = cleanString(body.last_name);
  const businessName = cleanString(body.business_name);
  const email = normalizeEmail(body.email);
  const whatsappRaw = cleanString(body.whatsapp);
  const categorySlug = cleanString(body.category_slug).toLowerCase();
  const serviceArea = cleanString(body.service_area);
  const description = cleanString(body.description);

  if (!firstName) return error("validation_error", "First name is required", { field: "first_name" });
  if (!lastName) return error("validation_error", "Last name is required", { field: "last_name" });
  if (!email || !email.includes("@")) return error("validation_error", "Valid email is required", { field: "email" });
  if (!whatsappRaw) return error("validation_error", "WhatsApp number is required", { field: "whatsapp" });
  if (!categorySlug) return error("validation_error", "Primary service is required", { field: "category_slug" });
  if (!serviceArea) return error("validation_error", "Service area is required", { field: "service_area" });
  if (!description) return error("validation_error", "Description is required", { field: "description" });

  const whatsappE164 = normalizeWhatsAppE164(whatsappRaw);
  if (!whatsappE164) return error("validation_error", "Please enter a valid WhatsApp number", { field: "whatsapp" });

  const contactName = `${firstName} ${lastName}`.trim();

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Validate category is in approved taxonomy + active
  const { data: catRow, error: catErr } = await supabase
    .from("categories")
    .select("slug,is_active")
    .eq("slug", categorySlug)
    .maybeSingle();

  if (catErr) return error("server_error", "Failed to validate category", { supabase: catErr }, 500);
  if (!catRow || catRow.is_active !== true) {
    return error("validation_error", "Unknown or inactive category", { field: "category_slug", category_slug: categorySlug });
  }

  // MVP: Vancouver-only, but stored as slug for multi-city readiness
  const citySlug = "vancouver";

  const meta = {
    referrer: req.headers.get("referer"),
    user_agent: req.headers.get("user-agent"),
  };

  const { data, error: insErr } = await supabase
    .from("applications")
    .insert({
      status: "submitted",
      city_slug: citySlug,
      category_slug: categorySlug,
      contact_name: contactName,
      business_name: businessName || null,
      email,
      whatsapp_e164: whatsappE164,
      service_area: serviceArea,
      description,
      source: "become_taskleader_page",
      meta,
    })
    .select("id")
    .single();

  if (insErr) {
    return error("server_error", "Failed to submit application", { supabase: insErr }, 500);
  }

  // Send confirmation email (non-blocking — application succeeds regardless)
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "TaskLeaders <info@task-leaders.com>";
  if (resendKey) {
    const emailPayload = {
      from: fromEmail,
      to: [email],
      subject: "We received your TaskLeaders application",
      html: `<!DOCTYPE html><html><body style="font-family:sans-serif;font-size:15px;color:#000;margin:0;padding:20px;"><p>Hi ${firstName},</p><p>We received your application and will reach out via WhatsApp within 24 hours to schedule your founder call.</p><p>— The TaskLeaders Team</p></body></html>`,
      text: `Hi ${firstName}, we received your application and will reach out via WhatsApp within 24 hours to schedule your founder call. — The TaskLeaders Team`,
    };
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailPayload),
    }).catch(() => {}); // fire-and-forget; do not block the response
  }

  return json({ ok: true, data: { application_id: data.id } }, 200);
});
