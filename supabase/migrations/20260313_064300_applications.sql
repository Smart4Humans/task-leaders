-- TaskLeaders MVP (Phase 1) — Provider applications (write-side foundation)
-- Founder-operable intake table for Become a TaskLeader.

begin;

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  status text not null default 'submitted',
  city_slug text not null,
  category_slug text not null,

  contact_name text not null,
  business_name text,
  email text not null,
  whatsapp_e164 text not null,

  service_area text not null,
  description text not null,

  source text not null,
  meta jsonb,

  founder_notes text,
  reviewed_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text
);

-- Minimal helpful indexes for founder review + dedupe
create index if not exists idx_applications_status_created_at on public.applications(status, created_at desc);
create index if not exists idx_applications_email on public.applications(email);
create index if not exists idx_applications_whatsapp on public.applications(whatsapp_e164);

commit;
