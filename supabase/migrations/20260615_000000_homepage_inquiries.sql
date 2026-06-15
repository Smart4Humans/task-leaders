-- TaskLeaders — Homepage Score funnel + Marketplace waitlist capture (v0.2)
-- Stage 1 of the service-pro Score funnel. There is NO scoring-on-demand backend:
-- Score requests are captured for MANUAL review / triage by TaskLeaders.
-- RLS-locked; only the service-role Edge Function (homepage-inquiry) touches it.
-- Does NOT replace the provider-application path (/apply -> public.applications).

begin;

create table if not exists public.homepage_inquiries (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  type          text not null check (type in ('score_assessment','marketplace_waitlist')),
  status        text not null default 'new',          -- coarse: new | triaged | closed (loose, no hard check)
  email         text not null,

  -- score_assessment fields
  first_name    text,
  last_name     text,
  business_name text,
  category_slug text,
  category_label text,
  city_or_area  text,
  website       text,
  note          text,

  -- marketplace_waitlist fields
  city          text,
  category      text,

  -- consent + provenance (server-stamped; not client-trusted)
  consent       boolean,
  consent_text  text,
  consent_at    timestamptz,
  source        text not null default 'homepage',
  page          text,
  referrer      text,
  user_agent    text,
  meta          jsonb,

  -- funnel lifecycle. type + score_category_status are integrity-critical (hard checks).
  -- score_status / offer_stage / status / followup_status are intentionally loose text so
  -- the offer ladder can evolve without a migration.
  score_category_status text check (score_category_status in
        ('supported','unsupported','unknown','manual_review')),
  score_status   text default 'not_started',
        -- expected: not_started | queued | in_review | completed | cannot_score_yet | closed
  offer_stage    text default 'none',
        -- expected: none | free_score_requested | free_score_sent | detailed_report_offer |
        --           paid_report_customer | marketplace_application_suggested |
        --           concierge_review_candidate | closed
  followup_status text,

  internal_notification_sent_at timestamptz,
  autoresponder_sent_at         timestamptz,
  response_sent_at              timestamptz,
  last_contacted_at             timestamptz,
  next_followup_at              timestamptz,
  internal_notes                text,

  -- per-type required shape, enforced at the DB layer (mirrors the Edge Function)
  constraint homepage_inquiries_shape_chk check (
    (type = 'score_assessment'
       and first_name    is not null
       and last_name     is not null
       and business_name is not null
       and category_slug is not null
       and city_or_area  is not null
       and consent = true and consent_text is not null and consent_at is not null)
    or
    (type = 'marketplace_waitlist'
       and city is not null
       and consent = true and consent_text is not null and consent_at is not null)
  )
);

create index if not exists idx_hpi_type_created    on public.homepage_inquiries(type, created_at desc);
create index if not exists idx_hpi_status_created  on public.homepage_inquiries(status, created_at desc);
create index if not exists idx_hpi_score_status    on public.homepage_inquiries(score_status, created_at desc);
create index if not exists idx_hpi_offer_stage     on public.homepage_inquiries(offer_stage, created_at desc);
create index if not exists idx_hpi_next_followup   on public.homepage_inquiries(next_followup_at);
create index if not exists idx_hpi_email           on public.homepage_inquiries(email);

-- keep updated_at fresh on any row update
create or replace function public.tg_homepage_inquiries_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_hpi_touch on public.homepage_inquiries;
create trigger trg_hpi_touch
  before update on public.homepage_inquiries
  for each row execute function public.tg_homepage_inquiries_touch();

-- Service-role-only access: RLS enabled with NO policies => anon / authenticated
-- (the publishable key) cannot read or write. The Edge Function uses the service
-- role key, which bypasses RLS.
alter table public.homepage_inquiries enable row level security;

commit;
