-- Rollback for 3520_user_stamps_client_column_grants.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3520 DID
-- =============
--   * REVOKE SELECT ON TABLE public.user_stamps FROM anon, authenticated;
--   * GRANT SELECT (17 columns) ON public.user_stamps TO anon, authenticated,
--     withholding lat, lng and metadata.
--   No policy, row, function, trigger or service_role privilege was touched,
--   and 2972's write boundary (no client INSERT/UPDATE/DELETE/TRUNCATE) was
--   left exactly as it was.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores exactly the state 0081 and 2972 left: anon and authenticated hold
-- table-level SELECT on user_stamps and no column-level privilege, so
-- pg_attribute.attacl is NULL for every column again.
--
-- ⚠ IT RE-OPENS THE DEFECT 3520 CLOSED. With table-level SELECT back, any
-- SIGNED-IN user reads lat and lng on every row user_stamps_public_read admits
-- — 47 of 47 rows on production, 20 of them with coordinates — which
-- 0081:49 says must never be exposed. 0081's own
-- `REVOKE SELECT (lat, lng)` does NOT prevent this and never did: privileges
-- are additive, and a column-level REVOKE cannot subtract from a table-level
-- GRANT. Re-running 0081 after this rollback would therefore restore the
-- defect while appearing to fix it.
--
-- Use it only to recover from a reader 3520 broke, and re-apply 3520 — with
-- the missing column added to its granted list, if that column carries no
-- position — as soon as that is fixed.
--
-- It changes no row except its own schema_migration_ledger row, which it
-- deletes (below) so the runner re-applies 3520 later.

BEGIN;

DO $$
DECLARE
  bad text;
BEGIN
  IF to_regclass('public.user_stamps') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520 rollback): public.user_stamps does not exist.';
  END IF;
  -- Refuse anything but 3520's state: no table-level SELECT for a client role
  -- or PUBLIC, and the column-level SELECT 3520 granted is present.
  --
  -- Whatever table-level WRITE grants the client roles hold are not checked
  -- here and are not touched below: 2972 removes those, and on production it
  -- has not run yet, so anon and authenticated still hold INSERT, UPDATE and
  -- DELETE whether or not 3520 has been applied. Requiring their absence
  -- would make this rollback unrunnable on the database it is for.
  SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.user_stamps'::regclass
     AND ((a.grantee = 0) OR (a.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND a.privilege_type = 'SELECT'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520 rollback): a table-level SELECT already covers every column on user_stamps (%); this is not the state 3520 left.', bad;
  END IF;
  IF NOT has_column_privilege('anon', 'public.user_stamps', 'id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.user_stamps', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520 rollback): anon/authenticated do not hold 3520''s column-level SELECT on user_stamps.id; this is not the state 3520 left.';
  END IF;
END $$;

-- Revoking the table-level privilege also revokes every column-level SELECT
-- the two roles hold (PostgreSQL does both), so pg_attribute.attacl returns to
-- NULL; then the table-level SELECT is granted again.
REVOKE SELECT ON TABLE public.user_stamps FROM anon, authenticated;
GRANT SELECT ON TABLE public.user_stamps TO anon;
GRANT SELECT ON TABLE public.user_stamps TO authenticated;
DELETE FROM public.schema_migration_ledger WHERE filename = '3520_user_stamps_client_column_grants.sql';
COMMIT;

-- ── Postconditions: the pre-3520 state, exactly ─────────────────────────────
DO $post$
DECLARE
  privs text;
BEGIN
  -- The table-level SELECT is back for both client roles, without the grant
  -- option, and PUBLIC still holds nothing. Other table-level privileges are
  -- reported, not asserted: see the precondition's note on 2972.
  SELECT string_agg(format('%s:%s%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
                           x.privilege_type, CASE WHEN x.is_grantable THEN '+grant' ELSE '' END), ',' ORDER BY format('%s:%s', x.grantee::regrole::text, x.privilege_type))
    INTO privs
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.user_stamps'::regclass
     AND ((x.grantee = 0) OR (x.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND x.privilege_type = 'SELECT'));
  IF privs IS DISTINCT FROM 'anon:SELECT,authenticated:SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520 rollback): the table-level SELECT state on user_stamps is "%", expected anon:SELECT,authenticated:SELECT.', privs;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.user_stamps'::regclass AND attnum > 0 AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520 rollback): a column-level privilege survives on user_stamps.';
  END IF;
  -- The runner wrote 3520's ledger row in 3520's own transaction; with it
  -- gone, a later scripts/src/apply-migrations.ts run re-applies 3520 instead
  -- of taking it as applied (the convention this lane's rollbacks follow).
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3520_user_stamps_client_column_grants.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520 rollback): the ledger still records 3520 as applied.';
  END IF;
END $post$;
