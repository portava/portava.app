-- 3365_post_media_write_boundary.sql
-- post_media: what 2158 meant for client writes, as a narrowing only, safe in
-- any order with 3363 (census-media §44.18.3, lane G1).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it. It changes what the public key can write
-- to a live table, so it needs the owner's production approval (census-media
-- §44.18.5 is the approval step: order, verification, recovery).
--
-- ── THE DEFECT (census-media §44.15.1, the integrator's production read) ────
-- Production's ledger records 2158_post_media_write_boundary.sql as `backfill`,
-- but its grants are not in force: anon and authenticated hold table-level
-- INSERT and DELETE on post_media, with no column ACLs. The owner-insert policy
-- pins moderation_status = 'pending' and owned, unmoderated storage paths; it
-- does not pin processing_status, canonical_place_id, stamp_overlay, phash,
-- dedup_processed, feed_storage_path or feed_url. post_media_public_select
-- admits processing_status = 'ready' with moderation 'pending'. Executed on the
-- local harness in production's shape: the owner inserted a row as 'ready',
-- with a canonical_place_id and a stamp_overlay label, skipping processing, and
-- another signed-in user read it. That is the defect 2158's header describes.
--
-- ── WHY NOT RUN 2158 ITSELF (measured on the harness, census-media §44.18.3) ─
-- * After 3363, 2158 does not refuse: it applies, its postcondition passes, and
--   its REVOKE ALL + table-level GRANT SELECT undoes 3363 on post_media —
--   canonical_place_id and stamp_overlay become readable by anon again.
-- * On production it would WIDEN writes: it grants authenticated column UPDATE
--   on 12 descriptor columns, and production's clients hold no UPDATE on
--   post_media at all (2098 revoked it).
-- 2158 is frozen history and stays unedited; its `backfill` row stays as it is.
--
-- ── WHAT IT DOES: 2158's end state for writes, intersected with what is held ─
-- * anon and PUBLIC: no write privilege on post_media (2158 granted anon none).
-- * authenticated: no table-level write privilege. Column INSERT only on 2158's
--   14 descriptor columns, and only those it could already insert; column
--   UPDATE only on 2158's 12, and only those it could already update. So
--   nothing is ever granted that was not held: on production UPDATE stays
--   absent, and INSERT narrows from every column to the 14.
-- * DELETE, TRUNCATE, REFERENCES and TRIGGER: revoked from the client roles.
--   2158 revoked DELETE too; no client code deletes post_media rows (the app
--   removes storage objects through the storage API, never table rows).
-- * SELECT is not touched, table- or column-level: 3363's grants (or the
--   table-level SELECT without 3363) stay exactly as they are.
-- * No policy, row, service_role privilege or other table changes.
-- On the tree, where 2158 is in force, this is a byte-identical no-op.
--
-- ── HOW THE ROLLBACK RESTORES THE EXACT PRIOR PRIVILEGES ────────────────────
-- As 3364: the table's ACL, and the client roles' column write grants, as they
-- were, are recorded in the table's comment (after any comment it already had),
-- and the rollback restores from that record and refuses if anything else
-- changed meanwhile.
--
-- Rollback: db/rollback/2026-09-27-3365-post-media-write-boundary-rollback.sql
-- (restores the record, restores the prior comment, deletes this file's ledger
-- row, and with them re-opens the defect where it existed).

BEGIN;

