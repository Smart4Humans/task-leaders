// TaskLeaders — Edge Function: twilio-webhook
// Contract: POST /twilio-webhook (Twilio form-encoded inbound message data)
//
// Handles ALL inbound WhatsApp messages to the TaskLeaders number.
// Routes based on sender identity, job context, and session state.
//
// ── Job context resolution (§10, ordered) ────────────────────────────────────
// 1. Explicit public job ID in reply body (e.g. "PLM-00001")
// 2. Pending prompt context in conversation_sessions (last_prompt / session_state)
// 3. Single active job_participants entry for this sender
// 4. current_job_id from session if that job is still in an active state
// 5. Escalate to admin as ambiguous
//
// ── Multi-job relay safety ────────────────────────────────────────────────────
// All relayed messages include the job header: [Job #PLM-00001 | 123 Main St]
// so clients and providers can distinguish threads when multiple jobs are active.
// When a sender has multiple active jobs and no explicit job ID, a disambiguation
// prompt is sent rather than silently routing to the wrong job.
//
// ── Routing constraint ────────────────────────────────────────────────────────
// All messages route through the TaskLeaders WhatsApp number.
// No direct number exchange. This applies to both Concierge and Marketplace.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  validateTwilioSignature, getTwilioEnv, sendWhatsApp, logMessage,
  buildWC4, buildWC2, buildRelayToProvider, buildRelayToClient,
  SURVEY_QUESTIONS, buildMKT2Declined, jobHeader,
} from "../_shared/twilio.ts";
import {
  normalizeKeyword,
  KW_ACCEPT, KW_PASS, KW_DECLINE, KW_HELP,
  KW_KEEP_OPEN, KW_KEEP_SEARCHING, KW_CANCEL, KW_CLOSE_NOW, KW_YES, KW_NO, KW_CLOSE, KW_DONE,
  CATEGORY_NAMES, CATEGORY_LEAD_FEES_CENTS, calcGst as calcGstFn,
  SLUG_TO_CATEGORY_CODE, extractMunicipalityFromAddress,
} from "../_shared/constants.ts";
import { toPublicJobId } from "../_shared/job-ids.ts";

// Re-declare GST calc locally to keep import clean
function calcGst(base: number) { return Math.round(base * 0.05); }

// ─── Reserved cancel commands ─────────────────────────────────────────────────
// Checked before any address/timing parsing in intake states.
// Any of these signals an intent to abort the current intake session.

function isCancelCommand(body: string): boolean {
  const lower = body.trim().toLowerCase();
  return lower === "cancel" || lower === "stop" || lower === "never mind" || lower === "nevermind";
}

// ─── Thread-close commands ───────────────────────────────────────────────────
// Intercepted in active (open) thread sessions — BEFORE relay — so they are
// never forwarded to the other participant as chat messages.
// Triggers the two-step close confirmation flow (prompt → YES/NO).

function isThreadCloseCommand(kw: string): boolean {
  return kw === KW_CLOSE || kw === KW_CANCEL || kw === KW_DONE;
}

// ─── TwiML response (no auto-reply) ──────────────────────────────────────────

function twilioResponse() {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
    { headers: { "content-type": "text/xml; charset=utf-8" } },
  );
}
function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ─── Context type ─────────────────────────────────────────────────────────────

interface Ctx {
  supabase:       ReturnType<typeof createClient>;
  supabaseUrl:    string;
  serviceRoleKey: string;
  twilioEnv:      ReturnType<typeof getTwilioEnv>;
  fromNumber:     string;
  body:           string;
  messageSid:     string;
  session:        Record<string, unknown> | null;
}

// ─── sendAndLog ───────────────────────────────────────────────────────────────
// Wraps sendWhatsApp + logMessage so the actual Twilio result is always captured.
//
// Previously, sendWhatsApp was called with its return value discarded, and
// logMessage was always called with status: "sent" regardless of outcome.
// If Twilio returned an error (wrong number format, sandbox join required,
// bad credentials, permission denied, etc.) there was zero visibility.
//
// This helper:
//   1. Calls sendWhatsApp and captures { ok, messageSid, error }
//   2. Writes the actual status to message_log ("sent" | "failed" | "no_twilio_env")
//   3. If !ok, inserts an admin_alerts row (escalation / high) with the Twilio error
//      so failures surface without manual SQL inspection
//   4. Returns the ok boolean so callers can branch if needed

async function sendAndLog(
  ctx:          Ctx,
  to:           string,
  messageBody:  string,
  opts: {
    jobId?:        string | null;
    templateName?: string | null;
  } = {},
): Promise<boolean> {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv } = ctx;

  let ok         = false;
  let messageSid: string | null = null;
  let sendError:  string | null = null;

  if (twilioEnv) {
    const result = await sendWhatsApp(twilioEnv, to, messageBody);
    ok         = result.ok;
    messageSid = result.messageSid;
    sendError  = result.error;

    if (!result.ok) {
      // Write failure to admin_alerts so it's visible without manual SQL checking.
      // The process-timeouts escalation email arm picks this up on its next run.
      try {
        await supabase.from("admin_alerts").insert({
          alert_type:           "escalation",
          priority:             "high",
          job_id:               opts.jobId ?? null,
          participant_whatsapp: to,
          description:
            `sendWhatsApp FAILED. To: ${to}. ` +
            `Twilio error: ${result.error ?? "unknown"}. ` +
            `Template: ${opts.templateName ?? "(none)"}. ` +
            `Body preview: ${messageBody.substring(0, 100)}.`,
          status: "open",
        });
      } catch { /* non-fatal: alert insert failure does not block flow */ }
    }
  }

  // Log with actual send status — never hardcode "sent".
  logMessage({
    supabaseUrl,
    serviceRoleKey,
    direction:           "outbound",
    jobId:               opts.jobId ?? null,
    participantWhatsapp: to,
    messageSid,
    templateName:        opts.templateName ?? null,
    body:                messageBody,
    status:              !twilioEnv ? "no_twilio_env"
                       : ok        ? "sent"
                       :             "failed",
  });

  return ok;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResp({ ok: true });
  if (req.method !== "POST")    return new Response("Method not allowed", { status: 405 });

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const twilioToken    = Deno.env.get("TWILIO_AUTH_TOKEN");
  const webhookUrl     = Deno.env.get("TWILIO_WEBHOOK_URL");

  if (!supabaseUrl || !serviceRoleKey || !twilioToken) {
    return new Response("Missing configuration", { status: 500 });
  }

  const rawBody = await req.text();
  const params  = Object.fromEntries(new URLSearchParams(rawBody).entries());

  // Validate Twilio signature (set TWILIO_SKIP_SIG=true in dev/sandbox)
  if (Deno.env.get("TWILIO_SKIP_SIG") !== "true" && webhookUrl) {
    const sig   = req.headers.get("x-twilio-signature") ?? "";
    const valid = await validateTwilioSignature(twilioToken, webhookUrl, params, sig);
    if (!valid) return new Response("Invalid signature", { status: 403 });
  }

  // Strip the "whatsapp:" prefix Twilio prepends to From/To fields.
  const fromRaw    = (params["From"] ?? "").replace(/^whatsapp:/, "");
  const body       = (params["Body"] ?? "").trim();
  const messageSid = params["MessageSid"] ?? "";

  if (!fromRaw) return twilioResponse();

  // Normalize to E.164 (e.g. "+16041234567").
  // Twilio always sends the + prefix; stored numbers in concierge_clients / provider_accounts
  // may have been entered without it. We derive both forms and use an OR lookup so a
  // format mismatch in the DB never silently misroutes the sender.
  const fromNumber       = fromRaw.startsWith("+") ? fromRaw : `+${fromRaw.replace(/\D/g, "")}`;
  const fromNumberDigits = fromNumber.replace(/^\+/, ""); // e.g. "16041234567" — no + prefix

  const supabase  = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const twilioEnv = getTwilioEnv();

  // Log inbound immediately (job_id unknown at this point).
  // Awaited with try/catch — PostgrestFilterBuilder does not have .catch().
  // A log failure is non-fatal; the webhook continues regardless.
  try {
    await supabase.from("message_log").insert({
      direction:            "inbound",
      participant_whatsapp: fromNumber,
      twilio_message_sid:   messageSid,
      body,
      status: "received",
    });
  } catch { /* non-fatal: log insert failure does not block webhook processing */ }

  // ── Identify sender ────────────────────────────────────────────────────────
  // Match the stored number in either +E164 or plain-digits format, and filter
  // at the DB level to a single usable (active, not suspended) row.
  //
  // Uses .in() instead of .or() so a literal '+' in the E.164 form never reaches
  // PostgREST URL decoding. Uses .limit(1) instead of .maybeSingle() so multi-row
  // matches (duplicate rows across number formats, or shared numbers) cannot
  // silently poison the lookup with PGRST116. Any PostgrestError is surfaced to
  // admin_alerts so a broken lookup cannot fall through to "we don't have a record".
  const [clientRes, providerRes] = await Promise.all([
    supabase
      .from("concierge_clients")
      .select("id, first_name, last_name, name, status, suspended, risk_flags")
      .in("whatsapp", [fromNumber, fromNumberDigits])
      .eq("status", "active")
      .eq("suspended", false)
      .limit(1),
    supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, status, suspended, concierge_eligible, card_on_file")
      .in("whatsapp_number", [fromNumber, fromNumberDigits])
      .eq("status", "active")
      .eq("suspended", false)
      .limit(1),
  ]);

  if (clientRes.error || providerRes.error) {
    try {
      await supabase.from("admin_alerts").insert({
        alert_type:          "escalation",
        priority:            "high",
        participant_whatsapp: fromNumber,
        description:
          `Sender lookup failed. ` +
          `client_err=${clientRes.error?.code ?? "-"}:${clientRes.error?.message ?? "-"} ` +
          `provider_err=${providerRes.error?.code ?? "-"}:${providerRes.error?.message ?? "-"}`,
        status: "open",
      });
    } catch { /* non-fatal: alert insert failure does not block webhook processing */ }
  }

  const client   = clientRes.data?.[0] ?? null;
  const provider = providerRes.data?.[0] ?? null;

  // ── Load conversation session ─────────────────────────────────────────────
  const { data: session } = await supabase
    .from("conversation_sessions")
    .select("*")
    .eq("whatsapp_e164", fromNumber)
    .maybeSingle();

  const updateSession = (patch: Record<string, unknown>) =>
    supabase.from("conversation_sessions").upsert(
      { whatsapp_e164: fromNumber, last_activity_at: new Date().toISOString(), ...patch },
      { onConflict: "whatsapp_e164" },
    );

  const ctx: Ctx = { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body, messageSid, session };

  // ── Route ─────────────────────────────────────────────────────────────────
  if (client && client.status === "active" && !client.suspended) {
    await handleClientMessage(ctx, client, updateSession);
  } else if (provider && provider.status === "active" && !provider.suspended) {
    await handleProviderMessage(ctx, provider, updateSession);
  } else {
    await handleUnknownSender(ctx, client, provider);
  }

  return twilioResponse();
});

// ─── Job context resolution ───────────────────────────────────────────────────
// Returns { jobId, address, confident } or null if unresolvable.
// "confident" = false means we used a best-effort guess and should flag it.

