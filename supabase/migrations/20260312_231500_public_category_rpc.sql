-- TaskLeaders MVP (Phase 1) — Read RPC for Category Page
-- Provides a stable read model for providers in a given city + category.

begin;

create or replace function public.get_public_category_providers(
  p_city_slug text default 'vancouver',
  p_category_slug text default 'handyman'
)
returns table (
  provider_slug text,
  display_name text,
  response_time_minutes integer,
  reliability_percent integer,
  hourly_rate_cents integer,
  currency text,
  rank integer,
  is_featured boolean
)
language sql
stable
as $$
  with
    city as (
      select id
      from public.cities
      where slug = coalesce(p_city_slug, 'vancouver')
        and is_active = true
      limit 1
    ),
    cat as (
      select id
      from public.categories
      where slug = coalesce(p_category_slug, 'handyman')
        and is_active = true
      limit 1
    )
  select
    p.provider_slug,
    p.display_name,
    p.response_time_minutes,
    p.reliability_percent,
    p.hourly_rate_cents,
    p.currency,
    r.rank,
    coalesce(r.is_featured, false) as is_featured
  from public.providers p
  join city on p.city_id = city.id
  join cat on p.category_id = cat.id
  left join public.provider_rankings r
    on r.city_id = p.city_id
   and r.category_id = p.category_id
   and r.provider_id = p.id
  where p.status = 'approved'
    and p.is_active = true
  order by
    r.rank asc nulls last,
    p.display_name asc;
$$;

commit;
