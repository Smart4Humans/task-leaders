-- ============================================================================
-- TaskLeaders — Phase 5: Operational Event Constraints
-- Date: 2026-04-08
--
-- Adds DB-level guards on reliability_inputs to enforce:
--   1. Idempotency: one negative event entry per (provider_slug, job_id, input_type)
--   2. Mutual exclusivity: accepted_no_proceed and no_show cannot coexist for
--      the same provider/job (they are mutually exclusive by definition)
--
-- These constraints are the final guard. The record-operational-event edge
-- function also checks at the application layer before inserting.
--
-- ── Policy note ─────────────────────────────────────────────────────────────
-- accepted_no_proceed = provider accepted lead and failed to meaningfully
--   proceed BEFORE any real appointment/commitment was established.
-- no_show = provider had progressed to an actual appointment/commitment
--   and then failed to appear.
-- Only one of the two can apply to a given provider/job.
--
-- manual_positive and manual_negative are NOT covered by these constraints.
-- They are internal-only signals and are recorded without a job_id in some
-- cases (admin notes on overall behavior, not tied to a single job).
-- ============================================================================

-- ── Idempotency index ────────────────────────────────────────────────────────
-- Prevents the same negative event type from being recorded more than once
-- for the same provider/job combination.
-- Partial: only applies to the four factual negative event types.
-- manual_positive / manual_negative are excluded (can legitimately repeat).
CREATE UNIQUE INDEX IF NOT EXISTS reliability_inputs_negative_event_dedup_idx
  ON public.reliability_inputs (provider_slug, job_id, input_type)
  WHERE input_type IN ('payment_failure', 'accepted_no_proceed', 'no_show', 'poor_eta')
    AND job_id IS NOT NULL;

-- ── Mutual exclusivity index ─────────────────────────────────────────────────
-- Enforces that at most one of (accepted_no_proceed, no_show) can exist
-- per (provider_slug, job_id). The unique index on (provider_slug, job_id)
-- scoped to WHERE input_type IN (...) means the second insert of either type
-- will violate the constraint if the first already exists.
CREATE UNIQUE INDEX IF NOT EXISTS reliability_inputs_mutually_exclusive_events_idx
  ON public.reliability_inputs (provider_slug, job_id)
  WHERE input_type IN ('accepted_no_proceed', 'no_show')
    AND job_id IS NOT NULL;

-- ── Index comment ────────────────────────────────────────────────────────────
COMMENT ON INDEX public.reliability_inputs_negative_event_dedup_idx IS
  'Idempotency guard: one entry per (provider_slug, job_id, input_type) for '
  'each negative operational event type. Prevents double-recording.';

COMMENT ON INDEX public.reliability_inputs_mutually_exclusive_events_idx IS
  'Mutual exclusivity guard: accepted_no_proceed and no_show cannot both be '
  'recorded for the same provider/job. These are mutually exclusive by definition. '
  'accepted_no_proceed = failed before appointment; no_show = failed to appear '
  'after appointment was established.';
