-- ROLLBACK for 2337_trip_crew_rls_membership_convergence.sql
--
-- Restores the exact pre-2337 text of all twenty-nine policies and of
-- public.is_accepted_trip_member, captured from pg_policies on portava-ci AND
-- production 2026-09-07 (the two agreed byte-for-byte on every policy this file
-- touches). Idempotent: DROP POLICY IF EXISTS then CREATE, CREATE OR REPLACE for
-- the function, DROP FUNCTION IF EXISTS for the five helpers.
--
-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║  READ THIS BEFORE RUNNING IT. THIS ROLLBACK REOPENS A SECURITY HOLE.        ║
-- ╠════════════════════════════════════════════════════════════════════════════╣
-- ║                                                                            ║
-- ║  DESTRUCTIVE STEP 1 -- IT RESTORES THREE BLANKET READ POLICIES.             ║
-- ║                                                                            ║
-- ║      trip_crew_location_events.crew_events_trip_members                     ║
-- ║      plan_attendance_events.attendance_events_trip_members                  ║
-- ║      plan_checkins.trip_members_view_checkins                               ║
-- ║                                                                            ║
-- ║  each go back to `USING (auth.uid() IS NOT NULL)`. That means ANY logged-in ║
-- ║  user can again read EVERY row of those three tables for EVERY trip --      ║
-- ║  including trip_crew_location_events, the audit log of who shared their     ║
-- ║  live location with whom and when. `anon` and `authenticated` hold the full ║
-- ║  DML set on all three, so RLS is the only control on the direct-PostgREST   ║
-- ║  path. This was measured, not inferred: before 2337 a fixture STRANGER read ║
-- ║  all three rows on portava-ci.                                              ║
-- ║                                                                            ║
-- ║  DESTRUCTIVE STEP 2 -- IT RE-ADMITS PENDING INVITEES EVERYWHERE ELSE.       ║
-- ║                                                                            ║
-- ║  Every restored policy goes back to a membership test that never reads      ║
-- ║  trip_members.status, so role='member' + status='invited' -- a pending      ║
-- ║  invitee, an encoding production actually holds -- is admitted again to the ║
-- ║  crew's location preferences, live-share sessions, plan, geofences, plan    ║
-- ║  editors, reservations, activity log, availability and trip_only posts and  ║
-- ║  media, and regains WRITE access to plan items and availability rows. A     ║
-- ║  pending co_host regains read access to the trip's join requests.           ║
-- ║                                                                            ║
-- ║  DESTRUCTIVE STEP 3 -- IT NARROWS ACCESS FOR REAL CREW.                     ║
-- ║                                                                            ║
-- ║  Accepted co_hosts and viewers, and trip owners holding no trip_members row ║
-- ║  (5 of 43 trips in production), lose access again to most of the same       ║
-- ║  tables. This half is a correctness regression rather than a breach, and it ║
-- ║  will look like "the feature broke" rather than like a rollback.            ║
-- ║                                                                            ║
-- ║  ONLY RUN THIS IF 2337 ITSELF IS CAUSING A WORSE PROBLEM. Rolling back the  ║
-- ║  new helper functions alone is not possible: the restored policies do not   ║
-- ║  reference them, so the DROP FUNCTIONs at the foot are safe, but the        ║
-- ║  policies and the helpers must be rolled back together or not at all.       ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
--
-- NOT REVERSED BY THIS FILE, because 2337 did not change them:
--   highlights_select_active, crew_session_owner_select, and every policy on
--   trip_members, trip_readiness_items and trip_readiness_snapshots.
--
-- authz.is_trip_crew(uuid) is NOT dropped here: it belongs to 2334 and the
-- route-plan policies still depend on it. Dropping it would break those.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: authz.is_trip_crew(uuid) missing -- this database is not in a state 2337 was applied to.';
  END IF;
  RAISE WARNING '2337 ROLLBACK: restoring three USING (auth.uid() IS NOT NULL) blanket read policies on trip_crew_location_events, plan_attendance_events and plan_checkins. Any authenticated user will again read every row of those tables for every trip.';
