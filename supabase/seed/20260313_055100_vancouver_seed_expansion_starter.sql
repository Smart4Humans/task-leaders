-- TaskLeaders MVP — Vancouver seed expansion (starter set)
-- Additive + idempotent: safe to run multiple times.
-- Focus categories: Handyman, Cleaning, Painting, Plumbing, Electrical.

begin;

-- Ensure Vancouver exists
insert into public.cities (slug, name, region, country, is_active)
values ('vancouver', 'Vancouver', 'BC', 'CA', true)
on conflict (slug) do update set
  name = excluded.name,
  region = excluded.region,
  country = excluded.country,
  is_active = excluded.is_active,
  updated_at = now();

-- Ensure approved categories exist (upsert)
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
  is_active = excluded.is_active,
  updated_at = now();

with
  v as (
    select id as city_id
    from public.cities
    where slug = 'vancouver'
    limit 1
  ),
  providers_in as (
    -- provider_slug, display_name, category_slug, whatsapp_e164, response_time_minutes, reliability_percent, hourly_rate_cents, currency
    select * from (
      values
        -- Handyman (8)
        ('sam-fixit', 'Sam Fixit', 'handyman', '+16045550101', 6, 92, 8500, 'CAD'),
        ('van-handyman-eastside-repairs', 'Eastside Repairs', 'handyman', '+16045550201', 4, 90, 9500, 'CAD'),
        ('van-handyman-kits-quickfix', 'Kits QuickFix', 'handyman', '+16045550202', 3, 88, 10500, 'CAD'),
        ('van-handyman-burnaby-handyco', 'Burnaby HandyCo', 'handyman', '+16045550203', 10, 94, 8000, 'CAD'),
        ('van-handyman-mtpleasant-pro', 'Mt Pleasant Pro Handyman', 'handyman', '+16045550204', 12, 91, 7500, 'CAD'),
        ('van-handyman-northshore-oddjobs', 'North Shore Odd Jobs', 'handyman', '+16045550205', 18, 89, 7000, 'CAD'),
        ('van-handyman-downtown-punchlist', 'Downtown Punchlist', 'handyman', '+16045550206', 8, 86, 11000, 'CAD'),
        ('van-handyman-southvan-reliable', 'South Van Reliable', 'handyman', '+16045550207', 20, 93, 7800, 'CAD'),

        -- Cleaning (6)
        ('neat-nora', 'Neat Nora', 'cleaning', '+16045550102', 8, 95, 6500, 'CAD'),
        ('van-cleaning-kits-sparkle', 'Kits Sparkle Cleaners', 'cleaning', '+16045550301', 6, 92, 7200, 'CAD'),
        ('van-cleaning-eastvan-deepclean', 'East Van Deep Clean', 'cleaning', '+16045550302', 12, 90, 6000, 'CAD'),
        ('van-cleaning-burnaby-moveout', 'Burnaby Move-Out Pros', 'cleaning', '+16045550303', 14, 93, 7000, 'CAD'),
        ('van-cleaning-downtown-fastturn', 'Downtown Fast Turn', 'cleaning', '+16045550304', 5, 88, 8500, 'CAD'),
        ('van-cleaning-northshore-eco', 'North Shore Eco Clean', 'cleaning', '+16045550305', 16, 94, 6800, 'CAD'),

        -- Painting (5)
        ('paint-pat', 'Paint Pat', 'painting', '+16045550103', 12, 90, 7800, 'CAD'),
        ('van-painting-westend-finish', 'West End Finish Co.', 'painting', '+16045550401', 9, 92, 9200, 'CAD'),
        ('van-painting-eastvan-rollers', 'East Van Rollers', 'painting', '+16045550402', 15, 89, 7000, 'CAD'),
        ('van-painting-burnaby-trimline', 'Burnaby Trimline Painting', 'painting', '+16045550403', 18, 94, 8500, 'CAD'),
        ('van-painting-kits-quickcoat', 'Kits QuickCoat', 'painting', '+16045550404', 7, 87, 9500, 'CAD'),

        -- Plumbing (3)
        ('van-plumbing-rapid-drain', 'Rapid Drain Plumbing', 'plumbing', '+16045550501', 5, 93, 11500, 'CAD'),
        ('van-plumbing-burnaby-leakfix', 'Burnaby LeakFix', 'plumbing', '+16045550502', 10, 90, 10500, 'CAD'),
        ('van-plumbing-northshore-pipepro', 'North Shore PipePro', 'plumbing', '+16045550503', 14, 94, 12500, 'CAD'),

        -- Electrical (3)
        ('van-electrical-quick-spark', 'Quick Spark Electrical', 'electrical', '+16045550601', 6, 96, 12000, 'CAD'),
        ('van-electrical-kits-circuitcare', 'CircuitCare Kits', 'electrical', '+16045550602', 12, 92, 11000, 'CAD'),
        ('van-electrical-burnaby-safegrid', 'SafeGrid Burnaby', 'electrical', '+16045550603', 16, 94, 13000, 'CAD')
    ) as t(
      provider_slug,
      display_name,
      category_slug,
      whatsapp_e164,
      response_time_minutes,
      reliability_percent,
      hourly_rate_cents,
      currency
    )
  )
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
  'approved'::text as status,
  true as is_active,
  'direct'::text as contact_mode,
  (select city_id from v) as city_id,
  c.id as category_id,
  p.whatsapp_e164,
  p.response_time_minutes,
  p.reliability_percent,
  p.hourly_rate_cents,
  p.currency,
  'curated'::text as metrics_source,
  now() as metrics_last_reviewed_at
