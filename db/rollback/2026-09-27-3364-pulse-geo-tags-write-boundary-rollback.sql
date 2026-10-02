-- Rollback for 3364_pulse_geo_tags_write_boundary.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3364 DID
-- =============
--   * REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
--     public.pulse_geo_tags FROM anon, authenticated, PUBLIC;
--   * recorded the table's whole ACL, as it was, at the end of the table's
--     comment (after any comment the table already had).
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores the recorded ACL, and only it: whatever the client roles held
-- before 3364 — GRANT ALL where 2490 is not applied (the tree, the harness),
-- SELECT/INSERT/UPDATE/DELETE on production (census-media §44.15.1), where
-- 2490 had removed TRUNCATE, REFERENCES, TRIGGER and MAINTAIN — comes back,
-- and nothing more. It never widens past the recorded state.
--   * Entries are restored in the recorded order: a client entry 3364 emptied
--     is re-granted, and every later non-owner entry (service_role) is
--     revoked and re-granted with exactly its recorded privileges so that it
--     lands after it again. The result is asserted equal to the record, as
--     text, inside this transaction.
--   * It refuses if any privilege outside the client roles' writes differs
--     from the record: something else changed since 3364, and restoring the
--     record would undo it.
--   * The comment returns to what it was before 3364 (none, on the tree).
--   * It deletes 3364's schema_migration_ledger row, so a later run of
--     scripts/src/apply-migrations.ts re-applies 3364.
--
-- ⚠ IT RE-OPENS THE DEFECT 3364 CLOSED: a signed-in stranger can again attach a
-- geo tag, with any venue, to another author's untagged post, and Pulse serves
-- it (census-media §44.16, item 1). Use it only to recover from a writer 3364
-- broke.
--
-- It changes no row other than the ledger's.

BEGIN;

