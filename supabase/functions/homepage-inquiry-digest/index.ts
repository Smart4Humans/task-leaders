// homepage-inquiry-digest — Homepage Inquiry Engine v1B (internal daily digest)
//
// Sends ONE internal email summarizing homepage inquiries (Score requests +
// Marketplace waitlist) from the last 24h, plus unsent-email warnings and a
// current demand snapshot, so the admin does not have to remember to check the
// Supabase rows or the admin dashboard.
//
// Design constraints (Option 1 — smallest safe v1B):
//   • DB access is SELECT-ONLY. This function performs NO writes (no schema,
//     no admin_alerts, no timestamp updates). Dedupe is by created_at window.
//   • INTERNAL email only — recipient is always the admin address; a submitter
//     email is NEVER used as the recipient.
//   • Suppress-empty: if there are no new rows AND no unsent rows, send nothing
//     and return { sent: false }.
//   • Auth: x-cron-secret header must equal INTERNAL_CRON_SECRET (same gate as
//     process-timeouts). Triggered by pg_cron via pg_net once scheduled.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const ADMIN_LINK = "https://task-leaders.com/v0.5/admin/approve.html";

type Row = {
  id: string;
  type: string;
  status: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
  category_slug: string | null;
  category_label: string | null;
  city_or_area: string | null;
  city: string | null;
  category: string | null;
  internal_notification_sent_at: string | null;
  autoresponder_sent_at: string | null;
  created_at: string;
};

