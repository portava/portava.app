-- ============================================================================
-- Travel Buddy — Backend migration 0006
-- Follow graph (standalone). Phase 1 of relationships.
--
-- HARD RULES (enforced here + in API):
--   * Follow is PUBLIC SOCIAL DISCOVERY ONLY.
--   * A follow grants NOTHING sensitive: no private posts, no trip_only posts,
--     no live location, no circle membership, no trip access.
--   * This table is completely separate from circle_memberships and trip_members.
--     Nothing here writes to those tables.
--   * A user can only create/delete their OWN follow rows (as the follower).
--   * No self-follow. No duplicates.
-- ============================================================================

create table if not exists user_follows (
  follower_id   uuid not null references profiles(id) on delete cascade,
  following_id  uuid not null references profiles(id) on delete cascade,
  created_at    timestamptz not null default now(),

  primary key (follower_id, following_id),       -- blocks duplicate follows
  constraint no_self_follow check (follower_id <> following_id)
);

create index if not exists idx_follows_follower  on user_follows(follower_id);
create index if not exists idx_follows_following on user_follows(following_id);

-- ============================================================================
-- RLS — defense-in-depth. The API server (service role) is the write path and
-- re-checks everything; these stop any direct client violation.
-- ============================================================================
alter table user_follows enable row level security;

-- SELECT: follow edges are public social info (who follows whom / counts).
-- This exposes ONLY the follow edge, never any private content.
drop policy if exists follows_select on user_follows;
create policy follows_select on user_follows for select using (true);

-- INSERT: a user may only create a row where THEY are the follower.
-- (No self-follow is also enforced by the check constraint.)
drop policy if exists follows_insert on user_follows;
create policy follows_insert on user_follows for insert to authenticated
  with check (follower_id = auth.uid() and follower_id <> following_id);

-- DELETE: a user may only delete their OWN follow (unfollow).
drop policy if exists follows_delete on user_follows;
create policy follows_delete on user_follows for delete to authenticated
  using (follower_id = auth.uid());

-- No UPDATE policy: follow rows are immutable (follow or unfollow only).

-- ============================================================================
-- Notes
-- - Counts: select count(*) from user_follows where following_id = X  (followers)
--           select count(*) from user_follows where follower_id  = X  (following)
-- - This migration does NOT touch circle_memberships, trip_members, posts, or
--   any location table. A follow is purely a social edge.
-- - Blocking: when a block model exists later, add a guard here/in the API so a
--   blocked user cannot follow. (No block table yet; API leaves a hook.)
-- ============================================================================
