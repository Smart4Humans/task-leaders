// TaskLeaders — Edge Function: twilio-webhook
// Contract: POST /twilio-webhook (Twilio sends form-encoded inbound message data)
//
// Handles ALL inbound WhatsApp messages to the TaskLeaders number.
// Routes based on sender identity, job context, and session state.
//
// Ambiguity resolution order (§10 of brief):
//   1. Explicit job ID in reply body
//   2. Pending prompt for sender (conversation_sessions.last_prompt context)
//   3. Single active job for sender
//   4. Most recent active job if confidence high
//   5. Escalate to admin
//
// ROUTING CONSTRAINT: All communication stays routed through the TaskLeaders
// number. No direct number exchange between client and provider in this phase.
//
// State machine: Concierge and Marketplace flows are kept distinct.
// Do not collapse them into a single generic path.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  validateTwilioSignature, getTwilioEnv, sendWhatsApp, logMessage,
  buildWC1, buildWC2, buildWC3, buildWC4,
  buildWT1, buildWT2, buildWT3, buildWT4, buildWT5, buildWT6, buildWT7,
  SURVEY_QUESTIONS,
} from "../_shared/twilio.ts";
import {
  normalizeKeyword,
  KW_ACCEPT, KW_PASS, KW_DECLINE, KW_HELP,
  KW_KEEP_OPEN, KW_CANCEL, KW_YES, KW_NO,
  CATEGORY_NAMES, CATEGORY_LEAD_FEES_CENTS, calcGst,
  SLUG_TO_CATEGORY_CODE,
} from "../_shared/constants.ts";
import { toPublicJobId } from "../_shared/job-ids.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function twilioResponse(body = "") {
  // Return empty TwiML response (no auto-reply — we send via REST API instead)
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
    { headers: { "content-type": "text/xml; charset=utf-8" } },
  );
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResp({ ok: true });
  if (req.method !== "POST")    return new Response("Method not allowed", { status: 405 });

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const twilioToken    = Deno.env.get("TWILIO_AUTH_TOKEN");
  const webhookUrl     = Deno.env.get("TWILIO_WEBHOOK_URL"); // full URL of this function

  if (!supabaseUrl || !serviceRoleKey || !twilioToken) {
    return new Response("Missing configuration", { status: 500 });
  }

  // Parse Twilio form-encoded body
  const rawBody = await req.text();
  const params  = Object.fromEntries(new URLSearchParams(rawBody).entries());

  // Validate Twilio signature (skip in sandbox/dev if TWILIO_SKIP_SIG=true)
  const skipSig = Deno.env.get("TWILIO_SKIP_SIG") === "true";
  if (!skipSig && webhookUrl) {
    const sig   = req.headers.get("x-twilio-signature") ?? "";
    const valid = await validateTwilioSignature(twilioToken, webhookUrl, params, sig);
    if (!valid) return new Response("Invalid signature", { status: 403 });
  }

  // Extract core message fields
  const rawFrom   = params["From"] ?? "";
  const rawTo     = params["To"]   ?? "";
  const body      = (params["Body"] ?? "").trim();
  const messageSid = params["MessageSid"] ?? "";

  // Strip whatsapp: prefix — store numbers in plain E.164
  const fromNumber = rawFrom.replace(/^whatsapp:/, "");
  const toNumber   = rawTo.replace(/^whatsapp:/, "");

  if (!fromNumber) return twilioResponse();

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const twilioEnv = getTwilioEnv();

  // Log inbound message immediately (job_id resolved later if possible)
  // Fire-and-forget
  const logPromise = supabase.from("message_log").insert({
    direction:            "inbound",
    participant_whatsapp: fromNumber,
    twilio_message_sid:   messageSid,
    body,
    status: "received",
  });

  // ── Identify sender ────────────────────────────────────────────────────────
  const [clientRes, providerRes] = await Promise.all([
    supabase
      .from("concierge_clients")
      .select("id, first_name, last_name, name, status, suspended, risk_flags")
      .eq("whatsapp", fromNumber)
      .maybeSingle(),
    supabase
      .from("provider_accounts")
      .select("slug, first_name, last_name, status, suspended, concierge_eligible, card_on_file")
      .eq("whatsapp_number", fromNumber)
      .maybeSingle(),
  ]);

  const client   = clientRes.data;
  const provider = providerRes.data;

  // ── Load or create conversation session ───────────────────────────────────
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

  // ── Route ─────────────────────────────────────────────────────────────────

  if (client && client.status === "active" && !client.suspended) {
    await handleClientMessage(
      { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body, messageSid, session },
      client,
      updateSession,
      logPromise,
    );
  } else if (provider && provider.status === "active" && !provider.suspended) {
    await handleProviderMessage(
      { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body, messageSid, session },
      provider,
      updateSession,
    );
  } else {
    await handleUnknownSender(
      { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body, messageSid },
      client,
      provider,
    );
  }

  return twilioResponse();
});

