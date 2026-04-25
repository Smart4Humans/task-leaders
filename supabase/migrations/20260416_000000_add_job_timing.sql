-- Add job_timing column to jobs table
-- Separates "when" (timing) from "what" (description) in the concierge intake flow.
-- Previously both were stored in jobs.description, causing WT-2 to show the same
-- value for both the "When" and "Details" template variables.
--
-- job_timing  = client's scheduling preference ("tomorrow morning", "ASAP", etc.)
-- description = specific job details collected in the new awaiting_details step

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_timing TEXT;
