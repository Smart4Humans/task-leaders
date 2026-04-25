-- ============================================================================
-- Migration: Exempt card_on_file payment records from manual-payment timeout
-- Date: 2026-04-20
--
-- ROOT CAUSE:
--   check_payment_timeouts() queried ALL payment_records WHERE
--   payment_status = 'pending' with no guard on payment_method.
--   Card-on-file PaymentIntents (payment_method = 'card_on_file') are
--   confirmed synchronously by Stripe — the provider takes no action and
--   there is no "payment window" to enforce. Despite this, the function was
--   queuing WT-6 (5-min warning) and WT-7 (release) alerts for those records,
--   sending incorrect messages to the provider and reverting the job to
--   broadcast_sent.
--
-- FIX:
--   Add AND pr.payment_method IS DISTINCT FROM 'card_on_file' to both
--   the warning loop and the release loop.
--   IS DISTINCT FROM correctly handles any NULL payment_method values
--   (includes them in the timeout logic, same as before, as a safe default).
--
-- SCOPE: check_payment_timeouts() only. No other functions changed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_payment_timeouts()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_warnings_queued  INTEGER := 0;
  v_releases_queued  INTEGER := 0;
  r                  RECORD;
BEGIN
  -- ── Warning: 5 minutes remaining ─────────────────────────────────────────
  -- Fires when: initiated_at + 5min <= NOW() AND timeout_at > NOW()
  -- Excluded: card_on_file records — Stripe confirms these automatically;
  --           no provider action is required and no payment window applies.
  FOR r IN
    SELECT pr.id, pr.job_id, pr.provider_slug, pr.total_charged_cents,
           pr.stripe_payment_link_url
    FROM   public.payment_records pr
    WHERE  pr.payment_status                    = 'pending'
    AND    pr.payment_method IS DISTINCT FROM   'card_on_file'
    AND    pr.payment_warning_sent_at IS NULL
    AND    pr.payment_timeout_at - INTERVAL '5 minutes' <= NOW()
    AND    pr.payment_timeout_at > NOW()
  LOOP
    UPDATE public.payment_records
    SET payment_warning_sent_at = NOW()
    WHERE id = r.id;

    INSERT INTO public.admin_alerts
      (alert_type, priority, job_id, provider_slug, description, status)
    VALUES
      ('payment_warning', 'high', r.job_id, r.provider_slug,
       'WT-6 required — 5 minutes remaining on payment window', 'open');

    v_warnings_queued := v_warnings_queued + 1;
  END LOOP;

  -- ── Release: 10-minute window expired ────────────────────────────────────
  -- Excluded: card_on_file records — same rationale as above.
  FOR r IN
    SELECT pr.id, pr.job_id, pr.provider_slug, pr.stripe_payment_link_url
    FROM   public.payment_records pr
    WHERE  pr.payment_status                  = 'pending'
    AND    pr.payment_method IS DISTINCT FROM 'card_on_file'
    AND    pr.payment_timeout_at <= NOW()
  LOOP
    -- Release the payment record
    UPDATE public.payment_records
    SET payment_status = 'released', released_at = NOW()
    WHERE id = r.id;

    -- Revert job: back to broadcast_sent so next provider can claim
    UPDATE public.jobs
    SET
      state                  = 'broadcast_sent',
      assigned_provider_slug = NULL,
      payment_status         = 'unpaid'
    WHERE job_id                = r.job_id
    AND   assigned_provider_slug = r.provider_slug;

    -- Mark broadcast_response for this provider
    UPDATE public.broadcast_responses
    SET
      response         = 'ACCEPT',
      responded_at     = COALESCE(responded_at, NOW()),
      claim_attempt_at = COALESCE(claim_attempt_at, NOW()),
      claim_successful = false
    WHERE job_id = r.job_id AND provider_slug = r.provider_slug;

    INSERT INTO public.admin_alerts
      (alert_type, priority, job_id, provider_slug, description, status)
    VALUES
      ('payment_released', 'high', r.job_id, r.provider_slug,
       'WT-7 required — lead released after payment timeout', 'open');

    v_releases_queued := v_releases_queued + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'warnings_queued', v_warnings_queued,
    'releases_queued', v_releases_queued,
    'checked_at',      NOW()
  );
END;
$$;
