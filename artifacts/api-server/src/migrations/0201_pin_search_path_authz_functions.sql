-- Migration 0201: pin search_path on the SECURITY DEFINER authorization functions
--
-- THE HAZARD, DEMONSTRATED RATHER THAN ASSERTED
-- ---------------------------------------------
-- A SECURITY DEFINER function runs with the DEFINER's privileges but, unless it
-- pins one, with the CALLER's search_path. Every function below reads its tables
-- unqualified. So a caller who can CREATE a schema can put a shadowing table in
-- it, put that schema first in search_path, and make the function read THEIR
-- table while still executing as the definer.
--
-- This was not taken on faith. scripts/verify-search-path-hazard.mjs builds the
-- attack — creates a schema, adds a shadowing table holding a row that flips the
-- answer, sets search_path to prefer it, calls the function — and BEFORE this
-- migration it reported, against the live database:
--
--   ✘  is_blocked:         HAZARD OPEN — function resolved to the SHADOW table
--   ✘  in_accepted_circle: HAZARD OPEN — function resolved to the SHADOW table
--   ✘  can_see_post:       HAZARD OPEN — function resolved to the SHADOW table
--   ✘  can_see_trip:       HAZARD OPEN — function resolved to the SHADOW table
--
-- can_see_post and can_see_trip are live RLS predicates. Returning true for a
-- row that exists only in the caller's own schema is a read-authorization
-- bypass, not a tidiness issue.
--
-- WHY ALTER AND NOT CREATE OR REPLACE
-- -----------------------------------
-- CREATE OR REPLACE would require restating every body, and any transcription
-- slip would silently rewrite an authorization predicate. ALTER FUNCTION ... SET
-- touches only proconfig and cannot alter behaviour beyond name resolution.
-- Migration 0200 exists precisely to stop bodies drifting from live; this file
-- does not reopen that risk.
--
-- WHY 'public', 'pg_catalog'
-- --------------------------
-- Matches the existing precedent in this schema: enforce_is_official_privileged,
-- enforce_profile_role_privileged and admin_set_profile_role already use
-- SET search_path TO 'public', 'pg_catalog'. This is not a new pattern.
--
-- BEHAVIOUR-NEUTRALITY — CHECKED PER FUNCTION, NOT IN BULK
-- --------------------------------------------------------
-- Every body below was read from live and inspected individually. All of them
-- resolve exclusively against public (application tables, and the enum types
-- member_role / event_role_type / event_rsvp_status / event_state, all of which
-- are in public) plus pg_catalog builtins (now(), make_interval(), EXISTS, the
-- comparison operators). auth.uid() is written schema-qualified everywhere, so
-- pinning does not affect it. None of them touch a temp table, and none touch an
-- object in the extensions schema — pgcrypto, uuid-ossp and pg_stat_statements
-- live there, but no body calls into them. PostGIS and unaccent are installed in
-- public, so even a body that used them would still resolve under this pin.
-- Nothing here changes behaviour for a caller whose search_path already included
-- public, which is every legitimate caller.
--
-- SCOPE — 16 OF THE 23 UNPINNED
-- -----------------------------
-- A live sweep found 45 SECURITY DEFINER functions in public, 22 already pinned
-- and 23 not. This migration pins the 16 that are authorization: the RLS
-- predicates, the helpers they call, and the event-permission family. The other
-- 7 are left alone deliberately and inventoried at the bottom of this file.

BEGIN;

-- called by can_post_to_trip / can_see_post / can_see_postcard
ALTER FUNCTION public.is_accepted_trip_member(t_id uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: posts
ALTER FUNCTION public.can_post_to_trip(t_id uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: posts
ALTER FUNCTION public.can_see_post(p_id uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: passport_postcards
ALTER FUNCTION public.can_see_postcard(pc_id uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: trips + 9 trip child tables
ALTER FUNCTION public.can_see_trip(t_id uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: user_locations
ALTER FUNCTION public.can_see_location(viewer uuid, target uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: profiles, events, highlights, posts_comments, posts_likes, +
ALTER FUNCTION public.viewer_is_blocked(target_id uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: profiles, events, messages, highlights, posts_comments, posts_likes, +
ALTER FUNCTION public.is_blocked(a uuid, b uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: highlights; also called by can_see_location
ALTER FUNCTION public.in_accepted_circle(viewer uuid, target uuid) SET search_path TO 'public', 'pg_catalog';

-- authorization helper
ALTER FUNCTION public.shares_trip_with(other uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: 12 event tables
ALTER FUNCTION public.auth_uid_is_event_host(eid uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: 9 event tables
ALTER FUNCTION public.auth_uid_has_event_role(eid uuid, roles event_role_type[]) SET search_path TO 'public', 'pg_catalog';

-- RLS: event_media, event_posts, event_updates
ALTER FUNCTION public.auth_uid_has_event_rsvp(eid uuid, statuses event_rsvp_status[]) SET search_path TO 'public', 'pg_catalog';

-- RLS: event_cohosts, event_media, event_posts, event_updates
ALTER FUNCTION public.auth_uid_is_event_cohost(eid uuid) SET search_path TO 'public', 'pg_catalog';

-- RLS: events
ALTER FUNCTION public.user_is_event_participant(eid uuid) SET search_path TO 'public', 'pg_catalog';

-- event-state predicate (same family as the above)
ALTER FUNCTION public.event_is_in_state(eid uuid, states event_state[]) SET search_path TO 'public', 'pg_catalog';

COMMIT;


-- ─────────────────────────────────────────────────────────────────────────────
-- NOT PINNED BY THIS MIGRATION — the remaining 7 unpinned SECURITY DEFINER
-- functions. Recorded so the decision is auditable rather than implied.
--
-- These are NOT authorization functions, which is the scope of this migration.
-- They are, however, the same hazard class, and two of them are arguably higher
-- risk than the read-only predicates above because they WRITE:
--
--   add_owner_as_member()          trigger on trips; INSERTs into trip_members.
--                                  A shadowed trip_members would misdirect the
--                                  write. RECOMMENDED as the next one to pin.
--   handle_new_user()              trigger on auth.users; INSERTs into profiles.
--                                  A shadowed profiles would misdirect signup
--                                  row creation. RECOMMENDED likewise.
--   increment_distribution_stats() writes content_distribution_stats.
--   increment_hashtag_usage_count() writes hashtags.
--   upsert_hashtag_usage_and_increment() writes hashtag_usage + hashtags.
--   purge_old_ranking_debug_samples() deletes from ranking_debug_samples.
--   enforce_is_official_service_role() superseded by
--                                  enforce_is_official_privileged (migration
--                                  2079) and bound to no trigger — dead code.
--                                  Pinning it would harden something nothing
--                                  calls; dropping it is the better cleanup and
--                                  belongs in its own migration.
--
-- Pinning the writers is a straightforward follow-up and should be done. It is
-- excluded here only to keep this migration to one reviewable claim:
-- authorization predicates resolve against public, always.
-- ─────────────────────────────────────────────────────────────────────────────
