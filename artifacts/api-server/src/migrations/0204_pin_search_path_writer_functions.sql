-- Migration 0204: pin search_path on the SECURITY DEFINER functions that WRITE
--
-- WHY THESE ARE WORSE THAN THE READ-SIDE PREDICATES
-- -------------------------------------------------
-- 0201 pinned the authorization predicates, where a shadowed table misinforms a
-- decision. These six WRITE. A shadowed write target does not misinform anything
-- — it puts the row somewhere the caller controls, or deletes from a table that
-- is not the one the author meant, while executing with the definer's rights.
--
-- DEMONSTRATED, NOT ASSERTED
-- --------------------------
-- scripts/verify-write-path-hazard.mjs builds the attack: creates a schema, adds
-- a shadowing table with the same name as the public table the function writes
-- to, sets search_path to prefer it, invokes the function, then looks in the
-- shadow to see where the write landed. Every probe ends in an unconditional
-- RAISE, so the shadow schema and any write against the real tables are rolled
-- back together. Against live, BEFORE this migration:
--
--   x  increment_hashtag_usage_count:      HAZARD OPEN - 1 row written into the shadow
--   x  upsert_hashtag_usage_and_increment: HAZARD OPEN - 1 row written into the shadow
--   x  increment_distribution_stats:       HAZARD OPEN - 1 row written into the shadow
--   x  purge_old_ranking_debug_samples:    HAZARD OPEN - DELETE misdirected into the shadow
--   x  add_owner_as_member:                HAZARD OPEN - 1 row written into the shadow
--
-- The last one is the sharpest. A genuine INSERT INTO public.trips fired
-- trg_trip_owner_member, and the membership row that records the trip's OWNER
-- landed in the attacker's schema instead of public.trip_members — so the owner
-- would simply not be a member of their own trip in the real table, with no
-- error raised anywhere.
--
-- After this migration the identical probe reports HAZARD CLOSED for all five,
-- with public row counts unchanged.
--
-- PROBE COVERAGE - PER FUNCTION, NOT IMPLIED UNIFORMLY
-- ---------------------------------------------------
-- Five of the six are demonstrated red-then-green. handle_new_user is NOT, and
-- the reason is not auth.uid() this time: it is a trigger function bound to NO
-- TRIGGER AT ALL. public auth.users carries zero non-internal triggers, so there
-- is no live write path to demonstrate, and manufacturing one against the auth
-- schema is not worth the blast radius. It is pinned on the strength of the
-- mechanism the other five demonstrate. Do not read the probe's green run as
-- per-function proof for handle_new_user.
--
-- (That it is unbound is itself worth knowing: profile creation is done by the
-- application today, not by this trigger. It is pinned rather than dropped
-- because, unlike enforce_is_official_service_role, nothing supersedes it and it
-- may be intended to be re-bound. If it IS re-bound later, it is already safe.)
--
-- BEHAVIOUR-NEUTRALITY - CHECKED PER FUNCTION
-- -------------------------------------------
-- Each body was read from live and inspected individually. All six reference
-- ONLY public tables — trip_members, profiles, content_distribution_stats,
-- hashtags, hashtag_usage, ranking_debug_samples, every one confirmed to be in
-- public — plus pg_catalog builtins (now(), lower(), coalesce(), split_part(),
-- nullif(), the jsonb ->> operator, interval arithmetic). Mechanically checked
-- for, and none found: calls into the extensions schema (pgcrypto, uuid-ossp and
-- pg_stat_statements live there — no body calls gen_random_uuid,
-- uuid_generate_v*, crypt, digest or similar), references to auth/storage/vault/
-- realtime/graphql, and temp tables. The enum types they assign (member_role,
-- underexposure_status_enum) are in public. Nothing here changes behaviour for a
-- caller whose search_path already included public.
--
-- 'public', 'pg_catalog' matches the existing precedent: 0201, plus
-- enforce_is_official_privileged / enforce_profile_role_privileged /
-- admin_set_profile_role.
--
-- ALTER, NOT CREATE OR REPLACE - restating a body risks silently rewriting it,
-- which is the drift 0200 and 0203 exist to prevent.
--
-- KNOCK-ON: purge_old_ranking_debug_samples was backfilled by 0203 and its
-- verifier asserted proconfig = (none). That assertion is now WRONG BY DESIGN
-- and is updated in the same change — the empty expectation existed precisely so
-- that this fix landing would be noticed rather than silently absorbed.

BEGIN;

-- trigger trg_trip_owner_member, AFTER INSERT ON public.trips -> INSERTs public.trip_members. PROBED: red -> green.
ALTER FUNCTION public.add_owner_as_member() SET search_path TO 'public', 'pg_catalog';

-- INSERTs public.profiles. Bound to NO trigger today - see note. NOT probed.
ALTER FUNCTION public.handle_new_user() SET search_path TO 'public', 'pg_catalog';

-- INSERT/UPDATE public.content_distribution_stats. PROBED: red -> green.
ALTER FUNCTION public.increment_distribution_stats(p_item_id text, p_viewer_id text, p_negative_signal boolean, p_threshold integer, p_suppression_rate double precision) SET search_path TO 'public', 'pg_catalog';

-- UPDATEs public.hashtags. PROBED: red -> green.
ALTER FUNCTION public.increment_hashtag_usage_count(p_hashtag_id uuid) SET search_path TO 'public', 'pg_catalog';

-- INSERTs public.hashtag_usage, UPDATEs public.hashtags. PROBED: red -> green.
ALTER FUNCTION public.upsert_hashtag_usage_and_increment(p_hashtag_id uuid, p_source_type text, p_source_id uuid, p_author_id uuid, p_city text, p_country text) SET search_path TO 'public', 'pg_catalog';

-- DELETEs from public.ranking_debug_samples. PROBED: red -> green.
ALTER FUNCTION public.purge_old_ranking_debug_samples() SET search_path TO 'public', 'pg_catalog';

COMMIT;