DO $$
DECLARE
  rel       regclass := to_regclass('public.pulse_geo_tags');
  descr     text;
  recorded  aclitem[];
  prior     text;
  me        oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  writes    text[] := ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  k         int;
  item      record;
  priv      record;
  bad       text;
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): public.pulse_geo_tags does not exist.';
  END IF;
  IF (SELECT relowner FROM pg_class WHERE oid = rel) <> me THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): % does not own pulse_geo_tags; the recorded ACL could not be restored exactly.', current_user;
  END IF;

  descr := obj_description(rel, 'pg_class');
  recorded := substring(descr FROM 'ACL before 3364, which its rollback restores: (\{[^}]*\})$')::aclitem[];
  IF recorded IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): pulse_geo_tags carries no 3364 ACL record; this is not the state 3364 left.';
  END IF;
  prior := CASE WHEN descr LIKE '3364 (census-media 44.18):%' THEN NULL
                ELSE substring(descr FROM '^(.*)\n\n3364 \(census-media 44\.18\):') END;
  IF descr NOT LIKE '3364 (census-media 44.18):%' AND prior IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): the comment on pulse_geo_tags is not in the shape 3364 wrote.';
  END IF;

  -- 3364's state: no client role or PUBLIC holds a write privilege.
  SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = rel AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     AND x.privilege_type = ANY (writes);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): client roles already hold write privileges on pulse_geo_tags (%); this is not the state 3364 left.', bad;
  END IF;

  -- Everything 3364 did not revoke must still be what was recorded; otherwise
  -- restoring the record would silently undo a later change.
  SELECT string_agg(e, ', ') INTO bad FROM (
    (SELECT format('%s|%s|%s|%s', x.grantor::regrole, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type, x.is_grantable) AS e
       FROM aclexplode(recorded) x
      WHERE NOT ((x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole)) AND x.privilege_type = ANY (writes))
     EXCEPT
     SELECT format('%s|%s|%s|%s', x.grantor::regrole, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type, x.is_grantable)
       FROM pg_class c, LATERAL aclexplode(c.relacl) x WHERE c.oid = rel)
    UNION ALL
    (SELECT format('%s|%s|%s|%s', x.grantor::regrole, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type, x.is_grantable)
       FROM pg_class c, LATERAL aclexplode(c.relacl) x WHERE c.oid = rel
     EXCEPT
     SELECT format('%s|%s|%s|%s', x.grantor::regrole, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type, x.is_grantable)
       FROM aclexplode(recorded) x)) d;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): pulse_geo_tags privileges other than the client writes changed since 3364 (%); restoring the record would undo that. Refusing.', bad;
  END IF;

  -- The first recorded entry that 3364 changed: a client role holding a write.
  SELECT min(o) INTO k
    FROM unnest(recorded) WITH ORDINALITY u(a, o), LATERAL aclexplode(ARRAY[u.a]) x
   WHERE (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole)) AND x.privilege_type = ANY (writes);
  IF k IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): the record holds no client write privilege; there is nothing to restore.';
  END IF;

  -- Restore entry by entry, from k on, in the recorded order.
  FOR item IN
    SELECT u.o, u.a,
           (SELECT x.grantee FROM aclexplode(ARRAY[u.a]) x LIMIT 1) AS grantee,
           (SELECT x.grantor FROM aclexplode(ARRAY[u.a]) x LIMIT 1) AS grantor
      FROM unnest(recorded) WITH ORDINALITY u(a, o)
     WHERE u.o >= k ORDER BY u.o
  LOOP
    IF item.grantor <> me THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): recorded entry % was granted by %, not %; it cannot be re-created exactly.', item.a, item.grantor::regrole, current_user;
    END IF;
    IF item.grantee = (SELECT relowner FROM pg_class WHERE oid = rel) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3364 rollback): the owner''s entry follows a client entry in the record; its position cannot be restored.';
    END IF;
    IF item.grantee = 0 OR item.grantee IN ('anon'::regrole, 'authenticated'::regrole) THEN
      -- A client entry: re-grant its recorded write privileges (its other
      -- privileges were never revoked and are still in place).
      FOR priv IN SELECT x.privilege_type, x.is_grantable FROM aclexplode(ARRAY[item.a]) x WHERE x.privilege_type = ANY (writes) LOOP
        EXECUTE format('GRANT %s ON TABLE public.pulse_geo_tags TO %s%s', priv.privilege_type,
                       CASE WHEN item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(item.grantee::regrole::text) END,
                       CASE WHEN priv.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    ELSE
      -- Any other entry after it (service_role): re-issue exactly its recorded
      -- privileges so that it follows the client entries again.
      EXECUTE format('REVOKE ALL ON TABLE public.pulse_geo_tags FROM %I', item.grantee::regrole::text);
      FOR priv IN SELECT x.privilege_type, x.is_grantable FROM aclexplode(ARRAY[item.a]) x LOOP
        EXECUTE format('GRANT %s ON TABLE public.pulse_geo_tags TO %I%s', priv.privilege_type, item.grantee::regrole::text,
                       CASE WHEN priv.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    END IF;
  END LOOP;

  -- Exact, or nothing.
  IF (SELECT relacl::text FROM pg_class WHERE oid = rel) IS DISTINCT FROM recorded::text THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3364 rollback): the restored ACL % is not the recorded %.',
      (SELECT relacl::text FROM pg_class WHERE oid = rel), recorded::text;
  END IF;

  EXECUTE format('COMMENT ON TABLE public.pulse_geo_tags IS %L', prior);
END $$;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3364_pulse_geo_tags_write_boundary.sql';

COMMIT;

-- ── Postconditions: the writes are back, the record is gone, and so is the ledger row ──
DO $post$
DECLARE
  rel regclass := 'public.pulse_geo_tags'::regclass;
BEGIN
  -- 3364's precondition required both roles to hold these three; the record
  -- restored them.
  IF NOT (has_table_privilege('anon', rel, 'INSERT') AND has_table_privilege('anon', rel, 'UPDATE') AND has_table_privilege('anon', rel, 'DELETE')
          AND has_table_privilege('authenticated', rel, 'INSERT') AND has_table_privilege('authenticated', rel, 'UPDATE') AND has_table_privilege('authenticated', rel, 'DELETE')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364 rollback): the client roles do not hold INSERT, UPDATE and DELETE on pulse_geo_tags again.';
  END IF;
  IF coalesce(obj_description(rel, 'pg_class'), '') LIKE '%3364 (census-media 44.18)%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364 rollback): the 3364 record is still in the table comment.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3364_pulse_geo_tags_write_boundary.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364 rollback): the ledger still records 3364 as applied.';
  END IF;
END $post$;
