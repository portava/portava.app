-- Rollback for 3362_posts_client_column_grants.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3362 DID
-- =============
--   * REVOKE SELECT ON TABLE public.posts FROM anon, authenticated;
--   * GRANT SELECT (40 columns) ON public.posts TO anon, authenticated.
--   No policy, row, function or service_role privilege was touched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores exactly the state 2148 left: anon and authenticated hold
-- table-level SELECT on posts and no column-level privilege. On the local
-- harness the restored pg_class.relacl is byte-identical to the pre-3362 one,
-- and every pg_attribute.attacl is NULL again (census-media §44.5).
--
-- ⚠ IT RE-OPENS THE DEFECT 3362 CLOSED. With table-level SELECT back, the
-- public anon key reads every column of every row posts' policies admit —
-- user_gps_*, original_*, geog, the venue, the geofence exit time — whatever
-- the author chose as location_privacy_mode (census-media §42.6, item 5).
-- Use it only to recover from a reader 3362 broke, and re-apply 3362 (with the
-- missing column granted, if it is not a location) as soon as that is fixed.
--
-- It changes no row.

BEGIN;

DO $$
DECLARE
  bad text;
BEGIN
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362 rollback): public.posts does not exist.';
  END IF;
  -- Refuse anything but 3362's state: client roles hold no table-level
  -- privilege, and whatever column-level privilege they hold is SELECT.
  SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.posts'::regclass
     AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362 rollback): client roles already hold table-level privileges on posts (%); this is not the state 3362 left.', bad;
  END IF;
  IF NOT has_column_privilege('anon', 'public.posts', 'id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.posts', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362 rollback): anon/authenticated do not hold 3362''s column-level SELECT on posts.id; this is not the state 3362 left.';
  END IF;
END $$;

-- Revoking the table-level privilege also revokes every column-level SELECT
-- the two roles hold (PostgreSQL does both), so pg_attribute.attacl returns to
-- NULL; then the table-level SELECT 2148 granted is granted again.
REVOKE SELECT ON TABLE public.posts FROM anon, authenticated;
GRANT SELECT ON TABLE public.posts TO anon;
GRANT SELECT ON TABLE public.posts TO authenticated;

COMMIT;

-- ── Postconditions: 2148's state, exactly ───────────────────────────────────
DO $post$
DECLARE
  privs text;
BEGIN
  SELECT string_agg(format('%s:%s%s', x.grantee::regrole::text, x.privilege_type,
                           CASE WHEN x.is_grantable THEN '+grant' ELSE '' END), ',' ORDER BY x.grantee::regrole::text)
    INTO privs
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.posts'::regclass
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF privs IS DISTINCT FROM 'anon:SELECT,authenticated:SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362 rollback): client-role table privileges on posts are "%", expected anon:SELECT,authenticated:SELECT.', privs;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362 rollback): a column-level privilege survives on posts.';
  END IF;
END $post$;