interface JobContext { jobId: string; address: string; source: string; confident: boolean; }

async function resolveJobContext(
  supabase: ReturnType<typeof createClient>,
  fromNumber: string,
  sessionJobId: string | undefined,
  messageBody: string,
): Promise<JobContext | "ambiguous" | null> {
  // Step 1: Explicit public job ID in message body (e.g. "PLM-00001")
  const match = messageBody.match(/\b([A-Z]{2,3}-\d{5})\b/);
  if (match) {
    const [cat, seq] = match[1].split("-");
    // Search for matching internal job ID (city prefix varies; match by cat+seq)
    const { data: jobs } = await supabase
      .from("jobs")
      .select("job_id, address, source")
      .like("job_id", `%-${cat}-${seq}`)
      .not("state", "in", '("closed","cancelled")')
      .limit(2);
    if (jobs && jobs.length === 1) {
      return { jobId: jobs[0].job_id, address: jobs[0].address ?? "address on file", source: jobs[0].source, confident: true };
    }
    // Multiple matches unlikely but guard against it
  }

  // Step 2 + 4: Use session's current_job_id if still active
  if (sessionJobId) {
    const { data: job } = await supabase
      .from("jobs")
      .select("job_id, address, source, state")
      .eq("job_id", sessionJobId)
      .not("state", "in", '("closed","cancelled","survey_complete")')
      .maybeSingle();
    if (job) {
      return { jobId: job.job_id, address: job.address ?? "address on file", source: job.source, confident: true };
    }
  }

  // Step 3: Single active job_participants entry for this sender
  const { data: parts } = await supabase
    .from("job_participants")
    .select("job_id")
    .eq("whatsapp_e164", fromNumber)
    .eq("session_state", "active");

  if (!parts || parts.length === 0) return null;

  if (parts.length === 1) {
    const { data: job } = await supabase
      .from("jobs")
      .select("job_id, address, source")
      .eq("job_id", parts[0].job_id)
      .maybeSingle();
    if (job) {
      return { jobId: job.job_id, address: job.address ?? "address on file", source: job.source, confident: true };
    }
  }

  // Step 5: Multiple active jobs — ambiguous
  if (parts.length > 1) return "ambiguous";

  return null;
}

// ─── Client message handler ───────────────────────────────────────────────────

async function handleClientMessage(
  ctx: Ctx,
  client: Record<string, unknown>,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { twilioEnv, fromNumber, body } = ctx;
  const sessionState  = String(ctx.session?.session_state ?? "idle");
  const currentJobId  = ctx.session?.current_job_id as string | undefined;
  const kw            = normalizeKeyword(body);

  // ── Survey answer ─────────────────────────────────────────────────────────
  if (sessionState.startsWith("awaiting_survey_q")) {
    await handleSurveyAnswer(ctx, sessionState, currentJobId, kw, updateSession);
    return;
  }

  // ── Guarantee claim confirmation ───────────────────────────────────────────
  if (sessionState === "awaiting_guarantee_confirm") {
    await handleGuaranteeConfirmation(ctx, currentJobId, kw, updateSession);
    return;
  }

  // ── No-match decision ──────────────────────────────────────────────────────
  if (sessionState === "awaiting_no_match_decision") {
    await handleNoMatchDecision(ctx, currentJobId, kw, updateSession);
    return;
  }

  // ── Awaiting match (job broadcast sent; pre-ACCEPT/payment) ───────────────
  // Set by finalizeAndDispatch so a subsequent inbound from the client cannot
  // silently start a second intake while the first is still being matched.
  // Accepts a cancel command to abort the current job; any other message gets
  // a "still searching" acknowledgement without falling through to a new intake.
  if (sessionState === "awaiting_match") {
    await handleAwaitingMatchMessage(ctx, currentJobId, body, updateSession);
    return;
  }

  // ── Structured intake wizard states (Phase 1 + 2) ──────────────────────────
  // Each handler owns its own cancel check so NO / CANCEL at any pre-finalize
  // step cleanly resets the session and cancels the draft job if one exists.
  if (sessionState === "awaiting_service") {
    await handleAwaitingService(ctx, client, updateSession);
    return;
  }
  if (sessionState === "awaiting_service_confirm") {
    await handleAwaitingServiceConfirm(ctx, client, updateSession);
    return;
  }
  if (sessionState === "awaiting_municipality") {
    await handleAwaitingMunicipality(ctx, updateSession);
    return;
  }
  if (sessionState === "awaiting_final_confirm") {
    await handleAwaitingFinalConfirm(ctx, updateSession);
    return;
  }
  if (sessionState === "awaiting_edit_choice") {
    await handleAwaitingEditChoice(ctx, updateSession);
    return;
  }

  // ── Thread-close confirmation ──────────────────────────────────────────────
  // Client has already been shown the close prompt and is answering YES/NO.
  if (sessionState === "awaiting_close_confirm") {
    await handleCloseConfirm(ctx, currentJobId, kw, "client", updateSession);
    return;
  }

  // ── Active thread: relay to provider ──────────────────────────────────────
  if (sessionState === "open" || sessionState === "active") {
    // Intercept close commands BEFORE relay — never forward them as chat messages.
    if (isThreadCloseCommand(kw) && currentJobId) {
      await handleCloseRequest(ctx, currentJobId, updateSession);
      return;
    }
    const jctx = await resolveJobContext(ctx.supabase, fromNumber, currentJobId, body);
    if (jctx === "ambiguous") {
      await sendDisambiguationPrompt(ctx, updateSession);
      return;
    }
    if (jctx) {
      await relayClientToProvider(ctx, jctx, updateSession);
      return;
    }
    // Session says open but no active job — fall through to intake
  }

  // ── New intake ─────────────────────────────────────────────────────────────
  await handleConciergeIntake(ctx, client, updateSession);
}

// ─── Disambiguation prompt ────────────────────────────────────────────────────

async function sendDisambiguationPrompt(
  ctx: Ctx,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  // List active jobs for this sender
  const { data: parts } = await supabase
    .from("job_participants")
    .select("job_id")
    .eq("whatsapp_e164", fromNumber)
    .eq("session_state", "active");

  if (!parts || parts.length === 0) {
    // No active jobs — treat as new intake
    await handleConciergeIntake(ctx, {}, updateSession);
    return;
  }

  const jobLines: string[] = [];
  for (const p of parts) {
    const { data: job } = await supabase
      .from("jobs")
      .select("job_id, category_name, category_code")
      .eq("job_id", p.job_id)
      .maybeSingle();
    if (job) {
      const catName = CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code;
      jobLines.push(`• ${catName} — reply with ${toPublicJobId(job.job_id)}`);
    }
  }

  const prompt = (
    `You have multiple active jobs. To route your message correctly, please include the job ID.\n\n` +
    jobLines.join("\n") + `\n\nExample: "${toPublicJobId(parts[0].job_id)}: your message here"`
  );

  await sendAndLog(ctx, fromNumber, prompt, { templateName: "DISAMBIGUATION_PROMPT" });
  await updateSession({ session_state: "open", last_prompt: prompt });
}

// ─── Timing phrase extractor ──────────────────────────────────────────────────
// Extracts the specific timing signal from free-text, not the whole sentence.
// Patterns are ordered most-specific → least-specific so compound phrases like
// "tomorrow morning" match before their individual words.
// Returns the matched substring (original casing preserved) or null if no match.

function extractTimingPhrase(text: string): string | null {
  const patterns: RegExp[] = [
    /\b(tomorrow\s+(?:morning|afternoon|evening))\b/i,
    /\b(this\s+(?:morning|afternoon|evening|weekend|week))\b/i,
    /\b(next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|week))\b/i,
    /\b((?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:morning|afternoon|evening))\b/i,
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\b(tomorrow)\b/i,
    /\b(today)\b/i,
    /\b(asap)\b/i,
    /\b(weekend)\b/i,
    /\b(morning|afternoon|evening)\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── Inline address extractor ────────────────────────────────────────────────
// Used on the FIRST intake message only, to detect whether a complete address
// was included up-front (e.g. "I need a cleaner at 123 Main St, New Westminster").
//
// Two independent guards must both pass — this is what keeps false-positive risk low:
//   1. Known municipality via extractMunicipalityFromAddress() — precise, exhaustive list.
//   2. A plausible street-number pattern via one of two sub-tests:
//        a. Contextual: number directly follows "at ", "@", or message start (^).
//           "at" + number eliminates most quantity phrases ("at 10 units" is
//           unrealistic; "I need 10 units" has no "at" before the digit).
//        b. Structural: number followed by a common BC street-type abbreviation
//           (St, Ave, Blvd, Rd, Dr, Way, Ln, Crt, Pl, Cres, Terr, Hwy).
//           Catches "123 Main Ave, Vancouver" without a leading "at".
//
// 2+ digit minimum for contextual path (eliminates "1 plumber").
// Street-type path uses 2+ digits plus an explicit suffix — very low false-positive risk.
//
// Returns the composed address string and municipality info, or null if either
// guard fails.

function extractInlineAddress(
  text: string,
): { address: string; code: string; name: string } | null {
  // Guard 1: known municipality
  const munResult = extractMunicipalityFromAddress(text);
  if (!munResult) return null;

  // Guard 2a: contextual — number following "at", "@", or start-of-message
  const contextualMatch = /(?:^|\bat\s+|@\s*)(\d{2,}[A-Za-z]?\s+[A-Za-z][^,]*)/i.exec(text);
  // Guard 2b: structural — number followed by a recognised BC street-type suffix
  const structuralMatch = /\b(\d{2,}[A-Za-z]?\s+[A-Za-z][A-Za-z0-9\s.-]*\b(?:street|avenue|boulevard|road|drive|way|lane|court|place|crescent|terrace|highway|st|ave|blvd|rd|dr|ln|crt|pl|cres|terr|hwy)\b)/i.exec(text);

  const rawFragment = (contextualMatch?.[1] ?? structuralMatch?.[1] ?? "").trim();
  if (!rawFragment) return null;

  // Trim the fragment to end at the municipality name, discarding any trailing
  // words (e.g. "123 Main St New Westminster please" → "123 Main St New Westminster").
  const munNameEscaped = munResult.name.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&").replace(/\s+/g, "\\s+");
  const munInFrag = new RegExp(munNameEscaped, "i").exec(rawFragment);
  const fragment  = munInFrag
    ? rawFragment.slice(0, munInFrag.index + munInFrag[0].length).trim()
    : rawFragment.trim();

  // Compose: append municipality name if not already present in the fragment.
  const address = extractMunicipalityFromAddress(fragment)
    ? fragment
    : `${fragment}, ${munResult.name}`;

  return { address, code: munResult.code, name: munResult.name };
}

// ─── Category keyword matching ────────────────────────────────────────────────
// Module-level so both the fresh-intake path and the opening-remainder helper
// can see the keyword that fired without re-deriving it.

const CATEGORY_KEYWORDS: [string[], string][] = [
  [["plumb", "pipe", "leak", "drain"],                 "PLM"],
  [["clean"],                                          "CLN"],
  [["handyman", "repair", "fix", "install"],           "HND"],
  [["electric", "outlet", "wiring", "breaker"],        "ELC"],
  [["paint"],                                          "PLT"],
  [["hvac", "heat", "furnace", "air condition", "ac"], "HVC"],
  [["mov", "transport", "haul"],                       "MVG"],
  [["yard", "lawn", "garden", "snow"],                 "YRD"],
];

function matchCategoryKeyword(text: string): { code: string; keyword: string } | null {
  const lower = text.toLowerCase();
  for (const [keywords, code] of CATEGORY_KEYWORDS) {
    const hit = keywords.find((kw) => lower.includes(kw));
    if (hit) return { code, keyword: hit };
  }
  return null;
}

// ─── Opening-message details remainder ────────────────────────────────────────
// After address + timing are captured from the client's opening message, see
// whether the leftover text is substantial enough to treat as the service
// description — letting us skip the extra "briefly describe…" prompt.
//
// Conservative thresholds: at least 4 content words (stopwords excluded) AND
// at least 15 non-whitespace chars in the remainder. Stopwords are excluded
// from the count but preserved in the returned string so it reads naturally.

const OPENING_REMAINDER_STOPWORDS = new Set([
  "i", "need", "a", "an", "the", "please", "to", "for", "in", "at", "on", "my", "our",
]);
const OPENING_REMAINDER_MIN_CONTENT_WORDS = 4;
const OPENING_REMAINDER_MIN_CHARS         = 15;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractOpeningRemainder(
  opening: string,
  parts: {
    address?: string | null;
    timingPhrase?: string | null;
    categoryKeyword?: string | null;
  },
): string | null {
  if (!opening) return null;
  let remainder = opening;

  // Strip the address phrase along with any immediately preceding connector word
  // (at / @ / in / on / near / by) so we don't leave fragments like "I need help at."
  // after the address is removed. Falls back to bare-phrase strip if no connector is
  // adjacent.
  if (parts.address) {
    const addr = escapeRegExp(parts.address);
    const re = new RegExp(`\\b(?:at|@|in|on|near|by)\\s+${addr}|${addr}`, "i");
    remainder = remainder.replace(re, " ");
  }

  // Strip the timing phrase as a plain substring (first occurrence, case-insensitive).
  if (parts.timingPhrase) {
    const re = new RegExp(escapeRegExp(parts.timingPhrase), "i");
    remainder = remainder.replace(re, " ");
  }

  // Strip the category keyword only at a word boundary so compound forms like
  // "cleaner", "cleaning", or "deep-clean" are preserved in the description.
  if (parts.categoryKeyword) {
    const re = new RegExp(`\\b${escapeRegExp(parts.categoryKeyword)}\\b`, "i");
    remainder = remainder.replace(re, " ");
  }

  // Collapse whitespace; pull punctuation back to the preceding word so we don't
  // emit "service . Furnace"; trim stranded separators introduced by the strips above.
  remainder = remainder
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-—:;]+|[\s,.\-—:;]+$/g, "")
    .trim();

  if (remainder.replace(/\s+/g, "").length < OPENING_REMAINDER_MIN_CHARS) return null;

  const contentWordCount = remainder
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => {
      const alpha = w.replace(/[^a-z]/g, "");
      return alpha.length > 0 && !OPENING_REMAINDER_STOPWORDS.has(alpha);
    })
    .length;

  if (contentWordCount < OPENING_REMAINDER_MIN_CONTENT_WORDS) return null;

  return remainder;
}

