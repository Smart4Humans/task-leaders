-- ============================================================================
-- TaskLeaders Messaging Engine — Schema Migration
-- Date: 2026-04-08
-- Scope: Phase 2 — Twilio / WhatsApp / Stripe / State Machine
--
-- Adds:
--   • concierge_eligible + Stripe/payment fields on provider_accounts
--   • suspended + risk_flags on concierge_clients
--   • state machine + messaging columns on jobs
--   • broadcast_responses, job_participants, message_log, conversation_sessions,
--     payment_records, survey_responses, guarantee_claims, admin_alerts tables
--   • generate_public_job_id(), claim_lead(), check_payment_timeouts() functions
--   • pg_cron schedule for payment timeout checks
--
-- Payment rule (locked): 10-minute total window, warning at 5 minutes remaining.
-- Public job ID format: PLM-00001 (city prefix suppressed, stored internally only).
-- ============================================================================

-- ─── EXTENSIONS ─────────────────────────────────────────────────────────────
-- pg_net: HTTP calls from Postgres. Required for pg_cron → edge function calls.
-- pg_cron: Scheduled Postgres jobs. Enable in Dashboard > Database > Extensions
--          if the line below fails.
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ─── COLUMN ADDITIONS — provider_accounts ───────────────────────────────────

-- concierge_eligible: explicit Concierge Tier 1 flag.
-- Only TRUE providers may receive Concierge broadcast leads.
-- Marketplace-only providers remain FALSE.
ALTER TABLE public.provider_accounts
  ADD COLUMN IF NOT EXISTS concierge_eligible       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_customer_id       TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT,
  ADD COLUMN IF NOT EXISTS card_on_file             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS risk_flags               JSONB   NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS provider_accounts_concierge_eligible_idx
  ON public.provider_accounts (concierge_eligible)
  WHERE concierge_eligible = true;

-- ─── COLUMN ADDITIONS — concierge_clients ───────────────────────────────────

ALTER TABLE public.concierge_clients
  ADD COLUMN IF NOT EXISTS suspended  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS risk_flags JSONB   NOT NULL DEFAULT '{}';

-- ─── COLUMN ADDITIONS — jobs ─────────────────────────────────────────────────

-- state: granular state machine state (separate from status which admin sees).
-- source: 'concierge' | 'marketplace' — preserves distinct workflow logic.
-- payment_status: 'unpaid' | 'pending' | 'paid' | 'failed' | 'released'
-- lead_fee_cents / gst_cents / total_charged_cents stored separately (locked rule).
-- client_whatsapp: denormalized for fast webhook routing without a join.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS state                    TEXT    NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS source                   TEXT    NOT NULL DEFAULT 'concierge',
  ADD COLUMN IF NOT EXISTS lead_fee_cents           INTEGER,
  ADD COLUMN IF NOT EXISTS gst_cents                INTEGER,
  ADD COLUMN IF NOT EXISTS total_charged_cents      INTEGER,
  ADD COLUMN IF NOT EXISTS assigned_provider_slug   TEXT,
  ADD COLUMN IF NOT EXISTS broadcast_sent_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS survey_sent_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS survey_completed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_status           TEXT    NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS client_whatsapp          TEXT,
  ADD COLUMN IF NOT EXISTS marketplace_provider_slug TEXT;

CREATE INDEX IF NOT EXISTS jobs_state_idx          ON public.jobs (state);
CREATE INDEX IF NOT EXISTS jobs_source_idx         ON public.jobs (source);
CREATE INDEX IF NOT EXISTS jobs_client_whatsapp_idx ON public.jobs (client_whatsapp);
CREATE INDEX IF NOT EXISTS jobs_assigned_provider_idx ON public.jobs (assigned_provider_slug);

-- ─── TABLE: broadcast_responses ─────────────────────────────────────────────
-- Tracks every provider who received a Concierge broadcast and their response.
-- One row per (job, provider). Used to pick winner and manage the broadcast queue.
CREATE TABLE IF NOT EXISTS public.broadcast_responses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            TEXT        NOT NULL REFERENCES public.jobs(job_id) ON DELETE CASCADE,
  provider_slug     TEXT        NOT NULL,
  whatsapp_e164     TEXT        NOT NULL,
  broadcast_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response          TEXT,         -- 'ACCEPT' | 'PASS' | 'DECLINE' | NULL = no response
  responded_at      TIMESTAMPTZ,
  claim_attempt_at  TIMESTAMPTZ,
  claim_successful  BOOLEAN,
  UNIQUE(job_id, provider_slug)
);

