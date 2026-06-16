// TaskLeaders — Edge Function: homepage-inquiry
// Contract: POST /homepage-inquiry
// Captures public homepage Score requests (service pros) and Marketplace
// waitlist signups (clients) as funnel stage 1.
//
// IMPORTANT business rules (do not regress):
//  - There is NO scoring-on-demand backend. Score requests are captured for
//    MANUAL review / triage. Never promise instant or automated scoring.
//  - This endpoint does NOT handle provider applications. Those keep their own
//    path (become-task-leader.html -> /apply -> public.applications). Any type
//    other than the two below is rejected.
//  - No Airtable. Writes go to Supabase public.homepage_inquiries via service role.

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
function error(code: string, message: string, details?: unknown, status = 400) {
  return json({ ok: false, error: { code, message, details } }, status);
}

// ── Length caps (reject over-cap) ───────────────────────────────────────────
const CAPS: Record<string, number> = {
  email: 320, first_name: 100, last_name: 100, business_name: 200,
  category: 80, category_slug: 80, category_label: 80, city: 120,
  city_or_area: 120, website: 500, note: 2000, page: 300,
};
function overCap(field: string, value: string) {
  const cap = CAPS[field];
  return cap !== undefined && value.length > cap;
}

// ── Category taxonomy (Marketplace categories — NOT a score-readiness signal) ─
const LABEL_TO_SLUG: Record<string, string> = {
  "cleaning": "cleaning", "handyman": "handyman", "hvac": "hvac",
  "electrical": "electrical", "plumbing": "plumbing", "painting": "painting",
  "yard work": "yard-work", "yard-work": "yard-work",
  "moving / transport": "moving", "moving": "moving", "transport": "moving",
};
const KNOWN_SLUGS = new Set([
  "cleaning", "handyman", "hvac", "electrical", "plumbing", "painting", "yard-work", "moving",
]);
// v0.2: empty on purpose. Nothing is auto-marked "supported" until Todd enables it.
const SCORE_READY_CATEGORIES = new Set<string>([]);

function categorySlugFromLabel(raw: string) {
  const key = raw.trim().toLowerCase();
  return LABEL_TO_SLUG[key] ?? key.replace(/\s+/g, "-");
}

// ── Canonical consent text (server-authoritative; not trusted from client) ───
const CONSENT_TEXT_SCORE =
  "I agree that TaskLeaders may store my submitted business details and email me about my private Score request and related follow-up.";
const CONSENT_TEXT_WAITLIST =
  "I agree that TaskLeaders may store my submitted details and email me about Marketplace availability and related updates.";

const SCORE_REPLY_TO = "score@task-leaders.com";
const WAITLIST_REPLY_TO = "info@task-leaders.com";

function esc(s: string) {
  return String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
}

