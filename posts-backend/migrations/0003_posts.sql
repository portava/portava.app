-- ============================================================================
-- Travel Buddy — Backend migration 0003
-- Posts: standalone (global feed) OR trip-attached. Mirrors 0001 conventions
-- (enum guards, set_updated_at trigger, SECURITY DEFINER helpers, RLS).
-- Run in the Supabase SQL editor AFTER 0001_spine.sql and 0002_map_privacy.sql.
--
-- Design (per product spec):
--   trip_id NULL      -> standalone/global post
--   trip_id present   -> trip-attached post
--   visibility public / private / trip_only
--   HARD RULE: visibility=trip_only REQUIRES trip_id, and is readable ONLY by
--   accepted trip members/owner. trip_only/private posts MUST NOT leak into the
--   global feed. A nullable trip_id must never weaken trip privacy.
--
-- NOTE: RLS here is defense-in-depth. The API server (service role) is the
-- intentional write path and re-checks all of this in application code. RLS
-- guarantees that even a direct/anon/authenticated client cannot read or write
-- in violation of these rules.
-- ============================================================================

-- ---------- Enum: post_visibility ----------
-- Separate from trip_visibility on purpose (trips use 'buddies'/'invite';
-- posts use 'trip_only'). Do not reuse the trips enum.
do $$ begin
  create type post_visibility as enum ('public','trip_only','private');
exception when duplicate_object then null; end $$;

-- ---------- Enum: post_status (moderation/lifecycle) ----------
do $$ begin
  create type post_status as enum ('active','hidden','reported','deleted');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- posts
-- ============================================================================
create table if not exists posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references profiles(id) on delete cascade,
  trip_id     uuid references trips(id) on delete cascade,          -- nullable: null = standalone
  content     text not null default '',
  media_urls  text[] not null default '{}',
  visibility  post_visibility not null default 'public',
  status      post_status not null default 'active',
  -- audit fields (set by API server)
  created_by  uuid references profiles(id),
  updated_by  uuid references profiles(id),
  source      text not null default 'api_server',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  -- HARD RULE enforced at the DB level: trip_only must have a trip.
  constraint posts_trip_only_requires_trip
    check (visibility <> 'trip_only' or trip_id is not null),
  -- a post with no text must have at least one media url
  constraint posts_has_body
    check (content <> '' or array_length(media_urls, 1) >= 1)
);

drop trigger if exists trg_posts_updated on posts;
create trigger trg_posts_updated before update on posts
  for each row execute function set_updated_at();

create index if not exists idx_posts_author      on posts(author_id);
create index if not exists idx_posts_trip         on posts(trip_id);
create index if not exists idx_posts_created      on posts(created_at desc);
-- Partial index for the hot path: active public standalone feed.
create index if not exists idx_posts_global_feed
  on posts(created_at desc)
  where trip_id is null and visibility = 'public' and status = 'active';

-- ============================================================================
-- Helper: is the current user an ACCEPTED participant of this trip?
-- Only owner or member (NOT 'invited'). Used by both the read path
-- (trip_only posts) and the author path. Defined before can_see_post so the
-- dependency order is explicit.
create or replace function is_accepted_trip_member(t_id uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from trip_members m
    where m.trip_id = t_id
      and m.user_id = auth.uid()
      and m.role in ('owner','member')   -- excludes 'invited'
  );
$$;

-- Helper: is the current user allowed to AUTHOR a post into this trip?
-- Only ACCEPTED participants: owner or member. 'invited' (not yet accepted)
-- CANNOT post. Standalone posts (null trip) need no trip check.
create or replace function can_post_to_trip(t_id uuid)
returns boolean language sql security definer stable as $$
  select t_id is null or is_accepted_trip_member(t_id);
$$;

-- ============================================================================
-- Helper: can the current user READ this post?  (SECURITY DEFINER, avoids
-- RLS recursion — same pattern as can_see_trip in 0001.)
--   - author always can
--   - hidden/deleted/reported never visible to non-author
--   - public  : visible to everyone (if active)
--   - private : author only
--   - trip_only: ACCEPTED trip members/owner only (NOT 'invited' users)
-- ============================================================================
create or replace function can_see_post(p_id uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from posts p
    where p.id = p_id and (
      p.author_id = auth.uid()
      or (
        p.status = 'active' and p.deleted_at is null and (
          p.visibility = 'public'
          or (p.visibility = 'trip_only' and p.trip_id is not null and is_accepted_trip_member(p.trip_id))
        )
      )
    )
  );
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table posts enable row level security;

-- SELECT: per-post visibility via helper (covers global feed + trip feeds).
-- trip_only/private never leak because can_see_post gates them.
drop policy if exists posts_select on posts;
create policy posts_select on posts for select using (can_see_post(id));

-- INSERT: author must be the current user; if trip-attached, must be a member;
-- trip_only requires a trip (also enforced by check constraint). Even though
-- the API server uses the service role (which bypasses RLS), these policies
-- protect against any direct authenticated-client insert.
drop policy if exists posts_insert on posts;
create policy posts_insert on posts for insert to authenticated with check (
  author_id = auth.uid()
  and can_post_to_trip(trip_id)
  and (visibility <> 'trip_only' or trip_id is not null)
);

-- UPDATE: author only.
drop policy if exists posts_update on posts;
create policy posts_update on posts for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- DELETE: author only. (App prefers soft-delete via status/deleted_at, but a
-- hard delete by the author is still permitted.)
drop policy if exists posts_delete on posts;
create policy posts_delete on posts for delete to authenticated
  using (author_id = auth.uid());

-- ============================================================================
-- Done. Posts support standalone + trip-attached with privacy preserved.
-- Next: comments, likes, reports table for moderation queue.
-- ============================================================================