// ─── Context ─────────────────────────────────────────────────────────────────

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

// ─── Client message handler ───────────────────────────────────────────────────

async function handleClientMessage(
  ctx: Ctx,
  client: Record<string, unknown>,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
  _logPromise: Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;
  const { session } = ctx;
  const kw          = normalizeKeyword(body);
  const sessionState = String(session?.session_state ?? "idle");
  const currentJobId = session?.current_job_id as string | undefined;

  // ── Survey answer capture ─────────────────────────────────────────────────
  if (sessionState.startsWith("awaiting_survey_q")) {
    await handleSurveyAnswer(ctx, client, sessionState, currentJobId, kw, updateSession);
    return;
  }

  // ── Guarantee claim confirmation ───────────────────────────────────────────
  if (sessionState === "awaiting_guarantee_confirm") {
    await handleGuaranteeConfirmation(ctx, currentJobId, kw, updateSession);
    return;
  }

  // ── No-match decision ──────────────────────────────────────────────────────
  if (sessionState === "awaiting_no_match_decision") {
    await handleNoMatchDecision(ctx, client, currentJobId, kw, updateSession);
    return;
  }

  // ── Active thread: relay message to provider ───────────────────────────────
  if ((sessionState === "open" || sessionState === "active") && currentJobId) {
    await relayClientToProvider(ctx, currentJobId, updateSession);
    return;
  }

  // ── New intake: client has no active session ───────────────────────────────
  await handleConciergeIntake(ctx, client, session, updateSession);
}

// ─── Concierge intake ─────────────────────────────────────────────────────────

async function handleConciergeIntake(
  ctx: Ctx,
  client: Record<string, unknown>,
  session: Record<string, unknown> | null,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;
  const sessionState = String(session?.session_state ?? "idle");
  const firstName    = String(client.first_name ?? (client.name as string ?? "").split(" ")[0] ?? "there");

  // ── Awaiting address ───────────────────────────────────────────────────────
  if (sessionState === "awaiting_address") {
    const jobId = session?.current_job_id as string | undefined;
    if (!jobId) { await startFreshIntake(ctx, client, body, updateSession); return; }

    // Store address on job
    await supabase.from("jobs").update({ address: body }).eq("job_id", jobId);

    // Check if we also need timing
    const { data: job } = await supabase.from("jobs")
      .select("description").eq("job_id", jobId).single();

    if (!job?.description) {
      const prompt = `Thank you. When do you need this done? (e.g. "tomorrow morning" or "ASAP")`;
      if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, prompt);
      logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: prompt, status: "sent" });
      await updateSession({ session_state: "awaiting_timing", current_job_id: jobId, last_prompt: prompt });
    } else {
      await finalizeIntakeAndDispatch(ctx, jobId, updateSession);
    }
    return;
  }

  // ── Awaiting timing ────────────────────────────────────────────────────────
  if (sessionState === "awaiting_timing") {
    const jobId = session?.current_job_id as string | undefined;
    if (!jobId) { await startFreshIntake(ctx, client, body, updateSession); return; }

    await supabase.from("jobs").update({ description: body }).eq("job_id", jobId);
    await finalizeIntakeAndDispatch(ctx, jobId, updateSession);
    return;
  }

  // ── Fresh request ──────────────────────────────────────────────────────────
  await startFreshIntake(ctx, client, body, updateSession);
}

