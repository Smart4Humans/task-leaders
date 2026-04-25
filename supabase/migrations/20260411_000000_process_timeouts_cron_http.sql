-- TaskLeaders — Migration: Schedule process-timeouts HTTP call via pg_cron
--
-- ROOT CAUSE:
--   check_payment_timeouts() SQL function runs via pg_cron every minute and
--   correctly writes admin_alerts rows (payment_warning / payment_released)
--   with provider_slug populated. However, process-timeouts — the edge function
--   that reads those alerts and sends WT-6 / WT-7 WhatsApp messages — was never
--   wired to a scheduled trigger. Alerts remained open with whatsapp_sent = false
--   indefinitely.
--
-- FIX:
--   Add a pg_cron job that calls process-timeouts via pg_net HTTP every minute.
--   The existing taskleaders-check-payment-timeouts job (direct SQL call) is
--   left intact. process-timeouts also calls check_payment_timeouts() internally
--   (Step 1); the IS NULL guards in that function make double-calling idempotent.
--
-- PREREQUISITE — run this in SQL editor BEFORE applying this migration:
--
--   ALTER DATABASE postgres SET app.cron_secret TO '<YOUR_INTERNAL_CRON_SECRET>';
--   SELECT pg_reload_conf();
--
--   app.cron_secret is read at job execution time by current_setting().
--   If not set, the HTTP call proceeds with a NULL x-cron-secret header and
--   process-timeouts returns 401 — the cron schedule itself will not break.
--   Set the parameter before applying to activate immediately.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available — process-timeouts HTTP schedule not created.';
    RETURN;
  END IF;

  -- Idempotent: unschedule existing job if present
  BEGIN
    PERFORM cron.unschedule('taskleaders-process-timeouts-http');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Schedule HTTP call to process-timeouts edge function every minute.
  -- current_setting('app.cron_secret', true): the second arg (true = missing_ok)
  -- returns NULL instead of throwing if the DB param is not yet set.
  PERFORM cron.schedule(
    'taskleaders-process-timeouts-http',
    '* * * * *',
    $$
    SELECT net.http_post(
      url     := 'https://iwgoafvemlsswkjroyhl.supabase.co/functions/v1/process-timeouts',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', current_setting('app.cron_secret', true)
      ),
      body    := '{}'::jsonb
    )
    $$
  );

  RAISE NOTICE 'taskleaders-process-timeouts-http scheduled (every minute).';

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule process-timeouts HTTP job: %', SQLERRM;
END;
$$;
