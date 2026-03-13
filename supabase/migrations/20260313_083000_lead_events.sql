-- TaskLeaders MVP (Phase 1) — Lead events (minimal)
-- Best-effort event logging for Connect instrumentation.

begin;

create table if not exists public.lead_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  event_type text not null,
  source text not null,
  page text not null,
  session_id text not null,

  city_slug text not null,
  category_slug text,
  provider_slug text,

  consent_checked boolean,
  handoff_channel text,
  handoff_mode text,

  meta jsonb
);

create index if not exists idx_lead_events_created_at on public.lead_events(created_at desc);
create index if not exists idx_lead_events_type_created_at on public.lead_events(event_type, created_at desc);
create index if not exists idx_lead_events_provider_created_at on public.lead_events(provider_slug, created_at desc);

commit;
