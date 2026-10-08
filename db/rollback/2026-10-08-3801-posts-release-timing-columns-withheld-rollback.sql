-- Rollback for 3801_posts_release_timing_columns_withheld.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3801 DID
-- =============
--   * REVOKE SELECT ON TABLE public.posts FROM anon, authenticated, PUBLIC;
--   * GRANT SELECT (3362's 40 columns minus updated_at and publish_at) ON
--     public.posts TO anon, authenticated.
--   No policy, row, function or service_role privilege was touched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Re-grants SELECT (updated_at, publish_at) to anon and authenticated. That is
-- 3362's end state exactly: no table-level client privilege, column SELECT on
-- 3362's 40 columns (census-media §50.16).
--
-- ⚠ IT RE-OPENS N2b. A signed-in stranger can read updated_at again through
-- PostgREST, and on a "Publish after I leave" post that is the instant the
-- author left the place (the geofence-exit UPDATE) or the release instant (the
-- worker's UPDATE). Use it only to recover from a reader 3801 broke.
--
-- IF 3801 WAS APPLIED OVER 2148's STATE (production on 2026-10-08, where 3362
-- was never applied), this still leaves 3362's end state, not 2148's: it never
-- restores a table-level SELECT, which would expose the GPS columns again.
-- 3362's own rollback goes from there to 2148's state, if that is ever wanted.
--
-- It changes no row except its own schema_migration_ledger row, which it
-- deletes, so a later runner pass re-applies 3801 (the convention 3362's
-- rollback follows).

BEGIN;

DO $$
DECLARE
  bad text;
BEGIN
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801 rollback): public.posts does not exist.';
  END IF;
  -- Refuse anything but 3801's state: no table-level client privilege, the
  -- column grants in place, and neither release-timing column granted.
  SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.posts'::regclass
     AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801 rollback): client roles hold table-level privileges on posts (%); this is not the state 3801 left.', bad;
  END IF;
  IF NOT has_column_privilege('anon', 'public.posts', 'id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.posts', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801 rollback): anon/authenticated do not hold column-level SELECT on posts.id; this is not the state 3801 left.';
  END IF;
  IF has_column_privilege('anon', 'public.posts', 'updated_at', 'SELECT')
     OR has_column_privilege('authenticated', 'public.posts', 'updated_at', 'SELECT')
     OR has_column_privilege('anon', 'public.posts', 'publish_at', 'SELECT')
     OR has_column_privilege('authenticated', 'public.posts', 'publish_at', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3801 rollback): a client role already reads updated_at or publish_at; 3801 is not in force here.';
  END IF;
END $$;

GRANT SELECT (updated_at, publish_at) ON TABLE public.posts TO anon, authenticated;
DELETE FROM public.schema_migration_ledger WHERE filename = '3801_posts_release_timing_columns_withheld.sql';
COMMIT;

-- ── Postconditions: 3362's end state, exactly ───────────────────────────────
DO $post$
DECLARE
  granted text[] := ARRAY[
    'id','author_id','trip_id','content','media_urls','visibility','status',
    'created_by','updated_by','source','created_at','updated_at','deleted_at',
    'media_type','add_to_passport','like_count','comment_count','share_count',
    'comments_setting','likes_hidden','sharing_disabled','reposting_disabled',
    'category','save_count','media_thumbnail_url','primary_media_type',
    'media_count','has_video','filter_id','filter_intensity',
    'media_duration_seconds','post_buckets','bucket_classified',
    'original_language','publish_at','geo_restriction',
    'age_restriction_enabled','age_min','age_max','tombstoned_at'];
  leak text;
  lost text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
              WHERE c.oid = 'public.posts'::regclass
                AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801 rollback): a client role or PUBLIC holds a table-level privilege on posts.';
  END IF;
  SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text <> ALL (granted)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801 rollback): a client role reads a column 3362 withholds: %.', leak;
  END IF;
  SELECT string_agg(r || '.' || a.attname, ', ') INTO lost
    FROM unnest(ARRAY['anon','authenticated']) r, pg_attribute a
   WHERE a.attrelid = 'public.posts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (granted)
     AND NOT has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801 rollback): a client role does not read a column 3362 grants: %.', lost;
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3801_posts_release_timing_columns_withheld.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3801 rollback): the ledger still records 3801 as applied.';
  END IF;
END $post$;
