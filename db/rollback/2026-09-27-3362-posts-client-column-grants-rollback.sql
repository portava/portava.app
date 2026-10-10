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
-- It changes no row except its own schema_migration_ledger row, which it deletes (below, census-media §44.11) so the runner re-applies 3362 later.

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
  -- 3801 (2026-10-08) narrowed 3362's grant by updated_at and publish_at. On
  -- its state this rollback would hand the client roles every column back
  -- while the ledger still recorded 3801 as applied, and 3801's own rollback
  -- would then refuse (verifier M4 F1). So 3362's exact column state is
  -- required: roll 3801 back first.
  IF NOT has_column_privilege('anon', 'public.posts', 'updated_at', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.posts', 'updated_at', 'SELECT')
     OR NOT has_column_privilege('anon', 'public.posts', 'publish_at', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.posts', 'publish_at', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3362 rollback): anon/authenticated do not read posts.updated_at and publish_at, so a later migration (3801) narrowed 3362''s grants. Roll 3801 back first (db/rollback/2026-10-08-3801-posts-release-timing-columns-withheld-rollback.sql).';
  END IF;
END $$;

-- Revoking the table-level privilege also revokes every column-level SELECT
-- the two roles hold (PostgreSQL does both), so pg_attribute.attacl returns to
-- NULL; then the table-level SELECT 2148 granted is granted again.
REVOKE SELECT ON TABLE public.posts FROM anon, authenticated;
GRANT SELECT ON TABLE public.posts TO anon;
GRANT SELECT ON TABLE public.posts TO authenticated;
DELETE FROM public.schema_migration_ledger WHERE filename = '3362_posts_client_column_grants.sql';
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
  -- The runner wrote 3362's ledger row in 3362's own transaction; with it gone,
  -- a later scripts/src/apply-migrations.ts run re-applies 3362 instead of
  -- taking it as applied (the convention lane X's rollbacks follow).
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3362_posts_client_column_grants.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3362 rollback): the ledger still records 3362 as applied.';
  END IF;
END $post$;