async function startFreshIntake(
  ctx: Ctx,
  client: Record<string, unknown>,
  requestBody: string,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  // Try to parse service type from message
  // Simple keyword scan for category — more sophisticated NLP is Phase 5
  const bodyLower = requestBody.toLowerCase();
  let categoryCode: string | null = null;
  let categoryName: string | null = null;

  const keywordMap: Record<string, string> = {
    "plumb": "PLM", "pipe": "PLM",
    "clean": "CLN",
    "handyman": "HND", "repair": "HND", "fix": "HND",
    "electric": "ELC",
    "paint": "PLT",
    "hvac": "HVC", "heat": "HVC", "furnace": "HVC", "air condition": "HVC",
    "mov": "MVG", "transport": "MVG",
    "yard": "YRD", "lawn": "YRD", "garden": "YRD",
  };

  for (const [kw, code] of Object.entries(keywordMap)) {
    if (bodyLower.includes(kw)) {
      categoryCode = code;
      categoryName = CATEGORY_NAMES[code];
      break;
    }
  }

  // Try to detect address (heuristic: contains a number followed by words)
  const addressMatch = requestBody.match(/\d+\s+[A-Za-z][\w\s,]+/);
  const detectedAddress = addressMatch?.[0]?.trim() ?? null;

  // Load client's city context — default to VAN for MVP
  // TODO Phase 5: derive city from client profile or WhatsApp geolocation
  const cityCode = "VAN";

  // Create job record
  // We call the generate_job_id RPC directly from here
  const { data: jobIdData } = await supabase
    .rpc("generate_job_id", { p_city_code: cityCode, p_category_code: categoryCode ?? "HND" });

  if (!jobIdData) {
    if (twilioEnv) {
      await sendWhatsApp(twilioEnv, fromNumber, "We're having trouble processing your request. Please try again in a moment.");
    }
    return;
  }

  const baseFee  = categoryCode ? (CATEGORY_LEAD_FEES_CENTS[categoryCode] ?? 0) : 0;
  const gst      = calcGst(baseFee);

  const { data: job } = await supabase.from("jobs").insert({
    job_id:          jobIdData,
    city_code:       cityCode,
    category_code:   categoryCode ?? "HND",
    category_name:   categoryName ?? "General",
    status:          "pending",
    state:           "intake_started",
    source:          "concierge",
    client_id:       client.id ?? null,
    client_whatsapp: fromNumber,
    address:         detectedAddress,
    description:     requestBody,
    lead_fee_cents:  baseFee,
    gst_cents:       gst,
    total_charged_cents: baseFee + gst,
  }).select("job_id, address, description").single();

  if (!job) return;

  // If we're missing address, ask for it
  if (!job.address) {
    const prompt = `Got it — we'll find you a ${categoryName ?? "TaskLeader"}. What's the service address?`;
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, prompt);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: job.job_id, participantWhatsapp: fromNumber, body: prompt, status: "sent" });
    await updateSession({ session_state: "awaiting_address", current_job_id: job.job_id, sender_type: "client", last_prompt: prompt });
    return;
  }

  // If we're missing timing, ask for it
  if (!job.description || job.description === requestBody) {
    // Description = original message. That's fine for timing.
    // Check if timing is implied in the message
    const hasTimingKeyword = /asap|today|tomorrow|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|weekend/i.test(requestBody);
    if (!hasTimingKeyword) {
      const prompt = `Thanks — and when do you need this? (e.g. "tomorrow morning", "ASAP")`;
      if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, prompt);
      logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId: job.job_id, participantWhatsapp: fromNumber, body: prompt, status: "sent" });
      await updateSession({ session_state: "awaiting_timing", current_job_id: job.job_id, sender_type: "client", last_prompt: prompt });
      return;
    }
  }

  // All details collected — confirm and dispatch
  await finalizeIntakeAndDispatch(ctx, job.job_id, updateSession);
}

async function finalizeIntakeAndDispatch(
  ctx: Ctx,
  jobId: string,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  // Confirm to client
  const confirm = `We've received your request and we're finding you a match now. We'll be in touch shortly.`;
  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, confirm);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: confirm, status: "sent" });

  // Advance job state
  await supabase.from("jobs")
    .update({ state: "intake_confirmed" })
    .eq("job_id", jobId);

  await updateSession({ session_state: "idle", current_job_id: jobId, sender_type: "client" });

  // Trigger dispatch (call job-dispatch function internally)
  const dispatchUrl  = Deno.env.get("SUPABASE_URL")?.replace("supabase.co", "supabase.co") ?? "";
  const cronSecret   = Deno.env.get("INTERNAL_CRON_SECRET");
  const fnBase       = `${dispatchUrl.replace("https://", "https://").split(".supabase.co")[0]}.supabase.co/functions/v1`;

  fetch(`${fnBase}/job-dispatch`, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-internal-secret": cronSecret ?? "",
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(() => {}); // fire-and-forget
}

