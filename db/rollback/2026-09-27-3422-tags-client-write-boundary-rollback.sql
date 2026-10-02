-- Rollback for 3422_tags_client_write_boundary.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3422 DID
-- =============
--   * REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
--     public.tags FROM anon, authenticated, PUBLIC;
--   * recorded the table's whole ACL, as it was, at the end of the table's
--     comment (after any comment the table already had).
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores the recorded ACL, and only it: whatever the client roles held
-- before 3422 — GRANT ALL where 2490 is not applied (the tree, the harness),
-- SELECT/INSERT/UPDATE/DELETE where 2490 had removed TRUNCATE, REFERENCES,
-- TRIGGER and MAINTAIN — comes back, and nothing more. It never widens past the
-- recorded state. The mechanism is 3364's rollback, applied to public.tags:
--   * Entries are restored in the recorded order: a client entry 3422 emptied
--     is re-granted, and every later non-owner entry (service_role) is
--     revoked and re-granted with exactly its recorded privileges so that it
--     lands after it again. The result is asserted equal to the record, as
--     text, inside this transaction.
--   * It refuses if any privilege outside the client roles' writes differs
--     from the record: something else changed since 3422, and restoring the
--     record would undo it.
--   * The comment returns to what it was before 3422 (none, on the tree).
--   * It deletes 3422's schema_migration_ledger row, so a later run of
--     scripts/src/apply-migrations.ts re-applies 3422.
--   * No policy is touched, because 3422 touched none.
--
-- ⚠ IT RE-OPENS THE DEFECT 3422 CLOSED: a signed-in client can again INSERT a
-- tag directly, naming a user whose tag_permission is 'nobody', on a post it
-- does not own, and the row lands 'approved' — bypassing the source check, the
-- approval gate, the caps and disable_tagging (census-discovery §59.1 DV-76).
-- Use it only to recover from a writer 3422 broke; census-discovery §62.4 found
-- none.
--
-- It changes no row other than the ledger's.

BEGIN;

DO $$
DECLARE
  rel       regclass := to_regclass('public.tags');
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
    RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): public.tags does not exist.';
  END IF;
  IF (SELECT relowner FROM pg_class WHERE oid = rel) <> me THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): % does not own tags; the recorded ACL could not be restored exactly.', current_user;
  END IF;

  descr := obj_description(rel, 'pg_class');
  recorded := substring(descr FROM 'ACL before 3422, which its rollback restores: (\{[^}]*\})$')::aclitem[];
  IF recorded IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): tags carries no 3422 ACL record; this is not the state 3422 left.';
  END IF;
  prior := CASE WHEN descr LIKE '3422 (census-discovery 62):%' THEN NULL
                ELSE substring(descr FROM '^(.*)\n\n3422 \(census-discovery 62\):') END;
  IF descr NOT LIKE '3422 (census-discovery 62):%' AND prior IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): the comment on tags is not in the shape 3422 wrote.';
  END IF;

  -- 3422's state: no client role or PUBLIC holds a write privilege.
  SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = rel AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     AND x.privilege_type = ANY (writes);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): client roles already hold write privileges on tags (%); this is not the state 3422 left.', bad;
  END IF;

  -- Everything 3422 did not revoke must still be what was recorded; otherwise
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
    RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): tags privileges other than the client writes changed since 3422 (%); restoring the record would undo that. Refusing.', bad;
  END IF;

  -- The first recorded entry that 3422 changed: a client role holding a write.
  SELECT min(o) INTO k
    FROM unnest(recorded) WITH ORDINALITY u(a, o), LATERAL aclexplode(ARRAY[u.a]) x
   WHERE (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole)) AND x.privilege_type = ANY (writes);
  IF k IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): the record holds no client write privilege; there is nothing to restore.';
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
      RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): recorded entry % was granted by %, not %; it cannot be re-created exactly.', item.a, item.grantor::regrole, current_user;
    END IF;
    IF item.grantee = (SELECT relowner FROM pg_class WHERE oid = rel) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3422 rollback): the owner''s entry follows a client entry in the record; its position cannot be restored.';
    END IF;
    IF item.grantee = 0 OR item.grantee IN ('anon'::regrole, 'authenticated'::regrole) THEN
      -- A client entry: re-grant its recorded write privileges (its other
      -- privileges were never revoked and are still in place).
      FOR priv IN SELECT x.privilege_type, x.is_grantable FROM aclexplode(ARRAY[item.a]) x WHERE x.privilege_type = ANY (writes) LOOP
        EXECUTE format('GRANT %s ON TABLE public.tags TO %s%s', priv.privilege_type,
                       CASE WHEN item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(item.grantee::regrole::text) END,
                       CASE WHEN priv.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    ELSE
      -- Any other entry after it (service_role): re-issue exactly its recorded
      -- privileges so that it follows the client entries again.
      EXECUTE format('REVOKE ALL ON TABLE public.tags FROM %I', item.grantee::regrole::text);
      FOR priv IN SELECT x.privilege_type, x.is_grantable FROM aclexplode(ARRAY[item.a]) x LOOP
        EXECUTE format('GRANT %s ON TABLE public.tags TO %I%s', priv.privilege_type, item.grantee::regrole::text,
                       CASE WHEN priv.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    END IF;
  END LOOP;

  -- Exact, or nothing.
  IF (SELECT relacl::text FROM pg_class WHERE oid = rel) IS DISTINCT FROM recorded::text THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3422 rollback): the restored ACL % is not the recorded %.',
      (SELECT relacl::text FROM pg_class WHERE oid = rel), recorded::text;
  END IF;

  EXECUTE format('COMMENT ON TABLE public.tags IS %L', prior);
END $$;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3422_tags_client_write_boundary.sql';

COMMIT;

-- ── Postconditions: the writes are back, the record is gone, and so is the ledger row ──
DO $post$
DECLARE
  rel regclass := 'public.tags'::regclass;
BEGIN
  -- 3422's precondition required both roles to hold these three; the record
  -- restored them.
  IF NOT (has_table_privilege('anon', rel, 'INSERT') AND has_table_privilege('anon', rel, 'UPDATE') AND has_table_privilege('anon', rel, 'DELETE')
          AND has_table_privilege('authenticated', rel, 'INSERT') AND has_table_privilege('authenticated', rel, 'UPDATE') AND has_table_privilege('authenticated', rel, 'DELETE')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422 rollback): the client roles do not hold INSERT, UPDATE and DELETE on tags again.';
  END IF;
  IF coalesce(obj_description(rel, 'pg_class'), '') LIKE '%3422 (census-discovery 62)%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422 rollback): the 3422 record is still in the table comment.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3422_tags_client_write_boundary.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422 rollback): the ledger still records 3422 as applied.';
  END IF;
END $post$;
