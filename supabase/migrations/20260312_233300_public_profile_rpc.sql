-- TaskLeaders MVP (Phase 1) — Read RPC for Public Profile
-- Provides a stable read model for a provider profile in a given city.

begin;

create or replace function public.get_public_profile(
  p_city_slug text default 'vancouver',
  p_provider_slug text default null
)
returns table (
  provider_slug text,
  display_name text,

  city_slug text,
  city_name text,

  category_slug text,
  category_name text,
  category_icon text,

  response_time_minutes integer,
  reliability_percent integer,
  hourly_rate_cents integer,
  currency text,

  whatsapp_e164 text,

  about_text text,
  service_areas text[],
  hero_photo_url text
)
language sql
stable
as $$
  with
    city as (
      select id, slug, name
      from public.cities
      where slug = coalesce(p_city_slug, 'vancouver')
        and is_active = true
      limit 1
    )
  select
    p.provider_slug,
    p.display_name,

    city.slug as city_slug,
    city.name as city_name,

    c.slug as category_slug,
    c.display_name as category_name,
    c.icon as category_icon,

    p.response_time_minutes,
    p.reliability_percent,
    p.hourly_rate_cents,
    p.currency,

    p.whatsapp_e164,

    p.about_text,
    p.service_areas,
    p.hero_photo_url
  from public.providers p
  join city on p.city_id = city.id
  join public.categories c on c.id = p.category_id
  where p.provider_slug = p_provider_slug
    and p.status = 'approved'
    and p.is_active = true
    and c.is_active = true;
$$;

commit;