END $$;

-- ── The shared helper, back to its pre-2337 body ──────────────────────────────
CREATE OR REPLACE FUNCTION public.is_accepted_trip_member(t_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  select exists (
    select 1 from trip_members m
    where m.trip_id = t_id
      and m.user_id = auth.uid()
      and m.role in ('owner','member')   -- excludes 'invited'
  );
$fn$;

COMMENT ON FUNCTION public.is_accepted_trip_member(uuid) IS NULL;

-- ── Crew location ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "crew_events_trip_members" ON public.trip_crew_location_events;
CREATE POLICY "crew_events_trip_members" ON public.trip_crew_location_events
  FOR SELECT USING (auth.uid() IS NOT NULL);      -- <<< BLANKET READ. See banner.

DROP POLICY IF EXISTS "crew_events_members_read" ON public.trip_crew_location_events;
CREATE POLICY "crew_events_members_read" ON public.trip_crew_location_events
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trips
             WHERE trips.id = trip_crew_location_events.trip_id AND trips.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.trip_members
                WHERE trip_members.trip_id = trip_crew_location_events.trip_id
                  AND trip_members.user_id = auth.uid()
                  AND trip_members.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "crew_prefs_members_read" ON public.trip_crew_location_preferences;
CREATE POLICY "crew_prefs_members_read" ON public.trip_crew_location_preferences
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trips
             WHERE trips.id = trip_crew_location_preferences.trip_id AND trips.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.trip_members
                WHERE trip_members.trip_id = trip_crew_location_preferences.trip_id
                  AND trip_members.user_id = auth.uid()
                  AND trip_members.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "crew_loc_sessions_trip_member_read" ON public.trip_crew_location_sessions;
CREATE POLICY "crew_loc_sessions_trip_member_read" ON public.trip_crew_location_sessions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trip_members
             WHERE trip_members.trip_id = trip_crew_location_sessions.trip_id
               AND trip_members.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "crew_sessions_recipients_read" ON public.trip_crew_location_sessions;
CREATE POLICY "crew_sessions_recipients_read" ON public.trip_crew_location_sessions
  FOR SELECT USING (
    status = 'active'
    AND expires_at > now()
    AND auth.uid() = ANY (allowed_member_ids)
    AND (
      EXISTS (SELECT 1 FROM public.trips
               WHERE trips.id = trip_crew_location_sessions.trip_id AND trips.owner_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.trip_members
                  WHERE trip_members.trip_id = trip_crew_location_sessions.trip_id
                    AND trip_members.user_id = auth.uid()
                    AND trip_members.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
    )
  );

-- ── Plan attendance / check-ins ───────────────────────────────────────────────
DROP POLICY IF EXISTS "attendance_events_trip_members" ON public.plan_attendance_events;
CREATE POLICY "attendance_events_trip_members" ON public.plan_attendance_events
  FOR SELECT USING (auth.uid() IS NOT NULL);      -- <<< BLANKET READ. See banner.

DROP POLICY IF EXISTS "pae_select_accepted" ON public.plan_attendance_events;
CREATE POLICY "pae_select_accepted" ON public.plan_attendance_events
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trips t
             WHERE t.id = plan_attendance_events.trip_id AND t.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.trip_members tm
                WHERE tm.trip_id = plan_attendance_events.trip_id
                  AND tm.user_id = auth.uid()
                  AND tm.role = 'member'::member_role)
  );

DROP POLICY IF EXISTS "trip_members_view_checkins" ON public.plan_checkins;
CREATE POLICY "trip_members_view_checkins" ON public.plan_checkins
  FOR SELECT USING (auth.uid() IS NOT NULL);      -- <<< BLANKET READ. See banner.