// ─── Concierge intake ─────────────────────────────────────────────────────────

async function handleConciergeIntake(
  ctx: Ctx,
  client: Record<string, unknown>,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body, session } = ctx;
  const sessionState = String(session?.session_state ?? "idle");
  const currentJobId = session?.current_job_id as string | undefined;

  // ── Reserved cancel commands — checked before any input parsing ───────────
  // Aborts intake at any pre-finalize state. "cancel", "stop", "never mind",
  // "nevermind" are all treated as explicit abandonment intent.
  const PRE_FINALIZE_STATES = new Set(["awaiting_address", "awaiting_timing", "awaiting_details"]);
  if (PRE_FINALIZE_STATES.has(sessionState) && isCancelCommand(body)) {
    if (currentJobId) {
      await supabase.from("jobs")
        .update({ state: "cancelled", status: "completed" })
        .eq("job_id", currentJobId);
    }
    await updateSession({ session_state: "idle", current_job_id: null });
    const msg = "No problem — your request has been cancelled. Message us any time you need help.";
    await sendAndLog(ctx, fromNumber, msg, { jobId: currentJobId ?? null, templateName: "INTAKE_CANCELLED" });
    return;
  }

  // ── Awaiting address (street-only; city is already on record) ─────────────
  // Structured wizard: when the user is asked for an address, the municipality
  // has already been confirmed and saved to jobs.municipality_code/name. This
  // handler only requires a street number; we compose "{street}, {city}" using
  // the already-stored city. No municipality parsing runs on the reply — that
  // structurally eliminates the single-word-municipality street-name collision
  // class of bug flagged in CLAUDE.md §11.
  if (sessionState === "awaiting_address" && currentJobId) {
    const hasStreetNumber = /\d/.test(body);
    if (!hasStreetNumber) {
      const prompt = `Please include a street number (e.g. "123 Main St").`;
      await sendAndLog(ctx, fromNumber, prompt, { jobId: currentJobId, templateName: "INTAKE_ADDRESS_INVALID" });
      return;
    }

    const { data: job } = await supabase
      .from("jobs").select("municipality_name").eq("job_id", currentJobId).single();
    const cityName = String((job as Record<string, unknown> | null)?.municipality_name ?? "").trim();
    const composed = cityName ? `${body.trim()}, ${cityName}` : body.trim();

    await supabase.from("jobs").update({ address: composed }).eq("job_id", currentJobId);
    await advanceToNextIntakeStep(ctx, currentJobId, updateSession);
    return;
  }

  // ── Awaiting timing ────────────────────────────────────────────────────────
  if (sessionState === "awaiting_timing" && currentJobId) {
    // Race-condition guard: a concurrent webhook may have already captured timing.
    // If so, treat this message as the details reply instead of overwriting timing.
    const { data: jCheck } = await supabase
      .from("jobs").select("job_timing").eq("job_id", currentJobId).single();
    const alreadyHasTiming = !!(jCheck as Record<string, unknown> | null)?.job_timing;

    if (alreadyHasTiming) {
      await supabase.from("jobs").update({ description: body }).eq("job_id", currentJobId);
      await advanceToNextIntakeStep(ctx, currentJobId, updateSession);
      return;
    }

    await supabase.from("jobs").update({ job_timing: body }).eq("job_id", currentJobId);
    await advanceToNextIntakeStep(ctx, currentJobId, updateSession);
    return;
  }

  // ── Awaiting details ───────────────────────────────────────────────────────
  // Terminal transition no longer calls finalizeAndDispatch directly; it renders
  // the final summary and moves to awaiting_final_confirm. Dispatch is gated on
  // explicit YES at the summary step.
  if (sessionState === "awaiting_details" && currentJobId) {
    await supabase.from("jobs").update({ description: body }).eq("job_id", currentJobId);
    await advanceToNextIntakeStep(ctx, currentJobId, updateSession);
    return;
  }

  // ── Fresh inbound: route to service wizard ────────────────────────────────
  // No job row is inserted here anymore. The job is created on service_confirm=YES
  // in handleAwaitingServiceConfirm, after the user has confirmed the detected
  // service. If the opening message contains no recognized service keyword, we
  // start with the welcome/awaiting_service prompt instead of silently ignoring.
  const categoryMatch = matchCategoryKeyword(body);
  if (!categoryMatch) {
    const prompt =
      "Hi — how can we help you today? We connect you with vetted local TaskLeaders " +
      "for Cleaning, Plumbing, Electrical, HVAC, Handyman, Painting, Moving, and Yard Work.";
    await sendAndLog(ctx, fromNumber, prompt, { templateName: "INTAKE_WELCOME" });
    await updateSession({ session_state: "awaiting_service", sender_type: "client", last_prompt: prompt });
    return;
  }

  const categoryName = CATEGORY_NAMES[categoryMatch.code];
  const confirmPrompt = `Just to confirm — you need ${categoryName}? Reply YES or NO.`;
  await sendAndLog(ctx, fromNumber, confirmPrompt, { templateName: "INTAKE_SERVICE_CONFIRM_PROMPT" });
  await updateSession({ session_state: "awaiting_service_confirm", sender_type: "client", last_prompt: confirmPrompt });
}

// ─── Structured intake wizard: prompt helpers ────────────────────────────────
// Each helper sends a single prompt and sets the session to the matching state.
// The prompt copy lives here so the state-advance helper and the edit-menu
// handler both issue identical text.

async function promptMunicipality(
  ctx: Ctx,
  jobId: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const prompt =
    "Great. Which city is the job in? " +
    "(e.g. Vancouver, Burnaby, Surrey, New Westminster, Coquitlam, Maple Ridge, Mission…)";
  await sendAndLog(ctx, ctx.fromNumber, prompt, { jobId, templateName: "INTAKE_MUNICIPALITY_PROMPT" });
  await updateSession({
    session_state:  "awaiting_municipality",
    current_job_id: jobId,
    sender_type:    "client",
    last_prompt:    prompt,
  });
}

async function promptStreetAddress(
  ctx: Ctx,
  jobId: string,
  cityName: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const prompt = cityName
    ? `Got it — ${cityName}. What's the street address? (e.g. "123 Main St")`
    : `What's the street address? (e.g. "123 Main St")`;
  await sendAndLog(ctx, ctx.fromNumber, prompt, { jobId, templateName: "INTAKE_ADDRESS_PROMPT" });
  await updateSession({
    session_state:  "awaiting_address",
    current_job_id: jobId,
    sender_type:    "client",
    last_prompt:    prompt,
  });
}

async function promptTiming(
  ctx: Ctx,
  jobId: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const prompt = `When do you need this done? (e.g. "tomorrow morning", "ASAP", "this weekend")`;
  await sendAndLog(ctx, ctx.fromNumber, prompt, { jobId, templateName: "INTAKE_TIMING_PROMPT" });
  await updateSession({
    session_state:  "awaiting_timing",
    current_job_id: jobId,
    sender_type:    "client",
    last_prompt:    prompt,
  });
}

async function promptDetails(
  ctx: Ctx,
  jobId: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const prompt = `Briefly describe what needs to be done (e.g. "fix a leaking kitchen faucet", "3-bedroom deep clean").`;
  await sendAndLog(ctx, ctx.fromNumber, prompt, { jobId, templateName: "INTAKE_DETAILS_PROMPT" });
  await updateSession({
    session_state:  "awaiting_details",
    current_job_id: jobId,
    sender_type:    "client",
    last_prompt:    prompt,
  });
}

async function promptFinalSummary(
  ctx: Ctx,
  jobId: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, fromNumber } = ctx;
  const { data: job } = await supabase
    .from("jobs")
    .select("category_code, category_name, address, job_timing, description")
    .eq("job_id", jobId)
    .single();

  const j = (job ?? {}) as Record<string, unknown>;
  const categoryName = CATEGORY_NAMES[String(j.category_code ?? "")] ?? String(j.category_name ?? "");
  const address      = String(j.address ?? "(missing)");
  const timing       = String(j.job_timing ?? "(missing)");
  const description  = String(j.description ?? "(missing)");

  const summary =
    `Here's your request:\n\n` +
    `• Service: ${categoryName}\n` +
    `• Address: ${address}\n` +
    `• When: ${timing}\n` +
    `• Details: ${description}\n\n` +
    `Reply YES to submit, EDIT to change something, or NO to cancel.`;

  await sendAndLog(ctx, fromNumber, summary, { jobId, templateName: "INTAKE_FINAL_SUMMARY" });
  await updateSession({
    session_state:  "awaiting_final_confirm",
    current_job_id: jobId,
    sender_type:    "client",
    last_prompt:    summary,
  });
}

