-- Rollback for 3365_post_media_write_boundary.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3365 DID
-- =============
--   * REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
--     public.post_media FROM anon, authenticated, PUBLIC;
--   * GRANT back to authenticated column INSERT / UPDATE on 2158's descriptor
--     columns, only those it could write before;
--   * recorded the table's ACL and authenticated's column write grants, as they
--     were, at the end of the table's comment.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores the record, and only it. On production (census-media §44.15.1)
-- that is table-level INSERT and DELETE for anon and authenticated, with no
-- column write grants; on the tree it is 2158's column grants, which 3365
-- left as they were. It never widens past the recorded state.
--   * Client table-level write entries come back in the recorded order; any
--     later non-owner entry (service_role) is revoked and re-granted with
--     exactly its recorded privileges so that it follows them again. The
--     table ACL is asserted equal to the record, as text, in this transaction.
--   * authenticated's column write grants come back exactly as recorded, and
--     are asserted equal to the record.
--   * It refuses if SELECT, or any privilege of another role, differs from the
--     record: something else changed since 3365.
--   * The comment returns to what it was before 3365.
--   * It deletes 3365's schema_migration_ledger row, so a later run of
--     scripts/src/apply-migrations.ts re-applies 3365.
--
-- ⚠ ON PRODUCTION IT RE-OPENS THE DEFECT 3365 CLOSED: an owner can again insert
-- their own media as processing_status 'ready', with a canonical_place_id and
-- a stamp_overlay, skipping processing, and other users read it (census-media
-- §44.18.3). Use it only to recover from a writer 3365 broke.
--
-- It changes no row other than the ledger's.

BEGIN;

DO $$
DECLARE
  rel       regclass := to_regclass('public.post_media');
  me        oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  writes    text[] := ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  descr     text;
  recorded  aclitem[];
  colw      jsonb;
  bad       text;
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): public.post_media does not exist.';
  END IF;
  IF (SELECT relowner FROM pg_class WHERE oid = rel) <> me THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): % does not own post_media; the recorded ACL could not be restored exactly.', current_user;
  END IF;
  descr := obj_description(rel, 'pg_class');
  recorded := substring(descr FROM 'ACL before 3365, which its rollback restores: (\{[^}]*\})$')::aclitem[];
  colw := substring(descr FROM 'Column writes before 3365: (\{.*\}) ACL before 3365')::jsonb;
  IF recorded IS NULL OR colw IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): post_media carries no 3365 record; this is not the state 3365 left.';
  END IF;
  IF descr NOT LIKE '3365 (census-media 44.18.3):%' AND substring(descr FROM '^(.*)\n\n3365 \(census-media 44\.18\.3\):') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): the comment on post_media is not in the shape 3365 wrote.';
  END IF;

  -- 3365's state: no client table-level write; anon and PUBLIC write nothing.
  SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = rel AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     AND x.privilege_type = ANY (writes);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): client roles hold table-level writes on post_media (%); this is not the state 3365 left.', bad;
  END IF;

  -- Everything that is not a client write must still be what was recorded.
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
    RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): post_media privileges other than the client writes changed since 3365 (%); restoring the record would undo that. Refusing.', bad;
  END IF;

  PERFORM set_config('g1_3365rb.recorded', recorded::text, true);
  PERFORM set_config('g1_3365rb.colw', colw::text, true);
  PERFORM set_config('g1_3365rb.prior',
    coalesce(CASE WHEN descr LIKE '3365 (census-media 44.18.3):%' THEN NULL
                  ELSE substring(descr FROM '^(.*)\n\n3365 \(census-media 44\.18\.3\):') END, E'\x01'), true);
END $$;