DROP POLICY IF EXISTS "chk_select_accepted" ON public.plan_checkins;
CREATE POLICY "chk_select_accepted" ON public.plan_checkins
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trips t
             WHERE t.id = plan_checkins.trip_id AND t.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.trip_members tm
                WHERE tm.trip_id = plan_checkins.trip_id
                  AND tm.user_id = auth.uid()
                  AND tm.role = 'member'::member_role)
  );

DROP POLICY IF EXISTS "plan_checkins_trip_member_read" ON public.plan_checkins;
CREATE POLICY "plan_checkins_trip_member_read" ON public.plan_checkins
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.plan_geofences pg
                 JOIN public.trip_members tm ON tm.trip_id = pg.trip_id
                WHERE pg.id = plan_checkins.plan_geofence_id
                  AND tm.user_id = auth.uid())
  );

-- ── The plan ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "plan_editors_select" ON public.plan_editors;
CREATE POLICY "plan_editors_select" ON public.plan_editors
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trip_members tm
             WHERE tm.trip_id = plan_editors.trip_id
               AND tm.user_id = auth.uid()
               AND tm.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "plan_geofences_select_accepted" ON public.plan_geofences;
CREATE POLICY "plan_geofences_select_accepted" ON public.plan_geofences
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.trips
             WHERE trips.id = plan_geofences.trip_id
               AND (trips.owner_id = auth.uid()
                    OR EXISTS (SELECT 1 FROM public.trip_members tm
                                WHERE tm.trip_id = trips.id
                                  AND tm.user_id = auth.uid()
                                  AND tm.role = 'member'::member_role)))
  );

DROP POLICY IF EXISTS "plan_geofences_insert_accepted" ON public.plan_geofences;
CREATE POLICY "plan_geofences_insert_accepted" ON public.plan_geofences
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.trips
             WHERE trips.id = plan_geofences.trip_id
               AND (trips.owner_id = auth.uid()
                    OR EXISTS (SELECT 1 FROM public.trip_members tm
                                WHERE tm.trip_id = trips.id
                                  AND tm.user_id = auth.uid()
                                  AND tm.role = 'member'::member_role)))
  );

DROP POLICY IF EXISTS "plan_geofences_update_accepted" ON public.plan_geofences;
CREATE POLICY "plan_geofences_update_accepted" ON public.plan_geofences
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.trips
             WHERE trips.id = plan_geofences.trip_id
               AND (trips.owner_id = auth.uid()
                    OR EXISTS (SELECT 1 FROM public.trip_members tm
                                WHERE tm.trip_id = trips.id
                                  AND tm.user_id = auth.uid()
                                  AND tm.role = 'member'::member_role)))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.trips
             WHERE trips.id = plan_geofences.trip_id
               AND (trips.owner_id = auth.uid()
                    OR EXISTS (SELECT 1 FROM public.trip_members tm
                                WHERE tm.trip_id = trips.id
                                  AND tm.user_id = auth.uid()
                                  AND tm.role = 'member'::member_role)))
  );

DROP POLICY IF EXISTS "plan_items_select" ON public.trip_plan_items;
CREATE POLICY "plan_items_select" ON public.trip_plan_items
  FOR SELECT USING (
    removed_at IS NULL
    AND EXISTS (SELECT 1 FROM public.trip_members tm
                 WHERE tm.trip_id = trip_plan_items.trip_id
                   AND tm.user_id = auth.uid()
                   AND tm.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "plan_items_insert" ON public.trip_plan_items;
CREATE POLICY "plan_items_insert" ON public.trip_plan_items
  FOR INSERT WITH CHECK (
    creator_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.trip_members tm
                 WHERE tm.trip_id = trip_plan_items.trip_id
                   AND tm.user_id = auth.uid()
                   AND tm.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "plan_items_update" ON public.trip_plan_items;
CREATE POLICY "plan_items_update" ON public.trip_plan_items
  FOR UPDATE USING (
    creator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.trip_members tm
                WHERE tm.trip_id = trip_plan_items.trip_id
                  AND tm.user_id = auth.uid()
                  AND tm.role = 'owner'::member_role)
  );

-- ── Trip records ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "trip_reservations_member_read" ON public.trip_reservations;
CREATE POLICY "trip_reservations_member_read" ON public.trip_reservations
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trips t
             WHERE t.id = trip_reservations.trip_id AND t.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.trip_members m
                WHERE m.trip_id = trip_reservations.trip_id
                  AND m.user_id = auth.uid()
                  AND m.role = ANY (ARRAY['owner'::member_role,'co_host'::member_role,
                                          'member'::member_role,'viewer'::member_role]))
  );

