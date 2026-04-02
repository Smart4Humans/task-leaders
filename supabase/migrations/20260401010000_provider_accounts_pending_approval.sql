-- TaskLeaders — Extend provider_accounts status to include pending_approval
-- Status lifecycle: pending_onboarding → pending_approval → active
-- pending_approval is set by complete-onboarding when provider submits profile setup.
-- active is set by admin via approve-application activate action.

begin;

alter table public.provider_accounts
  drop constraint provider_accounts_status_check;

alter table public.provider_accounts
  add constraint provider_accounts_status_check
  check (status in ('pending_onboarding', 'pending_approval', 'active'));

commit;