DO $$
DECLARE
  rel     regclass := to_regclass('public.post_media');
  me      oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  prior   text;
  bad     text;
  colw    jsonb;
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365): public.post_media does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = rel) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365): RLS is not enabled on post_media.';
  END IF;
  IF (SELECT relowner FROM pg_class WHERE oid = rel) <> me THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365): % does not own post_media; the rollback could not restore its ACL exactly.', current_user;
  END IF;
  prior := obj_description(rel, 'pg_class');
  IF prior LIKE '%3365 (census-media 44.18.3)%' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365): post_media already carries 3365''s record; 3365 is applied.';
  END IF;
  -- The columns 2158 named must all exist.
  SELECT string_agg(c, ', ') INTO bad
    FROM unnest(ARRAY['post_id','user_id','media_type','storage_bucket','storage_path','public_url','thumbnail_url',
                      'thumbnail_storage_path','mime_type','file_size_bytes','duration_seconds','width','height','sort_order']) c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = c AND NOT attisdropped);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365): post_media lacks 2158''s descriptor column(s): %.', bad;
  END IF;

  -- Every client-role write privilege, table- or column-level, was granted by
  -- the role applying this, without grant option: so REVOKE removes it and the
  -- rollback can re-create it with the same grantor.
  SELECT string_agg(e, ', ') INTO bad FROM (
    SELECT format('%s:%s/%s%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type,
                  x.grantor::regrole::text, CASE WHEN x.is_grantable THEN '+grant' ELSE '' END) AS e
      FROM pg_class c, LATERAL aclexplode(c.relacl) x
     WHERE c.oid = rel AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
       AND x.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
       AND (x.is_grantable OR x.grantor <> me)
    UNION ALL
    SELECT format('%s.%s:%s/%s%s', a.attname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type,
                  x.grantor::regrole::text, CASE WHEN x.is_grantable THEN '+grant' ELSE '' END)
      FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = rel AND a.attnum > 0
       AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
       AND x.privilege_type IN ('INSERT','UPDATE','REFERENCES')
       AND (x.is_grantable OR x.grantor <> me)) d;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365): client-role write privileges not granted plainly by %: %.', current_user, bad;
  END IF;
  -- Column-level write grants may exist only for authenticated (2158's shape).
  SELECT string_agg(a.attname || ':' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END || ':' || x.privilege_type, ', ')
    INTO bad
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = rel AND a.attnum > 0 AND x.privilege_type <> 'SELECT'
     AND x.grantee <> 'authenticated'::regrole;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3365): post_media carries column-level write privileges for a role other than authenticated (%); not a shape this was written against.', bad;
  END IF;

  -- The record, and what authenticated could write before, for the next blocks.
  SELECT coalesce(jsonb_object_agg(p, cols), '{}'::jsonb) INTO colw FROM (
    SELECT x.privilege_type AS p, jsonb_agg(a.attname ORDER BY a.attnum) AS cols
      FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = rel AND a.attnum > 0 AND x.grantee = 'authenticated'::regrole AND x.privilege_type <> 'SELECT'
     GROUP BY x.privilege_type) g;
  PERFORM set_config('g1_3365.relacl_before', (SELECT relacl::text FROM pg_class WHERE oid = rel), true);
  PERFORM set_config('g1_3365.colwrites_before', colw::text, true);
  PERFORM set_config('g1_3365.insertable_before',
    coalesce((SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
               WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped
                 AND has_column_privilege('authenticated', rel, attnum, 'INSERT')), ''), true);
  PERFORM set_config('g1_3365.updatable_before',
    coalesce((SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
               WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped
                 AND has_column_privilege('authenticated', rel, attnum, 'UPDATE')), ''), true);
  PERFORM set_config('g1_3365.select_before',
    (SELECT coalesce(string_agg(e, ';' ORDER BY e), '') FROM (
       SELECT '' || '|' || x.grantee || '|' || x.is_grantable AS e FROM pg_class c, LATERAL aclexplode(c.relacl) x WHERE c.oid = rel AND x.privilege_type = 'SELECT'
       UNION ALL
       SELECT a.attname || '|' || x.grantee || '|' || x.is_grantable FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
        WHERE a.attrelid = rel AND a.attnum > 0 AND x.privilege_type = 'SELECT') s), true);
END $$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.post_media
  FROM anon, authenticated, PUBLIC;

DO $$
DECLARE
  rel        regclass := 'public.post_media'::regclass;
  ins_ok     text[] := ARRAY['post_id','user_id','media_type','storage_bucket','storage_path','public_url','thumbnail_url',
                             'thumbnail_storage_path','mime_type','file_size_bytes','duration_seconds','width','height','sort_order'];
  upd_ok     text[] := ARRAY['media_type','storage_bucket','storage_path','public_url','thumbnail_url',
                             'thumbnail_storage_path','mime_type','file_size_bytes','duration_seconds','width','height','sort_order'];
  had_ins    text[] := string_to_array(nullif(current_setting('g1_3365.insertable_before'), ''), ',');
  had_upd    text[] := string_to_array(nullif(current_setting('g1_3365.updatable_before'), ''), ',');
  give_ins   text[];
  give_upd   text[];
  prior      text := obj_description('public.post_media'::regclass, 'pg_class');
  record     text;