CREATE INDEX IF NOT EXISTS broadcast_responses_job_id_idx
  ON public.broadcast_responses (job_id);
CREATE INDEX IF NOT EXISTS broadcast_responses_provider_slug_idx
  ON public.broadcast_responses (provider_slug);
CREATE INDEX IF NOT EXISTS broadcast_responses_pending_idx
  ON public.broadcast_responses (job_id)
  WHERE response IS NULL;

-- ─── TABLE: job_participants ─────────────────────────────────────────────────
-- Active participants in a job's routed thread (post-assignment).
-- Always 1 client + 1 provider. All messages route through the TaskLeaders number.
-- Direct number exposure between client and provider is NOT allowed in this phase.
CREATE TABLE IF NOT EXISTS public.job_participants (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           TEXT        NOT NULL REFERENCES public.jobs(job_id) ON DELETE CASCADE,
  participant_type TEXT        NOT NULL,      -- 'client' | 'provider'
  whatsapp_e164    TEXT        NOT NULL,
  provider_slug    TEXT,                      -- populated when participant_type = 'provider'
  client_id        UUID,                      -- populated when participant_type = 'client'
  session_state    TEXT        NOT NULL DEFAULT 'active', -- 'active' | 'removed'
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, whatsapp_e164)
);

CREATE INDEX IF NOT EXISTS job_participants_job_id_idx
  ON public.job_participants (job_id);
CREATE INDEX IF NOT EXISTS job_participants_whatsapp_idx
  ON public.job_participants (whatsapp_e164);

