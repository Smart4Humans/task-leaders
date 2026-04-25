// TaskLeaders — Twilio WhatsApp Utility
//
// Handles:
//  - Outbound WhatsApp message sends via Twilio Messages API
//  - Template body construction for all 11 approved templates (WC-1 … WT-7)
//  - Twilio webhook signature validation (HMAC-SHA1)
//  - message_log persistence
//
// ROUTING CONSTRAINT: All communication routes through the TaskLeaders
// WhatsApp number. No direct number exchange between client and provider.
// This applies to both Concierge and Marketplace flows in the current phase.
//
// TEMPLATE PRODUCTION NOTE:
// In Twilio WhatsApp Sandbox mode, templates are sent as plain text bodies.
// In production, each template needs a Content SID (from Twilio Content API
// after Meta approval). Add ContentSid / ContentVariables when templates are
// approved. The buildTemplateBody() functions below produce the exact approved
// copy for sandbox testing and for production body matching.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toPublicJobId, jobHeader } from "./job-ids.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TwilioEnv {
  accountSid:       string;
  authToken:        string;
  whatsappNumber:   string; // E.164, e.g. +17781234567
}

export interface SendResult {
  ok:         boolean;
  messageSid: string | null;
  error:      string | null;
}

// ─── Env loader ──────────────────────────────────────────────────────────────

export function getTwilioEnv(): TwilioEnv | null {
  const accountSid     = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken      = Deno.env.get("TWILIO_AUTH_TOKEN");
  const whatsappNumber = Deno.env.get("TWILIO_WHATSAPP_NUMBER");
  if (!accountSid || !authToken || !whatsappNumber) return null;
  return { accountSid, authToken, whatsappNumber };
}

// ─── Twilio signature validation ─────────────────────────────────────────────

/**
 * Validates the X-Twilio-Signature header on inbound webhook requests.
 * Uses HMAC-SHA1 over (url + sorted params concatenated).
 */
export async function validateTwilioSignature(
  authToken: string,
  webhookUrl: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  const sortedKeys = Object.keys(params).sort();
  let s = webhookUrl;
  for (const key of sortedKeys) {
    s += key + (params[key] ?? "");
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const rawSig = await crypto.subtle.sign("HMAC", key, enc.encode(s));
  const computed = btoa(String.fromCharCode(...new Uint8Array(rawSig)));
  return computed === signature;
}

// ─── Outbound send ───────────────────────────────────────────────────────────

/**
 * Sends a WhatsApp message via Twilio Messages API.
 * All messages originate from the TaskLeaders WhatsApp number (TWILIO_WHATSAPP_NUMBER).
 * The recipient (to) is an E.164 number without the whatsapp: prefix.
 *
 * Use this for in-session/free-form messages (WT-6, WT-7, WT-8, relay messages).
 * For business-initiated sends that require Meta-approved templates, use sendTemplateWhatsApp().
 */
export async function sendWhatsApp(
  env: TwilioEnv,
  to: string,        // E.164, e.g. +16041234567
  body: string,
): Promise<SendResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.accountSid}/Messages.json`;
  const params = new URLSearchParams({
    From: `whatsapp:${env.whatsappNumber}`,
    To:   `whatsapp:${to}`,
    Body: body,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": "Basic " + btoa(`${env.accountSid}:${env.authToken}`),
      },
      body: params,
    });

    const data = await res.json();
    if (res.ok && data.sid) {
      return { ok: true, messageSid: data.sid, error: null };
    }
    return { ok: false, messageSid: null, error: data.message ?? "Twilio send failed" };
  } catch (e) {
    return { ok: false, messageSid: null, error: String(e) };
  }
}

/**
 * Sends a business-initiated WhatsApp message using a Meta-approved Content Template.
 *
 * Production path (contentSid set):
 *   Sends via ContentSid + ContentVariables. The approved template body is rendered
 *   by Twilio/Meta — the fallbackBody is NOT sent, but IS used for message_log.
 *
 * Sandbox / development path (contentSid absent or null):
 *   Falls through to plain Body send (same as sendWhatsApp). Sandbox does not
 *   enforce template approval, so this works for testing without SIDs configured.
 *
 * Use for all 9 business-initiated sends: WC-1..WC-4, WT-1..WT-5.
 * Configure template SIDs via Supabase Edge Function secrets:
 *   TWILIO_TEMPLATE_SID_WC1, TWILIO_TEMPLATE_SID_WC2, ... TWILIO_TEMPLATE_SID_WT5
 *
 * contentVariables keys must match the {{N}} placeholder indices in the registered
 * Twilio Content Template exactly (e.g. {"1": "Alice", "2": "Cleaning"}).
 */
export async function sendTemplateWhatsApp(
  env: TwilioEnv,
  to: string,                                              // E.164, e.g. +16041234567
  contentSid: string | null | undefined,                   // HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  contentVariables: Record<string, string> | null | undefined,
  fallbackBody: string,                                    // buildXxx() output — logged always
): Promise<SendResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.accountSid}/Messages.json`;

  const params: Record<string, string> = {
    From: `whatsapp:${env.whatsappNumber}`,
    To:   `whatsapp:${to}`,
  };

  if (contentSid) {
    params["ContentSid"] = contentSid;
    if (contentVariables && Object.keys(contentVariables).length > 0) {
      params["ContentVariables"] = JSON.stringify(contentVariables);
    }
  } else {
    // No SID configured — fall through to plain body (Sandbox / pre-production)
    params["Body"] = fallbackBody;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": "Basic " + btoa(`${env.accountSid}:${env.authToken}`),
      },
      body: new URLSearchParams(params),
    });

    const data = await res.json();
    if (res.ok && data.sid) {
      return { ok: true, messageSid: data.sid, error: null };
    }
    return { ok: false, messageSid: null, error: data.message ?? "Twilio send failed" };
  } catch (e) {
    return { ok: false, messageSid: null, error: String(e) };
  }
}

