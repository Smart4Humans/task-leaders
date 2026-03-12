-- TaskLeaders MVP (Phase 1) — Read RPC for Homepage
-- Provides a stable read model for category supply counts by city.

begin;

create or replace function public.get_homepage_category_supply(p_city_slug text default 'vancouver')
returns table (
  category_slug text,
  display_name text,
  icon text,
  provider_count bigint
)
language sql
stable
as $$
  with city as (
    select id from public.cities where slug = coalesce(p_city_slug, 'vancouver') limit 1
  )
  select
    c.slug as category_slug,
    c.display_name,
    c.icon,
    count(p.id) as provider_count
  from public.categories c
  join city on true
  left join public.providers p
    on p.category_id = c.id
   and p.city_id = city.id
   and p.status = 'approved'
   and p.is_active = true
  where c.is_active = true
  group by c.slug, c.display_name, c.icon
  having count(p.id) > 0
  order by coalesce(c.sort_order, 999999) asc, c.display_name asc;
$$;

commit;
