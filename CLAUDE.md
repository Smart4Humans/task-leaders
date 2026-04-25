# CLAUDE.md — TaskLeaders Project Orientation

> **CORE RULE:** This file is an orientation aid, not the source of truth.
> If anything here conflicts with actual source files or the latest migration SQL, **the source files and migrations win — always.** Read the code before acting on anything in this document.

---

## 1. What This Project Is

TaskLeaders is a curated, concierge-first local services platform connecting vetted tradespeople ("TaskLeaders") with clients — initially targeting Vancouver realtors and property managers. Two tiers:

- **Tier 1 — Concierge:** Broadcast-and-match model. Client sends a WhatsApp request → system broadcasts to all eligible providers in category + area → first to ACCEPT and pay the lead fee wins the exclusive lead.
- **Tier 2 — Marketplace:** Profile-originated requests. Client picks a specific TaskLeader from the public site → system routes the request to that provider for ACCEPT/DECLINE.

Both tiers are fully routed through a single TaskLeaders WhatsApp number. No direct client/provider number exposure in v1. No native WhatsApp groups in v1.

**Geographic focus:** Metro Vancouver (Lower Mainland) at launch.

---

## 2. Active Stack & App Version

| Layer | Tool | Notes |
|---|---|---|
| Frontend | GitHub Pages | static site, repo: `smart4humans/task-leaders` |
| Active frontend version | **v0.5** | Profile Setup, Welcome flow at `/v0.5/` |
| Backend | Supabase (Edge Functions + Postgres) | project ref: `iwgoafvemlsswkjroyhl` |
| WhatsApp | Twilio WhatsApp Business API | single number: +1 604 699 6168 |
| Payments | Stripe + Stripe Tax | GST collected and itemized on all receipts |
| Email | Resend | from: `info@task-leaders.com` |
| Hosting domain | task-leaders.com | DNS via GoDaddy |
| Dev tool | Claude Code | all implementation done here |

**Supabase project:** `task-leaders` (free tier)
**Project ref:** `iwgoafvemlsswkjroyhl`
**Deploy command:** `supabase functions deploy <function-name> --project-ref iwgoafvemlsswkjroyhl`

> Note: `supabase db push` has migration tracking conflicts on this project. For schema changes, use a temporary edge function with `postgresjs` + `SUPABASE_DB_URL`, or run DDL directly via the Supabase SQL editor.

---

## 3. Source-of-Truth Hierarchy

1. **`supabase/functions/`** — edge function source (Deno/TypeScript)
2. **`supabase/migrations/`** — schema history; latest migration is authoritative on DB structure
3. **`supabase/functions/_shared/`** — constants, fees, job-ids, twilio helpers
4. Reference docs (in order of recency): WhatsApp Architecture v8 → State Machine v8 → Strategic Brief v7 → Platform Reference 4.4.2026
5. This CLAUDE.md file (orientation only)

---

## 4. Standing Rules & Conventions

- **Slug format:** `firstname-lastname`; collision suffix `-2`, `-3`
- **Display name:** if `display_name_type = 'business'` → show `business_name`; else `first_name + last_name`
- **Job ID format:** internal `VAN-PLM-00001`; public display suppresses city prefix → `PLM-00001` (via `toPublicJobId()`)
- **Message header format:** `[Job #PLM-00001 | 123 Main St]` (via `jobHeader()`)
- **Public copy uses "we / us / our"** — "TN" and "TaskLeaders Network" are internal terms only
- **Broadcast privacy rule:** Initial lead broadcast exposes safe area / municipality only — never the full civic address. Full address released post-assignment only
- **GST rate:** 5% (locked; set in `_shared/constants.ts`)
- **Payment window:** 10 minutes total, WT-6 warning sent at 5 minutes remaining
- **24-hour WhatsApp session window:** evaluated **per participant**, not per job — a client may have an open session while the provider does not, and vice versa
- **`concierge_eligible = true`** is the explicit Tier 1 flag; Marketplace-only providers are never included in Concierge broadcasts regardless of other criteria
- **Job-thread introduction** is a system-generated in-thread message, not a Twilio template
- **Survey questions** (Q1/Q2/Q3) are in-session only — not submitted templates

---

## 5. Edge Function Map

All functions live in `supabase/functions/`. All have `verify_jwt = false` in `supabase/config.toml`.

| Function | Purpose | Auth |
|---|---|---|
| `twilio-webhook` | Inbound WhatsApp handler — all client/provider message routing | Twilio signature |
| `job-dispatch` | Broadcasts confirmed Concierge job to eligible providers (WT-2) | admin_password or x-internal-secret |
| `create-payment-link` | Post-ACCEPT: auto-charge or Stripe payment link; inserts payment_records | x-internal-secret or admin_password |
| `stripe-webhook` | Stripe event handler — confirms payment, advances to thread_live | Stripe signature or x-admin-simulate |
| `process-timeouts` | pg_cron HTTP target (every 1 min) — sends WT-6/WT-7, admin digest email | x-cron-secret |
| `marketplace-connect` | Handles Connect form submission from public profile pages; sends MKT-1 | public |
| `trigger-survey` | Admin-triggered: sends WC-3 + WT-5 for survey, or WT-3 ETA reminder | admin_password or x-internal-secret |
| `initiate-guarantee-claim` | Starts Lead Guarantee claim flow | admin |
| `apply` | Application form submission → `applications` table + Resend email | public |
| `approve-application` | Admin: generates slug, creates `provider_accounts`, returns welcome link | admin |
| `complete-onboarding` | Profile Setup submission → writes to `provider_accounts` + `public.providers` | slug-auth |
| `get-provider` | Fetches single provider by slug (public profile page) | public |
| `public-category` | Ranked provider list for a category | public |
| `public-homepage` | Category counts for homepage cards | public |
| `apply-reliability` | Updates provider reliability score from reliability_inputs | internal |
| `record-operational-event` | Writes operational events to reliability_inputs | internal |
| `lead-event` | Logs lead events | internal |
| `send-whatsapp` | Direct WhatsApp send (admin/internal use) | admin |

**Shared library (`_shared/`):**
- `constants.ts` — category codes/names, lead fees, city/municipality mappings, normalization functions, keyword constants (ACCEPT, DECLINE, PASS, HELP, YES, NO, CLOSE, DONE, KEEP OPEN, CANCEL)
- `fees.ts` — `getCategoryLeadFee()` (DB-first, constant fallback), `FeeBreakdown` interface
- `job-ids.ts` — `toPublicJobId()`, `jobHeader()`
- `twilio.ts` — `sendWhatsApp()`, `sendTemplateWhatsApp()`, `logMessage()`, all template builder functions (WC-1 through WC-4, WT-1 through WT-8, MKT-1/MKT-2)