// ─── message_log persistence ─────────────────────────────────────────────────

export async function logMessage(opts: {
  supabaseUrl:    string;
  serviceRoleKey: string;
  direction:      "inbound" | "outbound";
  jobId?:         string | null;
  participantWhatsapp: string;
  messageSid?:    string | null;
  templateName?:  string | null;
  body?:          string | null;
  status?:        string | null;
}) {
  const sb = createClient(opts.supabaseUrl, opts.serviceRoleKey, {
    auth: { persistSession: false },
  });
  await sb.from("message_log").insert({
    direction:            opts.direction,
    job_id:               opts.jobId ?? null,
    participant_whatsapp: opts.participantWhatsapp,
    twilio_message_sid:   opts.messageSid ?? null,
    template_name:        opts.templateName ?? null,
    body:                 opts.body ?? null,
    status:               opts.status ?? null,
  });
  // Fire-and-forget — don't block on log write
}

// ─── Template body builders ───────────────────────────────────────────────────
// Each function returns the exact approved copy with variables substituted.
// Public-facing copy uses we/us/our (locked rule). TN/TaskLeaders Network is internal only.
// All job IDs are public format (city prefix suppressed) — use toPublicJobId().

/** WC-1 — Client welcome / Concierge approval */
export function buildWC1(firstName: string): string {
  return (
    `Hi ${firstName} — you're approved for TaskLeaders Concierge.\n\n` +
    `Save this number. When you need help, just message us here and we'll take it from there.\n\n` +
    `No login. No account setup each time. Just send your request with details when you need a TaskLeader.\n\n` +
    `— TaskLeaders Concierge`
  );
}

/** WC-2 — Job confirmed / TaskLeader assigned */
export function buildWC2(
  jobId: string,
  address: string,
  providerName: string,
  categoryName: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} ${providerName} is confirmed for your ${categoryName} job.\n\n` +
    `We're opening your TaskLeaders job thread now so timing, updates, and communication stay organized.\n\n` +
    `We encourage strong communication, so please take this opportunity to initiate the next steps toward successful completion.`
  );
}

/** WC-3 — Post-job survey intro (sent to client) */
export function buildWC3(
  jobId: string,
  address: string,
  providerName: string,
  categoryName: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} We'd appreciate your feedback on ${providerName} for your ${categoryName} job.\n\n` +
    `We'll ask 3 quick questions next. For each one, please rate from 1 to 5, where 1 is the lowest and 5 is the highest.`
  );
}

/** WC-3 survey questions (sent sequentially after WC-3) */
export const SURVEY_QUESTIONS = {
  q1: "Punctuality — please reply with a number from 1 to 5 (1 = lowest, 5 = highest).",
  q2: "Communication — please reply with a number from 1 to 5 (1 = lowest, 5 = highest).",
  q3: "Quality — please reply with a number from 1 to 5 (1 = lowest, 5 = highest).",
};

/** WC-4 — No match available (sent to client) */
export function buildWC4(
  jobId: string,
  address: string,
  categoryName: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} We apologize — we weren't able to confirm a ${categoryName} match for you just yet.\n\n` +
    `Your request is still open.\n\n` +
    `Reply KEEP SEARCHING if you'd like us to keep trying, or CLOSE NOW if you'd like us to close this request.`
  );
}