function scoreCategoryOf(r: Row): string {
  return (r.category_label || r.category_slug || "(uncategorized)").trim() || "(uncategorized)";
}
function waitlistCityCat(r: Row): string {
  const city = (r.city || "(no city)").trim() || "(no city)";
  const cat = (r.category || "(any)").trim() || "(any)";
  return `${city} · ${cat}`;
}
function tally(keys: string[]): [string, number][] {
  const m: Record<string, number> = {};
  for (const k of keys) m[k] = (m[k] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
function tallyLine(pairs: [string, number][]): string {
  return pairs.length ? pairs.map(([k, v]) => `${k}: ${v}`).join(" · ") : "none";
}
function tallyLineHtml(pairs: [string, number][]): string {
  return pairs.length ? pairs.map(([k, v]) => `${esc(k)}: ${v}`).join(" &middot; ") : "none";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  // Accepts EITHER the shared INTERNAL_CRON_SECRET (used by the production pg_cron
  // job via app.cron_secret) OR a dedicated DIGEST_CRON_SECRET (for manual/admin
  // triggers without touching the shared secret). Either match authorizes.
  const cronSecret     = Deno.env.get("INTERNAL_CRON_SECRET") ?? undefined;
  const digestSecret   = Deno.env.get("DIGEST_CRON_SECRET") ?? undefined;
  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Missing configuration" }, 500);
  }

  // Auth: x-cron-secret header must match either accepted secret.
  const incomingSecret = req.headers.get("x-cron-secret");
  const authed = !!incomingSecret && (
    (!!cronSecret   && incomingSecret === cronSecret) ||
    (!!digestSecret && incomingSecret === digestSecret)
  );
  if (!authed) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // ── SELECT 1: rows created in the last 24h (new + unsent sections) ──────────
  const { data: windowData, error: windowErr } = await supabase
    .from("homepage_inquiries")
    .select("id, type, status, email, first_name, last_name, business_name, category_slug, category_label, city_or_area, city, category, internal_notification_sent_at, autoresponder_sent_at, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(500);

  if (windowErr) return json({ ok: false, error: windowErr.message }, 500);
  const windowRows = (windowData ?? []) as Row[];

  // ── SELECT 2: lightweight all-rows pull for the current demand snapshot ─────
  const { data: demandData, error: demandErr } = await supabase
    .from("homepage_inquiries")
    .select("type, category_slug, category_label, category, city_or_area, city")
    .limit(2000);

  if (demandErr) return json({ ok: false, error: demandErr.message }, 500);
  const demandRows = (demandData ?? []) as Row[];

  const newScore    = windowRows.filter((r) => r.type === "score_assessment");
  const newWaitlist = windowRows.filter((r) => r.type === "marketplace_waitlist");
  const unsent      = windowRows.filter((r) => !r.internal_notification_sent_at || !r.autoresponder_sent_at);

  // Suppress-empty: nothing new AND nothing unsent → send no email.
  if (windowRows.length === 0 && unsent.length === 0) {
    return json({ ok: true, data: { sent: false, reason: "no new rows and no unsent rows in window" } });
  }

  // Demand snapshot (current — over all rows, not just the window).
  const scoreByCat = tally(demandRows.filter((r) => r.type === "score_assessment").map(scoreCategoryOf));
  const waitByCity = tally(demandRows.filter((r) => r.type === "marketplace_waitlist").map(waitlistCityCat));

  const resendKey  = Deno.env.get("RESEND_API_KEY");
  const adminEmail = Deno.env.get("TASKLEADERS_ADMIN_EMAIL") ?? "info@task-leaders.com";
  const fromEmail  = Deno.env.get("RESEND_FROM_EMAIL") ?? "TaskLeaders <info@task-leaders.com>";

  if (!resendKey) {
    // Can't send without the key; do not fail the cron loudly — report soft skip.
    return json({ ok: true, data: { sent: false, reason: "RESEND_API_KEY not configured" } });
  }

  const fullName = (r: Row) => (`${r.first_name || ""} ${r.last_name || ""}`).trim() || "(no name)";
  const mark = (ts: string | null) => (ts ? "yes" : "NO");
  const markHtml = (ts: string | null) => (ts ? "✓" : '<strong style="color:#b00020">✗</strong>');

  const unsentCount = unsent.length;
  const subject =
    `[TaskLeaders] Homepage inquiries - ${windowRows.length} new ` +
    `(${newScore.length} Score / ${newWaitlist.length} Waitlist)` +
    (unsentCount ? ` - ${unsentCount} unsent` : "");

  // ── Plain-text body ─────────────────────────────────────────────────────
  const textLines: string[] = [];
  textLines.push("TaskLeaders — Homepage inquiries (last 24h)");
  textLines.push("");
  textLines.push(`New: ${windowRows.length} (${newScore.length} Score, ${newWaitlist.length} Waitlist)`);
  if (unsentCount) textLines.push(`Unsent email warnings: ${unsentCount}`);
  textLines.push("");
  textLines.push(`Score requests (new): ${newScore.length}`);
  for (const r of newScore) {
    textLines.push(`  • ${fullName(r)} | ${r.business_name || "(no business)"} | ${scoreCategoryOf(r)} | ${r.city_or_area || "-"} | ${r.email || "-"} | notified:${mark(r.internal_notification_sent_at)} auto-reply:${mark(r.autoresponder_sent_at)}`);
  }
  textLines.push("");
  textLines.push(`Marketplace waitlist (new): ${newWaitlist.length}`);
  for (const r of newWaitlist) {
    textLines.push(`  • ${r.email || "-"} | ${r.city || "-"} | ${r.category || "-"} | notified:${mark(r.internal_notification_sent_at)} auto-reply:${mark(r.autoresponder_sent_at)}`);
  }
  if (unsentCount) {
    textLines.push("");
    textLines.push(`⚠ Unsent (missing internal notification or autoresponder), last 24h: ${unsentCount}`);
    for (const r of unsent) {
      const who = r.type === "score_assessment" ? `${fullName(r)} / ${r.business_name || "-"}` : (r.email || "-");
      textLines.push(`  • [${r.type}] ${who} | notified:${mark(r.internal_notification_sent_at)} auto-reply:${mark(r.autoresponder_sent_at)}`);
    }
  }
  textLines.push("");
  textLines.push("Demand snapshot (all rows):");
  textLines.push(`  Score requests by category: ${tallyLine(scoreByCat)}`);
  textLines.push(`  Waitlist by city · category: ${tallyLine(waitByCity)}`);
  textLines.push("");
  textLines.push(`Full read-only view: ${ADMIN_LINK}`);
  const textBody = textLines.join("\n");

  // ── HTML body ───────────────────────────────────────────────────────────
  const scoreRowsHtml = newScore.length
    ? newScore.map((r) => `<tr>
        <td>${esc(fullName(r))}</td><td>${esc(r.business_name || "—")}</td>
        <td>${esc(scoreCategoryOf(r))}</td><td>${esc(r.city_or_area || "—")}</td>
        <td>${esc(r.email || "—")}</td>
        <td style="text-align:center">${markHtml(r.internal_notification_sent_at)}</td>
        <td style="text-align:center">${markHtml(r.autoresponder_sent_at)}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" style="color:#777">No new Score requests in the last 24h.</td></tr>`;

  const waitRowsHtml = newWaitlist.length
    ? newWaitlist.map((r) => `<tr>
        <td>${esc(r.email || "—")}</td><td>${esc(r.city || "—")}</td><td>${esc(r.category || "—")}</td>
        <td style="text-align:center">${markHtml(r.internal_notification_sent_at)}</td>
        <td style="text-align:center">${markHtml(r.autoresponder_sent_at)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="color:#777">No new waitlist entries in the last 24h.</td></tr>`;

  const unsentHtml = unsentCount
    ? `<p style="margin-top:18px"><strong style="color:#b00020">⚠ Unsent (${unsentCount})</strong> — missing internal notification or autoresponder (last 24h):</p>
       <ul>${unsent.map((r) => {
         const who = r.type === "score_assessment" ? `${esc(fullName(r))} / ${esc(r.business_name || "—")}` : esc(r.email || "—");
         return `<li>[${esc(r.type)}] ${who} — notified ${markHtml(r.internal_notification_sent_at)} · auto-reply ${markHtml(r.autoresponder_sent_at)}</li>`;
       }).join("")}</ul>`
    : "";

  const tableStyle = `style="border-collapse:collapse;width:100%;font-size:13px"`;
  const thtd = `style="border:1px solid #ddd;padding:6px 8px;text-align:left"`;
  const htmlBody = `
    <html><head><meta charset="utf-8"></head>
    <body style="font-family:sans-serif;font-size:15px;color:#111;line-height:1.5">
      <p><strong>TaskLeaders — Homepage inquiries (last 24h)</strong></p>
      <p>New: <strong>${windowRows.length}</strong> (${newScore.length} Score &middot; ${newWaitlist.length} Waitlist)${unsentCount ? ` &middot; <strong style="color:#b00020">${unsentCount} unsent</strong>` : ""}</p>

      <p style="margin-bottom:4px"><strong>Score requests (new)</strong></p>
      <table ${tableStyle}><thead><tr>
        <th ${thtd}>Name</th><th ${thtd}>Business</th><th ${thtd}>Category</th><th ${thtd}>City/Area</th>
        <th ${thtd}>Email</th><th ${thtd}>Notified</th><th ${thtd}>Auto-reply</th>
      </tr></thead><tbody>${scoreRowsHtml}</tbody></table>

      <p style="margin:16px 0 4px"><strong>Marketplace waitlist (new)</strong></p>
      <table ${tableStyle}><thead><tr>
        <th ${thtd}>Email</th><th ${thtd}>City</th><th ${thtd}>Category</th>
        <th ${thtd}>Notified</th><th ${thtd}>Auto-reply</th>
      </tr></thead><tbody>${waitRowsHtml}</tbody></table>

      ${unsentHtml}

      <p style="margin-top:18px"><strong>Demand snapshot</strong> (all rows)<br>
        Score requests by category: ${tallyLineHtml(scoreByCat)}<br>
        Waitlist by city &middot; category: ${tallyLineHtml(waitByCity)}</p>

      <p style="margin-top:18px"><a href="${ADMIN_LINK}">Open the full read-only Homepage Inquiries view</a></p>
    </body></html>`;

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromEmail,
      to: [adminEmail], // INTERNAL admin recipient only — never a submitter email
      subject,
      html: htmlBody,
      text: textBody,
    }),
  });

  if (!emailRes.ok) {
    const errText = await emailRes.text().catch(() => "(unreadable)");
    console.error(`[homepage-inquiry-digest] Resend send FAILED: HTTP ${emailRes.status}. Body: ${errText.substring(0, 500)}`);
    return json({ ok: false, error: `Resend send failed (HTTP ${emailRes.status})` }, 502);
  }

  return json({
    ok: true,
    data: {
      sent: true,
      to: adminEmail,
      new_total: windowRows.length,
      new_score: newScore.length,
      new_waitlist: newWaitlist.length,
      unsent: unsentCount,
    },
  });
});