-- ─── TABLE: message_log ──────────────────────────────────────────────────────
-- Full inbound/outbound WhatsApp message history tied to job context.
-- Source of truth for all TaskLeaders thread communication.
CREATE TABLE IF NOT EXISTS public.message_log (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  direction            TEXT        NOT NULL,  -- 'inbound' | 'outbound'
  job_id               TEXT,                  -- NULL during intake before job is created
  participant_whatsapp TEXT        NOT NULL,
  twilio_message_sid   TEXT,
  template_name        TEXT,                  -- e.g. 'WT-2', 'WC-1'; NULL = free-form
  body                 TEXT,
  status               TEXT,                  -- 'sent' | 'delivered' | 'read' | 'failed'
  error_code           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS message_log_job_id_idx
  ON public.message_log (job_id);
CREATE INDEX IF NOT EXISTS message_log_participant_idx
  ON public.message_log (participant_whatsapp);
CREATE INDEX IF NOT EXISTS message_log_created_at_idx
  ON public.message_log (created_at DESC);

-- ─── TABLE: conversation_sessions ───────────────────────────────────────────
-- Per-sender session state for routing inbound WhatsApp messages.
-- One row per WhatsApp number. Updated on every inbound/outbound message.
CREATE TABLE IF NOT EXISTS public.conversation_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_e164    TEXT        NOT NULL UNIQUE,
  sender_type      TEXT,   -- 'client' | 'provider' | 'unknown'
  current_job_id   TEXT,   -- most recently active job for this sender
  session_state    TEXT    NOT NULL DEFAULT 'idle',
  -- States:
  --   idle                          — no pending prompt
  --   open                          — active thread, free-form allowed
  --   awaiting_accept               — broadcast sent, waiting for ACCEPT/PASS
  --   awaiting_address              — intake in progress, collecting address
  --   awaiting_timing               — intake in progress, collecting timing
  --   awaiting_survey_q1            — punctuality question sent
  --   awaiting_survey_q2            — communication question sent
  --   awaiting_survey_q3            — quality question sent
  --   awaiting_guarantee_confirm    — WT-4 sent, waiting YES/NO
  --   awaiting_no_match_decision    — WC-4 sent, waiting KEEP OPEN/CANCEL
  last_prompt      TEXT,   -- last outbound body (for context resolution)
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_sessions_whatsapp_idx
  ON public.conversation_sessions (whatsapp_e164);

-- ─── TABLE: payment_records ──────────────────────────────────────────────────
-- Lead fee payment tracking per job/provider with Stripe IDs and timeout stamps.
--
-- LOCKED PAYMENT RULE: 10-minute total window, warning at 5 minutes remaining.
-- Any reference to "5-minute window" in older docs is outdated and must not be
-- used in timers, constants, or column naming.
CREATE TABLE IF NOT EXISTS public.payment_records (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   TEXT        NOT NULL REFERENCES public.jobs(job_id) ON DELETE CASCADE,
  provider_slug            TEXT        NOT NULL,
  -- Fee breakdown (stored separately, locked rule):
  base_fee_cents           INTEGER     NOT NULL,
  gst_cents                INTEGER     NOT NULL,
  total_charged_cents      INTEGER     NOT NULL,
  payment_method           TEXT,       -- 'card_on_file' | 'payment_link'
  stripe_payment_intent_id TEXT,
  stripe_payment_link_id   TEXT,
  stripe_payment_link_url  TEXT,
  payment_status           TEXT        NOT NULL DEFAULT 'pending',
  -- pending | paid | failed | released | refunded
  payment_initiated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- payment_warning_sent_at: set when WT-6 fires (5 minutes remaining).
  -- Named "warning" not "5min" to decouple from the old rule.
  payment_warning_sent_at  TIMESTAMPTZ,
  -- payment_timeout_at: set at initiation to NOW() + 10 minutes.
  payment_timeout_at       TIMESTAMPTZ,
  payment_completed_at     TIMESTAMPTZ,
  released_at              TIMESTAMPTZ,
  UNIQUE(job_id, provider_slug)
);

CREATE INDEX IF NOT EXISTS payment_records_job_id_idx
  ON public.payment_records (job_id);
CREATE INDEX IF NOT EXISTS payment_records_status_timeout_idx
  ON public.payment_records (payment_status, payment_timeout_at)
  WHERE payment_status = 'pending';

-- ─── TABLE: survey_responses ─────────────────────────────────────────────────
-- Post-job survey: 3 questions on a 1–5 scale (WC-3 flow).
-- Feeds into reliability score pipeline (Phase 4).
CREATE TABLE IF NOT EXISTS public.survey_responses (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                    TEXT        NOT NULL REFERENCES public.jobs(job_id) ON DELETE CASCADE,
  client_whatsapp           TEXT        NOT NULL,
  provider_slug             TEXT,
  punctuality_score         INTEGER     CHECK (punctuality_score BETWEEN 1 AND 5),
  communication_score       INTEGER     CHECK (communication_score BETWEEN 1 AND 5),
  quality_score             INTEGER     CHECK (quality_score BETWEEN 1 AND 5),
  survey_started_at         TIMESTAMPTZ,
  survey_completed_at       TIMESTAMPTZ,
  reliability_input_applied BOOLEAN     NOT NULL DEFAULT false,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, client_whatsapp)
);

CREATE INDEX IF NOT EXISTS survey_responses_job_id_idx
  ON public.survey_responses (job_id);
CREATE INDEX IF NOT EXISTS survey_responses_provider_slug_idx
  ON public.survey_responses (provider_slug);
CREATE INDEX IF NOT EXISTS survey_responses_unapplied_idx
  ON public.survey_responses (provider_slug)
  WHERE reliability_input_applied = false AND survey_completed_at IS NOT NULL;

