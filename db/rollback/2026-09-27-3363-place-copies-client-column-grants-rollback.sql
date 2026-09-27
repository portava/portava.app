-- Rollback for 3363_place_copies_client_column_grants.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3363 DID
-- =============
-- On pulse_geo_tags, passport_postcards and post_media:
--   * REVOKE SELECT ON TABLE ... FROM anon, authenticated;
--   * GRANT SELECT (the non-place columns) ON ... TO anon, authenticated.
-- Nothing else: no INSERT/UPDATE/DELETE privilege, policy or row was touched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores the SELECT grants 3363 found: table-level SELECT for anon and
-- authenticated, and no column-level SELECT for either. One REVOKE per table
-- removes 3363's column SELECTs (PostgreSQL revokes the column privileges of
-- the same type with the table's) and leaves every column INSERT/UPDATE grant
-- (2151, 2152, 2158) exactly as it is; the table-level SELECT is then granted
-- again. On the local harness the restored pg_class.relacl and every
-- pg_attribute.attacl are byte-identical to the pre-3363 ones (census-media
-- §44.14). Where a client role held ONLY SELECT and its ACL entry was not the
-- last one, the re-granted entry is appended at the end: the same privileges,
-- in a different array order, which carries no meaning.
--
-- It deletes 3363's schema_migration_ledger row (the runner writes it in the
-- file's own transaction), so a later run of scripts/src/apply-migrations.ts
-- re-applies 3363 instead of taking it as applied.
--
-- ⚠ IT RE-OPENS THE DEFECT 3363 CLOSED: the public key reads, again, the venue,
-- district, city, geo zone and hotel-blur flag of every Pulse geo tag, and the
-- venue and verification distance of every postcard can_see_postcard admits,
-- whatever the author chose as location_privacy_mode (census-media §44.7,
-- item 2). Use it only to recover from a reader 3363 broke.
--
-- It changes no row other than the ledger's.

BEGIN;

DO $$
DECLARE
  t   text;
  rel regclass;
  bad text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pulse_geo_tags', 'passport_postcards', 'post_media'] LOOP
    rel := to_regclass('public.' || t);
    IF rel IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363 rollback): public.% does not exist.', t;
    END IF;
    -- Refuse anything but 3363's state: no table-level SELECT for a client
    -- role, and 3363's column SELECT on id for both.
    SELECT string_agg(format('%s:%s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type), ', ')
      INTO bad
      FROM pg_class c, LATERAL aclexplode(c.relacl) a
     WHERE c.oid = rel AND a.privilege_type = 'SELECT'
       AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole));
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363 rollback): client roles already hold table-level SELECT on % (%); this is not the state 3363 left.', t, bad;
    END IF;
    IF NOT has_column_privilege('anon', rel, 'id', 'SELECT')
       OR NOT has_column_privilege('authenticated', rel, 'id', 'SELECT') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3363 rollback): anon/authenticated do not hold 3363''s column-level SELECT on %.id; this is not the state 3363 left.', t;
    END IF;
  END LOOP;
END $$;

REVOKE SELECT ON TABLE public.pulse_geo_tags FROM anon, authenticated;
GRANT SELECT ON TABLE public.pulse_geo_tags TO anon;
GRANT SELECT ON TABLE public.pulse_geo_tags TO authenticated;

REVOKE SELECT ON TABLE public.passport_postcards FROM anon, authenticated;
GRANT SELECT ON TABLE public.passport_postcards TO anon;
GRANT SELECT ON TABLE public.passport_postcards TO authenticated;

REVOKE SELECT ON TABLE public.post_media FROM anon, authenticated;
GRANT SELECT ON TABLE public.post_media TO anon;
GRANT SELECT ON TABLE public.post_media TO authenticated;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3363_place_copies_client_column_grants.sql';

COMMIT;

-- ── Postconditions: the SELECT grants 3363 found, and no ledger row ─────────
DO $post$
DECLARE
  t   text;
  rel regclass;
  bad text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pulse_geo_tags', 'passport_postcards', 'post_media'] LOOP
    rel := ('public.' || t)::regclass;
    IF (SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) x
         WHERE c.oid = rel AND x.privilege_type = 'SELECT' AND NOT x.is_grantable
           AND x.grantee IN ('anon'::regrole, 'authenticated'::regrole)) <> 2 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3363 rollback): anon and authenticated do not both hold table-level SELECT on % again.', t;
    END IF;
    SELECT string_agg(a.attname || ':' || x.grantee::regrole::text, ', ') INTO bad
      FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = rel AND a.attnum > 0 AND x.privilege_type = 'SELECT'
       AND x.grantee IN ('anon'::regrole, 'authenticated'::regrole);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3363 rollback): a column-level SELECT survives on %: %.', t, bad;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3363_place_copies_client_column_grants.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3363 rollback): the ledger still records 3363 as applied.';
  END IF;
END $post$;