/** WT-1 — TaskLeader profile activation / welcome (sent to provider) */
export function buildWT1(firstName: string): string {
  return (
    `Hi ${firstName} — welcome to TaskLeaders Concierge.\n\n` +
    `Your profile is now active.\n\n` +
    `When a matching Concierge lead comes in, we'll message you here. The first qualified TaskLeader to accept and complete lead fee payment gets the job.\n\n` +
    `Reply HELP any time if you need support.`
  );
}

/** WT-2 — Lead broadcast (sent to provider) */
export function buildWT2(
  jobId: string,
  address: string,
  categoryName: string,
  timing: string,
  description: string,
  leadFeeDollars: string, // e.g. "50.00"
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} New Concierge lead.\n\n` +
    `Service: ${categoryName}\n` +
    `Timing: ${timing}\n` +
    `Details: ${description}\n` +
    `Lead fee: $${leadFeeDollars} + GST\n\n` +
    `Reply ACCEPT to claim this job. The first qualified TaskLeader to accept and complete payment of the lead fee owns it.\n\n` +
    `If you have a card on file, your lead fee will be charged automatically once your claim is confirmed. If you do not have a card on file, you will receive a payment link and must complete payment within the required time window.\n\n` +
    `Reminder: all lead fees are guaranteed. However, claiming a lead and not completing payment hurts your Reliability score.`
  );
}

/** WT-3 — Day-of ETA reminder (sent to provider; conditional — only if eligible) */
export function buildWT3(
  jobId: string,
  address: string,
  categoryName: string,
  clientName: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} Reminder — you have a ${categoryName} job today for ${clientName}.\n\n` +
    `Please send your ETA in the TaskLeaders job thread before heading over.\n\n` +
    `Keep in mind that communication and punctuality are key parts of your Reliability score.`
  );
}

/**
 * WT-4 — Lead Guarantee factual confirmation (sent to provider / TaskLeader)
 * Registered in Twilio with YES/NO Quick Reply buttons. In production the interactive
 * buttons render from the approved Content Template. The fallback body below is used
 * for sandbox testing and message_log.
 */
export function buildWT4(
  jobId: string,
  address: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} We have received your Lead Guarantee request for this job.\n\n` +
    `To process this claim, we need your factual confirmation: did any work take place, or was any work arranged to take place, for this job?\n\n` +
    `Please reply YES or NO.`
  );
}

/**
 * WC-5 — Lead Guarantee client factual check (sent to client)
 * Registered in Twilio with YES/NO Quick Reply buttons. In production the interactive
 * buttons render from the approved Content Template. The fallback body below is used
 * for sandbox testing and message_log.
 */
export function buildWC5(
  jobId: string,
  address: string,
  providerName: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} We have received a report from ${providerName} indicating that no work related to this job has taken place or will take place.\n\n` +
    `Did or will any work take place for the original job request you submitted?\n\n` +
    `Please reply YES or NO.`
  );
}

/** WT-5 — Post-job notification (sent to provider) */
export function buildWT5(
  jobId: string,
  address: string,
  clientName: string,
  categoryName: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} We have sent a post-job survey to ${clientName} for your ${categoryName} job.\n\n` +
    `Any eligible score update will be reflected in your profile metrics after processing.`
  );
}

/** WT-6 — Payment timeout warning (sent to provider; fires at 5 minutes remaining) */
export function buildWT6(
  jobId: string,
  address: string,
  paymentUrl: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} We have not received your lead fee payment yet.\n\n` +
    `You have 5 minutes left to complete payment for this job before it is released.\n\n` +
    `Reminder: non-payment of the lead fee negatively impacts your Reliability score.\n\n` +
    `Pay here: ${paymentUrl}`
  );
}

/** WT-7 — Lead released after timeout (sent to provider) */
export function buildWT7(
  jobId: string,
  address: string,
  updateCardUrl: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} This lead has been released because we did not receive payment within the required time window.\n\n` +
    `This will affect your Reliability score.\n\n` +
    `To avoid this in future, add or update your payment card on file here: ${updateCardUrl}`
  );
}

/** WT-8 — Payment confirmed / job thread open (sent to provider after successful payment)
 *
 * Concierge providers should initiate promptly — responsiveness and proactive
 * coordination are part of the TaskLeaders reliability standard. If the client's
 * first name is known, address the provider's call-to-action by name; otherwise
 * fall back to "the Client".
 */
export function buildWT8(
  jobId: string,
  address: string,
  categoryName: string,
  clientFirstName?: string | null,
): string {
  const hdr     = jobHeader(jobId, address);
  const whoRaw  = (clientFirstName ?? "").trim();
  const who     = whoRaw.length > 0 ? whoRaw : "the Client";
  return (
    `Payment received — you're confirmed on this ${categoryName} job.\n\n` +
    `Job ID: ${hdr}\n\n` +
    `We've opened your TaskLeaders job thread with ${who}. ` +
    `Please message ${who} here now to confirm job details, timing, and next steps.`
  );
}

