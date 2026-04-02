-- TaskLeaders MVP — Provider accounts table
-- NOTE: The existing public.providers table is the public marketplace listing table.
--       This table (provider_accounts) is the onboarding/auth record created at approval.
--       It bridges: application (submitted) → provider_accounts (approved) → profile goes live.
-- Status lifecycle: pending_onboarding → active

begin;

create table if not exists public.provider_accounts (
  id            uuid        primary key default gen_random_uuid(),
  slug          text        unique not null,          -- e.g. marco-a3x9 (used in welcome URL)
  status        text        not null default 'pending_onboarding',  -- pending_onboarding | active

  -- Copied from applications at approval time
  first_name        text        not null,
  last_name         text        not null,
  business_name     text,
  email             text        not null,
  whatsapp_number   text        not null,
  service_area      text        not null,
  primary_service   text        not null,
  short_description text,

  -- Added at Profile Setup
  profile_photo     text,       -- storage URL
  base_rate         text,

  -- Relations & timestamps
  application_id    uuid        references public.applications(id),
  created_at        timestamptz not null default now(),
  onboarded_at      timestamptz
);

-- Constraint: status must be one of the known lifecycle values
alter table public.provider_accounts
  add constraint provider_accounts_status_check
  check (status in ('pending_onboarding', 'active'));

create index if not exists idx_provider_accounts_slug        on public.provider_accounts(slug);
create index if not exists idx_provider_accounts_status      on public.provider_accounts(status);
create index if not exists idx_provider_accounts_email       on public.provider_accounts(email);
create index if not exists idx_provider_accounts_application on public.provider_accounts(application_id);

-- Disable public read access — all reads go through Edge Functions with service role
alter table public.provider_accounts enable row level security;

-- No RLS policies needed at this stage; Edge Functions use service-role key which bypasses RLS.

commit;
