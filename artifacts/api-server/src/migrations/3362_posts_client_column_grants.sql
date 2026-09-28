-- 3362_posts_client_column_grants.sql
-- posts: the client roles may read only the columns no location rule governs
-- (census-media §44, lane G1).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it. It changes what the public anon key can
-- read from a live table, so it needs the owner's production approval
-- (census-media §44.9 is the approval step: order, verification, recovery).
--
-- ── THE DEFECT (census-media §42.6, item 5) ─────────────────────────────────
-- 2148 left anon + authenticated with TABLE-level SELECT on public.posts. RLS
-- decides the ROWS (posts_select: can_see_post(id), for every role, anon
-- included; posts_select_policy for authenticated); nothing decides the
-- COLUMNS. So `GET /rest/v1/posts?select=*` with the public key returns, for
-- every public active post, the author's GPS at posting time (user_gps_*), the
-- exact point (original_*, geog), the venue (location_name, venue_name, the
-- place ids), the geofence exit time and every other column — whatever the
-- author chose as location_privacy_mode. The API withholds those per row
-- (mapPublicPost, the Hidden-Gem gate, postPlaceWithheld); PostgREST bypasses
-- all of it. A filter is enough without selecting a column:
-- `?original_lat=gt.48.85` is a range oracle on the exact point.
--
-- ── WHO READS posts AS A CLIENT ROLE (census-media §44.2) ───────────────────
-- * No client code. travel-buddy-standalone has no `.from('posts')`, no
--   embedded posts resource and no realtime subscription on posts, in the tree
--   or anywhere in its git history. It reads posts only through the API.
-- * The API reads posts only as service_role (lib/supabase.ts
--   getServiceClient; requireUser returns that client). This migration does
--   not touch service_role.
-- * In the database: three post_media policies subquery posts AS THE INVOKING
--   ROLE, reading id, author_id, status, visibility and trip_id. posts' own
--   policies read the same five (can_see_post is SECURITY DEFINER). No view
--   reads posts. Every function that reads posts and that a client role may
--   EXECUTE is SECURITY DEFINER and returns a boolean (can_see_post,
--   can_see_postcard).
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
-- REVOKE the table-level SELECT from anon and authenticated, and GRANT SELECT
-- on the 40 columns below instead. The other 35 are readable by no client
-- role; the API (service_role) still reads all 75.
--
--   GRANTED — no location rule applies to them: identity, body, media,
--   audience, counters, settings, timestamps of the post itself.
--
--   WITHHELD, by class (census-media §44.4 argues each):
--     exact position and presence evidence, never public in any mode —
--       user_gps_lat, user_gps_lng, original_lat, original_lng, geog,
--       location_distance_meters, exited_geofence_at, delayed_location_reason
--     the place, which the API discloses per row (mode, delayed status, Hidden
--     Gem) and a column grant cannot —
--       location_name, location_place_id, location_lat, location_lng,
--       public_lat, public_lng, public_location_label, venue_id, venue_name,
--       canonical_location_id, canonical_place_id, perspective_vantage
--     the city and country, which the API serves only on rows it serves: RLS
--     also admits a delayed post still pending, whose city is where its
--     author is now —
--       location_city, location_country
--     the delayed-publication and privacy state, which discloses that, when
--     and how a place is being withheld (publish_eligible_at is derived from
--     the geofence exit time) —
--       location_privacy_mode, location_sensitivity_level, post_status,
--       geofence_radius_meters, publish_after_exit, publish_after_time,
--       publish_eligible_at, published_at
--     location verification, which says the author was physically at the
--     (possibly withheld) place, and when —
--       location_source, location_verified, location_verified_at,
--       geotag_verified, geotag_credit_awarded
--
-- A column added to posts after this is readable by NO client role until a
-- migration grants it: the default is closed.
--
-- ── WHAT IT DOES NOT CHANGE ─────────────────────────────────────────────────
-- No policy, no row, no function, no trigger, no service_role privilege, no
-- write privilege (2148's none stays none). Every row a client role could
-- read before, it can read now; only the columns narrow. The table comment is
-- left as 2148 wrote it, so the rollback restores the catalog exactly.
--
-- Two columns are optional: tombstoned_at (2141) and perspective_vantage
-- (3352). Each is classified if present and skipped if absent; any OTHER
-- column this file does not classify refuses the apply, because an unknown
-- column may be a location.
--
-- Rollback: db/rollback/2026-09-27-3362-posts-client-column-grants-rollback.sql
-- (restores 2148's table-level SELECT exactly, and with it the defect).

BEGIN;

DO $pre$
DECLARE
  granted  text[] := ARRAY[
    'id','author_id','trip_id','content','media_urls','visibility','status',
    'created_by','updated_by','source','created_at','updated_at','deleted_at',
    'media_type','add_to_passport','like_count','comment_count','share_count',
    'comments_setting','likes_hidden','sharing_disabled','reposting_disabled',
    'category','save_count','media_thumbnail_url','primary_media_type',
    'media_count','has_video','filter_id','filter_intensity',
    'media_duration_seconds','post_buckets','bucket_classified',
    'original_language','publish_at','geo_restriction',
    'age_restriction_enabled','age_min','age_max','tombstoned_at'];
  withheld text[] := ARRAY[
    'user_gps_lat','user_gps_lng','original_lat','original_lng','geog',
    'location_distance_meters','exited_geofence_at','delayed_location_reason',
    'location_name','location_place_id','location_lat','location_lng',
    'public_lat','public_lng','public_location_label','venue_id','venue_name',
    'canonical_location_id','canonical_place_id','perspective_vantage',
    'location_city','location_country',
    'location_privacy_mode','location_sensitivity_level','post_status',
    'geofence_radius_meters','publish_after_exit','publish_after_time',
    'publish_eligible_at','published_at',
    'location_source','location_verified','location_verified_at',
    'geotag_verified','geotag_credit_awarded'];
  optional text[] := ARRAY['tombstoned_at','perspective_vantage'];
  cols     text[];
  missing  text;
  unknown  text;
  bad      text;
BEGIN
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362): public.posts does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.posts'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362): RLS is not enabled on posts; column grants would then be the only boundary. Refusing.';
  END IF;

  SELECT array_agg(attname::text ORDER BY attnum) INTO cols
    FROM pg_attribute
   WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped;

  -- Every column this file names (optional ones aside) must exist ...
  SELECT string_agg(c, ', ') INTO missing
    FROM unnest(granted || withheld) c
   WHERE c <> ALL (optional) AND c <> ALL (cols);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362): posts lacks column(s) this migration classifies: %. The schema is not the one this was written against.', missing;
  END IF;
  -- ... and every column that exists must be classified. An unclassified
  -- column may be a location: refuse rather than guess which side it goes.
  SELECT string_agg(c, ', ') INTO unknown
    FROM unnest(cols) c
   WHERE c <> ALL (granted) AND c <> ALL (withheld);
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362): posts has column(s) this migration does not classify: %. Classify them in 3362 before applying.', unknown;
  END IF;

  -- The starting state must be 2148's, or the rollback would not restore it:
  -- anon and authenticated hold exactly table-level SELECT (no grant option),
  -- PUBLIC holds nothing, and no role holds a column-level privilege.
  SELECT string_agg(format('%s:%s%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                           a.privilege_type, CASE WHEN a.is_grantable THEN '+grant' ELSE '' END), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.posts'::regclass
     AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     AND NOT (a.grantee IN ('anon'::regrole, 'authenticated'::regrole)
              AND a.privilege_type = 'SELECT' AND NOT a.is_grantable);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362): client-role table privileges on posts are not 2148''s SELECT-only state: %.', bad;
  END IF;
  IF (SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) a
       WHERE c.oid = 'public.posts'::regclass AND a.privilege_type = 'SELECT'
         AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362): anon and authenticated do not both hold table-level SELECT on posts; this is not the state 2148 left.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362): posts already carries column-level privileges; the rollback could not restore them. Inspect pg_attribute.attacl first.';
  END IF;