BEGIN
  -- Re-grant the allowlisted columns authenticated could already write; never more.
  SELECT array_agg(c ORDER BY o) INTO give_ins FROM unnest(ins_ok) WITH ORDINALITY u(c, o) WHERE c = ANY (coalesce(had_ins, '{}'));
  SELECT array_agg(c ORDER BY o) INTO give_upd FROM unnest(upd_ok) WITH ORDINALITY u(c, o) WHERE c = ANY (coalesce(had_upd, '{}'));
  IF give_ins IS NOT NULL THEN
    EXECUTE format('GRANT INSERT (%s) ON TABLE public.post_media TO authenticated',
                   (SELECT string_agg(quote_ident(c), ', ') FROM unnest(give_ins) c));
  END IF;
  IF give_upd IS NOT NULL THEN
    EXECUTE format('GRANT UPDATE (%s) ON TABLE public.post_media TO authenticated',
                   (SELECT string_agg(quote_ident(c), ', ') FROM unnest(give_upd) c));
  END IF;

  -- In-transaction assertion: SELECT, at every level and for every role, is
  -- exactly what it was.
  IF current_setting('g1_3365.select_before') IS DISTINCT FROM
     (SELECT coalesce(string_agg(e, ';' ORDER BY e), '') FROM (
        SELECT '' || '|' || x.grantee || '|' || x.is_grantable AS e FROM pg_class c, LATERAL aclexplode(c.relacl) x WHERE c.oid = rel AND x.privilege_type = 'SELECT'
        UNION ALL
        SELECT a.attname || '|' || x.grantee || '|' || x.is_grantable FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
         WHERE a.attrelid = rel AND a.attnum > 0 AND x.privilege_type = 'SELECT') s) THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3365): a SELECT privilege on post_media changed; 3365 touches writes only.';
  END IF;

  record := '3365 (census-media 44.18.3): anon and PUBLIC may not write this table; authenticated may insert and update '
         || 'only 2158''s descriptor columns, and only those it could before; every other write is the API''s, as service_role. '
         || 'Column writes before 3365: ' || current_setting('g1_3365.colwrites_before')
         || ' ACL before 3365, which its rollback restores: ' || current_setting('g1_3365.relacl_before');
  EXECUTE format('COMMENT ON TABLE public.post_media IS %L',
                 CASE WHEN prior IS NULL THEN record ELSE prior || E'\n\n' || record END);
END $$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE
  rel      regclass := 'public.post_media'::regclass;
  descr    text := obj_description('public.post_media'::regclass, 'pg_class');
  ins_ok   text[] := ARRAY['post_id','user_id','media_type','storage_bucket','storage_path','public_url','thumbnail_url',
                           'thumbnail_storage_path','mime_type','file_size_bytes','duration_seconds','width','height','sort_order'];
  upd_ok   text[] := ARRAY['media_type','storage_bucket','storage_path','public_url','thumbnail_url',
                           'thumbnail_storage_path','mime_type','file_size_bytes','duration_seconds','width','height','sort_order'];
  leak     text;
BEGIN
  -- anon: no write of any kind.
  SELECT string_agg(p, ', ') INTO leak FROM unnest(ARRAY['INSERT','UPDATE','REFERENCES']) p WHERE has_any_column_privilege('anon', rel, p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3365): anon can still write columns of post_media: %.', leak;
  END IF;
  -- Neither client role: DELETE, TRUNCATE, TRIGGER.
  SELECT string_agg(r || ':' || p, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['DELETE','TRUNCATE','TRIGGER']) p
   WHERE has_table_privilege(r, rel, p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3365): a client role still holds a table write privilege on post_media: %.', leak;
  END IF;
  -- authenticated: INSERT/UPDATE only inside 2158's allowlists, no REFERENCES.
  SELECT string_agg(a.attname || ':' || p, ', ') INTO leak
    FROM pg_attribute a, unnest(ARRAY['INSERT','UPDATE','REFERENCES']) p
   WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege('authenticated', rel, a.attnum, p)
     AND NOT ((p = 'INSERT' AND a.attname::text = ANY (ins_ok)) OR (p = 'UPDATE' AND a.attname::text = ANY (upd_ok)));
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3365): authenticated can write server-owned post_media column(s): %.', leak;
  END IF;
  -- The API's writer is untouched.
  IF NOT (has_table_privilege('service_role', rel, 'INSERT') AND has_table_privilege('service_role', rel, 'UPDATE')
          AND has_table_privilege('service_role', rel, 'DELETE') AND has_table_privilege('service_role', rel, 'SELECT')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3365): service_role lost a privilege on post_media; the API would break.';
  END IF;
  -- The rollback's record is there and parses.
  IF substring(descr FROM 'ACL before 3365, which its rollback restores: (\{[^}]*\})$')::aclitem[] IS NULL
     OR substring(descr FROM 'Column writes before 3365: (\{.*\}) ACL before 3365')::jsonb IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3365): the record the rollback restores from is missing from the table comment.';
  END IF;
END $post$;
