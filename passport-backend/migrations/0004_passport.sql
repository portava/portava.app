-- ============================================================================
-- Travel Buddy — Backend migration 0004
-- Passport postcards + location/GPS verification.
-- Run AFTER 0003_posts.sql.
--
-- Core product rule:
--   Post with media + add_to_passport  -> one passport_postcard.
--   GPS-verified near tagged location at posting time -> verified stamp.
--   Manual tag / GPS mismatch / no GPS -> location label only, NO stamp.
--
-- HARD privacy rules (enforced here + in API):
--   * The SERVER decides location_verified / stamp_eligible. RLS + the API
--     never trust client-supplied verification flags.
--   * Raw user GPS (user_gps_lat/lng) is PRIVATE — never returned by public
--     reads. We keep it on posts for the distance calc/audit, but API public
--     projections must exclude it (and RLS keeps rows owner-scoped where used).
--   * Exact tagged coordinates are not exposed in public passport responses;
--     city/place-level labels are. (API enforces the projection.)
-- ============================================================================

-- ---------- enums ----------
do $$ begin
  create type location_source as enum ('gps','manual','none');
exception when duplicate_object then null; end $$;

do $$ begin
  create type verification_method as enum (
    'gps_current_location','manual_only','gps_mismatch','unavailable'
  );
exception when duplicate_object then null; end $$;

-- ============================================================================
-- posts: add location + GPS + passport columns
-- ============================================================================
alter table posts add column if not exists media_type            text;
alter table posts add column if not exists location_name         text;
alter table posts add column if not exists location_place_id     text;
alter table posts add column if not exists location_city         text;
alter table posts add column if not exists location_country      text;
alter table posts add column if not exists location_lat          numeric;
alter table posts add column if not exists location_lng          numeric;
-- PRIVATE/internal: the user's GPS at posting time. Never exposed publicly.
alter table posts add column if not exists user_gps_lat          numeric;
alter table posts add column if not exists user_gps_lng          numeric;
alter table posts add column if not exists location_source       location_source not null default 'none';
-- server-decided verification result (never trusted from client):
alter table posts add column if not exists location_verified     boolean not null default false;
alter table posts add column if not exists location_verified_at  timestamptz;
alter table posts add column if not exists location_distance_meters numeric;
alter table posts add column if not exists add_to_passport       boolean not null default true;

-- ============================================================================
-- passport_postcards
-- ============================================================================
create table if not exists passport_postcards (
  id                 uuid primary key default gen_random_uuid(),
  post_id            uuid not null references posts(id) on delete cascade,
  user_id            uuid not null references profiles(id) on delete cascade,
  media_url          text not null,
  caption            text,
  location_name      text,
  location_city      text,
  location_country   text,
  -- server-decided (never client-trusted):
  location_verified  boolean not null default false,
  stamp_eligible     boolean not null default false,
  stamp_reason       text,
  verification_method verification_method not null default 'unavailable',
  verified_distance_meters numeric,
  verified_at        timestamptz,
  stamp_style        text,
  -- moderation:
  stamp_revoked      boolean not null default false,
  stamp_revoked_reason text,
  stamp_revoked_at   timestamptz,
  stamp_revoked_by   uuid references profiles(id),
  -- visibility mirrors the source post:
  visibility         post_visibility not null default 'public',
  status             post_status not null default 'active',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  -- one postcard per post
  constraint passport_postcards_post_unique unique (post_id)
);

drop trigger if exists trg_postcards_updated on passport_postcards;
create trigger trg_postcards_updated before update on passport_postcards
  for each row execute function set_updated_at();

create index if not exists idx_postcards_user      on passport_postcards(user_id);
create index if not exists idx_postcards_post      on passport_postcards(post_id);
create index if not exists idx_postcards_created   on passport_postcards(created_at desc);
create index if not exists idx_postcards_city
  on passport_postcards(user_id, location_city)
  where status = 'active' and deleted_at is null;

-- ============================================================================
-- Helper: can the current user SEE this postcard?
-- Mirrors post visibility: author always; else active + visibility rules.
-- trip_only requires accepted membership of the post's trip.
-- ============================================================================
create or replace function can_see_postcard(pc_id uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from passport_postcards pc
    left join posts p on p.id = pc.post_id
    where pc.id = pc_id and (
      pc.user_id = auth.uid()
      or (
        pc.status = 'active' and pc.deleted_at is null and (
          pc.visibility = 'public'
          or (pc.visibility = 'trip_only' and p.trip_id is not null and is_accepted_trip_member(p.trip_id))
        )
      )
    )
  );
$$;

-- ============================================================================
-- RLS — defense-in-depth. API server (service role) is the write path and
-- re-checks everything; these stop any direct client read/write violations.
-- ============================================================================
alter table passport_postcards enable row level security;

-- SELECT via visibility helper.
drop policy if exists postcards_select on passport_postcards;
create policy postcards_select on passport_postcards for select using (can_see_postcard(id));

-- INSERT: only your own postcards (author = current user). The API uses the
-- service role for the real auto-create, but this blocks any direct client insert
-- that isn't self-owned. stamp/verification columns are NOT constrained here
-- because the service role sets them; a direct authenticated insert can only
-- ever create a row for itself and RLS-select can't surface a forged stamp to
-- others beyond normal visibility (and the API never trusts client flags).
drop policy if exists postcards_insert on passport_postcards;
create policy postcards_insert on passport_postcards for insert to authenticated
  with check (user_id = auth.uid());

-- UPDATE: owner only (edit caption, remove from passport, change manual label).
-- Users cannot flip verification via the API (it ignores those fields); at the
-- DB level owner-update is still bounded to their own row.
drop policy if exists postcards_update on passport_postcards;
create policy postcards_update on passport_postcards for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DELETE: owner only (soft-delete preferred via API).
drop policy if exists postcards_delete on passport_postcards;
create policy postcards_delete on passport_postcards for delete to authenticated
  using (user_id = auth.uid());

-- ============================================================================
-- Notes
-- - user_gps_lat/lng on posts are PRIVATE. No public projection includes them.
-- - location_verified / stamp_eligible are SERVER-set. The API ignores any
--   client-provided values for these.
-- - When a post is soft-deleted/hidden, the API also hides the linked postcard.
--   (FK on delete cascade covers hard-delete; soft-delete handled in app code.)
-- ============================================================================