// ─── Survey answer handler ────────────────────────────────────────────────────

async function handleSurveyAnswer(
  ctx: Ctx,
  client: Record<string, unknown>,
  sessionState: string,
  jobId: string | undefined,
  kw: string,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;
  if (!jobId) return;

  const score = parseInt(kw, 10);
  if (isNaN(score) || score < 1 || score > 5) {
    if (twilioEnv) {
      await sendWhatsApp(twilioEnv, fromNumber, "Please reply with a number from 1 to 5.");
    }
    return;
  }

  let nextState: string;
  let updateField: string;
  let nextPrompt: string | null = null;

  if (sessionState === "awaiting_survey_q1") {
    updateField = "punctuality_score";
    nextState   = "awaiting_survey_q2";
    nextPrompt  = SURVEY_QUESTIONS.q2;
  } else if (sessionState === "awaiting_survey_q2") {
    updateField = "communication_score";
    nextState   = "awaiting_survey_q3";
    nextPrompt  = SURVEY_QUESTIONS.q3;
  } else {
    // q3
    updateField = "quality_score";
    nextState   = "idle";
  }

  // Upsert survey_responses
  await supabase.from("survey_responses")
    .upsert({
      job_id:          jobId,
      client_whatsapp: fromNumber,
      [updateField]:   score,
      ...(sessionState === "awaiting_survey_q1" ? { survey_started_at: new Date().toISOString() } : {}),
      ...(nextState === "idle" ? { survey_completed_at: new Date().toISOString() } : {}),
    }, { onConflict: "job_id,client_whatsapp" });

  if (nextPrompt && twilioEnv) {
    await sendWhatsApp(twilioEnv, fromNumber, nextPrompt);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: nextPrompt, status: "sent" });
    await updateSession({ session_state: nextState, current_job_id: jobId, last_prompt: nextPrompt });
  } else {
    // Survey complete
    await supabase.from("jobs")
      .update({ state: "survey_complete", survey_completed_at: new Date().toISOString() })
      .eq("job_id", jobId);

    const thanks = "Thank you for your feedback. We appreciate it.";
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, thanks);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: thanks, status: "sent" });
    await updateSession({ session_state: "idle", current_job_id: null });
  }
}

// ─── Guarantee claim confirmation ─────────────────────────────────────────────

async function handleGuaranteeConfirmation(
  ctx: Ctx,
  jobId: string | undefined,
  kw: string,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;
  if (!jobId) return;

  const response = kw === KW_YES ? "YES" : kw === KW_NO ? "NO" : null;
  if (!response) {
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, "Please reply YES or NO.");
    return;
  }

  const nextClaimState = response === "YES" ? "client_confirmed_yes" : "client_confirmed_no";
  await supabase.from("guarantee_claims")
    .update({
      client_response:     response,
      client_responded_at: new Date().toISOString(),
      claim_state:         nextClaimState,
    })
    .eq("job_id", jobId)
    .eq("client_whatsapp", fromNumber);

  const replyMsg = response === "YES"
    ? "Thank you. We'll continue reviewing this request and will be in touch."
    : "Thank you for confirming. We'll update this claim accordingly.";

  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, replyMsg);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: replyMsg, status: "sent" });

  await supabase.from("admin_alerts").insert({
    alert_type:          "guarantee_claim",
    priority:            "high",
    job_id:              jobId,
    participant_whatsapp: fromNumber,
    description:         `Client responded ${response} to guarantee claim confirmation.`,
    status:              "open",
  });

  await updateSession({ session_state: "idle", current_job_id: null });
}

// ─── No-match decision ────────────────────────────────────────────────────────

async function handleNoMatchDecision(
  ctx: Ctx,
  client: Record<string, unknown>,
  jobId: string | undefined,
  kw: string,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
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
    // Unrecognized reply to no-match prompt
    if (twilioEnv) {
      await sendWhatsApp(twilioEnv, fromNumber, "Please reply KEEP OPEN or CANCEL.");
    }
  }
}

// ─── Relay client message to provider ────────────────────────────────────────
// Routes message through the TaskLeaders number to the assigned provider.
// This is the routed thread model — no direct number exchange.

