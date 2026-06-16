-- TaskLeaders — Homepage Inquiry Engine v1B: schedule the daily internal digest
-- via pg_cron + pg_net.
--
-- SOURCE-OF-RECORD ONLY. Do NOT auto-apply via `supabase db push` (migration
-- tracking is unreliable on this project). Apply this by pasting it into the
-- Supabase SQL editor — and ONLY AFTER the homepage-inquiry-digest function is
-- deployed and manually verified (authenticated trigger + email contents).
--
-- Mirrors 20260411_000000_process_timeouts_cron_http.sql.
--   • Calls the homepage-inquiry-digest edge function once daily.
--   • Auth: x-cron-secret header sourced from the app.cron_secret DB parameter
--     (the same secret process-timeouts uses; must equal INTERNAL_CRON_SECRET).
--   • The function itself suppresses empty digests, so a daily fire with no new
--     rows sends no email.
--
-- Schedule: '0 16 * * *' = 16:00 UTC daily (~09:00 America/Vancouver). Adjust as needed.
-- Rollback: SELECT cron.unschedule('taskleaders-homepage-inquiry-digest');

DO $$
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
  -- current_setting('app.cron_secret', true): second arg (true = missing_ok)
  -- returns NULL instead of throwing if the DB param is not yet set.
  PERFORM cron.schedule(
    'taskleaders-homepage-inquiry-digest',
    '0 16 * * *',
    $$
    SELECT net.http_post(
      url     := 'https://iwgoafvemlsswkjroyhl.supabase.co/functions/v1/homepage-inquiry-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', current_setting('app.cron_secret', true)
      ),
      body    := '{}'::jsonb
    )
    $$
  );

  RAISE NOTICE 'taskleaders-homepage-inquiry-digest scheduled (daily 16:00 UTC).';

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule homepage-inquiry-digest job: %', SQLERRM;
END;
$$;
