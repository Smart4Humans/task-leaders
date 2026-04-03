-- TaskLeaders — Migration: add extended profile fields to provider_accounts
-- Adds 9 columns for data collected in taskleader-profile-setup.html
-- that was previously sent but not saved.

ALTER TABLE provider_accounts
  ADD COLUMN IF NOT EXISTS display_name_type  TEXT,
  ADD COLUMN IF NOT EXISTS backup_phone        TEXT,
  ADD COLUMN IF NOT EXISTS address_line1       TEXT,
  ADD COLUMN IF NOT EXISTS address_line2       TEXT,
  ADD COLUMN IF NOT EXISTS city                TEXT,
  ADD COLUMN IF NOT EXISTS province            TEXT,
  ADD COLUMN IF NOT EXISTS postal_code         TEXT,
  ADD COLUMN IF NOT EXISTS service_cities      TEXT[],
  ADD COLUMN IF NOT EXISTS additional_services TEXT[];
