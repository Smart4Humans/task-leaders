// TaskLeaders — Edge Function: concierge-apply
// Contract: POST /concierge-apply
// Body: { first_name, last_name, email, whatsapp, company, role }
// Inserts into concierge_clients, sends confirmation email via Resend.

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

function error(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

function clean(v: unknown) {
  return String(v ?? "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} });
  if (req.method !== "POST") return error("bad_request", "Method not allowed", 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return error("server_error", "Missing server configuration", 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("bad_request", "Invalid JSON body");
  }

  const firstName = clean(body.first_name);
  const lastName  = clean(body.last_name);
  const email     = clean(body.email).toLowerCase();
  const whatsapp  = clean(body.whatsapp);
  const company   = clean(body.company);
  const role      = clean(body.role);

  if (!firstName)                       return error("validation_error", "First name is required");
  if (!lastName)                        return error("validation_error", "Last name is required");
  if (!email || !email.includes("@"))   return error("validation_error", "Valid email is required");
  if (!whatsapp)                        return error("validation_error", "WhatsApp number is required");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error: insErr } = await supabase
    .from("concierge_clients")
    .insert({
      first_name: firstName,
      last_name:  lastName,
      // name kept for backward compatibility with any existing queries
      name:       `${firstName} ${lastName}`.trim(),
      email,
      whatsapp,
      company: company || null,
      role:    role    || null,
    })
    .select("id")
    .single();

  if (insErr) {
    return error("server_error", "Failed to submit application: " + insErr.message, 500);
  }

  // Send confirmation email — fire-and-forget; submission succeeds regardless
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "TaskLeaders <info@task-leaders.com>";

  if (resendKey) {
    const html = [
      "<html><head><meta charset=\"utf-8\"></head>",
      `<body style="font-family:sans-serif;font-size:16px;color:#000000;line-height:1.6;">`,
      `<p>Hi ${firstName},</p>`,
      "<p>Thanks for requesting access to the TaskLeaders Concierge service. We'll review your application and be in touch shortly.</p>",
      "<p>— The TaskLeaders Team</p>",
      "</body></html>",
    ].join("\n");

    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: "Your Concierge Access Request — TaskLeaders",
        html,
        text: `Hi ${firstName},\n\nThanks for requesting access to the TaskLeaders Concierge service. We'll review your application and be in touch shortly.\n\n— The TaskLeaders Team`,
      }),
    }).catch(() => {}); // non-blocking
  }

  return json({ ok: true, data: { id: data.id } });
});
