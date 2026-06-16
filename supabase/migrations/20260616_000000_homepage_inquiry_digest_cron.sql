-- TaskLeaders — Homepage Inquiry Engine v1B: schedule the daily internal digest
-- via pg_cron + pg_net.
--
-- SOURCE-OF-RECORD ONLY. Do NOT auto-apply via `supabase db push` (migration
-- tracking is unreliable on this project). Apply this by pasting it into the
-- Supabase SQL editor — and ONLY AFTER the homepage-inquiry-digest function is
-- deployed and manually verified (authenticated trigger + email contents).
--
-- This file reflects the VERIFIED-LIVE implementation (2026-06-16).
--   • Calls the homepage-inquiry-digest edge function once daily.
--   • Auth: x-cron-secret is read from Supabase Vault secret `digest_cron_secret`
--     (NOT app.cron_secret). Reason: the digest cron job's role cannot read the
--     privileged `app.cron_secret` GUC (confirmed: current_setting returns NULL in
--     this role), so it sent an empty header and the function returned 401. The
--     digest function accepts a dedicated DIGEST_CRON_SECRET (Edge secret); the same
--     value is stored in Vault as `digest_cron_secret` and read here at job runtime
--     (the cron role CAN read vault.decrypted_secrets). Fully decoupled from
--     INTERNAL_CRON_SECRET / app.cron_secret / process-timeouts (all untouched).
--   • Prereqs (set out-of-band; never commit the value):
--       (a) Edge secret   DIGEST_CRON_SECRET = <S>
--           supabase secrets set DIGEST_CRON_SECRET=<S> --project-ref iwgoafvemlsswkjroyhl
--       (b) Vault secret  digest_cron_secret = <S>
--           select vault.create_secret('<S>', 'digest_cron_secret');
--     (a) and (b) MUST hold the same value <S>.
--   • The function itself suppresses empty digests, so a daily fire with no new
--     rows sends no email.
--
-- Schedule: '0 16 * * *' = 16:00 UTC daily (~09:00 America/Vancouver, DST-shifting).
-- Note: distinct $do$ / $job$ dollar-quote tags are required — nested $$...$$ would
-- terminate the outer DO block prematurely (syntax error 42601).
-- Rollback: SELECT cron.unschedule('taskleaders-homepage-inquiry-digest');

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available — homepage-inquiry-digest schedule not created.';
    RETURN;
  END IF;

  -- Idempotent: unschedule existing job if present
  BEGIN
    PERFORM cron.unschedule('taskleaders-homepage-inquiry-digest');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Schedule HTTP call to homepage-inquiry-digest edge function once daily.
  -- x-cron-secret is read from Vault at job runtime (the cron role can read
  -- vault.decrypted_secrets; it cannot read app.cron_secret).
  PERFORM cron.schedule(
    'taskleaders-homepage-inquiry-digest',
    '0 16 * * *',
    $job$
    SELECT net.http_post(
      url     := 'https://iwgoafvemlsswkjroyhl.supabase.co/functions/v1/homepage-inquiry-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'digest_cron_secret')
      ),
      body    := '{}'::jsonb
    )
    $job$
  );

  RAISE NOTICE 'taskleaders-homepage-inquiry-digest scheduled (daily 16:00 UTC).';

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule homepage-inquiry-digest job: %', SQLERRM;
END;
$do$;