END $pre$;

-- The table-level SELECT goes; with it, PostgreSQL removes any column-level
-- SELECT the two roles held (there is none, by the precondition).
REVOKE SELECT ON TABLE public.posts FROM anon, authenticated;

GRANT SELECT (
  id, author_id, trip_id, content, media_urls, visibility, status,
  created_by, updated_by, source, created_at, updated_at, deleted_at,
  media_type, add_to_passport, like_count, comment_count, share_count,
  comments_setting, likes_hidden, sharing_disabled, reposting_disabled,
  category, save_count, media_thumbnail_url, primary_media_type,
  media_count, has_video, filter_id, filter_intensity,
  media_duration_seconds, post_buckets, bucket_classified,
  original_language, publish_at, geo_restriction,
  age_restriction_enabled, age_min, age_max
) ON TABLE public.posts TO anon, authenticated;

-- tombstoned_at (2141) is granted where it exists. perspective_vantage (3352)
-- is withheld, so it needs no statement either way.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.posts'::regclass AND attname = 'tombstoned_at' AND NOT attisdropped) THEN
    EXECUTE 'GRANT SELECT (tombstoned_at) ON TABLE public.posts TO anon, authenticated';
  END IF;
END $$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE
  granted  text[] := ARRAY[
    'id','author_id','trip_id','content','media_urls','visibility','status',
    'created_by','updated_by','source','created_at','updated_at','deleted_at',
    'media_type','add_to_passport','like_count','comment_count','share_count',
    'comments_setting','likes_hidden','sharing_disabled','reposting_disabled',
    'category','save_count','media_thumbnail_url','primary_media_type',
    'media_count','has_video','filter_id','filter_intensity',
    'media_duration_seconds','post_buckets','bucket_classified',
    'original_language','publish_at','geo_restriction',
    'age_restriction_enabled','age_min','age_max','tombstoned_at'];
  -- Never readable by a client role, in any mode (the §42.6 item 5 minimum).
  never    text[] := ARRAY[
    'user_gps_lat','user_gps_lng','original_lat','original_lng','geog',
    'location_distance_meters','exited_geofence_at','delayed_location_reason'];
  leak     text;
  lost     text;
  writable text;
  svc      text;
