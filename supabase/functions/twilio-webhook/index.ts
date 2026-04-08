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
  SURVEY_QUESTIONS, buildMKT2Declined,
} from "../_shared/twilio.ts";
import {
  normalizeKeyword,
  KW_ACCEPT, KW_PASS, KW_DECLINE, KW_HELP,
  KW_KEEP_OPEN, KW_CANCEL, KW_YES, KW_NO,
  CATEGORY_NAMES, CATEGORY_LEAD_FEES_CENTS, calcGst as calcGstFn,
  SLUG_TO_CATEGORY_CODE,
} from "../_shared/constants.ts";
import { toPublicJobId } from "../_shared/job-ids.ts";

// Re-declare GST calc locally to keep import clean
function calcGst(base: number) { return Math.round(base * 0.05); }

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
  // Both lookups use OR to match the stored number in either +E164 or plain-digits
  // format. concierge-apply and provider onboarding do not normalize phone numbers
  // before storage, so both formats may exist in production.
  const [clientRes, providerRes] = await Promise.all([
    supabase
      .from("concierge_clients")
      .select("id, first_name, last_name, name, status, suspended, risk_flags")
      .or(`whatsapp.eq.${fromNumber},whatsapp.eq.${fromNumberDigits}`)
      .maybeSingle(),
    supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, status, suspended, concierge_eligible, card_on_file")
      .or(`whatsapp_number.eq.${fromNumber},whatsapp_number.eq.${fromNumberDigits}`)
      .maybeSingle(),
  ]);

  const client   = clientRes.data;
  const provider = providerRes.data;

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

  // ── Active thread: relay to provider ──────────────────────────────────────
  if (sessionState === "open" || sessionState === "active") {
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

  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, prompt);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", participantWhatsapp: fromNumber, body: prompt, status: "sent" });
  await updateSession({ session_state: "open", last_prompt: prompt });
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

  // ── Awaiting address ───────────────────────────────────────────────────────
  if (sessionState === "awaiting_address" && currentJobId) {
    await supabase.from("jobs").update({ address: body }).eq("job_id", currentJobId);
    const { data: job } = await supabase.from("jobs").select("description").eq("job_id", currentJobId).single();
    if (!job?.description) {
      const prompt = `Thank you. When do you need this done? (e.g. "tomorrow morning", "ASAP")`;
      if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, prompt);
      logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: currentJobId, participantWhatsapp: fromNumber, body: prompt, status: "sent" });
      await updateSession({ session_state: "awaiting_timing", current_job_id: currentJobId, last_prompt: prompt });
    } else {
      await finalizeAndDispatch(ctx, currentJobId, updateSession);
    }
    return;
  }

  // ── Awaiting timing ────────────────────────────────────────────────────────
  if (sessionState === "awaiting_timing" && currentJobId) {
    await supabase.from("jobs").update({ description: body }).eq("job_id", currentJobId);
    await finalizeAndDispatch(ctx, currentJobId, updateSession);
    return;
  }

  // ── Parse fresh request ────────────────────────────────────────────────────
  const bodyLower = body.toLowerCase();
  const keywordMap: [string[], string][] = [
    [["plumb", "pipe", "leak", "drain"],               "PLM"],
    [["clean"],                                         "CLN"],
    [["handyman", "repair", "fix", "install"],          "HND"],
    [["electric", "outlet", "wiring", "breaker"],       "ELC"],
    [["paint"],                                         "PLT"],
    [["hvac", "heat", "furnace", "air condition", "ac"],"HVC"],
    [["mov", "transport", "haul"],                      "MVG"],
    [["yard", "lawn", "garden", "snow"],                "YRD"],
  ];
  let categoryCode = "HND"; // default if undetected
  for (const [keywords, code] of keywordMap) {
    if (keywords.some((kw) => bodyLower.includes(kw))) { categoryCode = code; break; }
  }
  const categoryName = CATEGORY_NAMES[categoryCode];

  // Address is always collected via the multi-step prompt flow (address → timing → dispatch).
  // Do NOT attempt to extract an address from the first intake message.
  // The previous regex /\d+\s+[A-Za-z][\w\s,.]+/ was too permissive: it matched
  // quantities, ordinals, and any digit-preceded text (e.g. "1 plumber", "2nd floor"),
  // producing false positives that bypassed address collection and sent execution
  // directly to finalizeAndDispatch, leaving session_state = "idle" on first message.

  const cityCode = "VAN"; // default — derive from client profile in a future phase
  const { data: jobIdData } = await supabase.rpc("generate_job_id", {
    p_city_code: cityCode, p_category_code: categoryCode,
  });
  if (!jobIdData) {
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, "We're having trouble processing your request right now. Please try again in a moment.");
    return;
  }

  const baseFee = CATEGORY_LEAD_FEES_CENTS[categoryCode] ?? 0;
  const gst     = calcGst(baseFee);

  const { data: job } = await supabase.from("jobs").insert({
    job_id:              jobIdData,
    city_code:           cityCode,
    category_code:       categoryCode,
    category_name:       categoryName,
    status:              "pending",
    state:               "intake_started",
    source:              "concierge",
    client_id:           client.id ?? null,
    client_whatsapp:     fromNumber,
    address:             null,   // always null on first intake — collected via address prompt
    description:         body,
    lead_fee_cents:      baseFee,
    gst_cents:           gst,
    total_charged_cents: baseFee + gst,
  }).select("job_id, address, description").single();

  if (!job) return;

  if (!job.address) {
    const prompt = `Got it — we'll find you a ${categoryName}. What's the service address?`;
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, prompt);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: job.job_id, participantWhatsapp: fromNumber, body: prompt, status: "sent" });
    await updateSession({ session_state: "awaiting_address", current_job_id: job.job_id, sender_type: "client", last_prompt: prompt });
    return;
  }

  const hasTimingKeyword = /asap|today|tomorrow|morning|afternoon|evening|mon|tue|wed|thu|fri|sat|sun|weekend/i.test(body);
  if (!hasTimingKeyword) {
    const prompt = `Thanks — when do you need this? (e.g. "tomorrow morning", "ASAP")`;
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, prompt);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: job.job_id, participantWhatsapp: fromNumber, body: prompt, status: "sent" });
    await updateSession({ session_state: "awaiting_timing", current_job_id: job.job_id, sender_type: "client", last_prompt: prompt });
    return;
  }

  await finalizeAndDispatch(ctx, job.job_id, updateSession);
}

