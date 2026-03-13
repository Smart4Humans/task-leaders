-- TaskLeaders MVP (Phase 1) — Profile read-layer foundation
-- Adds minimal columns needed to populate public profile page without redesign.

begin;

alter table public.providers
  add column if not exists about_text text,
  add column if not exists service_areas text[] not null default '{}',
  add column if not exists hero_photo_url text;

commit;