// ─── advanceToNextIntakeStep ─────────────────────────────────────────────────
// Completeness-driven step chooser. After any field write (including post-edit
// re-collection), this picks the earliest unfilled field and prompts for it,
// or renders the final summary if all fields are present. This means the wizard
// and the EDIT menu share a single forward path — editing one field returns the
// client directly to the summary when the other fields are still filled.

async function advanceToNextIntakeStep(
  ctx: Ctx,
  jobId: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase } = ctx;
  const { data: job } = await supabase
    .from("jobs")
    .select("municipality_code, municipality_name, address, job_timing, description")
    .eq("job_id", jobId)
    .single();

  const j = (job ?? {}) as Record<string, unknown>;

  if (!j.municipality_code || !j.municipality_name) {
    await promptMunicipality(ctx, jobId, updateSession);
    return;
  }
  if (!j.address) {
    await promptStreetAddress(ctx, jobId, String(j.municipality_name), updateSession);
    return;
  }
  if (!j.job_timing) {
    await promptTiming(ctx, jobId, updateSession);
    return;
  }
  if (!j.description) {
    await promptDetails(ctx, jobId, updateSession);
    return;
  }
  await promptFinalSummary(ctx, jobId, updateSession);
}

// ─── Load opening message for conservative pre-fill ──────────────────────────
// At service-confirm YES, the current inbound ("YES") is already written to
// message_log. The category-bearing opening message is the second-most-recent
// inbound for this sender. We read two rows and return the prior one.

async function loadOpeningMessage(ctx: Ctx): Promise<string | null> {
  const { supabase, fromNumber } = ctx;
  const { data } = await supabase
    .from("message_log")
    .select("body, created_at")
    .eq("participant_whatsapp", fromNumber)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(2);
  const rows = (data ?? []) as Array<{ body: string | null }>;
  return rows[1]?.body ?? null;
}

// ─── categoryCodeFromServiceConfirmPrompt ────────────────────────────────────
// The service_confirm prompt contains "you need {CategoryName}?". Reverse-lookup
// the name against CATEGORY_NAMES to recover the code when handling the YES reply.
// No DB writes depend on this — we derive it fresh from the stored last_prompt.

function categoryCodeFromServiceConfirmPrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const match = prompt.match(/you need\s+([^?]+?)\?/i);
  if (!match) return null;
  const nameLower = match[1].trim().toLowerCase();
  for (const [code, name] of Object.entries(CATEGORY_NAMES)) {
    if (name.toLowerCase() === nameLower) return code;
  }
  return null;
}

// ─── Cancel helper: shared across all structured-intake handlers ─────────────
// NO and CANCEL before dispatch cancel the draft job (if one exists) and reset
// the session to idle with the existing INTAKE_CANCELLED copy. Used by each new
// handler at entry to keep cancel behavior uniform across the wizard.

async function cancelDraftIntake(
  ctx: Ctx,
  jobId: string | undefined,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, fromNumber } = ctx;
  if (jobId) {
    await supabase.from("jobs")
      .update({ state: "cancelled", status: "completed" })
      .eq("job_id", jobId);
  }
  await updateSession({ session_state: "idle", current_job_id: null });
  await sendAndLog(
    ctx, fromNumber,
    "No problem — your request has been cancelled. Message us any time you need help.",
    { jobId: jobId ?? null, templateName: "INTAKE_CANCELLED" },
  );
}

// ─── handleAwaitingService ───────────────────────────────────────────────────
// Reached when the client's first message lacked a recognizable service keyword.
// Parses the reply for a category; on match, promotes to awaiting_service_confirm.
// Also handles the edit-flow "change service" path: if currentJobId is set, it
// is preserved across the transition so the YES handler updates the existing
// job rather than creating a new one.

async function handleAwaitingService(
  ctx: Ctx,
  _client: Record<string, unknown>,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { body, fromNumber, session } = ctx;
  const currentJobId = session?.current_job_id as string | undefined;

  if (isCancelCommand(body)) {
    await cancelDraftIntake(ctx, currentJobId, updateSession);
    return;
  }

  const match = matchCategoryKeyword(body);
  if (!match) {
    const prompt =
      "We connect you with vetted local TaskLeaders for Cleaning, Plumbing, " +
      "Electrical, HVAC, Handyman, Painting, Moving, and Yard Work. Which do you need?";
    await sendAndLog(ctx, fromNumber, prompt, { jobId: currentJobId ?? null, templateName: "INTAKE_SERVICE_REPROMPT" });
    await updateSession({
      session_state:  "awaiting_service",
      current_job_id: currentJobId ?? null,
      sender_type:    "client",
      last_prompt:    prompt,
    });
    return;
  }

  const categoryName = CATEGORY_NAMES[match.code];
  const prompt = `Just to confirm — you need ${categoryName}? Reply YES or NO.`;
  await sendAndLog(ctx, fromNumber, prompt, { jobId: currentJobId ?? null, templateName: "INTAKE_SERVICE_CONFIRM_PROMPT" });
  await updateSession({
    session_state:  "awaiting_service_confirm",
    current_job_id: currentJobId ?? null,
    sender_type:    "client",
    last_prompt:    prompt,
  });
}

// ─── handleAwaitingServiceConfirm ────────────────────────────────────────────
// YES → create job row (fresh) or update category (edit), apply conservative
// pre-fill from the opening message, advance to next step.
// NO  → return to awaiting_service and ask what service they need.
// Anything else → re-prompt YES/NO.

async function handleAwaitingServiceConfirm(
  ctx: Ctx,
  client: Record<string, unknown>,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, body, fromNumber, session } = ctx;
  const currentJobId = session?.current_job_id as string | undefined;
  const lastPrompt   = session?.last_prompt as string | undefined;
  const kw           = normalizeKeyword(body);

  if (isCancelCommand(body)) {
    await cancelDraftIntake(ctx, currentJobId, updateSession);
    return;
  }

  if (kw === KW_NO) {
    const prompt =
      "No problem — what service do you need? " +
      "(Cleaning, Plumbing, Electrical, HVAC, Handyman, Painting, Moving, or Yard Work)";
    await sendAndLog(ctx, fromNumber, prompt, { jobId: currentJobId ?? null, templateName: "INTAKE_SERVICE_RETRY" });
    await updateSession({
      session_state:  "awaiting_service",
      current_job_id: currentJobId ?? null,
      sender_type:    "client",
      last_prompt:    prompt,
    });
    return;
  }

  if (kw !== KW_YES) {
    await sendAndLog(ctx, fromNumber, "Please reply YES or NO.", { jobId: currentJobId ?? null });
    return;
  }

  // YES — recover the category from the prompt we sent.
  const categoryCode = categoryCodeFromServiceConfirmPrompt(lastPrompt);
  if (!categoryCode) {
    // Prompt state was lost or mangled — restart at awaiting_service.
    const prompt =
      "Let's start over — what service do you need? " +
      "(Cleaning, Plumbing, Electrical, HVAC, Handyman, Painting, Moving, or Yard Work)";
    await sendAndLog(ctx, fromNumber, prompt, { jobId: currentJobId ?? null, templateName: "INTAKE_SERVICE_RETRY" });
    await updateSession({
      session_state:  "awaiting_service",
      current_job_id: currentJobId ?? null,
      sender_type:    "client",
      last_prompt:    prompt,
    });
    return;
  }

  const categoryName = CATEGORY_NAMES[categoryCode];
  const baseFee      = CATEGORY_LEAD_FEES_CENTS[categoryCode] ?? 0;
  const gst          = calcGst(baseFee);

  // ── Edit-flow path: job already exists, update category only ───────────────
  // Triggered by the EDIT menu "1 = Service" branch, which holds currentJobId
  // across the awaiting_service → awaiting_service_confirm transition. Update
  // category + recompute fees in place, then advance — usually straight to the
  // summary since the other fields are still filled.
  if (currentJobId) {
    await supabase.from("jobs").update({
      category_code:       categoryCode,
      category_name:       categoryName,
      lead_fee_cents:      baseFee,
      gst_cents:           gst,
      total_charged_cents: baseFee + gst,
    }).eq("job_id", currentJobId);
    await advanceToNextIntakeStep(ctx, currentJobId, updateSession);
    return;
  }

  // ── Fresh-intake path: create job row and apply conservative pre-fill ──────
  const opening = await loadOpeningMessage(ctx);

  const prefill: Record<string, unknown> = {};
  if (opening) {
    const inline = extractInlineAddress(opening);
    const muni   = inline ? null : extractMunicipalityFromAddress(opening);
    const timing = extractTimingPhrase(opening);
    if (inline) {
      prefill.address           = inline.address;
      prefill.municipality_code = inline.code;
      prefill.municipality_name = inline.name;
    } else if (muni) {
      prefill.municipality_code = muni.code;
      prefill.municipality_name = muni.name;
    }
    if (timing) {
      prefill.job_timing = timing;
    }
  }

  const cityCode = "VAN";
  const { data: jobIdData } = await supabase.rpc("generate_job_id", {
    p_city_code: cityCode, p_category_code: categoryCode,
  });
  if (!jobIdData) {
    await sendAndLog(
      ctx, fromNumber,
      "We're having trouble processing your request right now. Please try again in a moment.",
      { templateName: "INTAKE_JOB_ID_FAIL" },
    );
    return;
  }

  const { data: job } = await supabase.from("jobs").insert({
    job_id:              jobIdData,
    city_code:           cityCode,
    market_code:         cityCode,
    category_code:       categoryCode,
    category_name:       categoryName,
    status:              "pending",
    state:               "intake_started",
    source:              "concierge",
    client_id:           client.id ?? null,
    client_whatsapp:     fromNumber,
    lead_fee_cents:      baseFee,
    gst_cents:           gst,
    total_charged_cents: baseFee + gst,
    ...prefill,
  }).select("job_id").single();

  if (!job) {
    await sendAndLog(
      ctx, fromNumber,
      "We're having trouble processing your request right now. Please try again in a moment.",
      { templateName: "INTAKE_INSERT_FAIL" },
    );
    return;
  }

  await advanceToNextIntakeStep(ctx, String(job.job_id), updateSession);
}

// ─── handleAwaitingMunicipality ──────────────────────────────────────────────
// Validates the city reply against the existing 18-code municipality registry.
// On match, saves municipality_code/name and advances (usually to awaiting_address
// with city already known). On miss, re-prompts with the valid list.

