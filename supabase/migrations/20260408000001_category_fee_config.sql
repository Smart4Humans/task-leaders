-- ============================================================================
-- TaskLeaders — Category Fee Config Table
-- Date: 2026-04-08
--
-- Stores lead fees by category. Seeded with locked flat rates.
-- Designed for clean migration to admin-managed pricing without refactoring:
--   - Phase 2: constants.ts fallback is used; this table is the source of truth
--             when a row exists and is_active = true
--   - Future: Admin Panel reads/writes this table; constants.ts fallback removed
--
-- Fee structure (locked flat by category, not percentage-of-job-value):
--   CLN $15, YRD $15, HND $20, MVG $25, PLT $40, PLM $50, ELC $50, HVC $60
--
-- GST (5%) is always calculated on top of lead_fee_cents at runtime.
-- Do not store GST here — it is applied at payment creation time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.category_fee_config (
  category_code   TEXT         PRIMARY KEY,
  category_name   TEXT         NOT NULL,
  lead_fee_cents  INTEGER      NOT NULL CHECK (lead_fee_cents > 0),
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  notes           TEXT,                          -- e.g. "Provisional — review Q3"
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by      TEXT                           -- audit trail for admin changes
);

COMMENT ON TABLE public.category_fee_config IS
  'Flat lead fees by category. Source of truth for pricing. '
  'Admin-managed in future phase. Fall back to constants.ts if no active row.';

COMMENT ON COLUMN public.category_fee_config.lead_fee_cents IS
  'Base lead fee in cents, before GST. GST applied at payment creation time.';

COMMENT ON COLUMN public.category_fee_config.is_active IS
  'Set false to temporarily disable a category fee (falls back to code constant).';

-- ── Seed with locked values (source: TaskLeaders Guidelines 2026-04-08) ──────
INSERT INTO public.category_fee_config
  (category_code, category_name, lead_fee_cents, notes)
VALUES
  ('CLN', 'Cleaning',          1500, 'Locked rate — 2026-04-08'),
  ('YRD', 'Yard Work',         1500, 'Locked rate — 2026-04-08'),
  ('HND', 'Handyman',          2000, 'Locked rate — 2026-04-08'),
  ('MVG', 'Moving / Transport',2500, 'Locked rate — 2026-04-08'),
  ('PLT', 'Painting',          4000, 'Locked rate — 2026-04-08'),
  ('PLM', 'Plumbing',          5000, 'Locked rate — 2026-04-08'),
  ('ELC', 'Electrical',        5000, 'Locked rate — 2026-04-08'),
  ('HVC', 'HVAC',              6000, 'Locked rate — 2026-04-08')
ON CONFLICT (category_code) DO NOTHING;

-- Index for active lookup (the common path)
CREATE INDEX IF NOT EXISTS category_fee_config_active_idx
  ON public.category_fee_config (category_code)
  WHERE is_active = true;

-- ── Marketplace provider response deadline ───────────────────────────────────
-- Add marketplace_notified_at and marketplace_response_deadline_at to jobs
-- to support future no-response timeout handling for Marketplace flow.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS marketplace_notified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS marketplace_response_deadline_at TIMESTAMPTZ;
