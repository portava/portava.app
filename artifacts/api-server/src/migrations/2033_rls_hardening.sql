-- Migration 2033: RLS Hardening Pass
-- Strengthens weak SELECT policies and adds missing ones across profile,
-- social-graph, content, and event/trip tables.
-- All statements are idempotent (DROP … IF EXISTS guards + DO blocks for
-- tables that may not exist in every environment).
--
-- Live-schema verified 2026-07-26:
--   highlights      → owner_id, deleted_at, expires_at, visibility (no trip_id)
--   highlight_replies → replier_id (no deleted_at, no user_id)
--   highlight_likes → user_id
--   posts_comments  → user_id, deleted_at
--   posts_likes     → user_id
--   user_friendships → user_a, user_b (if in public schema)
--   user_follows     → follower_id, following_id (if in public schema)

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Block visibility helper
-- ─────────────────────────────────────────────────────────────────────────────
-- is_blocked(a, b) already defined in 0015_blocks.sql.
-- viewer_is_blocked(target) wraps it for use inside RLS USING clauses
-- where auth.uid() is the implicit "me" side.

CREATE OR REPLACE FUNCTION viewer_is_blocked(target_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM blocks
    WHERE (blocker_id = auth.uid() AND blocked_id = target_id)
       OR (blocker_id = target_id AND blocked_id = auth.uid())
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. profiles — strengthen SELECT policy
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine policy allowed: own row OR is_private=false OR shares_trip_with().
-- Hardened: public rows require no block; add approved-friendship path.

DROP POLICY IF EXISTS profiles_select ON profiles;
CREATE POLICY profiles_select ON profiles FOR SELECT USING (
  id = auth.uid()
  OR (is_private = false AND NOT viewer_is_blocked(id))
  OR (
    NOT viewer_is_blocked(id)
    AND EXISTS (
      SELECT 1 FROM user_friendships
       WHERE (user_a = auth.uid() AND user_b = id)
          OR (user_b = auth.uid() AND user_a = id)
    )
  )
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. user_follows — enable RLS + own-row policies
-- ─────────────────────────────────────────────────────────────────────────────
-- Wrapped in a DO block so it degrades gracefully if the table is in a
-- non-public schema or has not been created yet.

DO $$ BEGIN
  ALTER TABLE user_follows ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "user_follows_own_read" ON user_follows;
  CREATE POLICY "user_follows_own_read" ON user_follows
    FOR SELECT TO authenticated USING (
      follower_id = auth.uid() OR following_id = auth.uid()
    );

  DROP POLICY IF EXISTS "user_follows_own_write" ON user_follows;
  CREATE POLICY "user_follows_own_write" ON user_follows
    FOR ALL TO authenticated
    USING (follower_id = auth.uid())
    WITH CHECK (follower_id = auth.uid());

  DROP POLICY IF EXISTS "user_follows_service_all" ON user_follows;
  CREATE POLICY "user_follows_service_all" ON user_follows
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. user_friendships — enable RLS + own-row policies
-- ─────────────────────────────────────────────────────────────────────────────
-- Symmetric pair table; user_a < user_b by convention.

DO $$ BEGIN
  ALTER TABLE user_friendships ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "user_friendships_own_read" ON user_friendships;
  CREATE POLICY "user_friendships_own_read" ON user_friendships
    FOR SELECT TO authenticated USING (
      user_a = auth.uid() OR user_b = auth.uid()
    );

  DROP POLICY IF EXISTS "user_friendships_service_all" ON user_friendships;
  CREATE POLICY "user_friendships_service_all" ON user_friendships
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. posts_likes — tighten from USING(true) → block-aware
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_view_post_likes" ON posts_likes;
CREATE POLICY "users_view_post_likes" ON posts_likes
  FOR SELECT TO authenticated USING (
    NOT viewer_is_blocked(user_id)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. posts_comments — add block guard (deleted_at check retained)
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_view_post_comments" ON posts_comments;
CREATE POLICY "users_view_post_comments" ON posts_comments
  FOR SELECT TO authenticated USING (
    deleted_at IS NULL
    AND NOT viewer_is_blocked(user_id)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. highlights — enforce visibility + block check
-- ─────────────────────────────────────────────────────────────────────────────
-- Live columns: owner_id, deleted_at, expires_at, visibility.
-- No trip_id in live schema → trip_only branch omitted.

DROP POLICY IF EXISTS "highlights_select" ON highlights;
CREATE POLICY "highlights_select" ON highlights FOR SELECT USING (
  deleted_at IS NULL
  AND expires_at > now()
  AND (
    owner_id = auth.uid()
    OR (
      NOT viewer_is_blocked(owner_id)
      AND (
        visibility IN ('public', 'travelers_nearby')
        OR (
          visibility = 'circle_only'
          AND (
            in_accepted_circle(auth.uid(), owner_id)
            OR EXISTS (
              SELECT 1 FROM user_friendships
               WHERE (user_a = auth.uid() AND user_b = owner_id)
                  OR (user_b = auth.uid() AND user_a = owner_id)
            )
          )
        )
      )
    )
  )
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. highlight_likes — tighten from USING(true) → block-aware
-- ─────────────────────────────────────────────────────────────────────────────
-- Live column: user_id.

DROP POLICY IF EXISTS "users_view_highlight_likes" ON highlight_likes;
CREATE POLICY "users_view_highlight_likes" ON highlight_likes
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR NOT viewer_is_blocked(user_id)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. highlight_replies — tighten: add block check
-- ─────────────────────────────────────────────────────────────────────────────
-- Live column: replier_id. No deleted_at in live schema.

DROP POLICY IF EXISTS "users_view_highlight_replies" ON highlight_replies;
CREATE POLICY "users_view_highlight_replies" ON highlight_replies
  FOR SELECT TO authenticated USING (
    NOT viewer_is_blocked(replier_id)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. user_account_states — add own-row SELECT (previously had no user policy)
-- ─────────────────────────────────────────────────────────────────────────────
-- Column name probed dynamically (live may differ from migration file).

DO $$
DECLARE user_col text;
BEGIN
  SELECT column_name INTO user_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'user_account_states'
     AND column_name IN ('user_id', 'target_user_id', 'profile_id')
   LIMIT 1;

  IF user_col IS NOT NULL THEN
    DROP POLICY IF EXISTS "account_states_own_read" ON user_account_states;
    EXECUTE format(
      'CREATE POLICY "account_states_own_read" ON user_account_states
         FOR SELECT TO authenticated USING (%I = auth.uid())',
      user_col
    );
  END IF;

  DROP POLICY IF EXISTS "account_states_service_all" ON user_account_states;
  CREATE POLICY "account_states_service_all" ON user_account_states
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. moderation_actions — explicit service_role-only guard
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  DROP POLICY IF EXISTS "moderation_actions_service_all" ON moderation_actions;
  CREATE POLICY "moderation_actions_service_all" ON moderation_actions
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. events — full recursive-policy elimination for the entire event graph
-- ─────────────────────────────────────────────────────────────────────────────
-- Every event sub-table policy that joins across events/event_roles/event_cohosts
-- creates mutual recursion (42P17). We break ALL cycles with SECURITY DEFINER
-- helper functions that bypass RLS on their target table, then replace every
-- affected policy to call helpers instead of doing bare table joins.

-- ── Helper functions ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION auth_uid_is_event_host(eid uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM events WHERE id = eid AND host_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION auth_uid_has_event_role(eid uuid, roles event_role_type[])
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM event_roles
    WHERE event_id = eid AND user_id = auth.uid() AND role = ANY(roles)
  );
$$;

CREATE OR REPLACE FUNCTION auth_uid_is_event_cohost(eid uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM event_cohosts WHERE event_id = eid AND user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION auth_uid_has_event_rsvp(eid uuid, statuses event_rsvp_status[])
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM event_rsvps
    WHERE event_id = eid AND user_id = auth.uid() AND status = ANY(statuses)
  );
$$;

CREATE OR REPLACE FUNCTION event_is_in_state(eid uuid, states event_state[])
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM events WHERE id = eid AND state = ANY(states));
$$;

-- Keep the earlier participant helper for backwards compatibility.
CREATE OR REPLACE FUNCTION user_is_event_participant(eid uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT
    EXISTS (SELECT 1 FROM event_rsvps WHERE event_id = eid AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM event_roles WHERE event_id = eid AND user_id = auth.uid());
$$;

-- ── events ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "events_public_read" ON events;
CREATE POLICY "events_public_read" ON events
  FOR SELECT USING (
    visibility = 'public'
    AND state IN ('open', 'full', 'waitlist', 'started', 'completed')
    AND NOT viewer_is_blocked(host_id)
  );

DROP POLICY IF EXISTS "events_participant_read" ON events;
CREATE POLICY "events_participant_read" ON events
  FOR SELECT TO authenticated USING (
    host_id = auth.uid() OR user_is_event_participant(id)
  );

DROP POLICY IF EXISTS "events_host_read" ON events;
CREATE POLICY "events_host_read" ON events
  FOR SELECT TO authenticated USING (
    host_id = auth.uid()
    OR auth_uid_has_event_role(id, ARRAY['host'::event_role_type, 'co_host'::event_role_type])
  );

-- ── event_roles ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_roles_host_read" ON event_roles;
CREATE POLICY "event_roles_host_read" ON event_roles
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_role(event_id, ARRAY['host'::event_role_type, 'co_host'::event_role_type])
  );

-- ── event_attendees ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_attendees_participant_read" ON event_attendees;
CREATE POLICY "event_attendees_participant_read" ON event_attendees
  FOR SELECT USING (
    user_id = auth.uid()
    OR auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_role(event_id,
         ARRAY['host'::event_role_type,'co_host'::event_role_type,'moderator'::event_role_type])
  );

-- ── event_attendee_states ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_attendee_states_host_read" ON event_attendee_states;
CREATE POLICY "event_attendee_states_host_read" ON event_attendee_states
  FOR SELECT TO authenticated USING (
    auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_role(event_id,
         ARRAY['host'::event_role_type,'co_host'::event_role_type,'moderator'::event_role_type])
  );

-- ── event_activity_log ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_activity_host_read" ON event_activity_log;
CREATE POLICY "event_activity_host_read" ON event_activity_log
  FOR SELECT USING (
    auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_role(event_id,
         ARRAY['host'::event_role_type,'co_host'::event_role_type,'moderator'::event_role_type])
  );

-- ── event_cohosts ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_cohosts_read" ON event_cohosts;
CREATE POLICY "event_cohosts_read" ON event_cohosts
  FOR SELECT USING (
    user_id = auth.uid()
    OR auth_uid_is_event_host(event_id)
    OR auth_uid_is_event_cohost(event_id)
  );

-- ── event_invites ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_invites_participant_read" ON event_invites;
CREATE POLICY "event_invites_participant_read" ON event_invites
  FOR SELECT USING (
    invitee_id = auth.uid()
    OR inviter_id = auth.uid()
    OR auth_uid_is_event_host(event_id)
  );

-- ── event_join_requests ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_join_requests_host_read" ON event_join_requests;
CREATE POLICY "event_join_requests_host_read" ON event_join_requests
  FOR SELECT TO authenticated USING (
    auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_role(event_id,
         ARRAY['host'::event_role_type,'co_host'::event_role_type,'moderator'::event_role_type])
  );

-- ── event_media ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_media_participant_read" ON event_media;
CREATE POLICY "event_media_participant_read" ON event_media
  FOR SELECT USING (
    uploader_id = auth.uid()
    OR auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_rsvp(event_id,
         ARRAY['going'::event_rsvp_status,'maybe'::event_rsvp_status])
    OR auth_uid_is_event_cohost(event_id)
  );

-- ── event_posts ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_posts_participant_read" ON event_posts;
CREATE POLICY "event_posts_participant_read" ON event_posts
  FOR SELECT USING (
    author_id = auth.uid()
    OR auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_rsvp(event_id,
         ARRAY['going'::event_rsvp_status,'maybe'::event_rsvp_status])
    OR auth_uid_is_event_cohost(event_id)
  );

-- ── event_rsvps ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_rsvps_host_read" ON event_rsvps;
CREATE POLICY "event_rsvps_host_read" ON event_rsvps
  FOR SELECT TO authenticated USING (
    auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_role(event_id,
         ARRAY['host'::event_role_type,'co_host'::event_role_type,'moderator'::event_role_type])
  );

-- ── event_updates ─────────────────────────────────────────────────────────────
-- event_updates are host announcements to attendees.
-- A state-only check is too permissive: it would expose private-event updates
-- to any authenticated user. Require actual participation.

DROP POLICY IF EXISTS "event_updates_public_read"      ON event_updates;
DROP POLICY IF EXISTS "event_updates_participant_read" ON event_updates;
CREATE POLICY "event_updates_participant_read" ON event_updates
  FOR SELECT TO authenticated USING (
    auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_role(event_id,
         ARRAY['host'::event_role_type,'co_host'::event_role_type,'moderator'::event_role_type])
    OR auth_uid_is_event_cohost(event_id)
    OR auth_uid_has_event_rsvp(event_id,
         ARRAY['going'::event_rsvp_status,'maybe'::event_rsvp_status,'interested'::event_rsvp_status])
  );

-- ── event_waitlist ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "event_waitlist_host_read" ON event_waitlist;
CREATE POLICY "event_waitlist_host_read" ON event_waitlist
  FOR SELECT TO authenticated USING (
    auth_uid_is_event_host(event_id)
    OR auth_uid_has_event_role(event_id,
         ARRAY['host'::event_role_type,'co_host'::event_role_type,'moderator'::event_role_type])
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. can_see_trip() — add block guard against the trip owner
-- ─────────────────────────────────────────────────────────────────────────────
-- Public trips respect block relationships.
-- Accepted members retain access regardless (they opted in via invitation).

CREATE OR REPLACE FUNCTION can_see_trip(t_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM trips t WHERE t.id = t_id AND (
      -- Owner always sees their own trip
      t.owner_id = auth.uid()
      -- Accepted members: owner, member, co_host, viewer.
      -- 'invited' role = pending invitation → does NOT grant visibility.
      OR EXISTS (
        SELECT 1 FROM trip_members m
         WHERE m.trip_id = t.id
           AND m.user_id  = auth.uid()
           AND m.role = ANY (
             ARRAY['owner'::member_role, 'member'::member_role,
                   'co_host'::member_role, 'viewer'::member_role]
           )
      )
      -- Public trip: visible unless there is a block relationship with the owner
      OR (
        t.visibility = 'public'
        AND NOT viewer_is_blocked(t.owner_id)
      )
    )
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. saved-content tables — owner-only SELECT
-- ─────────────────────────────────────────────────────────────────────────────

-- post_saves
DO $$ BEGIN
  DROP POLICY IF EXISTS "post_saves_own_select" ON post_saves;
  CREATE POLICY "post_saves_own_select" ON post_saves
    FOR SELECT TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- saved_places
DO $$ BEGIN
  DROP POLICY IF EXISTS "saved_places_own_select" ON saved_places;
  CREATE POLICY "saved_places_own_select" ON saved_places
    FOR SELECT TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- user_saves (profile/content bookmarks)
DO $$ BEGIN
  DROP POLICY IF EXISTS "user_saves_own_select" ON user_saves;
  CREATE POLICY "user_saves_own_select" ON user_saves
    FOR SELECT TO authenticated USING (saver_id = auth.uid());
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13b. Drop weak conflicting SELECT policies
-- ─────────────────────────────────────────────────────────────────────────────
-- PostgreSQL combines multiple SELECT policies with OR semantics, meaning a
-- permissive leftover policy completely nullifies a more restrictive one.
-- These pre-existing policies were created by earlier migrations and must be
-- dropped so the hardened policies above take full effect.

-- "profiles_hide_blocked" allowed any non-blocked user to see ANY profile,
-- ignoring is_private. The new profiles_select already handles block exclusion.
DROP POLICY IF EXISTS "profiles_hide_blocked" ON profiles;

-- "hlikes_select_all" is USING(true) — completely overrides the block check.
DROP POLICY IF EXISTS "hlikes_select_all" ON highlight_likes;

-- "posts_likes_select" is USING(true) — overrides the block check.
DROP POLICY IF EXISTS "posts_likes_select" ON posts_likes;

-- "posts_comments_select" is USING(deleted_at IS NULL) — no block gate,
-- so OR with the stronger policy still allows blocked users to read comments.
DROP POLICY IF EXISTS "posts_comments_select" ON posts_comments;

-- For highlight_replies, our new users_view_highlight_replies was too permissive
-- (NOT viewer_is_blocked only — no content gate). Drop it and strengthen the
-- existing hreplies_select with a block guard.
DROP POLICY IF EXISTS "users_view_highlight_replies" ON highlight_replies;
DROP POLICY IF EXISTS "hreplies_select" ON highlight_replies;
CREATE POLICY "hreplies_select" ON highlight_replies
  FOR SELECT USING (
    NOT viewer_is_blocked(replier_id)
    AND (
      replier_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM highlights h
         WHERE h.id = highlight_replies.highlight_id
           AND h.owner_id = auth.uid()
      )
    )
  );

-- "follows_select" is USING(true) — makes user_follows globally readable
-- (anon + all authenticated users), overriding both user_follows_own_read
-- and user_follows_hide_blocked. Must be dropped first.
DROP POLICY IF EXISTS "follows_select"            ON user_follows;
-- "user_follows_hide_blocked" still allows any authenticated user to enumerate
-- the full follow graph (not just their own rows) as long as no block exists.
-- Too permissive: own-row-only is the correct bound.
DROP POLICY IF EXISTS "user_follows_hide_blocked" ON user_follows;

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. Trip sub-tables — service_role blanket policies
-- ─────────────────────────────────────────────────────────────────────────────
-- trip_members and trips already have user-facing RLS from the spine.
-- Add explicit service_role policies so background workers can manage them.

DO $$ BEGIN
  DROP POLICY IF EXISTS "trip_members_service_all" ON trip_members;
  CREATE POLICY "trip_members_service_all" ON trip_members
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
EXCEPTION WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "trips_service_all" ON trips;
  CREATE POLICY "trips_service_all" ON trips
    FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
EXCEPTION WHEN undefined_table THEN NULL; END $$;