-- ─── TABLE: guarantee_claims ─────────────────────────────────────────────────
-- Lead Guarantee claims. Initiated by admin/email process (not auto-triggered).
-- Client confirmation is requested in WhatsApp (WT-4). Admin adjudicates if needed.
CREATE TABLE IF NOT EXISTS public.guarantee_claims (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              TEXT        NOT NULL REFERENCES public.jobs(job_id) ON DELETE CASCADE,
  provider_slug       TEXT        NOT NULL,
  initiated_by        TEXT,       -- 'admin' | 'email'
  claim_state         TEXT        NOT NULL DEFAULT 'initiated',
  -- initiated | client_confirmation_sent | client_confirmed_yes | client_confirmed_no
  -- | adjudicating | approved | denied | closed
  client_whatsapp     TEXT,
  client_response     TEXT,       -- 'YES' | 'NO'
  client_responded_at TIMESTAMPTZ,
  admin_notes         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS guarantee_claims_job_id_idx
  ON public.guarantee_claims (job_id);
CREATE INDEX IF NOT EXISTS guarantee_claims_state_idx
  ON public.guarantee_claims (claim_state)
  WHERE claim_state NOT IN ('closed', 'denied', 'approved');

-- ─── TABLE: admin_alerts ─────────────────────────────────────────────────────
-- Escalation records queued for admin review, email, and optional WhatsApp alert.
-- payment_warning / payment_released are processed by the process-timeouts function.
CREATE TABLE IF NOT EXISTS public.admin_alerts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type           TEXT        NOT NULL,
  -- payment_warning | payment_released | ambiguous_reply | no_match | guarantee_claim
  -- | risk_flag | escalation | no_provider_response
  priority             TEXT        NOT NULL DEFAULT 'normal', -- 'normal' | 'high'
  job_id               TEXT,
  participant_whatsapp TEXT,
  provider_slug        TEXT,
  description          TEXT,
  status               TEXT        NOT NULL DEFAULT 'open',  -- 'open' | 'acknowledged' | 'resolved'
  email_sent           BOOLEAN     NOT NULL DEFAULT false,
  whatsapp_sent        BOOLEAN     NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_alerts_status_idx
  ON public.admin_alerts (status)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS admin_alerts_type_status_idx
  ON public.admin_alerts (alert_type, status);
CREATE INDEX IF NOT EXISTS admin_alerts_job_id_idx
  ON public.admin_alerts (job_id);
CREATE INDEX IF NOT EXISTS admin_alerts_created_at_idx
  ON public.admin_alerts (created_at DESC);

-- ─── FUNCTION: generate_public_job_id ───────────────────────────────────────
-- Strips the city prefix from internal job IDs for all public-facing display.
-- Internal DB stores VAN-PLM-00001. Public display shows PLM-00001.
-- Job header format: [Job #PLM-00001 | 123 Main St]
CREATE OR REPLACE FUNCTION public.generate_public_job_id(full_job_id TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN array_length(string_to_array(full_job_id, '-'), 1) = 3
      THEN split_part(full_job_id, '-', 2) || '-' || split_part(full_job_id, '-', 3)
    ELSE full_job_id
  END;
$$;

-- ─── FUNCTION: claim_lead ────────────────────────────────────────────────────
-- Atomically claims a broadcast job for a provider.
-- Uses a conditional UPDATE to prevent race conditions when multiple providers
-- reply ACCEPT near-simultaneously.
-- Returns TRUE if this provider successfully claimed the job.
-- Returns FALSE if another provider already claimed it first.
CREATE OR REPLACE FUNCTION public.claim_lead(
  p_job_id        TEXT,
  p_provider_slug TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.jobs
  SET
    state                  = 'claim_received',
    assigned_provider_slug = p_provider_slug,
    payment_status         = 'pending'
  WHERE
    job_id                 = p_job_id
    AND state              = 'broadcast_sent'
    AND assigned_provider_slug IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    -- Record the successful claim attempt in broadcast_responses
    UPDATE public.broadcast_responses
    SET
      response         = 'ACCEPT',
      responded_at     = NOW(),
      claim_attempt_at = NOW(),
      claim_successful = true
    WHERE job_id = p_job_id AND provider_slug = p_provider_slug;
  END IF;

  RETURN v_updated > 0;
END;
$$;

-- ─── FUNCTION: check_payment_timeouts ───────────────────────────────────────
-- Called by pg_cron every minute.
-- Identifies payment_records needing:
--   1. Warning (WT-6): 5 minutes remaining — marks payment_warning_sent_at
--   2. Release (WT-7): 10 minutes expired  — marks released, reverts job to broadcast_sent
-- Inserts admin_alert rows for the process-timeouts edge function to action.
-- Twilio sends are NOT made from this function — they happen in the edge function.
--
-- PAYMENT WINDOW: 10 minutes total (PAYMENT_WINDOW_MINUTES = 10).
-- WARNING TRIGGER: at 5 minutes remaining (5 minutes after initiation).
-- WT-6 copy correctly says "5 minutes left" — this is the warning, not the window.
CREATE OR REPLACE FUNCTION public.check_payment_timeouts()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_warnings_queued  INTEGER := 0;
  v_releases_queued  INTEGER := 0;
  r                  RECORD;
BEGIN
  -- ── Warning: 5 minutes remaining ─────────────────────────────────────────
  -- Fires when: initiated_at + 5min <= NOW() AND timeout_at > NOW()
  FOR r IN
    SELECT pr.id, pr.job_id, pr.provider_slug, pr.total_charged_cents,
           pr.stripe_payment_link_url
    FROM   public.payment_records pr
    WHERE  pr.payment_status         = 'pending'
    AND    pr.payment_warning_sent_at IS NULL
    AND    pr.payment_timeout_at - INTERVAL '5 minutes' <= NOW()
    AND    pr.payment_timeout_at > NOW()
  LOOP
    UPDATE public.payment_records
    SET payment_warning_sent_at = NOW()
    WHERE id = r.id;

    INSERT INTO public.admin_alerts
      (alert_type, priority, job_id, provider_slug, description, status)
    VALUES
      ('payment_warning', 'high', r.job_id, r.provider_slug,
       'WT-6 required — 5 minutes remaining on payment window', 'open');

    v_warnings_queued := v_warnings_queued + 1;
  END LOOP;

  -- ── Release: 10-minute window expired ────────────────────────────────────
  FOR r IN
    SELECT pr.id, pr.job_id, pr.provider_slug, pr.stripe_payment_link_url
    FROM   public.payment_records pr
    WHERE  pr.payment_status    = 'pending'
    AND    pr.payment_timeout_at <= NOW()
  LOOP
    -- Release the payment record
    UPDATE public.payment_records
    SET payment_status = 'released', released_at = NOW()
    WHERE id = r.id;

    -- Revert job: back to broadcast_sent so next provider can claim
    UPDATE public.jobs
    SET
      state                  = 'broadcast_sent',
      assigned_provider_slug = NULL,
      payment_status         = 'unpaid'
    WHERE job_id                = r.job_id
    AND   assigned_provider_slug = r.provider_slug;

    -- Mark broadcast_response for this provider
    UPDATE public.broadcast_responses
    SET
      response         = 'ACCEPT',
      responded_at     = COALESCE(responded_at, NOW()),
      claim_attempt_at = COALESCE(claim_attempt_at, NOW()),
      claim_successful = false
    WHERE job_id = r.job_id AND provider_slug = r.provider_slug;

    INSERT INTO public.admin_alerts
      (alert_type, priority, job_id, provider_slug, description, status)
    VALUES
      ('payment_released', 'high', r.job_id, r.provider_slug,
       'WT-7 required — lead released after payment timeout', 'open');

    v_releases_queued := v_releases_queued + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'warnings_queued', v_warnings_queued,
    'releases_queued', v_releases_queued,
    'checked_at',      NOW()
  );
END;
$$;

-- ─── pg_cron: Payment timeout checks ────────────────────────────────────────
-- Runs check_payment_timeouts() every minute.
-- PREREQUISITE: pg_cron must be enabled in Supabase Dashboard > Database > Extensions.
-- If not yet enabled, the DO block catches the error gracefully.
--
-- SETUP REQUIRED before this runs correctly:
--   1. Enable pg_cron in Supabase Dashboard > Database > Extensions
--   2. Set INTERNAL_CRON_SECRET in Supabase Dashboard > Edge Functions > Secrets
--      (same value must be set as a DB param for pg_net calls to process-timeouts)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule if already exists (idempotent deploy)
    BEGIN
      PERFORM cron.unschedule('taskleaders-check-payment-timeouts');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- Schedule: every minute
    PERFORM cron.schedule(
      'taskleaders-check-payment-timeouts',
      '* * * * *',
      'SELECT public.check_payment_timeouts()'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- pg_cron not available. Timeouts will be processed by the
  -- process-timeouts edge function when called manually or via external cron.
  NULL;
END;
$$;
