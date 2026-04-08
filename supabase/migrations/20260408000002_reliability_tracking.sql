-- ============================================================================
-- TaskLeaders — Reliability & Response Time Tracking
-- Date: 2026-04-08
-- Phase 4
--
-- IMPORTANT SEPARATION (locked rule):
--   Response Time  = speed of reply (broadcast → first meaningful response)
--   Reliability    = follow-through quality (survey scores + approved negative inputs)
--   These are distinct metrics. Do NOT blend them in schema, logic, or scoring.
--
-- Approved negative reliability inputs (from Guidelines):
--   accepted_no_proceed | no_show | payment_failure | poor_eta | poor_survey
--   "repeated bad pattern behavior" is an admin-flagged manual input.
--
-- Weights in reliability_inputs are PROVISIONAL for Phase 4.
-- They must be reviewed and approved before being treated as locked business rules.
-- ============================================================================

-- ─── Column additions — jobs ─────────────────────────────────────────────────

ALTER TABLE public.jobs
  -- ETA reminder: set when WT-3 is sent. Prevents duplicate sends.
  ADD COLUMN IF NOT EXISTS eta_reminder_sent_at       TIMESTAMPTZ,
  -- Response time tracking (Marketplace): when provider first responded.
  -- Concierge response time uses broadcast_responses.responded_at instead.
  ADD COLUMN IF NOT EXISTS first_provider_response_at TIMESTAMPTZ,
  -- Job completion signal: set when admin or provider marks job done.
  ADD COLUMN IF NOT EXISTS completion_signaled_at     TIMESTAMPTZ;

-- ─── TABLE: reliability_inputs ───────────────────────────────────────────────
-- Records individual inputs to the reliability score pipeline.
-- Survey-based inputs are recorded here after survey_responses is complete.
-- Negative inputs are recorded when approved trigger conditions are met.
--
-- Weight convention:
--   Positive value = improves score (e.g. high survey score)
--   Negative value = reduces score (e.g. payment failure, no-show)
--
-- WARNING: Weights are provisional. Do not treat them as locked business rules.
-- Review and get product approval before changing weights in production.
CREATE TABLE IF NOT EXISTS public.reliability_inputs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_slug TEXT        NOT NULL,
  job_id        TEXT,
  input_type    TEXT        NOT NULL,
  -- Approved input types:
  --   survey           — derived from survey_responses (punctuality+comm+quality avg)
  --   payment_failure  — provider claimed lead, payment timed out or failed
  --   accepted_no_proceed — provider accepted, then disengaged without completing
  --   no_show          — provider did not show up for confirmed job
  --   poor_eta         — provider failed to send ETA (admin-flagged)
  --   manual_positive  — admin-added positive input
  --   manual_negative  — admin-added negative input ("repeated bad pattern")
  weight        NUMERIC     NOT NULL DEFAULT 0,
  notes         TEXT,
  applied       BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS reliability_inputs_provider_slug_idx
  ON public.reliability_inputs (provider_slug);
CREATE INDEX IF NOT EXISTS reliability_inputs_unapplied_idx
  ON public.reliability_inputs (provider_slug, applied)
  WHERE applied = false;
CREATE INDEX IF NOT EXISTS reliability_inputs_job_id_idx
  ON public.reliability_inputs (job_id);

COMMENT ON TABLE public.reliability_inputs IS
  'Individual inputs to the reliability score pipeline. '
  'Weights are provisional — product approval required before treating as locked rules.';

-- ─── Function: record_response_time ─────────────────────────────────────────
-- Updates providers.response_time_minutes for a provider.
-- Uses a simple rolling average over the last 10 recorded response times.
-- Response time is SEPARATE from reliability — tracked independently.
--
-- Concierge:   measured from broadcast_sent_at → broadcast_responses.responded_at
-- Marketplace: measured from marketplace_notified_at → first_provider_response_at
CREATE OR REPLACE FUNCTION public.record_response_time(
  p_provider_slug     TEXT,
  p_response_time_min NUMERIC
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_current NUMERIC;
  v_new     NUMERIC;
BEGIN
  -- Simple rolling average: weight new observation at 30%, existing at 70%
  -- This damps noise without over-reacting to a single outlier.
  -- Methodology is provisional — adjust weights with product approval.
  SELECT response_time_minutes INTO v_current
  FROM   public.providers
  WHERE  provider_slug = p_provider_slug;

  IF v_current IS NULL THEN
    v_new := p_response_time_min;
  ELSE
    v_new := ROUND((0.70 * v_current + 0.30 * p_response_time_min)::NUMERIC, 1);
  END IF;

  UPDATE public.providers
  SET    response_time_minutes = v_new,
         updated_at            = NOW()
  WHERE  provider_slug = p_provider_slug;
END;
$$;

-- ─── Function: apply_survey_to_reliability ───────────────────────────────────
-- Converts a completed survey_responses row into a reliability_inputs entry.
-- Does NOT update reliability_percent directly — that is done by apply-reliability
-- edge function which aggregates all pending inputs.
CREATE OR REPLACE FUNCTION public.apply_survey_to_reliability(
  p_job_id TEXT
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_survey        RECORD;
  v_avg_score     NUMERIC;
  v_weight        NUMERIC;
  v_provider_slug TEXT;
BEGIN
  -- Load completed survey
  SELECT s.punctuality_score, s.communication_score, s.quality_score, s.reliability_input_applied,
         j.assigned_provider_slug
  INTO   v_survey
  FROM   public.survey_responses s
  JOIN   public.jobs j ON j.job_id = s.job_id
  WHERE  s.job_id = p_job_id
  AND    s.survey_completed_at IS NOT NULL
  LIMIT  1;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_survey.reliability_input_applied THEN RETURN; END IF;

  v_provider_slug := v_survey.assigned_provider_slug;
  IF v_provider_slug IS NULL THEN RETURN; END IF;

  -- Average of three questions (1–5 scale)
  v_avg_score := (
    COALESCE(v_survey.punctuality_score,  3)
    + COALESCE(v_survey.communication_score, 3)
    + COALESCE(v_survey.quality_score,    3)
  )::NUMERIC / 3.0;

  -- Map 1–5 scale to a weight that the edge function can apply to a 0–100 score.
  -- A perfect 5/5 = +100, a 3/5 = neutral (0), a 1/5 = -40.
  -- Formula: (avg - 3) * 20 → range: -40 to +40 per survey.
  -- PROVISIONAL: review weights with product team before treating as locked.
  v_weight := ROUND((v_avg_score - 3.0) * 20.0, 1);

  INSERT INTO public.reliability_inputs
    (provider_slug, job_id, input_type, weight, notes)
  VALUES
    (v_provider_slug, p_job_id, 'survey', v_weight,
     format('Survey avg %.1f/5 → weight %.1f (provisional formula)', v_avg_score, v_weight));

  -- Mark survey as applied
  UPDATE public.survey_responses
  SET reliability_input_applied = true
  WHERE job_id = p_job_id;
END;
$$;