async function relayClientToProvider(
  ctx: Ctx,
  jobId: string,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;

  const { data: participant } = await supabase
    .from("job_participants")
    .select("whatsapp_e164")
    .eq("job_id", jobId)
    .eq("participant_type", "provider")
    .eq("session_state", "active")
    .maybeSingle();

  if (!participant?.whatsapp_e164) {
    // No provider in thread yet — log for admin
    await supabase.from("admin_alerts").insert({
      alert_type:          "escalation",
      priority:            "normal",
      job_id:              jobId,
      participant_whatsapp: fromNumber,
      description:         "Client sent message but no provider in thread yet.",
      status:              "open",
    });
    return;
  }

  // Prefix with [Client] so provider knows who sent it
  const relayBody = `[Client] ${body}`;
  if (twilioEnv) {
    const result = await sendWhatsApp(twilioEnv, participant.whatsapp_e164, relayBody);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: participant.whatsapp_e164, body: relayBody, status: result.ok ? "sent" : "failed" });
  }

  await updateSession({ session_state: "open", current_job_id: jobId });
}

// ─── Provider message handler ─────────────────────────────────────────────────

async function handleProviderMessage(
  ctx: Ctx,
  provider: Record<string, unknown>,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;
  const { session } = ctx;
  const kw          = normalizeKeyword(body);
  const sessionState = String(session?.session_state ?? "idle");
  const currentJobId = session?.current_job_id as string | undefined;

  // ── HELP keyword ───────────────────────────────────────────────────────────
  if (kw === KW_HELP) {
    await supabase.from("admin_alerts").insert({
      alert_type:          "escalation",
      priority:            "normal",
      provider_slug:       String(provider.slug),
      participant_whatsapp: fromNumber,
      description:         "Provider requested HELP.",
      status:              "open",
    });
    if (twilioEnv) {
      await sendWhatsApp(twilioEnv, fromNumber, "We've received your support request. Our team will be in touch shortly.");
    }
    return;
  }

  // ── ACCEPT ────────────────────────────────────────────────────────────────
  if (kw === KW_ACCEPT && (sessionState === "awaiting_accept" || currentJobId)) {
    const jobId = resolveJobId(body, currentJobId);
    if (!jobId) {
      await escalateAmbiguousReply(ctx, provider, "ACCEPT");
      return;
    }
    await handleProviderAccept(ctx, provider, jobId, updateSession);
    return;
  }

  // ── PASS or DECLINE ───────────────────────────────────────────────────────
  if ((kw === KW_PASS || kw === KW_DECLINE) && currentJobId) {
    const jobId = resolveJobId(body, currentJobId);
    if (jobId) {
      await supabase.from("broadcast_responses")
        .update({ response: kw, responded_at: new Date().toISOString() })
        .eq("job_id", jobId)
        .eq("provider_slug", String(provider.slug));

      await updateSession({ session_state: "idle", current_job_id: null, sender_type: "provider" });

      const ack = "Understood — you've passed on this job.";
      if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, ack);
      logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: ack, status: "sent" });
    }
    return;
  }

  // ── Active thread: relay to client ────────────────────────────────────────
  if ((sessionState === "open" || sessionState === "active") && currentJobId) {
    await relayProviderToClient(ctx, currentJobId, provider, updateSession);
    return;
  }

  // ── Unrecognized / no context ─────────────────────────────────────────────
  await escalateAmbiguousReply(ctx, provider, body);
}

// ─── Provider ACCEPT handler ──────────────────────────────────────────────────

async function handleProviderAccept(
  ctx: Ctx,
  provider: Record<string, unknown>,
  jobId: string,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber } = ctx;

  // Atomic claim via Postgres function (handles race condition)
  const { data: claimed } = await supabase.rpc("claim_lead", {
    p_job_id:        jobId,
    p_provider_slug: String(provider.slug),
  });

  if (!claimed) {
    // Another provider got there first
    const lostMsg = `[Job #${toPublicJobId(jobId)}] This job has already been claimed. Keep an eye out for the next one.`;
    if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, lostMsg);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: lostMsg, status: "sent" });
    await updateSession({ session_state: "idle", current_job_id: null });
    return;
  }

  // Claim successful — trigger payment
  await updateSession({ session_state: "idle", current_job_id: jobId, sender_type: "provider" });

  // Call create-payment-link internally
  const cronSecret = Deno.env.get("INTERNAL_CRON_SECRET");
  const supabaseUrl2 = Deno.env.get("SUPABASE_URL") ?? "";
  const fnBase = supabaseUrl2.includes("supabase.co")
    ? supabaseUrl2.replace("https://", "").split(".supabase.co")[0]
    : "";
  const paymentUrl = `https://${fnBase}.supabase.co/functions/v1/create-payment-link`;

  fetch(paymentUrl, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-internal-secret": cronSecret ?? "",
    },
    body: JSON.stringify({ job_id: jobId, provider_slug: String(provider.slug) }),
  }).catch(() => {});

  // Send acknowledgment to provider
  const ackMsg = `[Job #${toPublicJobId(jobId)}] Your claim has been received. ${
    provider.card_on_file
      ? "Your card on file will be charged now to confirm your assignment."
      : "Please complete payment using the link we're sending you."
  }`;
  if (twilioEnv) await sendWhatsApp(twilioEnv, fromNumber, ackMsg);
  logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: fromNumber, body: ackMsg, status: "sent" });
}