-- Clear what 3365 left (authenticated's allowlisted column grants).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.post_media
  FROM anon, authenticated, PUBLIC;

DO $$
DECLARE
  rel       regclass := 'public.post_media'::regclass;
  me        oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  writes    text[] := ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  recorded  aclitem[] := current_setting('g1_3365rb.recorded')::aclitem[];
  colw      jsonb := current_setting('g1_3365rb.colw')::jsonb;
  prior     text := nullif(current_setting('g1_3365rb.prior'), E'\x01');
  k         int;
  item      record;
  priv      record;
  p         text;
  now_colw  jsonb;
BEGIN
  -- Table level: from the first recorded client write entry on, in order.
  SELECT min(o) INTO k
    FROM unnest(recorded) WITH ORDINALITY u(a, o), LATERAL aclexplode(ARRAY[u.a]) x
   WHERE (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole)) AND x.privilege_type = ANY (writes);
  IF k IS NOT NULL THEN
    FOR item IN
      SELECT u.o, u.a,
             (SELECT x.grantee FROM aclexplode(ARRAY[u.a]) x LIMIT 1) AS grantee,
             (SELECT x.grantor FROM aclexplode(ARRAY[u.a]) x LIMIT 1) AS grantor
        FROM unnest(recorded) WITH ORDINALITY u(a, o) WHERE u.o >= k ORDER BY u.o
    LOOP
      IF item.grantor <> me THEN
        RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): recorded entry % was granted by %, not %; it cannot be re-created exactly.', item.a, item.grantor::regrole, current_user;
      END IF;
      IF item.grantee = (SELECT relowner FROM pg_class WHERE oid = rel) THEN
        RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): the owner''s entry follows a client entry in the record; its position cannot be restored.';
      END IF;
      IF item.grantee = 0 OR item.grantee IN ('anon'::regrole, 'authenticated'::regrole) THEN
        FOR priv IN SELECT x.privilege_type, x.is_grantable FROM aclexplode(ARRAY[item.a]) x WHERE x.privilege_type = ANY (writes) LOOP
          EXECUTE format('GRANT %s ON TABLE public.post_media TO %s%s', priv.privilege_type,
                         CASE WHEN item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(item.grantee::regrole::text) END,
                         CASE WHEN priv.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
      ELSE
        EXECUTE format('REVOKE ALL ON TABLE public.post_media FROM %I', item.grantee::regrole::text);
        FOR priv IN SELECT x.privilege_type, x.is_grantable FROM aclexplode(ARRAY[item.a]) x LOOP
          EXECUTE format('GRANT %s ON TABLE public.post_media TO %I%s', priv.privilege_type, item.grantee::regrole::text,
                         CASE WHEN priv.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  -- Column level: authenticated's recorded write grants.
  FOR p IN SELECT jsonb_object_keys(colw) LOOP
    IF p NOT IN ('INSERT','UPDATE','REFERENCES') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3365 rollback): the record holds an unexpected column privilege %.', p;
    END IF;
    EXECUTE format('GRANT %s (%s) ON TABLE public.post_media TO authenticated', p,
                   (SELECT string_agg(quote_ident(c), ', ') FROM jsonb_array_elements_text(colw -> p) c));
  END LOOP;

  -- Exact, or nothing.
  IF (SELECT relacl::text FROM pg_class WHERE oid = rel) IS DISTINCT FROM recorded::text THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3365 rollback): the restored ACL % is not the recorded %.',
      (SELECT relacl::text FROM pg_class WHERE oid = rel), recorded::text;
  END IF;
  SELECT coalesce(jsonb_object_agg(q, cols), '{}'::jsonb) INTO now_colw FROM (
    SELECT x.privilege_type AS q, jsonb_agg(a.attname ORDER BY a.attnum) AS cols
      FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = rel AND a.attnum > 0 AND x.grantee = 'authenticated'::regrole AND x.privilege_type <> 'SELECT'
     GROUP BY x.privilege_type) g;
  IF now_colw IS DISTINCT FROM colw THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3365 rollback): the restored column writes % are not the recorded %.', now_colw, colw;
  END IF;

  EXECUTE format('COMMENT ON TABLE public.post_media IS %L', prior);
END $$;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3365_post_media_write_boundary.sql';

COMMIT;

-- ── Postconditions: the record is gone, and so is the ledger row ────────────
DO $post$
BEGIN
  IF coalesce(obj_description('public.post_media'::regclass, 'pg_class'), '') LIKE '%3365 (census-media 44.18.3)%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3365 rollback): the 3365 record is still in the table comment.';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.post_media', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3365 rollback): service_role lost INSERT on post_media.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3365_post_media_write_boundary.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3365 rollback): the ledger still records 3365 as applied.';
  END IF;
END $post$;