async function handleAwaitingMunicipality(
  ctx: Ctx,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, body, fromNumber, session } = ctx;
  const currentJobId = session?.current_job_id as string | undefined;

  if (isCancelCommand(body)) {
    await cancelDraftIntake(ctx, currentJobId, updateSession);
    return;
  }

  if (!currentJobId) {
    // Session lost its draft — reset cleanly.
    await updateSession({ session_state: "idle", current_job_id: null });
    return;
  }

  const muni = extractMunicipalityFromAddress(body);
  if (!muni) {
    const prompt =
      "We don't currently cover that area. We serve: Vancouver, North Vancouver, " +
      "West Vancouver, Burnaby, Richmond, Surrey, Coquitlam, New Westminster, " +
      "Port Moody, Port Coquitlam, Delta, Langley, Maple Ridge, Pitt Meadows, " +
      "White Rock, Abbotsford, Chilliwack, Mission. Please reply with one of these.";
    await sendAndLog(ctx, fromNumber, prompt, { jobId: currentJobId, templateName: "INTAKE_MUNICIPALITY_INVALID" });
    return; // Stay in awaiting_municipality
  }

  await supabase.from("jobs").update({
    municipality_code: muni.code,
    municipality_name: muni.name,
  }).eq("job_id", currentJobId);

  await advanceToNextIntakeStep(ctx, currentJobId, updateSession);
}

// ─── handleAwaitingFinalConfirm ──────────────────────────────────────────────
// YES  → finalizeAndDispatch (the single client-intake entry to dispatch).
// EDIT → show numbered edit menu, move to awaiting_edit_choice.
// NO   → cancel draft, reset session.
// Other → re-prompt.

async function handleAwaitingFinalConfirm(
  ctx: Ctx,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { body, fromNumber, session } = ctx;
  const currentJobId = session?.current_job_id as string | undefined;
  const kw           = normalizeKeyword(body);

  if (isCancelCommand(body)) {
    await cancelDraftIntake(ctx, currentJobId, updateSession);
    return;
  }

  if (!currentJobId) {
    await updateSession({ session_state: "idle", current_job_id: null });
    return;
  }

  if (kw === "EDIT") {
    const prompt =
      "What would you like to change?\n" +
      "  1. Service\n" +
      "  2. City\n" +
      "  3. Address\n" +
      "  4. When\n" +
      "  5. Details\n\n" +
      "Reply with the number.";
    await sendAndLog(ctx, fromNumber, prompt, { jobId: currentJobId, templateName: "INTAKE_EDIT_MENU" });
    await updateSession({
      session_state:  "awaiting_edit_choice",
      current_job_id: currentJobId,
      sender_type:    "client",
      last_prompt:    prompt,
    });
    return;
  }

  if (kw === KW_YES) {
    await finalizeAndDispatch(ctx, currentJobId, updateSession);
    return;
  }

  if (kw === KW_NO) {
    await cancelDraftIntake(ctx, currentJobId, updateSession);
    return;
  }

  await sendAndLog(
    ctx, fromNumber,
    "Please reply YES to submit, EDIT to change something, or NO to cancel.",
    { jobId: currentJobId },
  );
}

// ─── handleAwaitingEditChoice ────────────────────────────────────────────────
// Parses a 1-5 selection, clears the corresponding field(s), and jumps to the
// matching prompt. Once the field is re-collected, advanceToNextIntakeStep will
// route the user straight back to the summary (the other fields are still full).

async function handleAwaitingEditChoice(
  ctx: Ctx,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, body, fromNumber, session } = ctx;
  const currentJobId = session?.current_job_id as string | undefined;

  if (isCancelCommand(body)) {
    await cancelDraftIntake(ctx, currentJobId, updateSession);
    return;
  }

  if (!currentJobId) {
    await updateSession({ session_state: "idle", current_job_id: null });
    return;
  }

  const digit = parseInt(body.trim(), 10);
  if (isNaN(digit) || digit < 1 || digit > 5) {
    await sendAndLog(
      ctx, fromNumber,
      "Please reply with a number from 1 to 5, or CANCEL to cancel your request.",
      { jobId: currentJobId },
    );
    return;
  }

  switch (digit) {
    case 1: {
      // Service edit: cancel the current draft and restart at awaiting_service so
      // the next service_confirm YES generates a new job_id whose category prefix
      // matches the confirmed category. Mutating category on the existing row
      // would leave the VAN-{OLD}-{seq} prefix misaligned with the new category.
      await supabase.from("jobs")
        .update({ state: "cancelled", status: "completed" })
        .eq("job_id", currentJobId);
      const prompt =
        "No problem — what service do you need? " +
        "We can help with Cleaning, Plumbing, Electrical, HVAC, Handyman, Painting, Moving, and Yard Work.";
      await sendAndLog(ctx, fromNumber, prompt, { jobId: currentJobId, templateName: "INTAKE_EDIT_SERVICE" });
      await updateSession({
        session_state:  "awaiting_service",
        current_job_id: null,
        sender_type:    "client",
        last_prompt:    prompt,
      });
      return;
    }
    case 2: {
      // City — changing city invalidates the stored street-only address too,
      // since the composed "street, city" record would be wrong for the new city.
      await supabase.from("jobs")
        .update({ municipality_code: null, municipality_name: null, address: null })
        .eq("job_id", currentJobId);
      await promptMunicipality(ctx, currentJobId, updateSession);
      return;
    }
    case 3: {
      await supabase.from("jobs").update({ address: null }).eq("job_id", currentJobId);
      const { data: job } = await supabase
        .from("jobs").select("municipality_name").eq("job_id", currentJobId).single();
      const cityName = String((job as Record<string, unknown> | null)?.municipality_name ?? "");
      await promptStreetAddress(ctx, currentJobId, cityName, updateSession);
      return;
    }
    case 4: {
      await supabase.from("jobs").update({ job_timing: null }).eq("job_id", currentJobId);
      await promptTiming(ctx, currentJobId, updateSession);
      return;
    }
    case 5: {
      await supabase.from("jobs").update({ description: null }).eq("job_id", currentJobId);
      await promptDetails(ctx, currentJobId, updateSession);
      return;
    }
  }
}