// ─── Relay provider message to client ─────────────────────────────────────────

async function relayProviderToClient(
  ctx: Ctx,
  jobId: string,
  provider: Record<string, unknown>,
  updateSession: (patch: Record<string, unknown>) => Promise<unknown>,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;

  const { data: participant } = await supabase
    .from("job_participants")
    .select("whatsapp_e164")
    .eq("job_id", jobId)
    .eq("participant_type", "client")
    .eq("session_state", "active")
    .maybeSingle();

  if (!participant?.whatsapp_e164) return;

  const firstName    = String(provider.first_name ?? "Your TaskLeader");
  const relayBody    = `[${firstName}] ${body}`;
  if (twilioEnv) {
    const result = await sendWhatsApp(twilioEnv, participant.whatsapp_e164, relayBody);
    logMessage({ supabaseUrl, serviceRoleKey, direction: "outbound", jobId, participantWhatsapp: participant.whatsapp_e164, body: relayBody, status: result.ok ? "sent" : "failed" });
  }

  await updateSession({ session_state: "open", current_job_id: jobId });
}

// ─── Ambiguous reply escalation ───────────────────────────────────────────────

async function escalateAmbiguousReply(
  ctx: Ctx,
  senderRecord: Record<string, unknown>,
  keyword: string,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, session } = ctx;

  await supabase.from("admin_alerts").insert({
    alert_type:          "ambiguous_reply",
    priority:            "normal",
    participant_whatsapp: fromNumber,
    provider_slug:       senderRecord.slug as string ?? null,
    description:         `Ambiguous reply '${keyword}' with no resolvable job context.`,
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
  _unused?: unknown,
) {
  const { supabase, supabaseUrl, serviceRoleKey, twilioEnv, fromNumber, body } = ctx;

  // Suspended check
  if (client?.suspended || provider?.suspended) {
    if (twilioEnv) {
      await sendWhatsApp(
        twilioEnv, fromNumber,
        "Your access has been temporarily suspended. Please contact us at info@task-leaders.com for assistance.",
      );
    }
    return;
  }

  // Pending (awaiting approval)
  if (client?.status === "pending" || provider?.status === "pending_onboarding" || provider?.status === "pending_approval") {
    if (twilioEnv) {
      await sendWhatsApp(
        twilioEnv, fromNumber,
        "Your account is currently under review. We'll reach out once it's approved.",
      );
    }
    return;
  }

  // Truly unknown sender
  await supabase.from("admin_alerts").insert({
    alert_type:          "escalation",
    priority:            "normal",
    participant_whatsapp: fromNumber,
    description:         `Message from unrecognized number: "${body.substring(0, 200)}"`,
    status:              "open",
  });

  if (twilioEnv) {
    await sendWhatsApp(
      twilioEnv, fromNumber,
      "Hi — we don't have a record matching your number. If you'd like to learn more about TaskLeaders, visit task-leaders.com.",
    );
  }
}

// ─── Job ID resolution helper ─────────────────────────────────────────────────

/**
 * Attempts to extract an explicit public job ID from the reply body.
 * Falls back to currentJobId from session.
 * Returns internal job_id format or null.
 */
function resolveJobId(body: string, currentJobId: string | undefined): string | null {
  // Match public format: PLM-00001 (in body)
  const match = body.match(/\b([A-Z]{2,3}-\d{5})\b/);
  if (match) {
    // We have a public ID — resolve back to full job_id via session context
    // For now return the public ID as-is; the DB stores full IDs but
    // generate_public_job_id() strips city — we check both formats in query
    return currentJobId ?? null; // Phase 5: full reverse-lookup from public ID
  }
  return currentJobId ?? null;
}