---

## 6. WhatsApp Architecture Summary

**Single number:** +1 604 699 6168 handles all traffic (Concierge + Marketplace)

**Session window rule:** WhatsApp 24-hour window opens on each inbound message from a participant. Inside the window: free-form messages allowed (cheap/free). Outside: must use Meta-approved templates. Twilio `sendTemplateWhatsApp()` handles both paths; falls back to plain `Body` when no Content SID is configured.

**Template pack (submitted to Twilio/Meta):**
| Template | Recipient | Purpose |
|---|---|---|
| WC-1 `wc_1_client_welcome` | Client | Concierge approval welcome |
| WC-2 `wc_2_job_confirmed` | Client | TaskLeader assigned + Job ID |
| WC-3 `wc_3_post_job_survey_start` | Client | Survey start prompt |
| WC-4 `wc_4_no_match_available` | Client | No match, 2-hour search window |
| WC-5 `wc_5_lead_guarantee_check_client` | Client | Lead Guarantee factual confirmation (YES/NO Quick Reply) |
| WC-6 `wc_6_job_completed_check_client` | Client | Completion check (submitted; not wired in code) |
| WC-7 `wc_7_lead_guarantee_approved_client` | Client | Lead Guarantee **approved** outcome notification |
| WC-8 `wc_8_lead_guarantee_denied_client` | Client | Lead Guarantee **denied** outcome notification |
| WT-1 `wt_1_taskleader_welcome` | Provider | Concierge activation welcome |
| WT-2 `wt_2_lead_broadcast` | Provider | Lead broadcast with ACCEPT/DECLINE |
| WT-3 `wt_3_communication_reminder` | Provider | ETA/communication reminder |
| WT-4 `wt_4_lead_guarantee_check_taskleader` | Provider | Lead Guarantee factual confirmation (YES/NO Quick Reply) |
| WT-5 `wt_5_post_job_notification` | Provider | Survey sent notification |
| WT-6 `wt_6_payment_timeout_warning` | Provider | 5-min payment window warning |
| WT-7 `wt_7_lead_released_timeout` | Provider | Lead released after timeout |
| WT-8 `wt_8_job_completed_check_taskleader` | Provider | **In code: payment confirmed / job thread open.** Sent via `sendWhatsApp()` (in-session), not `sendTemplateWhatsApp()`. Submitted template name reflects original design intent (completion check); current code behavior is a post-payment provider notification. |
| WT-9 `wt_9_lead_guarantee_approved_taskleader` | Provider | Lead Guarantee **approved** outcome notification |
| WT-10 `wt_10_lead_guarantee_denied_taskleader` | Provider | Lead Guarantee **denied** outcome notification |

**Not submitted as templates (in-session only):**
- Job-thread introduction (system-generated in-thread message)
- Survey questions Q1/Q2/Q3 and thank-you
- MKT-1 / MKT-2 (Marketplace connect notifications — check current approval status)

**Template SID env vars:** `TWILIO_TEMPLATE_SID_WC1` … `WC8` and `TWILIO_TEMPLATE_SID_WT1` … `WT10` — set in Supabase Edge Function secrets once Meta approvals are received. Functions fall back to plain `Body` if SID is not set. WC-7/WC-8/WT-9/WT-10 are the Lead Guarantee outcome-notification templates added in Architecture v8.

**Routed thread model:** Twilio Conversations simulates a three-party thread (client + provider + TaskLeaders) through the single number. All communication is logged; no direct number exposure. `job_participants` table records both sides; `conversation_sessions` tracks per-participant flow state.

---

## 7. State Machine & Payment Rules

### `jobs.state` sequence (source-of-truth: twilio-webhook, job-dispatch, stripe-webhook)

```
intake_started
  → intake_confirmed
    → broadcast_sent          (job-dispatch sends WT-2 to all eligible providers)
      → claim_received        (claim_lead() RPC — atomic, first-ACCEPT wins)
        → payment_link_sent   (manual payment path: Stripe link sent to provider)
        → autocharge_pending  (card-on-file path: PaymentIntent created)
          → confirmed_assigned  (stripe-webhook: payment success)
            → thread_live       (stripe-webhook: participants connected, WC-2 + WT-8 sent)
              → survey_pending
                → survey_complete
                  → closed
      → no_match              (job-dispatch: zero eligible providers found)
```

Also valid terminal/branch states: `cancelled`, `closed`

### `conversation_sessions.session_state` values

**Client:** `idle` | `awaiting_address` | `awaiting_timing` | `awaiting_details` | `awaiting_match` | `awaiting_no_match_decision` | `awaiting_survey_q1` | `awaiting_survey_q2` | `awaiting_survey_q3` | `awaiting_guarantee_confirm` | `awaiting_close_confirm` | `open`

> `awaiting_match` holds the client between `finalizeAndDispatch` and the next authoritative session upsert (job-dispatch → `awaiting_no_match_decision` on no-match; stripe-webhook → `open` after provider ACCEPT + payment). Intercepted by `handleAwaitingMatchMessage` in `twilio-webhook` so an inbound during this window cannot fall through to `handleConciergeIntake` and spawn a duplicate job; client CANCEL in this state cancels the active job and resets the session to `idle`.

**Provider:** `idle` | `awaiting_accept` | `open`

### Payment rules (confirmed in source: `_shared/constants.ts` + `create-payment-link` + `process-timeouts`)

- **Payment window:** 10 minutes total from payment_records insertion
- **WT-6 warning:** sent at 5 minutes remaining (`PAYMENT_WARNING_OFFSET_MS`)
- **On timeout:** `check_payment_timeouts()` pg_cron function sets `assigned_provider_slug = NULL`, `state = 'broadcast_sent'`, `payment_status = 'unpaid'` → lead released back to pool
- **Released guard:** once `payment_records.payment_status = 'released'`, the admin simulation path now blocks with 409 — stale confirmation or delayed payment must not revive the claim into `confirmed_assigned`
- **Auto-charge path:** `state → autocharge_pending` → Stripe PaymentIntent → `payment_intent.succeeded` → `confirmed_assigned` → `thread_live`
- **Manual path:** `state → payment_link_sent` → `checkout.session.completed` → `confirmed_assigned` → `thread_live`

### `claim_lead()` RPC (atomic)
```sql
UPDATE public.jobs
SET state = 'claim_received', assigned_provider_slug = p_provider_slug, payment_status = 'pending'
WHERE job_id = p_job_id AND state = 'broadcast_sent' AND assigned_provider_slug IS NULL;
```