async function finalizeAndDispatch(
  ctx: Ctx,
  jobId: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  const confirm = `We've received your request and we're finding you a match. We'll be in touch shortly.`;
  await sendAndLog(ctx, fromNumber, confirm, { jobId, templateName: "INTAKE_CONFIRM" });

  await supabase.from("jobs").update({ state: "intake_confirmed" }).eq("job_id", jobId);
  // awaiting_match holds the client until job-dispatch either (a) upserts the
  // session to awaiting_no_match_decision on a no-match outcome, or (b) stripe-webhook
  // upserts the session to 'open' after provider ACCEPT and payment. Prevents a
  // duplicate intake while the job is still being matched, and routes CANCEL via
  // handleAwaitingMatchMessage.
  await updateSession({ session_state: "awaiting_match", current_job_id: jobId, sender_type: "client" });

  // Trigger dispatch — awaited so the edge function doesn't terminate before
  // the HTTP call is sent. A failed dispatch is written to admin_alerts so it
  // surfaces without manual SQL inspection.
  const cronSecret = Deno.env.get("INTERNAL_CRON_SECRET");
  const fnBase     = (Deno.env.get("SUPABASE_URL") ?? "").split(".supabase.co")[0].replace("https://", "");
  try {
    const dispatchRes = await fetch(`https://${fnBase}.supabase.co/functions/v1/job-dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": cronSecret ?? "" },
      body: JSON.stringify({ job_id: jobId }),
    });
    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => "(unreadable)");
      await supabase.from("admin_alerts").insert({
        alert_type:  "escalation",
        priority:    "high",
        job_id:      jobId,
        description: `job-dispatch call FAILED after intake. Status: ${dispatchRes.status}. Body: ${errText.substring(0, 200)}`,
        status:      "open",
      });
    }
  } catch (e) {
    await supabase.from("admin_alerts").insert({
      alert_type:  "escalation",
      priority:    "high",
      job_id:      jobId,
      description: `job-dispatch fetch threw after intake: ${String(e)}`,
      status:      "open",
    });
  }
}

// ─── Awaiting-match handler ───────────────────────────────────────────────────
// Runs when the client's session is 'awaiting_match' — the window between
// finalizeAndDispatch and either a no-match outcome or a provider ACCEPT+payment.
// Two responsibilities only:
//   1. If the client sends a cancel command, cancel the job and reset the session.
//   2. Otherwise, send a "still searching" reply and stay in awaiting_match —
//      do NOT fall through to handleConciergeIntake (that would create a duplicate job).

async function handleAwaitingMatchMessage(
  ctx: Ctx,
  jobId: string | undefined,
  body: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, fromNumber } = ctx;

  if (isCancelCommand(body)) {
    if (jobId) {
      await supabase.from("jobs")
        .update({ state: "cancelled", status: "completed" })
        .eq("job_id", jobId);

      // Sweep provider sessions still parked on this cancelled broadcast.
      // Scoped strictly to providers whose session_state is still awaiting_accept
      // for THIS job_id. Winners who already claimed (now 'idle' pending payment)
      // and thread participants ('open') are intentionally untouched — see the
      // client-cancel-after-provider-accept race, which is a separate concern.
      // Non-fatal: a failure here does not block client-side cancel confirmation.
      try {
        await supabase.from("conversation_sessions")
          .update({
            session_state:    "idle",
            current_job_id:   null,
            last_prompt:      null,
            last_activity_at: new Date().toISOString(),
          })
          .eq("current_job_id", jobId)
          .eq("session_state", "awaiting_accept");
      } catch { /* non-fatal: client cancel path must not block on sweep */ }
    }
    await updateSession({ session_state: "idle", current_job_id: null });
    const msg = "No problem — your request has been cancelled. Message us any time you need help.";
    await sendAndLog(ctx, fromNumber, msg, { jobId: jobId ?? null, templateName: "INTAKE_CANCELLED" });
    return;
  }

  const msg = "We're still searching for a match on your previous request. Reply CANCEL to cancel it, or wait — we'll reach out as soon as we find a TaskLeader.";
  await sendAndLog(ctx, fromNumber, msg, { jobId: jobId ?? null, templateName: "AWAITING_MATCH_STILL_SEARCHING" });
}

// ─── Survey answer handler ────────────────────────────────────────────────────

async function handleSurveyAnswer(
  ctx: Ctx,
  sessionState: string,
  jobId: string | undefined,
  kw: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;
  if (!jobId) return;

  const score = parseInt(kw, 10);
  if (isNaN(score) || score < 1 || score > 5) {
    await sendAndLog(ctx, fromNumber, "Please reply with a number from 1 to 5.", { jobId, templateName: "SURVEY_RATING_RETRY" });
    return;
  }

  const fieldMap: Record<string, string> = {
    awaiting_survey_q1: "punctuality_score",
    awaiting_survey_q2: "communication_score",
    awaiting_survey_q3: "quality_score",
  };
  const nextMap: Record<string, string> = {
    awaiting_survey_q1: "awaiting_survey_q2",
    awaiting_survey_q2: "awaiting_survey_q3",
    awaiting_survey_q3: "idle",
  };

  const field    = fieldMap[sessionState];
  const nextState = nextMap[sessionState];
  const isLast   = nextState === "idle";

  await supabase.from("survey_responses").upsert({
    job_id:          jobId,
    client_whatsapp: fromNumber,
    [field]:         score,
    ...(sessionState === "awaiting_survey_q1" ? { survey_started_at: new Date().toISOString() } : {}),
    ...(isLast ? { survey_completed_at: new Date().toISOString() } : {}),
  }, { onConflict: "job_id,client_whatsapp" });

  if (!isLast) {
    const nextQ = nextState === "awaiting_survey_q2" ? SURVEY_QUESTIONS.q2 : SURVEY_QUESTIONS.q3;
    await sendAndLog(ctx, fromNumber, nextQ, { jobId, templateName: "SURVEY_NEXT_QUESTION" });
    await updateSession({ session_state: nextState, current_job_id: jobId, last_prompt: nextQ });
  } else {
    // Survey complete — advance job state
    await supabase.from("jobs").update({
      state:                "survey_complete",
      survey_completed_at:  new Date().toISOString(),
    }).eq("job_id", jobId);

    const thanks = "Thank you for your feedback. We appreciate it.";
    await sendAndLog(ctx, fromNumber, thanks, { jobId, templateName: "SURVEY_THANKS" });
    await updateSession({ session_state: "idle", current_job_id: null });

    // Trigger reliability pipeline (fire-and-forget).
    // Loads assigned_provider_slug from job, converts survey to reliability_input,
    // updates providers.reliability_percent.
    // Response time is NOT touched here — it was recorded when provider first responded.
    const { data: completedJob } = await supabase
      .from("jobs")
      .select("assigned_provider_slug")
      .eq("job_id", jobId)
      .maybeSingle();

    if (completedJob?.assigned_provider_slug) {
      triggerApplyReliability(completedJob.assigned_provider_slug, jobId);

      // Reset provider session now that the job is fully closed.
      // updateSession() only resets the client (the survey respondent). The
      // provider's session has been open on this job since payment confirmation
      // and is never otherwise reset — leaving it stale indefinitely.
      // Look up the provider's WhatsApp number to target the correct session row.
      const { data: providerAcct } = await supabase
        .from("provider_accounts")
        .select("whatsapp_number")
        .eq("slug", completedJob.assigned_provider_slug)
        .maybeSingle();

      if (providerAcct?.whatsapp_number) {
        await supabase.from("conversation_sessions").upsert({
          whatsapp_e164:    providerAcct.whatsapp_number,
          session_state:    "idle",
          current_job_id:   null,
          last_activity_at: new Date().toISOString(),
        }, { onConflict: "whatsapp_e164" });
      }
    }
  }
}

// ─── Guarantee claim confirmation ─────────────────────────────────────────────

async function handleGuaranteeConfirmation(
  ctx: Ctx,
  jobId: string | undefined,
  kw: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;
  if (!jobId) return;

  const response = kw === KW_YES ? "YES" : kw === KW_NO ? "NO" : null;
  if (!response) {
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, "Please reply YES or NO.");
    return;
  }

  // Load the active claim to determine whether the sender is the client or provider
  const { data: claim } = await supabase
    .from("guarantee_claims")
    .select("id, client_whatsapp, claim_state")
    .eq("job_id", jobId)
    .not("claim_state", "in", '("closed","denied","approved")')
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!claim) {
    const noClaimMsg = "We couldn't find an active guarantee claim for this job. Please contact us for support.";
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, noClaimMsg);
    await updateSession({ session_state: "idle", current_job_id: null });
    return;
  }

  const isClient = claim.client_whatsapp === fromNumber;
  const now = new Date().toISOString();

  if (isClient) {
    await supabase.from("guarantee_claims").update({
      client_response:     response,
      client_responded_at: now,
      claim_state:         response === "YES" ? "client_confirmed_yes" : "client_confirmed_no",
    }).eq("id", claim.id);
  } else {
    // Provider (TaskLeader) response — writes to provider_response columns
    await supabase.from("guarantee_claims").update({
      provider_response:     response,
      provider_responded_at: now,
      claim_state:           response === "YES" ? "provider_confirmed_yes" : "provider_confirmed_no",
    }).eq("id", claim.id);
  }

  const party = isClient ? "client" : "provider";
  const reply = response === "YES"
    ? "Thank you. We'll continue reviewing this request and will be in touch."
    : "Thank you for confirming. We'll update this claim accordingly.";

  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, reply);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: reply, status: "sent" });

  await supabase.from("admin_alerts").insert({
    alert_type: "guarantee_claim", priority: "high", job_id: jobId,
    participant_whatsapp: fromNumber,
    description: `${party === "client" ? "Client" : "Provider"} responded ${response} to guarantee claim confirmation.`,
    status: "open",
  });
  await updateSession({ session_state: "idle", current_job_id: null });
}

// ─── No-match decision ────────────────────────────────────────────────────────

async function handleNoMatchDecision(
  ctx: Ctx,
  jobId: string | undefined,
  kw: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;
  if (!jobId) return;

  // Accept both current WC-4 Quick Reply button labels (KEEP SEARCHING / CLOSE NOW)
  // and the legacy keyword labels (KEEP OPEN / CANCEL) so typed replies using
  // either wording still resolve. Match against both in each branch.
  if (kw === KW_KEEP_SEARCHING || kw === KW_KEEP_OPEN) {
    const reply = "Understood — we'll keep searching and let you know as soon as we have a match.";
    await sendAndLog(ctx, fromNumber, reply, { jobId, templateName: "NO_MATCH_KEEP_SEARCHING" });
    await supabase.from("jobs").update({ state: "no_match" }).eq("job_id", jobId);
    await updateSession({ session_state: "idle", current_job_id: jobId });
  } else if (kw === KW_CLOSE_NOW || kw === KW_CANCEL) {
    const reply = "No problem — this request has been closed. Message us any time you need a TaskLeader.";
    await sendAndLog(ctx, fromNumber, reply, { jobId, templateName: "NO_MATCH_CLOSE_NOW" });
    await supabase.from("jobs").update({ state: "closed", status: "completed" }).eq("job_id", jobId);
    await updateSession({ session_state: "idle", current_job_id: null });
  } else {
    await sendAndLog(ctx, fromNumber, "Please reply KEEP SEARCHING or CLOSE NOW.", { jobId, templateName: "NO_MATCH_RETRY" });
  }
}

// ─── Thread-close request ────────────────────────────────────────────────────
// Intercepts CLOSE / CANCEL / DONE in an active (open) session.
// Sends a confirmation prompt to the sender and moves them to awaiting_close_confirm.
// The other participant is NOT notified until the sender confirms with YES.

async function handleCloseRequest(
  ctx:          Ctx,
  jobId:        string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, fromNumber } = ctx;

  const { data: job } = await supabase
    .from("jobs")
    .select("job_id, address, state")
    .eq("job_id", jobId)
    .maybeSingle();

  // Guard: if already closed, just reset the session cleanly
  if (!job || job.state === "closed" || job.state === "cancelled") {
    await updateSession({ session_state: "idle", current_job_id: null });
    await sendAndLog(ctx, fromNumber, "This thread is already closed.", { jobId });
    return;
  }

  const hdr    = jobHeader(job.job_id, job.address ?? "address on file");
  const prompt = (
    `${hdr} Are you sure you want to close this job thread?\n\n` +
    `Reply YES to close it, or NO to continue.`
  );

  await sendAndLog(ctx, fromNumber, prompt, { jobId, templateName: "THREAD_CLOSE_PROMPT" });
  await updateSession({
    session_state:  "awaiting_close_confirm",
    current_job_id: jobId,
    last_prompt:    prompt,
  });
}

// ─── Thread-close confirmation ────────────────────────────────────────────────
// Handles YES/NO reply after a CLOSE/CANCEL/DONE prompt.
//
// YES path:
//   • jobs → state='closed', status='completed'
//   • job_participants → session_state='inactive' (removed from resolveJobContext)
//   • sender session → idle / null
//   • other participant session → idle / null
//   • sends confirmation to sender; sends notification to other participant
//
// NO path:
//   • restores sender session to open
//   • sends "your thread is still active" ack
//   • other participant is never notified (they saw nothing)
//
// Other reply (not YES or NO):
//   • re-prompts without changing session state

async function handleCloseConfirm(
  ctx:          Ctx,
  jobId:        string | undefined,
  kw:           string,
  senderType:   "client" | "provider",
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  if (!jobId) {
    await updateSession({ session_state: "idle", current_job_id: null });
    return;
  }

  // Re-prompt if sender replied with something other than YES or NO
  if (kw !== KW_YES && kw !== KW_NO) {
    await sendAndLog(ctx, fromNumber,
      "Please reply YES to close the thread, or NO to continue.",
      { jobId },
    );
    return;
  }

  if (kw === KW_NO) {
    await sendAndLog(ctx, fromNumber,
      "No problem — your job thread is still active.",
      { jobId, templateName: "THREAD_CLOSE_CANCELLED" },
    );
    await updateSession({ session_state: "open", current_job_id: jobId });
    return;
  }

  // ── YES: execute close ─────────────────────────────────────────────────────

  // 1. Load job for display header (before updating state)
  const { data: job } = await supabase
    .from("jobs")
    .select("job_id, address")
    .eq("job_id", jobId)
    .maybeSingle();

  const hdr = job
    ? jobHeader(job.job_id, job.address ?? "address on file")
    : `[Job #${jobId}]`;

  // 2. Close the job
  await supabase.from("jobs")
    .update({
      state:      "closed",
      status:     "completed",
    })
    .eq("job_id", jobId);

  // 3. Deactivate job_participants — removes them from resolveJobContext step 3
  await supabase.from("job_participants")
    .update({ session_state: "inactive" })
    .eq("job_id", jobId);

  // 4. Find the other participant so we can reset their session and notify them
  const otherType = senderType === "client" ? "provider" : "client";
  const { data: otherParticipant } = await supabase
    .from("job_participants")
    .select("whatsapp_e164")
    .eq("job_id", jobId)
    .eq("participant_type", otherType)
    .maybeSingle();

  // 5. Reset sender session
  await updateSession({ session_state: "idle", current_job_id: null });

  // 6. Reset other participant session — recipient-only event, do not stamp
  // last_activity_at (the other participant did not inbound; they are about
  // to receive a notification of the close).
  if (otherParticipant?.whatsapp_e164) {
    await supabase.from("conversation_sessions").upsert({
      whatsapp_e164:    otherParticipant.whatsapp_e164,
      session_state:    "idle",
      current_job_id:   null,
    }, { onConflict: "whatsapp_e164" });
  }

  // 7. Confirm to sender
  await sendAndLog(ctx, fromNumber,
    `${hdr} This job thread has been closed. Thank you for using TaskLeaders.`,
    { jobId, templateName: "THREAD_CLOSED_SENDER" },
  );

  // 8. Notify other participant (in-session — no template SID needed)
  if (otherParticipant?.whatsapp_e164) {
    const notifBody = `${hdr} This job thread has been closed.`;
    await sendAndLog(ctx, otherParticipant.whatsapp_e164, notifBody, {
      jobId,
      templateName: "THREAD_CLOSED_OTHER",
    });
  }
}

// ─── Relay: client → provider ─────────────────────────────────────────────────

async function relayClientToProvider(
  ctx: Ctx,
  jctx: JobContext,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;

  const { data: participant } = await supabase
    .from("job_participants")
    .select("whatsapp_e164")
    .eq("job_id", jctx.jobId)
    .eq("participant_type", "provider")
    .eq("session_state", "active")
    .maybeSingle();

  if (!participant?.whatsapp_e164) {
    await supabase.from("admin_alerts").insert({
      alert_type: "escalation", priority: "normal",
      job_id: jctx.jobId, participant_whatsapp: fromNumber,
      description: "Client sent message but no active provider in thread.",
      status: "open",
    });
    return;
  }

  // Always include job header so provider can distinguish jobs if they have multiple
  const relayBody = buildRelayToProvider(jctx.jobId, jctx.address, body);
  if (twilioEnv) {
    // Route through sendAndLog so a Twilio failure (e.g. recipient WhatsApp
    // session window closed, error code 63016) writes an admin_alerts row in
    // addition to the failed message_log entry. Phase 0 visibility only —
    // no reactivation template, no queue, no sender feedback.
    await sendAndLog(ctx, participant.whatsapp_e164, relayBody, {
      jobId:        jctx.jobId,
      templateName: "RELAY_CLIENT_TO_PROVIDER",
    });
  }

  // Update job-level message log with inbound as well
  logMessage({ supabaseUrl, serviceRoleKey, direction: "inbound", jobId: jctx.jobId, participantWhatsapp: fromNumber, body, status: "received" });

  await updateSession({ session_state: "open", current_job_id: jctx.jobId });
}

// ─── Relay: provider → client ─────────────────────────────────────────────────

async function relayProviderToClient(
  ctx: Ctx,
  jctx: JobContext,
  provider: Record<string, unknown>,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;

  const { data: participant } = await supabase
    .from("job_participants")
    .select("whatsapp_e164")
    .eq("job_id", jctx.jobId)
    .eq("participant_type", "client")
    .eq("session_state", "active")
    .maybeSingle();

  if (!participant?.whatsapp_e164) return;

  const firstName = String(provider.first_name ?? "Your TaskLeader");
  // Always include job header so client can distinguish jobs if they have multiple
  const relayBody = buildRelayToClient(jctx.jobId, jctx.address, firstName, body);

  if (twilioEnv) {
    // Route through sendAndLog so a Twilio failure (e.g. recipient WhatsApp
    // session window closed, error code 63016) writes an admin_alerts row in
    // addition to the failed message_log entry. Phase 0 visibility only.
    await sendAndLog(ctx, participant.whatsapp_e164, relayBody, {
      jobId:        jctx.jobId,
      templateName: "RELAY_PROVIDER_TO_CLIENT",
    });
  }

  logMessage({ supabaseUrl, serviceRoleKey, direction: "inbound", jobId: jctx.jobId, participantWhatsapp: fromNumber, body, status: "received" });

  // Update the sender's (provider's) session normally — their inbound just arrived.
  await updateSession({ session_state: "open", current_job_id: jctx.jobId });

  // Recipient-side (client) session: maintain current_job_id for multi-job routing
  // but DO NOT stamp last_activity_at. That field must only reflect participant
  // inbound activity, not passive receipt of a relayed message — otherwise any
  // downstream use of last_activity_at as a 24-hour-window signal produces false
  // positives for recipients who have not actually messaged in recently.
  await supabase.from("conversation_sessions")
    .update({ current_job_id: jctx.jobId })
    .eq("whatsapp_e164", participant.whatsapp_e164);
}

// ─── Provider message handler ─────────────────────────────────────────────────

async function handleProviderMessage(
  ctx: Ctx,
  provider: Record<string, unknown>,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body, session } = ctx;
  const kw           = normalizeKeyword(body);
  const sessionState = String(session?.session_state ?? "idle");
  const currentJobId = session?.current_job_id as string | undefined;

  // ── HELP ──────────────────────────────────────────────────────────────────
  if (kw === KW_HELP) {
    await supabase.from("admin_alerts").insert({
      alert_type: "escalation", priority: "normal",
      provider_slug: String(provider.slug),
      participant_whatsapp: fromNumber,
      description: "Provider requested HELP.",
      status: "open",
    });
    await sendAndLog(ctx, fromNumber, "We've received your support request. Our team will be in touch shortly.", { templateName: "PROVIDER_HELP_ACK" });
    return;
  }

  // ── ACCEPT ────────────────────────────────────────────────────────────────
  if (kw === KW_ACCEPT && sessionState === "awaiting_accept") {
    const jobId = await resolveAcceptJobId(ctx, provider);
    if (!jobId) { await escalateAmbiguousReply(ctx, provider, "ACCEPT"); return; }
    await handleProviderAccept(ctx, provider, jobId, updateSession);
    return;
  }

  // ── PASS or DECLINE ───────────────────────────────────────────────────────
  if (kw === KW_PASS || kw === KW_DECLINE) {
    const jctx = await resolveJobContext(supabase, fromNumber, currentJobId, body);
    if (jctx && jctx !== "ambiguous") {
      // Check if this is a Marketplace decline
      if (jctx.source === "marketplace") {
        // Record first response time symmetrically with Marketplace ACCEPT
        // (handleProviderAccept) and Concierge PASS (below). Without this,
        // jobs.first_provider_response_at stays NULL on declines and the
        // provider's rolling response_time_minutes never reflects fast no's.
        await recordProviderResponseTime(supabase, provider, jctx.jobId, jctx.source);
        await handleMarketplaceDecline(ctx, jctx, provider, updateSession);
      } else {
        // Concierge pass — record first response time before updating DB
        await recordProviderResponseTime(supabase, provider, jctx.jobId, jctx.source);
        await supabase.from("broadcast_responses").update({
          response: kw, responded_at: new Date().toISOString(),
        }).eq("job_id", jctx.jobId).eq("provider_slug", String(provider.slug));
        const ack = "Understood — you've passed on this job.";
        await sendAndLog(ctx, fromNumber, ack, { jobId: jctx.jobId, templateName: "CONCIERGE_PASS_ACK" });
      }
      await updateSession({ session_state: "idle", current_job_id: null });
    } else {
      await escalateAmbiguousReply(ctx, provider, kw);
    }
    return;
  }

  // ── Guarantee claim confirmation ──────────────────────────────────────────
  if (sessionState === "awaiting_guarantee_confirm") {
    await handleGuaranteeConfirmation(ctx, currentJobId, kw, updateSession);
    return;
  }

  // ── Thread-close confirmation ──────────────────────────────────────────────
  // Provider has already been shown the close prompt and is answering YES/NO.
  if (sessionState === "awaiting_close_confirm") {
    await handleCloseConfirm(ctx, currentJobId, kw, "provider", updateSession);
    return;
  }

  // ── Active thread: relay to client ────────────────────────────────────────
  if (sessionState === "open" || sessionState === "active") {
    // Intercept close commands BEFORE relay — never forward them as chat messages.
    if (isThreadCloseCommand(kw) && currentJobId) {
      await handleCloseRequest(ctx, currentJobId, updateSession);
      return;
    }
    const jctx = await resolveJobContext(supabase, fromNumber, currentJobId, body);
    if (jctx === "ambiguous") {
      await sendDisambiguationPrompt(ctx, updateSession);
      return;
    }
    if (jctx) {
      await relayProviderToClient(ctx, jctx, provider, updateSession);
      return;
    }
  }

  // ── Unrecognized ──────────────────────────────────────────────────────────
  await escalateAmbiguousReply(ctx, provider, body);
}

// ─── Resolve job ID for ACCEPT ────────────────────────────────────────────────
// Handles both Concierge (broadcast_sent state) and Marketplace (sent_to_provider).

async function resolveAcceptJobId(
  ctx: Ctx,
  provider: Record<string, unknown>,
): Promise<string | null> {
  const { supabase, fromNumber, body, session } = ctx;
  const currentJobId = session?.current_job_id as string | undefined;

  // Explicit job ID in message
  const match = body.match(/\b([A-Z]{2,3}-\d{5})\b/);
  if (match) {
    const [cat, seq] = match[1].split("-");
    const { data: jobs } = await supabase
      .from("jobs")
      .select("job_id")
      .like("job_id", `%-${cat}-${seq}`)
      .in("state", ["broadcast_sent", "sent_to_provider"])
      .limit(1);
    if (jobs?.[0]) return jobs[0].job_id;
  }

  // Session current_job_id
  if (currentJobId) {
    const { data: job } = await supabase.from("jobs")
      .select("job_id, state")
      .eq("job_id", currentJobId)
      .in("state", ["broadcast_sent", "sent_to_provider"])
      .maybeSingle();
    if (job) return job.job_id;
  }

  // Single pending broadcast for this provider (Concierge)
  const { data: brs } = await supabase.from("broadcast_responses")
    .select("job_id")
    .eq("provider_slug", String(provider.slug))
    .is("response", null)
    .limit(2);

  if (brs && brs.length === 1) return brs[0].job_id;

  // Single pending Marketplace job for this provider
  const { data: mkJobs } = await supabase.from("jobs")
    .select("job_id")
    .eq("marketplace_provider_slug", String(provider.slug))
    .eq("state", "sent_to_provider")
    .limit(2);

  if (mkJobs && mkJobs.length === 1) return mkJobs[0].job_id;

  return null;
}

// ─── Provider ACCEPT handler ──────────────────────────────────────────────────

async function handleProviderAccept(
  ctx: Ctx,
  provider: Record<string, unknown>,
  jobId: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  // Load job to determine flow (Concierge vs Marketplace)
  const { data: job } = await supabase.from("jobs")
    .select("job_id, source, state, address, category_code, category_name, client_whatsapp, client_id, assigned_provider_slug, marketplace_provider_slug")
    .eq("job_id", jobId)
    .single();

  if (!job) {
    await sendAndLog(ctx, fromNumber, `We couldn't find that job. Please contact support.`, {
      jobId,
      templateName: "JOB_NOT_FOUND",
    });
    return;
  }

  // ── Marketplace ACCEPT: direct path, no payment ───────────────────────────
  if (job.source === "marketplace") {
    // Record response time (marketplace: notified_at → first response)
    await recordProviderResponseTime(supabase, provider, jobId, "marketplace");

    if (job.state !== "sent_to_provider" || job.marketplace_provider_slug !== String(provider.slug)) {
      const msg = `[Job #${toPublicJobId(jobId)}] This request is no longer available.`;
      await sendAndLog(ctx, fromNumber, msg, {
        jobId,
        templateName: "MARKETPLACE_NO_LONGER_AVAILABLE",
      });
      return;
    }
    await handleMarketplaceAccept(ctx, provider, job, updateSession);
    return;
  }

  // ── Concierge ACCEPT: atomic claim → payment ──────────────────────────────
  // Record response time before claim — measures time from broadcast to ACCEPT.
  await recordProviderResponseTime(supabase, provider, jobId, "concierge");

  const { data: claimed } = await supabase.rpc("claim_lead", {
    p_job_id:        jobId,
    p_provider_slug: String(provider.slug),
  });

  if (!claimed) {
    const lostMsg = `[Job #${toPublicJobId(jobId)}] This job has already been claimed. Keep an eye out for the next one.`;
    await sendAndLog(ctx, fromNumber, lostMsg, { jobId, templateName: "CONCIERGE_CLAIM_LOST" });
    await updateSession({ session_state: "idle", current_job_id: null });
    return;
  }

  await updateSession({ session_state: "idle", current_job_id: jobId, sender_type: "provider" });

  // Trigger payment — awaited so failures surface immediately.
  // Any non-OK response or thrown error is written to admin_alerts so it's
  // visible without manual SQL inspection.
  const cronSecret = Deno.env.get("INTERNAL_CRON_SECRET");
  const fnBase     = (Deno.env.get("SUPABASE_URL") ?? "").split(".supabase.co")[0].replace("https://", "");
  try {
    const payRes = await fetch(`https://${fnBase}.supabase.co/functions/v1/create-payment-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": cronSecret ?? "" },
      body: JSON.stringify({ job_id: jobId, provider_slug: String(provider.slug) }),
    });
    if (!payRes.ok) {
      const errText = await payRes.text().catch(() => "(unreadable)");
      await supabase.from("admin_alerts").insert({
        alert_type:           "escalation",
        priority:             "high",
        job_id:               jobId,
        participant_whatsapp: fromNumber,
        description:
          `create-payment-link FAILED after provider ACCEPT. ` +
          `Status: ${payRes.status}. Body: ${errText.substring(0, 200)}`,
        status: "open",
      });
    }
  } catch (e) {
    await supabase.from("admin_alerts").insert({
      alert_type:           "escalation",
      priority:             "high",
      job_id:               jobId,
      participant_whatsapp: fromNumber,
      description:          `create-payment-link fetch threw after provider ACCEPT: ${String(e)}`,
      status:               "open",
    });
  }

  const ackMsg = `[Job #${toPublicJobId(jobId)}] Your claim has been received. ${
    provider.card_on_file
      ? "Your card on file will be charged now to confirm your assignment."
      : "Please complete payment using the link we're sending you now."
  }`;
  await sendAndLog(ctx, fromNumber, ackMsg, { jobId, templateName: "CONCIERGE_ACCEPT_ACK" });
}

// ─── Marketplace: provider ACCEPT ────────────────────────────────────────────

async function handleMarketplaceAccept(
  ctx: Ctx,
  provider: Record<string, unknown>,
  job: Record<string, unknown>,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;
  const jobId        = String(job.job_id);
  const categoryName = CATEGORY_NAMES[String(job.category_code)] ?? String(job.category_name ?? job.category_code);
  const address      = String(job.address ?? "address TBD");
  const clientWa     = String(job.client_whatsapp ?? "");

  // Advance job state — no payment required for Marketplace
  await supabase.from("jobs").update({
    state:                 "thread_live",
    status:                "assigned",
    assigned_provider_slug: String(provider.slug),
    assigned_at:           new Date().toISOString(),
    payment_status:        "n/a",
  }).eq("job_id", jobId);

  // Provider name for messages
  const providerName = String(provider.first_name ?? "Your TaskLeader");

  // Acknowledge to provider
  const ack = `[Job #${toPublicJobId(jobId)}] You've accepted this ${categoryName} request. We'll open the job thread now.`;
  await sendAndLog(ctx, fromNumber, ack, {
    jobId,
    templateName: "MKT_ACCEPT_PROVIDER_ACK",
  });

  // Add job_participants
  const participants: Record<string, unknown>[] = [
    { job_id: jobId, participant_type: "provider", whatsapp_e164: fromNumber, provider_slug: String(provider.slug) },
  ];
  if (clientWa) {
    participants.push({ job_id: jobId, participant_type: "client", whatsapp_e164: clientWa, client_id: job.client_id ?? null });
  }
  await supabase.from("job_participants").upsert(participants, { onConflict: "job_id,whatsapp_e164" });

  // Send WC-2 to client (Marketplace uses same assignment template).
  // Routed through sendAndLog so a Twilio failure (e.g. closed 24-hour session
  // window for a first-time web-submitted client) raises an admin_alerts row
  // in addition to the failed message_log entry. Phase 0 visibility only.
  if (clientWa) {
    const wc2 = buildWC2(jobId, address, providerName, categoryName);
    await sendAndLog(ctx, clientWa, wc2, {
      jobId,
      templateName: "MKT_ACCEPT_CLIENT_WC2",
    });

    // Update client session — recipient-only event, do not stamp
    // last_activity_at (the client did not inbound; they're being notified).
    await supabase.from("conversation_sessions").upsert({
      whatsapp_e164:   clientWa,
      sender_type:     "client",
      session_state:   "open",
      current_job_id:  jobId,
    }, { onConflict: "whatsapp_e164" });
  }

  await updateSession({ session_state: "open", current_job_id: jobId, sender_type: "provider" });
}

// ─── Marketplace: provider DECLINE ───────────────────────────────────────────

async function handleMarketplaceDecline(
  ctx: Ctx,
  jctx: JobContext,
  provider: Record<string, unknown>,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  await supabase.from("jobs").update({
    state:  "provider_declined",
    status: "pending",
  }).eq("job_id", jctx.jobId);

  // Acknowledge to provider
  const ack = `[Job #${toPublicJobId(jctx.jobId)}] Understood — you've declined this request.`;
  await sendAndLog(ctx, fromNumber, ack, {
    jobId: jctx.jobId,
    templateName: "MKT_DECLINE_PROVIDER_ACK",
  });

  // Load client WhatsApp
  const { data: job } = await supabase.from("jobs")
    .select("client_whatsapp, category_code, category_name")
    .eq("job_id", jctx.jobId).single();

  if (job?.client_whatsapp) {
    const catName = CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code;
    const notif   = buildMKT2Declined(jctx.jobId, jctx.address, catName);
    await sendAndLog(ctx, job.client_whatsapp, notif, {
      jobId: jctx.jobId,
      templateName: "MKT_2_DECLINED",
    });
  }

  // Reset the client's conversation session if (and only if) it is still tied
  // to this declined Marketplace job. The dual-eq guard (whatsapp_e164 AND
  // current_job_id) ensures we never clear a session that has already moved
  // on to a newer active request — e.g. if the client submitted a different
  // Marketplace Connect since this job was created, marketplace-connect would
  // have overwritten current_job_id with the new job, and that one stays.
  // Non-fatal: a failure here must not block the provider's session reset.
  // Recipient-only event — do not stamp last_activity_at (the client did not
  // inbound; they are about to receive the MKT-2-DECLINED notification).
  if (job?.client_whatsapp) {
    try {
      await supabase.from("conversation_sessions")
        .update({
          session_state:    "idle",
          current_job_id:   null,
        })
        .eq("whatsapp_e164", job.client_whatsapp)
        .eq("current_job_id", jctx.jobId);
    } catch { /* non-fatal: provider-side reset below must still run */ }
  }

  await updateSession({ session_state: "idle", current_job_id: null });
}

// ─── Ambiguous reply escalation ───────────────────────────────────────────────

async function escalateAmbiguousReply(
  ctx: Ctx,
  senderRecord: Record<string, unknown>,
  keyword: string,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  await supabase.from("admin_alerts").insert({
    alert_type:          "ambiguous_reply",
    priority:            "normal",
    participant_whatsapp: fromNumber,
    provider_slug:       senderRecord.slug as string ?? null,
    description:         `Ambiguous reply '${keyword.substring(0, 100)}' — no resolvable job context.`,
    status:              "open",
  });

  await sendAndLog(
    ctx, fromNumber,
    "We received your message but couldn't match it to an active job. Our team will follow up shortly. Reply HELP if you need support.",
    { templateName: "AMBIGUOUS_REPLY_ACK" },
  );
}

// ─── Unknown sender handler ───────────────────────────────────────────────────

async function handleUnknownSender(
  ctx: Ctx,
  client: Record<string, unknown> | null,
  provider: Record<string, unknown> | null,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;

  if (client?.suspended || provider?.suspended) {
    await sendAndLog(ctx, fromNumber,
      "Your access has been temporarily suspended. Please contact info@task-leaders.com for assistance.",
      { templateName: "UNKNOWN_SENDER_SUSPENDED" });
    return;
  }

  if (
    client?.status === "pending" ||
    provider?.status === "pending_onboarding" ||
    provider?.status === "pending_approval"
  ) {
    await sendAndLog(ctx, fromNumber,
      "Your account is currently under review. We'll reach out once it's approved.",
      { templateName: "UNKNOWN_SENDER_PENDING" });
    return;
  }

  await supabase.from("admin_alerts").insert({
    alert_type:          "escalation",
    priority:            "normal",
    participant_whatsapp: fromNumber,
    description:         `Message from unrecognized number: "${body.substring(0, 200)}"`,
    status:              "open",
  });

  await sendAndLog(ctx, fromNumber,
    "Hi — we don't have a record matching your number. If you'd like to learn more about TaskLeaders, visit task-leaders.com.",
    { templateName: "UNKNOWN_SENDER_INVITE" });
}

// ─── Response time recording ─────────────────────────────────────────────────
// Response time is SEPARATE from reliability. Tracked and stored independently.
// Called when a provider makes their first meaningful response (ACCEPT/PASS/DECLINE).
// Does NOT write to reliability_inputs or affect reliability_percent.

async function recordProviderResponseTime(
  supabase: ReturnType<typeof createClient>,
  provider: Record<string, unknown>,
  jobId: string,
  source: string,
) {
  const respondedAt = new Date().toISOString();

  if (source === "concierge") {
    // Concierge: measured from broadcast_sent_at → first provider response
    const { data: job } = await supabase
      .from("jobs")
      .select("broadcast_sent_at")
      .eq("job_id", jobId)
      .maybeSingle();

    if (job?.broadcast_sent_at) {
      const broadcastMs = new Date(job.broadcast_sent_at).getTime();
      const responseMs  = new Date(respondedAt).getTime();
      const responseMins = Math.round((responseMs - broadcastMs) / 60000 * 10) / 10;

      // Rolling average update via Postgres function (70/30 weight)
      await supabase.rpc("record_response_time", {
        p_provider_slug:     String(provider.slug),
        p_response_time_min: responseMins,
      });
    }
  } else if (source === "marketplace") {
    // Marketplace: measured from marketplace_notified_at → first provider response
    const { data: job } = await supabase
      .from("jobs")
      .select("marketplace_notified_at, first_provider_response_at")
      .eq("job_id", jobId)
      .maybeSingle();

    if (job?.marketplace_notified_at && !job.first_provider_response_at) {
      const notifiedMs  = new Date(job.marketplace_notified_at).getTime();
      const responseMs  = new Date(respondedAt).getTime();
      const responseMins = Math.round((responseMs - notifiedMs) / 60000 * 10) / 10;

      await supabase.from("jobs")
        .update({ first_provider_response_at: respondedAt })
        .eq("job_id", jobId);

      await supabase.rpc("record_response_time", {
        p_provider_slug:     String(provider.slug),
        p_response_time_min: responseMins,
      });
    }
  }
}

// ─── Trigger apply-reliability after survey complete ─────────────────────────
// Called from handleSurveyAnswer when the last question (q3) is answered.
// Fire-and-forget — survey record already written; this converts it to a
// reliability_input and updates providers.reliability_percent.

function triggerApplyReliability(providerSlug: string, jobId: string) {
  const cronSecret  = Deno.env.get("INTERNAL_CRON_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const fnBase      = supabaseUrl.split(".supabase.co")[0].replace("https://", "");
  fetch(`https://${fnBase}.supabase.co/functions/v1/apply-reliability`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": cronSecret ?? "" },
    body: JSON.stringify({ provider_slug: providerSlug, job_id: jobId }),
  }).catch(() => {});
}