async function sendResend(opts: {
  key: string; from: string; to: string; replyTo: string;
  subject: string; text: string; html: string;
}): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${opts.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: opts.from, to: [opts.to], reply_to: opts.replyTo,
        subject: opts.subject, text: opts.text, html: opts.html,
      }),
    });
    return res.ok;
  } catch (_e) {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} }, 200);
  if (req.method !== "POST") return error("bad_request", "Method not allowed", { method: req.method }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return error("server_error", "Missing server configuration", {
      missing: [!supabaseUrl ? "SUPABASE_URL" : null, !serviceRoleKey ? "TASKLEADERS_SERVICE_ROLE_KEY" : null].filter(Boolean),
    }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return error("bad_request", "Invalid JSON body");
  }

  // ── Honeypot: bots fill the hidden honeypot field. Pretend success; no write. ─
  // Field is named to avoid browser/password-manager autofill (was "nickname",
  // an autofill magnet that produced false positives → silent lead loss).
  if (cleanString(body.hp)) {
    return json({ ok: true, data: { received: true } }, 200);
  }

  const type = cleanString(body.type);
  if (type !== "score_assessment" && type !== "marketplace_waitlist") {
    return error("validation_error", "Unsupported inquiry type", { field: "type" });
  }

  const email = normalizeEmail(body.email);
  if (!email || !email.includes("@")) return error("validation_error", "Valid email is required", { field: "email" });
  if (overCap("email", email)) return error("validation_error", "Email is too long", { field: "email" });

  const consent = body.consent === true || cleanString(body.consent) === "true" || cleanString(body.consent) === "agreed";
  if (!consent) return error("validation_error", "Consent is required", { field: "consent" });

  // server-derived provenance (never trusted from the client body)
  const referrer = req.headers.get("referer");
  const userAgent = req.headers.get("user-agent");
  const page = cleanString(body.page);
  if (overCap("page", page)) return error("validation_error", "Invalid page", { field: "page" });
  const nowIso = new Date().toISOString();

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let row: Record<string, unknown>;
  let notifyTo: string;
  let replyTo: string;
  let autosubject: string;
  let autotext: string;
  let autohtml: string;

  if (type === "score_assessment") {
    const firstName = cleanString(body.first_name);
    const lastName = cleanString(body.last_name);
    const businessName = cleanString(body.business_name);
    const categoryLabel = cleanString(body.category);
    const cityOrArea = cleanString(body.city_or_area);
    const website = cleanString(body.website);
    const note = cleanString(body.note);

    if (!firstName) return error("validation_error", "First name is required", { field: "first_name" });
    if (!lastName) return error("validation_error", "Last name is required", { field: "last_name" });
    if (!businessName) return error("validation_error", "Business name is required", { field: "business_name" });
    if (!categoryLabel) return error("validation_error", "Service category is required", { field: "category" });
    if (!cityOrArea) return error("validation_error", "Primary city / service area is required", { field: "city_or_area" });
    for (const [f, v] of Object.entries({ first_name: firstName, last_name: lastName, business_name: businessName, category_label: categoryLabel, city_or_area: cityOrArea, website, note })) {
      if (overCap(f, v as string)) return error("validation_error", `${f} is too long`, { field: f });
    }

    const categorySlug = categorySlugFromLabel(categoryLabel);
    const known = KNOWN_SLUGS.has(categorySlug);
    const scoreCategoryStatus = SCORE_READY_CATEGORIES.has(categorySlug)
      ? "supported"
      : (known ? "manual_review" : "unknown");

    row = {
      type, status: "new", email,
      first_name: firstName, last_name: lastName, business_name: businessName,
      category_slug: categorySlug, category_label: categoryLabel,
      city_or_area: cityOrArea, website: website || null, note: note || null,
      consent: true, consent_text: CONSENT_TEXT_SCORE, consent_at: nowIso,
      source: "homepage", page: page || null, referrer, user_agent: userAgent,
      meta: { score_ready: SCORE_READY_CATEGORIES.has(categorySlug), known_category: known },
      score_category_status: scoreCategoryStatus,
      score_status: scoreCategoryStatus === "supported" ? "queued" : "not_started",
      offer_stage: "free_score_requested",
      followup_status: "pending",
    };

    notifyTo = "score@task-leaders.com";
    replyTo = SCORE_REPLY_TO;
    autosubject = "We received your TaskLeaders Score request";
    if (scoreCategoryStatus === "unknown") {
      autotext = `Hi ${firstName}, thanks for requesting your free TaskLeaders Score. We've received your request for ${businessName} and will review it before following up by email. If we need clarification about your service category, we'll ask by email. Your assessment is private and we don't publish your score.\n— The TaskLeaders Team`;
    } else {
      autotext = `Hi ${firstName}, thanks for requesting your free TaskLeaders Score. We've received your request for ${businessName} and will review it before following up by email. Your assessment is private and we don't publish your score. You can reply to this email with anything you'd like us to know.\n— The TaskLeaders Team`;
    }
    autohtml = `<p>${esc(autotext).replace(/\n/g, "<br>")}</p>`;
  } else {
    // marketplace_waitlist
    const city = cleanString(body.city);
    const category = cleanString(body.category);
    if (!city) return error("validation_error", "City is required", { field: "city" });
    for (const [f, v] of Object.entries({ city, category })) {
      if (overCap(f, v as string)) return error("validation_error", `${f} is too long`, { field: f });
    }

    row = {
      type, status: "new", email,
      city, category: category || null,
      consent: true, consent_text: CONSENT_TEXT_WAITLIST, consent_at: nowIso,
      source: "homepage", page: page || null, referrer, user_agent: userAgent,
      offer_stage: "none", followup_status: "pending",
    };

    notifyTo = "info@task-leaders.com";
    replyTo = WAITLIST_REPLY_TO;
    autosubject = "You're on the TaskLeaders Marketplace waitlist";
    const catPhrase = category ? ` for ${category}` : "";
    autotext = `Hi there, thanks for your interest in TaskLeaders. We've added you to the waitlist for ${city}${catPhrase}. We'll email you when Marketplace access opens in your area. We're onboarding carefully, so this isn't available yet. You can reply anytime if you no longer want updates.\n— The TaskLeaders Team`;
    autohtml = `<p>${esc(autotext).replace(/\n/g, "<br>")}</p>`;
  }

  // ── 1) Durable insert FIRST (never lose the record to an email failure) ─────
  const { data, error: insErr } = await supabase
    .from("homepage_inquiries")
    .insert(row)
    .select("id")
    .single();

  if (insErr) {
    console.error("[homepage-inquiry] insert failed", insErr);
    return error("server_error", "Failed to submit. Please try again.", undefined, 500);
  }
  const id = data.id as string;

  // ── 2) Best-effort emails AFTER the durable write. Failures never 500. ──────
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "TaskLeaders <info@task-leaders.com>";
  if (resendKey) {
    try {
      const r = row as Record<string, string>;
      const internalLines = type === "score_assessment"
        ? [
            "New TaskLeaders Score request (manual review)", "",
            `Name: ${r.first_name} ${r.last_name}`, `Email: ${email}`,
            `Business: ${r.business_name}`,
            `Category: ${r.category_label} (slug: ${r.category_slug}; status: ${r.score_category_status})`,
            `City / area: ${r.city_or_area}`,
            `Website: ${r.website || "(not provided)"}`,
            `Note: ${r.note || "(none)"}`,
            `Consent: ${CONSENT_TEXT_SCORE}`, `Consent at: ${nowIso}`,
            `Source: homepage  Page: ${page || "(n/a)"}`, `Record id: ${id}`,
          ]
        : [
            "New TaskLeaders Marketplace waitlist signup", "",
            `Email: ${email}`, `City: ${r.city}`, `Category needed: ${r.category || "(not provided)"}`,
            `Consent: ${CONSENT_TEXT_WAITLIST}`, `Consent at: ${nowIso}`,
            `Source: homepage  Page: ${page || "(n/a)"}`, `Record id: ${id}`,
          ];
      const internalText = internalLines.join("\n");

      const [internalOk, autoOk] = await Promise.all([
        sendResend({
          key: resendKey, from: fromEmail, to: notifyTo, replyTo: email,
          subject: type === "score_assessment"
            ? `New Score request — ${(row as any).business_name}`
            : `New Marketplace waitlist — ${(row as any).city}`,
          text: internalText, html: `<pre style="font-family:sans-serif;font-size:14px;white-space:pre-wrap">${esc(internalText)}</pre>`,
        }),
        sendResend({
          key: resendKey, from: fromEmail, to: email, replyTo,
          subject: autosubject, text: autotext, html: autohtml,
        }),
      ]);

      const patch: Record<string, string> = {};
      if (internalOk) patch.internal_notification_sent_at = nowIso;
      if (autoOk) patch.autoresponder_sent_at = nowIso;
      if (Object.keys(patch).length) {
        await supabase.from("homepage_inquiries").update(patch).eq("id", id);
      }
    } catch (e) {
      console.error("[homepage-inquiry] email step failed (record already saved)", e);
    }
  }

  return json({ ok: true, data: { id } }, 200);
});