from providers_in p
join public.categories c on c.slug = p.category_slug
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

-- Rankings (safe upserts)
with
  v as (
    select id as city_id
    from public.cities
    where slug = 'vancouver'
    limit 1
  ),
  ranks_in as (
    -- provider_slug, category_slug, rank, is_featured
    select * from (
      values
        -- Handyman ranks
        ('sam-fixit', 'handyman', 1, true),
        ('van-handyman-eastside-repairs', 'handyman', 2, true),
        ('van-handyman-kits-quickfix', 'handyman', 3, true),
        ('van-handyman-burnaby-handyco', 'handyman', 4, false),
        ('van-handyman-mtpleasant-pro', 'handyman', 5, false),
        ('van-handyman-northshore-oddjobs', 'handyman', 6, false),
        ('van-handyman-downtown-punchlist', 'handyman', 7, false),
        ('van-handyman-southvan-reliable', 'handyman', 8, false),

        -- Cleaning ranks
        ('neat-nora', 'cleaning', 1, true),
        ('van-cleaning-kits-sparkle', 'cleaning', 2, true),
        ('van-cleaning-eastvan-deepclean', 'cleaning', 3, false),
        ('van-cleaning-burnaby-moveout', 'cleaning', 4, false),
        ('van-cleaning-downtown-fastturn', 'cleaning', 5, false),
        ('van-cleaning-northshore-eco', 'cleaning', 6, false),

        -- Painting ranks
        ('paint-pat', 'painting', 1, true),
        ('van-painting-westend-finish', 'painting', 2, true),
        ('van-painting-eastvan-rollers', 'painting', 3, false),
        ('van-painting-burnaby-trimline', 'painting', 4, false),
        ('van-painting-kits-quickcoat', 'painting', 5, false),

        -- Plumbing ranks
        ('van-plumbing-rapid-drain', 'plumbing', 1, true),
        ('van-plumbing-burnaby-leakfix', 'plumbing', 2, false),
        ('van-plumbing-northshore-pipepro', 'plumbing', 3, false),

        -- Electrical ranks
        ('van-electrical-quick-spark', 'electrical', 1, true),
        ('van-electrical-kits-circuitcare', 'electrical', 2, false),
        ('van-electrical-burnaby-safegrid', 'electrical', 3, false)
    ) as t(provider_slug, category_slug, rank, is_featured)
  ),
  resolved as (
    select
      (select city_id from v) as city_id,
      c.id as category_id,
      p.id as provider_id,
      r.rank,
      r.is_featured
    from ranks_in r
    join public.categories c on c.slug = r.category_slug
    join public.providers p on p.provider_slug = r.provider_slug
  )
insert into public.provider_rankings (city_id, category_id, provider_id, rank, is_featured)
select city_id, category_id, provider_id, rank, is_featured
from resolved
on conflict (city_id, category_id, provider_id) do update set
  rank = excluded.rank,
  is_featured = excluded.is_featured,
  updated_at = now();

commit;