DROP POLICY IF EXISTS "trip_activity_log_select" ON public.trip_activity_log;
CREATE POLICY "trip_activity_log_select" ON public.trip_activity_log
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trip_members tm
             WHERE tm.trip_id = trip_activity_log.trip_id
               AND tm.user_id = auth.uid()
               AND tm.status = 'accepted'::text)
  );

-- ── Availability ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ta_own" ON public.trip_availability;
CREATE POLICY "ta_own" ON public.trip_availability
  FOR ALL
  USING (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.trip_members
                 WHERE trip_members.trip_id = trip_availability.trip_id
                   AND trip_members.user_id = auth.uid()
                   AND trip_members.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.trip_members
                 WHERE trip_members.trip_id = trip_availability.trip_id
                   AND trip_members.user_id = auth.uid()
                   AND trip_members.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "ta_trip_members_select" ON public.trip_availability;
CREATE POLICY "ta_trip_members_select" ON public.trip_availability
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trip_members tm1
                       JOIN public.trip_members tm2 ON tm1.trip_id = tm2.trip_id
             WHERE tm1.user_id = auth.uid()
               AND tm1.role = ANY (ARRAY['owner'::member_role,'member'::member_role])
               AND tm2.user_id = trip_availability.user_id
               AND tm2.trip_id = trip_availability.trip_id
               AND tm2.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "ua_trip_select" ON public.user_availability;
CREATE POLICY "ua_trip_select" ON public.user_availability
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.trip_members tm1
                       JOIN public.trip_members tm2 ON tm1.trip_id = tm2.trip_id
             WHERE tm1.user_id = auth.uid()
               AND tm1.role = ANY (ARRAY['owner'::member_role,'member'::member_role])
               AND tm2.user_id = user_availability.user_id
               AND tm2.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "qas_trip_select" ON public.quick_availability_status;
CREATE POLICY "qas_trip_select" ON public.quick_availability_status
  FOR SELECT USING (
    expires_at > now()
    AND EXISTS (SELECT 1 FROM public.trip_members tm1
                           JOIN public.trip_members tm2 ON tm1.trip_id = tm2.trip_id
                 WHERE tm1.user_id = auth.uid()
                   AND tm1.role = ANY (ARRAY['owner'::member_role,'member'::member_role])
                   AND tm2.user_id = quick_availability_status.user_id
                   AND tm2.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

-- ── Trip-only social content ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "posts_select_policy" ON public.posts;
CREATE POLICY "posts_select_policy" ON public.posts
  FOR SELECT TO authenticated USING (
    status = 'active'::post_status
    AND (
      visibility = 'public'::post_visibility
      OR author_id = auth.uid()
      OR (visibility = 'followers_only'::post_visibility
          AND EXISTS (SELECT 1 FROM public.user_follows uf
                       WHERE uf.follower_id = auth.uid()
                         AND uf.following_id = posts.author_id))
      OR (visibility = 'trip_only'::post_visibility
          AND trip_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.trip_members tm
                       WHERE tm.trip_id = posts.trip_id AND tm.user_id = auth.uid()))
    )
  );

DROP POLICY IF EXISTS "post_media_public_select" ON public.post_media;
CREATE POLICY "post_media_public_select" ON public.post_media
  FOR SELECT USING (
    user_id = auth.uid()
    OR (
      processing_status = 'ready'
      AND moderation_status <> ALL (ARRAY['rejected'::text,'flagged'::text])
      AND NOT EXISTS (SELECT 1 FROM public.blocks b
                       WHERE (b.blocker_id = auth.uid() AND b.blocked_id = post_media.user_id)
                          OR (b.blocker_id = post_media.user_id AND b.blocked_id = auth.uid()))
      AND EXISTS (
        SELECT 1 FROM public.posts p
         WHERE p.id = post_media.post_id
           AND p.status = 'active'::post_status
           AND (p.visibility = 'public'::post_visibility
                OR (p.visibility = 'trip_only'::post_visibility
                    AND p.trip_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM public.trip_members tm
                                 WHERE tm.trip_id = p.trip_id AND tm.user_id = auth.uid())))
      )
    )
  );

-- ── Join requests ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "trip_join_requests_select" ON public.trip_join_requests;
CREATE POLICY "trip_join_requests_select" ON public.trip_join_requests
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = trip_join_requests.trip_id AND t.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.trip_members m
                WHERE m.trip_id = trip_join_requests.trip_id
                  AND m.user_id = auth.uid()
                  AND m.role = 'co_host'::member_role)
  );