async function finalizeAndDispatch(
  ctx: Ctx,
  jobId: string,
  updateSession: (p: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  const confirm = `We've received your request and we're finding you a match. We'll be in touch shortly.`;
  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, confirm);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: confirm, status: "sent" });

  await supabase.from("jobs").update({ state: "intake_confirmed" }).eq("job_id", jobId);
  await updateSession({ session_state: "idle", current_job_id: jobId, sender_type: "client" });

  // Trigger dispatch
  const cronSecret = Deno.env.get("INTERNAL_CRON_SECRET");
  const fnBase     = (Deno.env.get("SUPABASE_URL") ?? "").split(".supabase.co")[0].replace("https://", "");
  fetch(`https://${fnBase}.supabase.co/functions/v1/job-dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": cronSecret ?? "" },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(() => {});
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
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, "Please reply with a number from 1 to 5.");
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
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, nextQ);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: nextQ, status: "sent" });
    await updateSession({ session_state: nextState, current_job_id: jobId, last_prompt: nextQ });
  } else {
    // Survey complete — advance job state
    await supabase.from("jobs").update({
      state:                "survey_complete",
      survey_completed_at:  new Date().toISOString(),
    }).eq("job_id", jobId);

    const thanks = "Thank you for your feedback. We appreciate it.";
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, thanks);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: thanks, status: "sent" });
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

  const nextClaimState = response === "YES" ? "client_confirmed_yes" : "client_confirmed_no";
  await supabase.from("guarantee_claims").update({
    client_response:     response,
    client_responded_at: new Date().toISOString(),
    claim_state:         nextClaimState,
  }).eq("job_id", jobId).eq("client_whatsapp", fromNumber);

  const reply = response === "YES"
    ? "Thank you. We'll continue reviewing this request and will be in touch."
    : "Thank you for confirming. We'll update this claim accordingly.";

  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, reply);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: reply, status: "sent" });

  await supabase.from("admin_alerts").insert({
    alert_type: "guarantee_claim", priority: "high", job_id: jobId,
    participant_whatsapp: fromNumber,
    description: `Client responded ${response} to guarantee claim confirmation.`,
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

  if (kw === KW_KEEP_OPEN) {
    const reply = "Understood — we'll keep searching and let you know as soon as we have a match.";
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, reply);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: reply, status: "sent" });
    await supabase.from("jobs").update({ state: "no_match" }).eq("job_id", jobId);
    await updateSession({ session_state: "idle", current_job_id: jobId });
  } else if (kw === KW_CANCEL) {
    const reply = "No problem — this request has been closed. Message us any time you need a TaskLeader.";
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, reply);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: reply, status: "sent" });
    await supabase.from("jobs").update({ state: "closed", status: "completed" }).eq("job_id", jobId);
    await updateSession({ session_state: "idle", current_job_id: null });
  } else {
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, "Please reply KEEP OPEN or CANCEL.");
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
    const result = await sendWhatsApp(twilioEnv, participant.whatsapp_e164, relayBody);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: jctx.jobId, participantWhatsapp: participant.whatsapp_e164, body: relayBody, status: result.ok ? "sent" : "failed" });
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
    const result = await sendWhatsApp(twilioEnv, participant.whatsapp_e164, relayBody);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: jctx.jobId, participantWhatsapp: participant.whatsapp_e164, body: relayBody, status: result.ok ? "sent" : "failed" });
  }

  logMessage({ supabaseUrl, serviceRoleKey, direction: "inbound", jobId: jctx.jobId, participantWhatsapp: fromNumber, body, status: "received" });

  // Update both sides of session with this job as current
  await updateSession({ session_state: "open", current_job_id: jctx.jobId });
  await supabase.from("conversation_sessions").upsert({
    whatsapp_e164:   participant.whatsapp_e164,
    current_job_id:  jctx.jobId,
    last_activity_at: new Date().toISOString(),
  }, { onConflict: "whatsapp_e164" });
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
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, "We've received your support request. Our team will be in touch shortly.");
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
        await handleMarketplaceDecline(ctx, jctx, provider, updateSession);
      } else {
        // Concierge pass — record first response time before updating DB
        await recordProviderResponseTime(supabase, provider, jctx.jobId, jctx.source);
        await supabase.from("broadcast_responses").update({
          response: kw, responded_at: new Date().toISOString(),
        }).eq("job_id", jctx.jobId).eq("provider_slug", String(provider.slug));
        const ack = "Understood — you've passed on this job.";
        if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, ack);
        logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: jctx.jobId, participantWhatsapp: fromNumber, body: ack, status: "sent" });
      }
      await updateSession({ session_state: "idle", current_job_id: null });
    } else {
      await escalateAmbiguousReply(ctx, provider, kw);
    }
    return;
  }

  // ── Active thread: relay to client ────────────────────────────────────────
  if (sessionState === "open" || sessionState === "active") {
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
    .select("job_id, source, state, address, category_code, category_name, client_whatsapp, client_id, assigned_provider_slug")
    .eq("job_id", jobId)
    .single();

  if (!job) {
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, `We couldn't find that job. Please contact support.`);
    return;
  }

  // ── Marketplace ACCEPT: direct path, no payment ───────────────────────────
  if (job.source === "marketplace") {
    // Record response time (marketplace: notified_at → first response)
    await recordProviderResponseTime(supabase, provider, jobId, "marketplace");

    if (job.state !== "sent_to_provider" || job.marketplace_provider_slug !== String(provider.slug)) {
      const msg = `[Job #${toPublicJobId(jobId)}] This request is no longer available.`;
      if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, msg);
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
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, lostMsg);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: lostMsg, status: "sent" });
    await updateSession({ session_state: "idle", current_job_id: null });
    return;
  }

  await updateSession({ session_state: "idle", current_job_id: jobId, sender_type: "provider" });

  // Trigger payment
  const cronSecret = Deno.env.get("INTERNAL_CRON_SECRET");
  const fnBase     = (Deno.env.get("SUPABASE_URL") ?? "").split(".supabase.co")[0].replace("https://", "");
  fetch(`https://${fnBase}.supabase.co/functions/v1/create-payment-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": cronSecret ?? "" },
    body: JSON.stringify({ job_id: jobId, provider_slug: String(provider.slug) }),
  }).catch(() => {});

  const ackMsg = `[Job #${toPublicJobId(jobId)}] Your claim has been received. ${
    provider.card_on_file
      ? "Your card on file will be charged now to confirm your assignment."
      : "Please complete payment using the link we're sending you now."
  }`;
  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, ackMsg);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: ackMsg, status: "sent" });
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
  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, ack);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: ack, status: "sent" });

  // Add job_participants
  const participants: Record<string, unknown>[] = [
    { job_id: jobId, participant_type: "provider", whatsapp_e164: fromNumber, provider_slug: String(provider.slug) },
  ];
  if (clientWa) {
    participants.push({ job_id: jobId, participant_type: "client", whatsapp_e164: clientWa, client_id: job.client_id ?? null });
  }
  await supabase.from("job_participants").upsert(participants, { onConflict: "job_id,whatsapp_e164" });

  // Send WC-2 to client (Marketplace uses same assignment template)
  if (twilioEnv && clientWa) {
    const wc2 = buildWC2(jobId, address, providerName, categoryName);
    const result = await sendWhatsApp(twilioEnv, clientWa, wc2);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: clientWa, templateName: "WC-2", body: wc2, status: result.ok ? "sent" : "failed" });

    // Update client session
    await supabase.from("conversation_sessions").upsert({
      whatsapp_e164:   clientWa,
      sender_type:     "client",
      session_state:   "open",
      current_job_id:  jobId,
      last_activity_at: new Date().toISOString(),
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
  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, ack);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: jctx.jobId, participantWhatsapp: fromNumber, body: ack, status: "sent" });

  // Load client WhatsApp
  const { data: job } = await supabase.from("jobs")
    .select("client_whatsapp, category_code, category_name")
    .eq("job_id", jctx.jobId).single();

  if (job?.client_whatsapp && twilioEnv) {
    const catName = CATEGORY_NAMES[job.category_code] ?? job.category_name ?? job.category_code;
    const notif   = buildMKT2Declined(jctx.jobId, jctx.address, catName);
    await sendWhatsApp(twilioEnv, job.client_whatsapp, notif);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: jctx.jobId, participantWhatsapp: job.client_whatsapp, templateName: "MKT-2-DECLINED", body: notif, status: "sent" });
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

  if (twilioEnv) {
    await sendWhatsApp(
      twilioEnv, fromNumber,
      "We received your message but couldn't match it to an active job. Our team will follow up shortly. Reply HELP if you need support.",
    );
  }
}

// ─── Unknown sender handler ───────────────────────────────────────────────────

async function handleUnknownSender(
  ctx: Ctx,
  client: Record<string, unknown> | null,
  provider: Record<string, unknown> | null,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;

  if (client?.suspended || provider?.suspended) {
    if (twilioEnv) {
      await sendWhatsApp(twilioEnv, fromNumber,
        "Your access has been temporarily suspended. Please contact info@task-leaders.com for assistance.");
    }
    return;
  }

  if (
    client?.status === "pending" ||
    provider?.status === "pending_onboarding" ||
    provider?.status === "pending_approval"
  ) {
    if (twilioEnv) {
      await sendWhatsApp(twilioEnv, fromNumber,
        "Your account is currently under review. We'll reach out once it's approved.");
    }
    return;
  }

  await supabase.from("admin_alerts").insert({
    alert_type:          "escalation",
    priority:            "normal",
    participant_whatsapp: fromNumber,
    description:         `Message from unrecognized number: "${body.substring(0, 200)}"`,
    status:              "open",
  });

  if (twilioEnv) {
    await sendWhatsApp(twilioEnv, fromNumber,
      "Hi — we don't have a record matching your number. If you'd like to learn more about TaskLeaders, visit task-leaders.com.");
  }
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