BEGIN
  -- has_column_privilege(role, table oid, attnum, ...) is used throughout: it
  -- cannot raise on a column name, whatever order the planner runs the quals.
  SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r,
         pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (never)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362): a client role can still read a private posts column: %.', leak;
  END IF;

  -- Exactly the granted set is readable: nothing more (a leak), nothing less
  -- (a broken reader: post_media's policies need id, author_id, status,
  -- visibility and trip_id).
  SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r,
         pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text <> ALL (granted)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362): a client role can read a withheld posts column: %.', leak;
  END IF;
  SELECT string_agg(r || '.' || a.attname, ', ') INTO lost
    FROM unnest(ARRAY['anon','authenticated']) r,
         pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (granted)
     AND NOT has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362): a client role lost a column it must keep: %.', lost;
  END IF;

  -- No table-level privilege of any kind survives for the client roles, and
  -- no column-level write or REFERENCES appeared (2148's boundary holds).
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
              WHERE c.oid = 'public.posts'::regclass
                AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362): a client role or PUBLIC still holds a table-level privilege on posts.';
  END IF;
  SELECT string_agg(DISTINCT r || '/' || p, ', ') INTO writable
    FROM unnest(ARRAY['anon','authenticated']) r,
         unnest(ARRAY['INSERT','UPDATE','REFERENCES']) p,
         pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege(r, a.attrelid, a.attnum, p);
  IF writable IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362): a client role holds a column privilege other than SELECT on posts: %.', writable;
  END IF;

  -- The API's path is untouched: service_role reads every column.
  SELECT string_agg(a.attname, ', ') INTO svc
    FROM pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT');
  IF svc IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362): service_role cannot read posts column(s) %; the API would break.', svc;
  END IF;
END $post$;