### `assigned_provider_slug` authority rule
`stripe-webhook → handlePaymentConfirmed()` sets `assigned_provider_slug` authoritatively on the `confirmed_assigned` UPDATE, regardless of any prior pg_cron reset. This is the fix applied 2026-04-17.

### Eligibility rules for Concierge broadcast (`job-dispatch`)
1. `provider_accounts.concierge_eligible = true`
2. `status = 'active'` AND `suspended = false`
3. Category match: `primary_service` OR any value in `additional_services` normalizes to `job.category_code`
4. Geography (two-tier): municipality match via `municipality_codes[]` first; market-level fallback via `service_cities[]` + `service_area`

### No-match flow
- WC-4 sent to client; `awaiting_no_match_decision` session state
- KEEP OPEN: one additional 2-hour continued-search window; admin alert created
- Must not create an indefinite loop (one extension maximum)

---

## 8. Key Database Tables

| Table | Purpose |
|---|---|
| `jobs` | Central job record; all state lives here |
| `provider_accounts` | Full provider record including onboarding, profile, Stripe fields |
| `public.providers` | Public-facing subset for Marketplace display |
| `applications` | Raw application submissions |
| `conversation_sessions` | Per-participant flow state (unique on `whatsapp_e164`) |
| `job_participants` | Client + provider per job; `session_state = 'active'` for relay routing |
| `broadcast_responses` | One row per provider per job broadcast; records ACCEPT/DECLINE |
| `payment_records` | Lead fee payment record; `payment_timeout_at` drives pg_cron timeout |
| `message_log` | Outbound/inbound message audit log |
| `admin_alerts` | Escalation queue; types: escalation, no_match, payment_warning, payment_released, ambiguous_reply, etc. |
| `survey_responses` | Post-job survey answers per job |
| `reliability_inputs` | Weighted inputs feeding provider Reliability Score |
| `category_fee_config` | DB-managed lead fees (overrides constants if present) |
| `lead_events` | Response-time tracking events |

**Key `jobs` columns added recently:**
- `job_timing TEXT` — client's scheduling preference ("tomorrow morning", "ASAP") — separate from `description`
- `market_code`, `municipality_code`, `municipality_name` — geography precision layer
- `provider_accounts.municipality_codes TEXT[]` — structured municipality coverage

---

## 9. Concierge Intake Flow (implemented)

Sequential collection in `twilio-webhook`. The fast path (inline address) can skip up to two steps.

**Fast path — inline address in opening message (`extractInlineAddress`):**
If the client's first message contains both a 2+ digit street number (contextual or structural match) AND a known municipality name, the job is created with `address`, `municipality_code`, and `municipality_name` pre-populated. The `awaiting_address` step is skipped entirely. Timing and details are still collected via the normal subsequent steps unless also present in the same message.

**Standard path — three sequential steps:**
1. **`awaiting_address`** — collects client address
   - **Municipality reuse:** if the reply contains a street number but no city, and a municipality was mentioned in the opening message, the system composes the full address from the known city — the client is not prompted to repeat information already provided
   - After address is stored, checks opening message for timing keywords; if found, extracts the timing phrase and skips to `awaiting_details`
2. **`awaiting_timing`** — collects scheduling preference → saved to `jobs.job_timing`
   - Race-condition guard: checks DB `job_timing` at handler entry; if already set (concurrent webhook), routes current message to details logic instead
3. **`awaiting_details`** — collects job specifics → saved to `jobs.description`
   - Then calls `finalizeAndDispatch()` → confirms job → triggers `job-dispatch`

**Timing phrase extraction (`extractTimingPhrase`):**
Wherever timing is auto-detected (opening message or address reply), only the matched phrase is stored in `job_timing` (e.g. `"tomorrow"`, `"this weekend"`) — not the full sentence. This keeps the WT-2 "When" field clean and distinct from the "Details" field.

`job-dispatch` uses `job_timing` (When) and `description` (Details) as separate WT-2 template variables.

---

## 10. Proven Live Behavior (as of 2026-04-23)

