-- guarantee_claims: add provider response columns for two-party confirmation flow
-- Both provider (WT-4) and client (WC-5) now each confirm the factual record.
ALTER TABLE guarantee_claims
  ADD COLUMN IF NOT EXISTS provider_response     TEXT,
  ADD COLUMN IF NOT EXISTS provider_responded_at TIMESTAMPTZ;