/**
 * WT-9 — Lead Guarantee claim approved (sent to provider / TaskLeader)
 * Business-initiated: must be sent via an approved template to cross the 24-hour
 * session window (admin may resolve the claim hours or days after WT-4).
 */
export function buildWT9(
  jobId: string,
  address: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} Your Lead Guarantee claim has been approved.\n\n` +
    `Your lead fee will be refunded to your original payment method within 7 business days. ` +
    `Refund processing is handled manually — we will follow up in this thread once the refund has been issued.\n\n` +
    `Reply HELP if you have any questions.`
  );
}

/**
 * WT-10 — Lead Guarantee claim denied (sent to provider / TaskLeader)
 * Business-initiated: must be sent via an approved template to cross the 24-hour
 * session window.
 */
export function buildWT10(
  jobId: string,
  address: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} Your Lead Guarantee claim has been reviewed and was not approved.\n\n` +
    `No refund will be issued for this claim.\n\n` +
    `Reply HELP if you have questions about this outcome.`
  );
}

/**
 * WC-7 — Lead Guarantee claim approved (sent to client)
 * Business-initiated: must be sent via an approved template to cross the 24-hour
 * session window.
 */
export function buildWC7(
  jobId: string,
  address: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} The Lead Guarantee claim for your job has been reviewed and approved.\n\n` +
    `No further action is required on your part.\n\n` +
    `Reply HELP if you have any questions.`
  );
}

/**
 * WC-8 — Lead Guarantee claim denied (sent to client)
 * Business-initiated: must be sent via an approved template to cross the 24-hour
 * session window.
 */
export function buildWC8(
  jobId: string,
  address: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} The Lead Guarantee claim for your job has been reviewed.\n\n` +
    `No further action is required on your part.\n\n` +
    `Reply HELP if you have any questions.`
  );
}

// ─── Routed-thread relay helpers ─────────────────────────────────────────────
// Every relayed message includes the job header so recipients can distinguish
// threads when multiple jobs are active simultaneously.
// Format: [Job #PLM-00001 | 123 Main St]\n[Sender] original message

/**
 * Wraps a client's free-form message for relay to the assigned provider.
 * Always prefixes with job header to maintain thread context.
 */
export function buildRelayToProvider(
  jobId: string,
  address: string,
  clientMessage: string,
): string {
  return `${jobHeader(jobId, address)}\n[Client] ${clientMessage}`;
}

/**
 * Wraps a provider's free-form message for relay to the client.
 * Always prefixes with job header to maintain thread context.
 */
export function buildRelayToClient(
  jobId: string,
  address: string,
  providerFirstName: string,
  providerMessage: string,
): string {
  return `${jobHeader(jobId, address)}\n[${providerFirstName}] ${providerMessage}`;
}

// ─── Marketplace templates ────────────────────────────────────────────────────

/**
 * MKT-1 — Marketplace provider notification
 * Sent to the specific provider selected from the public profile.
 * No lead fee — Marketplace providers receive direct requests.
 */
export function buildMKT1(
  jobId: string,
  address: string,
  clientName: string,
  categoryName: string,
  description: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} New request via your TaskLeaders profile.\n\n` +
    `Client: ${clientName}\n` +
    `Service: ${categoryName}\n` +
    `Details: ${description}\n\n` +
    `Reply ACCEPT to confirm this job. Reply DECLINE to pass.\n\n` +
    `This is a direct request from a client who selected your profile.`
  );
}

/**
 * MKT-2 — Client notification: provider declined or no response
 * Sent to the Marketplace client when the targeted provider declines or doesn't respond.
 */
export function buildMKT2Declined(
  jobId: string,
  address: string,
  categoryName: string,
): string {
  const hdr = jobHeader(jobId, address);
  return (
    `${hdr} The TaskLeader you selected is unable to take your ${categoryName} request at this time.\n\n` +
    `Browse more TaskLeaders at task-leaders.com to find another match.`
  );
}

// Re-export for convenience
export { toPublicJobId, jobHeader };
