-- TaskLeaders — Geography Refactor
-- Date: 2026-04-09
-- Scope: Separate market routing from municipality matching.
--
-- Problem: city_code (e.g. "VAN") has been overloaded as both a market-level
-- region code (Metro Vancouver) and the geographic unit used for provider
-- matching. This conflation causes VAN-market providers who cover only
-- "Vancouver" (city) to incorrectly match jobs in Burnaby, North Vancouver, etc.
--
-- Solution (additive, backward-compatible):
--   1. Add market_code  — the broad operating market (VAN, YYC, …)
--   2. Add municipality_code — the specific municipality for precise dispatch matching
--   3. Add municipality_name — human-readable display label
--   4. Add municipality_codes[] on provider_accounts — structured coverage data
--
-- Compatibility layer: job-dispatch continues to fall back to city_code / market-level
-- matching for jobs without a municipality_code, and for providers without
-- municipality_codes. New precision is additive; no existing match is removed.
--
-- Do not remove city_code. It continues to feed generate_job_id() until explicitly
-- deprecated in a future migration after all write paths have been updated.
-- ============================================================================

-- ─── jobs: new geography columns ─────────────────────────────────────────────

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS market_code       TEXT,
  ADD COLUMN IF NOT EXISTS municipality_code TEXT,
  ADD COLUMN IF NOT EXISTS municipality_name TEXT;

-- Backfill: existing jobs' market_code = city_code (safe, always equivalent now).
-- municipality_code and municipality_name remain NULL for existing rows —
-- job-dispatch falls back to city_code matching for these jobs automatically.
UPDATE public.jobs
   SET market_code = city_code
 WHERE market_code IS NULL AND city_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_market_code_idx
  ON public.jobs (market_code);

CREATE INDEX IF NOT EXISTS jobs_municipality_code_idx
  ON public.jobs (municipality_code)
  WHERE municipality_code IS NOT NULL;

-- ─── provider_accounts: structured municipality coverage ─────────────────────

ALTER TABLE public.provider_accounts
  ADD COLUMN IF NOT EXISTS municipality_codes TEXT[];

-- No backfill: existing providers have service_cities free-text, which the
-- dispatch compatibility layer continues to read. municipality_codes[] is
-- populated by the updated onboarding form and future profile-edit flows.
-- Providers without municipality_codes are matched via the market-level fallback.

CREATE INDEX IF NOT EXISTS provider_accounts_municipality_codes_idx
  ON public.provider_accounts USING gin (municipality_codes)
  WHERE municipality_codes IS NOT NULL;