-- ── Meetups ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "meetups_trip_select" ON public.meetups;
CREATE POLICY "meetups_trip_select" ON public.meetups
  FOR SELECT USING (
    visibility = 'trip'
    AND trip_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trip_members
                 WHERE trip_members.trip_id = meetups.trip_id
                   AND trip_members.user_id = auth.uid()
                   AND trip_members.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "mi_trip_select" ON public.meetup_invites;
CREATE POLICY "mi_trip_select" ON public.meetup_invites
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.meetups m
                       JOIN public.trip_members tm ON tm.trip_id = m.trip_id
             WHERE m.id = meetup_invites.meetup_id
               AND m.visibility = 'trip'
               AND tm.user_id = auth.uid()
               AND tm.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

DROP POLICY IF EXISTS "mto_trip_select" ON public.meetup_time_options;
CREATE POLICY "mto_trip_select" ON public.meetup_time_options
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.meetups m
                       JOIN public.trip_members tm ON tm.trip_id = m.trip_id
             WHERE m.id = meetup_time_options.meetup_id
               AND m.visibility = 'trip'
               AND tm.user_id = auth.uid()
               AND tm.role = ANY (ARRAY['owner'::member_role,'member'::member_role]))
  );

-- ── The five helpers 2337 introduced ──────────────────────────────────────────
-- Safe to drop only AFTER every policy above has been restored: nothing left in
-- the database references them at this point. authz.is_trip_crew(uuid) is
-- 2334's and stays.
DROP FUNCTION IF EXISTS authz.geofence_trip_id(uuid);
DROP FUNCTION IF EXISTS authz.accepted_trip_role(uuid);
DROP FUNCTION IF EXISTS authz.shares_accepted_trip(uuid);
DROP FUNCTION IF EXISTS authz.is_accepted_trip_member(uuid, uuid);
DROP FUNCTION IF EXISTS authz.accepted_trip_ids(uuid);

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (   coalesce(qual,'') || coalesce(with_check,'') LIKE '%authz.accepted_trip%'
         OR coalesce(qual,'') || coalesce(with_check,'') LIKE '%authz.shares_accepted_trip%'
         OR coalesce(qual,'') || coalesce(with_check,'') LIKE '%authz.geofence_trip_id%' );
  IF n <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % policies still reference a 2337 helper', n;
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'authz'
         AND p.proname IN ('accepted_trip_ids','is_accepted_trip_member',
                           'shares_accepted_trip','accepted_trip_role','geofence_trip_id')) <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: a 2337 helper survived the DROP.';
  END IF;

  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: authz.is_trip_crew(uuid) was destroyed -- 2334 is broken.';
  END IF;

  RAISE WARNING '2337 ROLLBACK COMPLETE. Three blanket auth.uid() IS NOT NULL read policies are live again on trip_crew_location_events, plan_attendance_events and plan_checkins, and pending invitees are re-admitted to every table this file touched.';
END $$;

COMMIT;
