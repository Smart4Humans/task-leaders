-- TaskLeaders MVP — Providers table
-- Created when Todd approves an application and generates a welcome link.
-- Status lifecycle: pending_onboarding → active

begin;

create table if not exists public.providers (
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
alter table public.providers
  add constraint providers_status_check
  check (status in ('pending_onboarding', 'active'));

create index if not exists idx_providers_slug        on public.providers(slug);
create index if not exists idx_providers_status      on public.providers(status);
create index if not exists idx_providers_email       on public.providers(email);
create index if not exists idx_providers_application on public.providers(application_id);

-- Disable public read access — all reads go through Edge Functions with service role
alter table public.providers enable row level security;

-- No RLS policies needed at this stage; Edge Functions use service-role key which bypasses RLS.

commit;
