-- TaskLeaders MVP (Phase 1) — Read-layer foundation
-- Creates minimal schema needed for /public-homepage
--
-- Notes:
-- - City and Category are first-class.
-- - Providers are scoped to a primary city + primary category for MVP.
-- - Rankings are stored separately for future flexibility.

begin;

-- 1) Cities
create table if not exists public.cities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  region text,
  country text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) Categories (approved taxonomy)
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  icon text,
  is_active boolean not null default true,
  sort_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) Providers (TaskLeaders)
-- For MVP: one primary city + one primary category.
create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),

  -- Public identifier
  provider_slug text not null unique,
  display_name text not null,

  -- Lifecycle
  status text not null default 'pending',
  is_active boolean not null default false,

  -- Routing (WhatsApp operating model)
  contact_mode text not null default 'direct', -- direct | concierge_only

  -- Location + category
  city_id uuid not null references public.cities(id),
  category_id uuid not null references public.categories(id),

  -- Trust signals (curated for MVP)
  response_time_minutes integer,
  reliability_percent integer,
  hourly_rate_cents integer,
  currency text not null default 'CAD',

  -- Metrics integrity
  metrics_source text not null default 'curated',
  metrics_last_reviewed_at timestamptz,

  -- Contact
  whatsapp_e164 text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4) Provider rankings (per city + category)
create table if not exists public.provider_rankings (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id),
  category_id uuid not null references public.categories(id),
  provider_id uuid not null references public.providers(id),
  rank integer not null,
  is_featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_rankings_unique unique (city_id, category_id, provider_id)
);

-- Basic helpful indexes
create index if not exists idx_providers_city_category on public.providers(city_id, category_id);
create index if not exists idx_providers_active on public.providers(status, is_active);
create index if not exists idx_rankings_city_category_rank on public.provider_rankings(city_id, category_id, rank);

commit;
