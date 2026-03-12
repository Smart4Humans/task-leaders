-- TaskLeaders MVP (Phase 1) — Seed data
-- Seeds:
-- - Vancouver city
-- - Approved 8 categories
-- - 3 sample approved+active TaskLeaders
-- - Rankings

begin;

-- City
insert into public.cities (slug, name, region, country, is_active)
values ('vancouver', 'Vancouver', 'BC', 'CA', true)
on conflict (slug) do update set
  name = excluded.name,
  region = excluded.region,
  country = excluded.country,
  is_active = excluded.is_active;

-- Categories (approved set)
insert into public.categories (slug, display_name, icon, sort_order, is_active)
values
  ('handyman', 'Handyman', '🔧', 10, true),
  ('plumbing', 'Plumbing', '🚿', 20, true),
  ('electrical', 'Electrical', '⚡', 30, true),
  ('painting', 'Painting', '🎨', 40, true),
  ('cleaning', 'Cleaning', '🧹', 50, true),
  ('furniture-assembly', 'Furniture Assembly', '📦', 60, true),
  ('moving', 'Moving Help', '🚚', 70, true),
  ('yard-work', 'Yard Work', '🌿', 80, true)
on conflict (slug) do update set
  display_name = excluded.display_name,
  icon = excluded.icon,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

-- Sample providers (approved + active; contact_mode defaults to direct)
-- NOTE: WhatsApp numbers below are placeholders for development.
with
  v as (select id as city_id from public.cities where slug = 'vancouver' limit 1),
  c_handyman as (select id as category_id from public.categories where slug = 'handyman' limit 1),
  c_cleaning as (select id as category_id from public.categories where slug = 'cleaning' limit 1),
  c_painting as (select id as category_id from public.categories where slug = 'painting' limit 1)
insert into public.providers (
  provider_slug,
  display_name,
  status,
  is_active,
  contact_mode,
  city_id,
  category_id,
  whatsapp_e164,
  response_time_minutes,
  reliability_percent,
  hourly_rate_cents,
  currency,
  metrics_source,
  metrics_last_reviewed_at
)
select
  p.provider_slug,
  p.display_name,
  p.status,
  p.is_active,
  p.contact_mode,
  p.city_id,
  p.category_id,
  p.whatsapp_e164,
  p.response_time_minutes,
  p.reliability_percent,
  p.hourly_rate_cents,
  p.currency,
  p.metrics_source,
  p.metrics_last_reviewed_at
from (
  select
    'sam-fixit'::text as provider_slug,
    'Sam Fixit'::text as display_name,
    'approved'::text as status,
    true as is_active,
    'direct'::text as contact_mode,
    (select city_id from v) as city_id,
    (select category_id from c_handyman) as category_id,
    '+16045550101'::text as whatsapp_e164,
    6 as response_time_minutes,
    92 as reliability_percent,
    8500 as hourly_rate_cents,
    'CAD'::text as currency,
    'curated'::text as metrics_source,
    now() as metrics_last_reviewed_at

  union all

  select
    'neat-nora'::text,
    'Neat Nora'::text,
    'approved'::text,
    true,
    'direct'::text,
    (select city_id from v),
    (select category_id from c_cleaning),
    '+16045550102'::text,
    8,
    95,
    6500,
    'CAD'::text,
    'curated'::text,
    now()

  union all

  select
    'paint-pat'::text,
    'Paint Pat'::text,
    'approved'::text,
    true,
    'direct'::text,
    (select city_id from v),
    (select category_id from c_painting),
    '+16045550103'::text,
    12,
    90,
    7800,
    'CAD'::text,
    'curated'::text,
    now()
) p
on conflict (provider_slug) do update set
  display_name = excluded.display_name,
  status = excluded.status,
  is_active = excluded.is_active,
  contact_mode = excluded.contact_mode,
  city_id = excluded.city_id,
  category_id = excluded.category_id,
  whatsapp_e164 = excluded.whatsapp_e164,
  response_time_minutes = excluded.response_time_minutes,
  reliability_percent = excluded.reliability_percent,
  hourly_rate_cents = excluded.hourly_rate_cents,
  currency = excluded.currency,
  metrics_source = excluded.metrics_source,
  metrics_last_reviewed_at = excluded.metrics_last_reviewed_at,
  updated_at = now();

-- Rankings (per city+category)
-- For MVP seed: rank each sample as #1 in its category
with
  v as (select id as city_id from public.cities where slug = 'vancouver' limit 1),
  p1 as (select id as provider_id, city_id, category_id from public.providers where provider_slug = 'sam-fixit' limit 1),
  p2 as (select id as provider_id, city_id, category_id from public.providers where provider_slug = 'neat-nora' limit 1),
  p3 as (select id as provider_id, city_id, category_id from public.providers where provider_slug = 'paint-pat' limit 1)
insert into public.provider_rankings (city_id, category_id, provider_id, rank, is_featured)
select (select city_id from v), p1.category_id, p1.provider_id, 1, true from p1
union all
select (select city_id from v), p2.category_id, p2.provider_id, 1, true from p2
union all
select (select city_id from v), p3.category_id, p3.provider_id, 1, true from p3
on conflict (city_id, category_id, provider_id) do update set
  rank = excluded.rank,
  is_featured = excluded.is_featured,
  updated_at = now();

commit;