| Behavior | Status |
|---|---|
| Intake: address → timing → details → dispatch (sequential) | ✅ Verified (CLN, ELC, HVC) |
| Intake race condition (timing/details overlap) | ✅ Fixed and retested |
| `job_timing` and `description` stored separately | ✅ Verified DB |
| `job_timing` stores extracted phrase only (not full opening sentence) | ✅ Verified DB (VAN-CLN-00035: `job_timing = 'tomorrow'`) |
| Provider broadcast (WT-2 with correct distinct timing + details vars) | ✅ Verified DB (VAN-CLN-00034, VAN-CLN-00035) |
| Inline address in opening message → `awaiting_address` step skipped | ✅ Verified live (VAN-CLN-00035: no `INTAKE_ADDRESS_PROMPT` in message_log) |
| `address`, `municipality_code`, `municipality_name` populated at job creation when inline address detected | ✅ Verified DB (VAN-CLN-00035) |
| Municipality reuse: city from opening message reused when address reply omits city | ✅ Verified live (VAN-CLN-00035) |
| Negative case: opening message with quantity but no address still triggers address prompt | ✅ Verified live ("I need 10 units cleaned in Vancouver" → address prompted) |
| Provider ACCEPT → `claim_lead()` atomic claim | ✅ Verified |
| Card-on-file auto-charge path: `autocharge_pending` → `confirmed_assigned` → `thread_live` | ✅ Verified live (VAN-CLN-00034) |
| Card-on-file records exempt from WT-6/WT-7 timeout (`payment_method IS DISTINCT FROM 'card_on_file'`) | ✅ Verified DB (VAN-CLN-00034: no WT-6/WT-7 in message_log, `payment_warning_sent_at` null) |
| Payment link creation (manual path) | ✅ Verified |
| Admin payment simulation (x-admin-simulate) | ✅ Verified |
| `confirmed_assigned` → `thread_live` transition | ✅ Verified |
| WC-2 to client (assignment confirmed) | ✅ Verified |
| WT-8 to provider (payment confirmed / thread open) | ✅ Verified |
| Client/provider conversation continuity in routed thread | ✅ Verified live (VAN-CLN-00034) |
| `assigned_provider_slug` persisted through to `thread_live` | ✅ Fixed 2026-04-17 |
| Released-state guard in admin simulation | ✅ Fixed 2026-04-17 |
| Client thread-close → job `closed`, sessions reset to `idle`, provider notified | ✅ Verified live (VAN-CLN-00035: `THREAD_CLOSED_SENDER` + `THREAD_CLOSED_OTHER` sent, both sessions `idle`) |
| `process-timeouts` pg_cron HTTP job firing every minute | ✅ Verified 2026-04-17 (cron.job_run_details: succeeded) |
| WT-6 (5-min warning) delivered to provider during active payment window | ✅ Verified live on VAN-CLN-00027 |
| WT-7 (lead released) delivered to provider after 10-min timeout | ✅ Verified live on VAN-CLN-00027 |
| `admin_alerts` payment_warning + payment_released resolved, `whatsapp_sent = true` | ✅ Verified DB |
| `message_log` WT-6 and WT-7 entries present | ✅ Verified DB |
| Job state reset to `broadcast_sent`, `assigned_provider_slug = NULL` on timeout | ✅ Verified DB |
| Duplicate Concierge intake during awaiting-match window blocked | ✅ Verified live 2026-04-23 (HVAC Vancouver: second identical inbound returned "still searching" reply, no second job row, no second WT-2 to Savio) |
| Client CANCEL during `awaiting_match` cancels the active job and resets session | ✅ Verified live 2026-04-23 (HVAC Vancouver: `jobs.state='cancelled'`, `status='completed'`, `conversation_sessions.session_state='idle'`, `current_job_id=NULL`, `INTAKE_CANCELLED` outbound logged) |
| Provider ACCEPT after client cancellation safely blocked by `claim_lead()` state guard | ✅ Verified live 2026-04-23 (HVAC Vancouver: `claim_lead()` atomic guard (`state='broadcast_sent'`) matched zero rows against cancelled job; zero `payment_records` created; Savio's `broadcast_responses.response=NULL`; fell through to `escalateAmbiguousReply`) |
| Backend municipality registry aligned with 18 application Service Area dropdown entries | ✅ Verified live 2026-04-23 (added `LGL`, `MPR`, `PTM`, `WHR`, `ABB`, `CHK`, `MSN` to `MUNICIPALITY_NAMES` / `MUNICIPALITY_TO_MARKET` / `MUNICIPALITY_ALIASES` / `MUNICIPALITY_PATTERNS` in `_shared/constants.ts`; all 11 existing codes byte-identical) |
| Mission municipality reuse: opening-msg city carried into street-only address reply | ✅ Verified live 2026-04-23 (VAN-YRD-00003: opening `"I need Yard Work done in Mission"` → street-only reply `"3344 2nd Ave"` composed to `"3344 2nd Ave, Mission"`, `municipality_code=MSN`; zero `INTAKE_ADDRESS_INVALID` in message_log) |
| Mission + Maple Ridge parse from full `street + city` opening | ✅ Verified live 2026-04-23 (VAN-YRD-00004 Mission inline; VAN-YRD-00005 Maple Ridge inline — both `state=broadcast_sent` with correct `municipality_code`) |
| Maple Ridge / Burnaby-St street-name collision classifies to Maple Ridge | ✅ Verified live 2026-04-23 (VAN-YRD-00007: `"1234 Burnaby St, Maple Ridge"` → `municipality_code=MPR` / `municipality_name=Maple Ridge`; two-word `\bmaple\s+ridge\b` pattern orders before single-word `\bburnaby\b`) |
| Existing single-word municipality parsing (Burnaby) unregressed after registry expansion | ✅ Verified live 2026-04-23 (VAN-YRD-00008: `"123 Main St, Burnaby"` → `municipality_code=BBY` / `municipality_name=Burnaby`) |
| Manual payment-link path end-to-end via real (test-mode) Stripe `checkout.session.completed` → `confirmed_assigned` → `thread_live` | ✅ Verified live 2026-04-23 (VAN-HVC-00012: `payment_records.payment_status='paid'`, `payment_method='payment_link'`, `stripe_payment_link_url=https://buy.stripe.com/test_…` confirms test-mode, `payment_completed_at=04:52:20`, `assigned_at=04:52:21`, WC-2 + WT-8 both delivered at 04:52:22, both sessions `open` on `VAN-HVC-00012`, `broadcast_responses.claim_successful=true`, zero `admin_alerts` escalations from the payment path; routed-thread relay further confirmed live by inbound `"Hello back"` from client → outbound `"[Client] Hello back"` to provider at 04:53:50) |
| Marketplace Connect dropdown restricted to the provider's `municipality_codes` coverage (P2) | ✅ Verified live 2026-04-23 (commit `b17bb90`; Savio dropdown shows only Vancouver; Bob Builder dropdown shows only his served set) |
| `marketplace-connect` rejects stale/manual submissions for municipalities outside provider coverage | ✅ Verified live 2026-04-23 (out-of-coverage submission returns `validation_error`, no `jobs` row, no MKT-1, no `admin_alerts`) |
| `complete-onboarding` derives `municipality_codes` from `baseCity` + `serviceCities` (home-base first, then submitted order, deduped; unrecognized names silently skipped); partial submits without coverage fields preserve existing codes | ✅ Verified live 2026-04-25 on test slug `ellie-brunel` (Test A: `{Burnaby, [Richmond,Vancouver]}` → `{BBY,RMD,VANCOUVER}`; Test B: empty payload preserves codes; Test C: `{Vancouver, [FakeTown,Vancouver,Burnaby]}` → `{VANCOUVER,BBY}`; rolled back cleanly to snapshot — `status=pending_approval`, `suspended=false`, `onboarded_at=2026-04-15 21:24:51.618+00`, `service_area=Richmond`, `service_cities=NULL`, `municipality_codes=NULL`). Source committed as `75e98a0` (committed after deploy; live function bytes already matched). The same commit also adds an active-status preservation guard on the return/edit path (`existing.status === "active" ? "active" : "pending_approval"`) — deployed in the same payload but not directly exercised against an active slug in this cluster; behavior is consistent with its source comment. |
| Category-page municipality filter (P4) — dropdown options built from the union of `municipality_codes` across providers in the current category; default "All municipalities" preserves prior behavior | ✅ Verified live 2026-04-25 (commit `765b21a`; HVAC / Cleaning / Yard Work spot-checks; Vancouver filter keeps Savio, Burnaby filter drops Savio; sort buttons + profile links unaffected; UX decision locked: list only municipalities represented in the current category, not all 18) |
| Category-card service-area labels (P3) — `Based in <base>`, `Based in <base> · Serves more areas`, or `Serves <selected> · Based in <base>` depending on filter and coverage breadth | ✅ Verified live 2026-04-25 (commit `68317f2`; desktop + mobile; Savio shows `Based in Vancouver`; multi-coverage providers show `Based in <base> · Serves more areas`) |
| Category → profile municipality preselect (P5) — category page attaches `?municipality=<CODE>` only when the provider's own `municipalityCodes` confirms coverage; profile validates against `MUNICIPALITY_REGISTRY` + the rendered dropdown options; preselect persists through modal Cancel/reopen and the Terms/Privacy `?reopenConnect=1` round-trip; stale/invalid/unsupported codes silently fall back to no preselect | ✅ Verified live 2026-04-25 (commit `0c47e7c`; e.g. category Vancouver filter → `profile.html?slug=savio-volpe&category=hvac&municipality=VANCOUVER` opens with Vancouver preselected) |

---

## 11. Remaining Hardening Items (post-timeout verification)

**Timeout path is operationally proven as of 2026-04-17.** Root cause of prior 401 failures: `app.cron_secret` DB parameter and `INTERNAL_CRON_SECRET` edge function secret were not aligned. Fixed by rotating to a new secret and setting both sides. See §14 for the live auth path truth.

Remaining hardening items within current scope:

- **Re-claim path after timeout** — not yet tested: when a job returns to `broadcast_sent` after WT-7, a second provider sending ACCEPT should re-trigger `claim_lead()` and the payment flow. Logic is in place but has not been verified live.
- **WT-6/WT-7 session window risk** — both are sent via `sendWhatsApp()` (plain text), not `sendTemplateWhatsApp()`. If a provider has not sent an inbound message in the past 24 hours, the WhatsApp session window is closed and Twilio will reject the send (fails silently to `message_log` with `status = 'failed'`). For production reliability, WT-6 and WT-7 should use Meta-approved template SIDs via `sendTemplateWhatsApp()` once approvals are received.
- **Admin escalation email digest** — `RESEND_API_KEY` and `TASKLEADERS_ADMIN_EMAIL` required; not verified live yet.
- **Dead import** — `create-payment-link/index.ts` imports `buildWT6` but never calls it (initial payment prompt uses an inline custom body). Harmless; low-priority cleanup.
- **`escalateAmbiguousReply` observability gap** — `twilio-webhook/index.ts` calls `sendWhatsApp()` directly for the ambiguous-reply escalation without a matching `logMessage()` call, so the outbound reply does not appear in `message_log` even though it reaches the recipient. Every other outbound path in this file pairs `sendWhatsApp` with `logMessage` (often via `sendAndLog`). Verified on 2026-04-23 during the provider-ACCEPT-after-cancel regression test: provider received the escalation message but no matching outbound row exists in `message_log`. Not a functional/safety bug; makes "why did this participant get this reply?" harder to diagnose from SQL. Add a `logMessage()` / `sendAndLog()` call alongside the escalation send when touched.
- **Single-word municipality street-name collision** — `MUNICIPALITY_PATTERNS` uses bare `\b<name>\b` regexes for single-word municipalities (`\bburnaby\b`, `\brichmond\b`, `\bsurrey\b`, `\bdelta\b`, `\bmission\b`, etc.). When a street is named after a municipality (e.g. "Burnaby St" in Vancouver; "Richmond Rd" in Surrey), the pattern matches the street name and misclassifies the job. Two-word municipalities (e.g. Maple Ridge) are ordered first and therefore immune when they appear in the same address. Residual exposure is where the real city is a single-word municipality that orders *after* the collision, or the Vancouver catch-all. Observed 2026-04-23 (VAN-YRD-00002: `"1234 Burnaby st, Maple Ridge"` pre-fix classified as Burnaby; now classifies as Maple Ridge because `\bmaple\s+ridge\b` orders first). Proper fix requires context-aware parsing (prefer the last-matched municipality, or only match after a comma or "in"/"at" connector).
- **Inline-address fragment composition omits city when fragment contains a municipality word** — `extractInlineAddress` in `twilio-webhook` composes the final address string as `fragment` if `extractMunicipalityFromAddress(fragment)` is truthy, else `${fragment}, ${munResult.name}`. When the fragment contains a street name that matches a single-word municipality pattern (e.g. "Burnaby St"), the composition takes the fragment branch and skips appending the real city — storing `"1234 Burnaby St"` instead of `"1234 Burnaby St, Maple Ridge"`. Municipality classification on the outer Guard 1 is still correct, so routing and broadcast header are unaffected; the stored address string is incomplete. Observed 2026-04-23 on VAN-YRD-00007. Same root cause family as the street-name collision item above.
- **`extractInlineAddress` numeric-prefix street-name gap** — Guard 2 regexes require the first word after the street number to start with `[A-Za-z]`. Addresses like `"3344 2nd Ave"`, `"123 3rd St"`, `"456 1st Blvd"` fail Guard 2 even when the municipality is recognized, because the first word ("2nd", "3rd", "1st") starts with a digit. Inline-address fast path returns null; flow falls back to the address-prompt path, which eventually succeeds via `awaiting_address` → municipality reuse. Observed 2026-04-23 on VAN-YRD-00004 (opening `"tomorrow morning mow my lawn at 3344 2nd Ave, Mission"` → inline path did not fire; address prompt issued; reply accepted by awaiting_address handler). Not a safety issue; a UX regression from the inline-path's ideal behavior. Fix would extend Guard 2's regex alternation to accept an optional ordinal-like prefix (`\d+(?:st|nd|rd|th)?`).

### Marketplace cluster — open backlog (post 2026-04-25 verification)

The Marketplace service-area cluster (P2 / P3 / P4 / P5 + `complete-onboarding` write-fix) is verified live as of 2026-04-25 — see §10. The following items remain backlog and were intentionally **not** addressed in that cluster:

- **WC-2 first-time web-client session-window risk** — Marketplace ACCEPT sends client WC-2 via plain `sendWhatsApp()`, not `sendTemplateWhatsApp()`. If a web-submitted client has no open 24-hour WhatsApp session, Twilio rejects the send. Needs a future narrow fix once a Meta-approved template SID is wired for WC-2.
- **Marketplace ACCEPT/DECLINE notification observability gap** — some sends use raw `sendWhatsApp()` / `logMessage()` and do not create `admin_alerts` rows on failure, so silent send failures are invisible to ops.
- **Recipient `last_activity_at` hygiene in Marketplace ACCEPT** — the client (recipient) session may be stamped `last_activity_at` even when the client did not initiate the inbound, polluting the 24-hour-window heuristic.
- **Stale malformed phone/session rows** — e.g. the no-plus row from VAN-HVC-00024 predates the `marketplace-connect` E.164 canonicalization fix; safe to clean later, no live impact.
- **Marketplace relay header `address TBD`** — Marketplace Connect does not collect address before MKT-1, so the routed-thread `[Job # | address]` header reads `address TBD`. Future option: collect address in the form, or after ACCEPT.
- **Reject-branch outbound observability gap** — the prior reject-branch "This request is no longer available" outbound was not logged to `message_log`. Same root family as the `escalateAmbiguousReply` gap in §11.
- **Provider-facing routed bracket name** — relay brackets sometimes show `[client]` instead of the client's first name; provider-side bracket worked. Verify and fix together once a job is in `thread_live`.
- **Doc set update** — WhatsApp Architecture v8 / AI State Machine v8 / Strategic Brief / Platform Reference / Terms / Guidelines have **not** been updated for this cluster yet. Hold until the implementation cluster is fully settled, then update in one pass.
- **Public-site link audit** — website / legal / footer / privacy / terms / guidelines link checks remain backlog; GitHub repo public/private decision also unresolved.
- **Building track-record placeholder** — provider profile track-record area still placeholder copy.
- **Workspace trial cancel / downgrade** — administrative housekeeping if still relevant.

---

## 12. Recent Implementation Themes (already resolved)

- **Intake three-step flow** — `awaiting_timing` and `awaiting_details` states added; `job_timing` column added via migration `20260416_000000_add_job_timing.sql`
- **Intake race condition fix** — DB-state guard at top of `awaiting_timing` handler in `twilio-webhook`
- **`job_timing` in broadcasts** — `job-dispatch` now selects and uses `job_timing` separately from `description` in WT-2 template variables
- **Inline address detection (`extractInlineAddress`)** — on the first intake message, `twilio-webhook` attempts to extract a complete civic address before creating the job. Requires both a 2+ digit street number (contextual: preceded by "at"/"@"/start-of-message, OR structural: followed by a BC street-type suffix) AND a known municipality. If both guards pass, job is created with `address`, `municipality_code`, and `municipality_name` pre-populated and the `awaiting_address` prompt is skipped. Verified live (VAN-CLN-00035).
- **Municipality reuse in `awaiting_address`** — if the client's address reply has a street number but no city, and the opening message mentioned a known municipality, the system composes the full address (`"{reply}, {city}"`) without re-prompting. Verified live (VAN-CLN-00035).
- **Timing phrase extraction (`extractTimingPhrase`)** — wherever timing is auto-detected (from opening message or address reply), only the matched phrase is written to `job_timing` (e.g. `"tomorrow"`, `"this weekend"`) rather than the full sentence. Prevents the WT-2 "When" field from containing an unrelated sentence fragment. Verified DB (VAN-CLN-00035).
- **Card-on-file timeout exemption** — `check_payment_timeouts()` updated (migration `20260420_000000_fix_card_on_file_timeout_exemption.sql`) to add `AND pr.payment_method IS DISTINCT FROM 'card_on_file'` to both the WT-6 warning loop and the WT-7 release loop. Card-on-file PaymentIntents are confirmed synchronously by Stripe; no payment window applies to them. Verified DB (VAN-CLN-00034: no WT-6/WT-7 sent).
- **`assigned_provider_slug` NULL bug** — `stripe-webhook → handlePaymentConfirmed()` now sets `assigned_provider_slug: provSlug` on the `confirmed_assigned` UPDATE (authoritative regardless of pg_cron resets)
- **Released-state simulation guard** — admin simulation now blocks on `payment_status = 'released'` in addition to `'paid'`
- **Geography precision layer** — `municipality_code`, `market_code`, `municipality_codes[]` added; two-tier dispatch matching in `job-dispatch`
- **process-timeouts cron auth fix** — `app.cron_secret` DB parameter and `INTERNAL_CRON_SECRET` edge function secret were misaligned (secret stored in Vault was never wired to either side). Fixed by rotating to a new secret and setting both independently. Timeout path is now operationally proven (VAN-CLN-00027).
- **Marketplace service-area cluster (P2 / P3 / P4 / P5 + `complete-onboarding` write-fix)** — five-step Marketplace coverage system shipped and verified live 2026-04-25:
  - **P2** (`b17bb90`) — `marketplace-connect` validates submitted municipality against provider coverage; profile Connect dropdown restricted to provider's `municipality_codes`.
  - **`complete-onboarding` write-fix** (commit `75e98a0`; committed after deploy, live function bytes already matched) — derives `municipality_codes` on profile-setup submission so new providers join the dataset already populated; partial submits without coverage fields preserve existing codes; verified safely on non-active slug `ellie-brunel` and rolled back. Same commit also adds an active-status preservation guard on the return/edit path — deployed alongside the write-fix but not directly exercised against an active slug in this cluster; behavior is consistent with its source comment.
  - **P4** (`765b21a`) — category-page municipality dropdown filters visible providers; options built from union of providers' coverage in the loaded category.
  - **P3** (`68317f2`) — category cards now disambiguate base location vs broader coverage.
  - **P5** (`0c47e7c`) — selected municipality is preserved into the profile Connect modal preselect via `?municipality=<CODE>`, validated against registry + provider coverage, with safe fallback to blank.
  - Backend changes were limited to the prior P2 work and `complete-onboarding`; P3/P4/P5 are frontend-only and live on the same `public-category` / `get-provider` contracts.
- **Working-tree hygiene cleanup — 8-commit deployed-vs-source resync** — eliminated a multi-month drift in which 15 modified backend / config files, 3 untracked function directories, 4 untracked migrations, and `CLAUDE.md` itself were live in production but not committed to git. Pre-flight verified deployed bytes byte-identical to working tree for `twilio-webhook` and `marketplace-connect` (and transitively for the `_shared/` bundle); confirmed all three new Stripe / card-on-file functions ACTIVE on Supabase since 2026-04-21; resolved one schema gap by manually applying the 20260422 `guarantee_claims` migration in the Supabase SQL editor before its source commit. Eight commits landed on `main` 2026-04-25 in dependency order, each file appearing in exactly one commit, no `git add -p` partial staging:
  - `aee3d95` — Track CLAUDE.md project orientation
  - `ccc84f2` — Sync deployed `_shared/` library (constants + twilio)
  - `6eb90b3` — Sync deployed Concierge intake & dispatch (incl. `20260411` and `20260416` migration files)
  - `4e63fb5` — Sync deployed Marketplace coverage backend (P2 server-side gate)
  - `b687200` — Sync deployed Stripe / card-on-file backend (incl. three new functions + `20260420` migration file)
  - `454ae38` — Sync deployed Lead Guarantee backend (incl. `20260422` migration file, applied before commit)
  - `54c03dc` — Sync deployed survey/reminder template sends
  - `98b0ab9` — Make application description optional
  No deploys, no DB mutations, no file edits performed during the cleanup itself — every commit recorded existing live state. Repo and live function bytes are now in sync; `CLAUDE.md` is now tracked.
- **Public-site legal footer + Painting category icon (commit `4d3e835`)** — homepage footer now reads `© 2026 TaskLeaders Network Inc.` (was `© 2026 TaskLeaders`); this was required for final WhatsApp Business account approval. Painting category icon changed to `🪜` across all five surfaces (`v0.5/homepage.html`, `v0.5/profile.html` ×2, `v0.5/taskleader-profile-setup.html` ×2) and the two backend metadata sources (`public-category` / `public-homepage` `CATEGORY_META.painting.icon`). Backend deploy executed: `public-category` advanced to v37 ACTIVE; `public-homepage` advanced to v33 ACTIVE — repo/source/deploy invariant preserved. Live testing passed across homepage, category page H1, profile page, onboarding setup. No DB, migration, WhatsApp logic, Stripe, or Concierge surfaces touched.

---

## 13. Pending / Pre-Launch Checklist

- [x] Verify `app.cron_secret` DB parameter is set and `process-timeouts` pg_cron job is firing correctly — **done 2026-04-17**
- [x] Run live timeout path test (let a payment window expire and verify WT-6 → WT-7 sequence) — **verified live on VAN-CLN-00027**
- [x] Verify manual payment-link end-to-end via real Stripe `checkout.session.completed` (test mode) — **verified live 2026-04-23 on VAN-HVC-00012**
- [ ] Live-mode Stripe cutover: install `sk_live_…` as `STRIPE_SECRET_KEY` and the matching live-mode `whsec_…` as `STRIPE_WEBHOOK_SECRET`; re-verify the payment path against a real (non-test) card before opening to non-test providers
- [ ] Set `TWILIO_TEMPLATE_SID_WC1` … `WC8` and `TWILIO_TEMPLATE_SID_WT1` … `WT10` in Supabase secrets once Meta approvals received (includes WC-7/WC-8/WT-9/WT-10 Lead Guarantee outcome templates added in Architecture v8)
- [ ] Submit WT-8 as a Meta-approved template (currently sent as plain WhatsApp via `sendWhatsApp()`, not `sendTemplateWhatsApp()`)
- [ ] Remove `x-admin-simulate` block from `stripe-webhook` before production launch
- [ ] Verify HTTPS enforcement on GitHub Pages (TLS auto-provisioning)
- [ ] Set Marketplace subscription pricing (TBD, single flat rate)

---

## 14. Known Doc/Code Relationships (updated 2026-04-17)

| Item | Status | Detail |
|---|---|---|
| **WT-8 purpose** | ✅ Docs corrected | WhatsApp Architecture v5 and State Machine v5 have been updated. In current code, WT-8 = payment-confirmed / thread-open notification sent to the provider by `stripe-webhook` after successful payment. Sent via `sendWhatsApp()` (in-session plain text), not `sendTemplateWhatsApp()`. The submitted template name `wt_8_job_completed_check_taskleader` reflects the original design intent but does not match current code behavior. |
| **WC-6 survey completion check** | ✅ Docs corrected | `buildWC6()` does not exist in `_shared/twilio.ts`. WC-6 is not wired anywhere in code. There is no completion-check gate before the survey in the current implementation. WhatsApp Architecture v5 and State Machine v5 have been updated to note this. WC-6 was submitted as a Twilio template and is reserved for future implementation. |
| **Survey sequence** | ✅ Docs corrected | Actual live sequence: admin triggers `trigger-survey` → WC-3 sent → Q1 immediately sent in-session → Q2/Q3 via `twilio-webhook` → thank-you → `survey_complete`. No WC-6 pre-check. No WC-6 handler anywhere. |
| **Manual payment window** | ✅ Docs corrected | Platform Reference (April 4) said "5-minute window" — corrected inline. Current code: 10-minute window, WT-6 warning at 5 minutes remaining. WhatsApp Architecture v5 and State Machine v5 already had this correct. |
| **Twilio integration status** | ✅ Docs corrected | Platform Reference "Communications (Pending)" section updated inline. Messaging engine is fully implemented and partially live-proven. |
| **`_shared/twilio.ts` header comment** | ⚠ Minor stale comment in source | Line 8 of `twilio.ts` says "WC-1 … WT-7" but WT-8 is also defined and used. Low priority — does not affect behavior. |
| **process-timeouts cron auth path (live truth)** | ✅ Verified 2026-04-17 | Two independent stores must match: (1) pg_cron job reads `current_setting('app.cron_secret', true)` from the PostgreSQL DB parameter and sends it as the `x-cron-secret` header via pg_net; (2) edge function reads `Deno.env.get("INTERNAL_CRON_SECRET")` from Supabase Edge Function secrets. Supabase Vault (`vault.decrypted_secrets`, name = `internal_cron_secret`) is the reference store for the secret value but is NOT read by either path at runtime — both `app.cron_secret` and `INTERNAL_CRON_SECRET` must be set manually to match it. Prior 401 failures were caused by these two sides never being aligned. |
| **WT-6/WT-7 send path** | ⚠ Latent production risk | Both sent via `sendWhatsApp()` (plain text), not `sendTemplateWhatsApp()`. Requires an active 24-hour WhatsApp session window. Failures log to `message_log` with `status = 'failed'` but the alert is still marked resolved — silent to ops. Needs Meta-approved template SIDs and migration to `sendTemplateWhatsApp()` before production at scale. |
| **`STRIPE_WEBHOOK_SECRET` / `STRIPE_SECRET_KEY` environment alignment** | ✅ Operational rule (verified 2026-04-23) | Stripe webhook signing secrets are environment-specific: a test-mode endpoint has a different `whsec_…` than the same endpoint in live mode. `STRIPE_WEBHOOK_SECRET` in Supabase **must** match the environment of `STRIPE_SECRET_KEY` (i.e. both `sk_test_` + `whsec_test-endpoint`, OR both `sk_live_` + `whsec_live-endpoint`). A mismatch causes `verifyStripeSignature` in `stripe-webhook` ([index.ts:166-176](supabase/functions/stripe-webhook/index.ts:166)) to return **`400 Invalid signature`** before any application code runs — so no `admin_alerts` row is created, no `payment_records` update happens, and the lead silently expires via `process-timeouts`. The original VAN-HVC-00011 failure was this exact case (secret missing). VAN-HVC-00012 confirmed the path end-to-end after the test-mode `whsec_…` was installed. Pre-cutover, also confirm via `supabase secrets list` that the `STRIPE_*` digests changed when the env is rotated, then re-run the manual payment-link verification on a fresh job. |

---

## 15. Session-Start Instructions for Future Claude Sessions

When starting a new session on this project:

1. **Read this file first** for orientation — but treat it as a starting point, not ground truth
2. **Read the specific files relevant to the task** before writing any code — use the function map in §5
3. **Check the most recent migration** (`supabase/migrations/`) to confirm current DB schema
4. **Check `_shared/constants.ts`** for category codes, city codes, fee constants, and keyword definitions before hardcoding anything
5. **Check `supabase/functions/_shared/twilio.ts`** for the current template builder signatures before constructing any message bodies
6. **Do not assume** any behavior described in this file is implemented exactly as described — read the source

**Quick orientation SQL (run in Supabase SQL editor to understand live state):**
```sql
-- Recent jobs
SELECT job_id, state, source, category_code, municipality_name, assigned_provider_slug, created_at
FROM jobs ORDER BY created_at DESC LIMIT 10;

-- Active sessions
SELECT whatsapp_e164, sender_type, session_state, current_job_id, last_activity_at
FROM conversation_sessions WHERE session_state != 'idle' ORDER BY last_activity_at DESC;

-- Open admin alerts
SELECT alert_type, priority, job_id, description, created_at FROM admin_alerts WHERE status = 'open' ORDER BY created_at DESC;
```

---

## 16. Documentation Maintenance Rule

Update this file when:
- A new edge function is added or renamed
- A `jobs.state` value is added or changed
- A `conversation_sessions.session_state` value is added or changed
- A template is added, renamed, or repurposed
- A major behavior is proven live (move it into §10)
- A pending task is completed (remove from §13)
- A new conflict between docs and code is discovered (add to §14)

Do **not** update this file to reflect desired future behavior — only confirmed current behavior. If you're unsure whether something is implemented, read the source and note it as "unconfirmed" in §14.

*Last updated: 2026-04-23 (adds `awaiting_match` client session state; duplicate-intake prevention during broadcast/search window verified live; client CANCEL during awaiting_match verified live; provider ACCEPT against a cancelled job safely blocked by `claim_lead()` atomic guard; `escalateAmbiguousReply` logging gap flagged as observability follow-up; backend municipality registry expanded from 11 to 18 codes to match the app Service Area dropdown — Mission, Maple Ridge, Pitt Meadows, Langley, White Rock, Abbotsford, Chilliwack added; Mission reuse and Maple Ridge + "Burnaby St" street-name-collision regression both verified live on VAN-YRD-00003 / VAN-YRD-00007; two new hardening items added — single-word municipality street-name collision, and inline-address numeric-prefix street-name gap; manual Stripe payment-link path verified end-to-end in test mode on VAN-HVC-00012 after `STRIPE_WEBHOOK_SECRET` was installed; routed-thread relay confirmed live by post-payment `"Hello back"` exchange; new §14 entry on Stripe webhook secret / API key environment alignment; live-mode Stripe cutover added to §13 as a remaining pre-launch item)*

*2026-04-25 update: Marketplace service-area cluster verified live — Marketplace Connect dropdown restricted to provider coverage and `marketplace-connect` rejects out-of-coverage submissions (P2, commit `b17bb90`); `complete-onboarding` write-fix derives `municipality_codes` from `baseCity` + `serviceCities` with partial-edit guard, plus an active-status preservation guard on the return/edit path (commit `75e98a0`, committed after deploy; municipality_codes behavior verified on test slug `ellie-brunel` and rolled back; the active-status guard is consistent with its source comment but was not directly exercised against an active slug in this cluster); category-page municipality filter (P4, commit `765b21a`) using available-municipalities-only dropdown; category-card service-area labels disambiguate base vs broader coverage (P3, commit `68317f2`); category-to-profile Connect preselect via validated `?municipality=<CODE>` (P5, commit `0c47e7c`). New §11 Marketplace-cluster open-backlog subsection records WC-2 first-time-client session-window risk, Marketplace ACCEPT/DECLINE observability gap, recipient `last_activity_at` hygiene, stale malformed phone/session rows, `address TBD` relay-header placeholder, reject-branch outbound logging gap, provider-facing routed-bracket `[client]` vs first-name verification, deferred WhatsApp Architecture v8 / State Machine v8 / Strategic Brief / Platform Reference / Terms / Guidelines doc-set update, public-site link audit + GitHub repo public/private decision, building track-record placeholder, and Workspace trial cancel/downgrade.*

*2026-04-25 supplement (working-tree hygiene cleanup): completed an 8-commit resync that eliminated a multi-month deployed-but-uncommitted drift. Pre-flight confirmed deployed bytes byte-identical to working tree for `twilio-webhook` and `marketplace-connect` (transitively covering the `_shared/` bundle); confirmed three new Stripe/card-on-file functions (`confirm-card-setup`, `create-setup-intent`, `get-provider-private`) ACTIVE on Supabase since 2026-04-21; closed one schema gap by manually applying the `20260422_000000_guarantee_claims_provider_response.sql` migration in the Supabase SQL editor before its source commit (both `provider_response` and `provider_responded_at` columns confirmed present immediately after). Eight commits landed in dependency order on 2026-04-25 (`aee3d95` track CLAUDE.md, `ccc84f2` `_shared/`, `6eb90b3` Concierge intake/dispatch + `20260411`/`20260416` migration files, `4e63fb5` Marketplace P2 backend, `b687200` Stripe/card-on-file backend incl. three new function dirs + `20260420` migration file, `454ae38` Lead Guarantee backend + `20260422` migration file, `54c03dc` survey/reminder templated sends, `98b0ab9` `apply` description-optional 1-liner). Each file appeared in exactly one commit; no `git add -p` partial staging. Working tree clean, `main` up to date with `origin/main`. CLAUDE.md is now tracked in git for the first time. Zero deploys, zero DB mutations, and zero file edits during the cleanup itself — every commit recorded existing live state. The repo now matches deployed Supabase Edge Function bytes plus the live DB schema; the deployed-but-uncommitted risk is fully retired.*

*2026-04-25 supplement (public-site fix, commit `4d3e835`): updated the homepage footer to render the full legal name `© 2026 TaskLeaders Network Inc.` (was `© 2026 TaskLeaders`) — required for final WhatsApp Business account approval. Replaced the Painting category icon with `🪜` across all five frontend surfaces (`v0.5/homepage.html`, `v0.5/profile.html` ×2, `v0.5/taskleader-profile-setup.html` ×2) and both backend metadata sources (`public-category`/`public-homepage` `CATEGORY_META.painting.icon`). Backend deploys: `public-category` → v37 ACTIVE, `public-homepage` → v33 ACTIVE. Live testing passed (homepage card, category-page H1, profile page service-strip, onboarding dropdown + checkbox). Repo/source/deploy invariant preserved. Working tree clean.*
