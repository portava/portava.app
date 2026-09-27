-- 3364_pulse_geo_tags_write_boundary.sql
-- pulse_geo_tags: no client role may write it (census-media §44.18, lane G1).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it. It changes what the public anon key can
-- write to a live table, so it needs the owner's production approval
-- (census-media §44.18.5 is the approval step: order, verification, recovery).
--
-- ── THE DEFECT (census-media §44.16, item 1) ────────────────────────────────
-- The baseline gives anon and authenticated GRANT ALL on pulse_geo_tags, and
-- its write policies check only `auth.uid() = user_id`, never that the POST is
-- the caller's. Executed on the local harness (3363 applied, which changes no
-- write): a signed-in stranger INSERTed a tag with venue_name 'Forged Venue'
-- for another author's post, and succeeded. The table allows one tag per post
-- (pgt_post_uniq), so any post the API has not yet tagged is open to this,
-- and Pulse serves the tag's venue. An author may also rewrite their own
-- tag's venue, visibility and hotel_blur_applied, which the API computed.
--
-- ── WHO WRITES IT (census-media §44.18.1) ───────────────────────────────────
-- * The API, as service_role: services/location/PulseGeoTagService is the one
--   writer (two INSERTs), called from POST /posts with getServiceClient().
-- * Nothing else. No client code (app, legacy root app, scripts, archived
--   copies; tree and git history) writes it; there is no edge function; no
--   function, trigger, rule or view in the database names it; no client role
--   may DELETE any of its three foreign-key parents, so no client-caused
--   cascade reaches it (and RI actions run as the table owner regardless).
-- So no client write is legitimate, and the narrow alternative (an author-only
-- WITH CHECK) would keep a write path nothing uses. Chosen: revoke.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
-- REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON pulse_geo_tags
-- FROM anon, authenticated and PUBLIC. Nothing else:
--   * SELECT is untouched: the column grants 3363 made (or the table-level
--     SELECT, where 3363 is not applied) stay exactly as they are.
--   * MAINTAIN (PostgreSQL 17) is not named: it writes no data, PostgreSQL 16
--     cannot parse it, and 2490 revokes it database-wide.
--   * No policy changes. pgt_insert_own, pgt_update_own and pgt_delete_own
--     stay, and grant nothing any more to a role without the privilege.
--   * service_role is untouched.
--
-- ── HOW THE ROLLBACK RESTORES THE EXACT PRIOR PRIVILEGES ────────────────────
-- What the client roles held before depends on the database: GRANT ALL
-- (awdDxt) where 2490 is not applied (the tree, the harness), INSERT/UPDATE/
-- DELETE only where it is. So this file records the table's whole ACL, as it
-- was, in the table's comment (with any comment the table already had kept in
-- front of it), and the rollback restores from that record, entry by entry and
-- in order, and refuses if anything else about the ACL changed meanwhile.
--
-- Rollback: db/rollback/2026-09-27-3364-pulse-geo-tags-write-boundary-rollback.sql
-- (restores the recorded ACL byte for byte, restores the prior comment, deletes
-- this file's ledger row, and with them re-opens the defect).

BEGIN;

DO $$
DECLARE
  rel     regclass := to_regclass('public.pulse_geo_tags');
  bad     text;
  prior   text;
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364): public.pulse_geo_tags does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = rel) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364): RLS is not enabled on pulse_geo_tags.';
  END IF;
  -- The rollback re-issues grants as the role applying this; it must own the
  -- table so that grantor and ACL order come back exactly.
  IF (SELECT relowner FROM pg_class WHERE oid = rel) <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364): % does not own pulse_geo_tags; the rollback could not restore its ACL exactly.', current_user;
  END IF;

  prior := obj_description(rel, 'pg_class');
  IF prior LIKE '%3364 (census-media 44.18)%' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364): pulse_geo_tags already carries 3364''s record; 3364 is applied.';
  END IF;

  -- The defect is present: anon and authenticated each hold INSERT, UPDATE
  -- and DELETE at table level. Anything else is not the state this was
  -- written against.
  SELECT string_agg(r || ':' || p, ', ') INTO bad
    FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['INSERT','UPDATE','DELETE']) p
   WHERE NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
                      WHERE c.oid = rel AND x.grantee = r::regrole AND x.privilege_type = p);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364): client roles do not hold the table-level write privileges this revokes (missing %).', bad;
  END IF;

  -- Every client-role write privilege was granted by the role applying this,
  -- without grant option, so that REVOKE removes it and the rollback can
  -- re-create it with the same grantor.
  SELECT string_agg(format('%s:%s/%s%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
                           x.privilege_type, x.grantor::regrole::text, CASE WHEN x.is_grantable THEN '+grant' ELSE '' END), ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = rel
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     AND x.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
     AND (x.is_grantable OR x.grantor <> (SELECT oid FROM pg_roles WHERE rolname = current_user));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364): client-role write privileges not granted plainly by %: %.', current_user, bad;
  END IF;

  -- No column-level write privilege for a client role: a table-level REVOKE
  -- would remove it too, and the recorded table ACL would not bring it back.
  SELECT string_agg(a.attname || ':' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END || ':' || x.privilege_type, ', ')
    INTO bad
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = rel AND a.attnum > 0 AND x.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3364): pulse_geo_tags carries column-level write privileges (%); the rollback could not restore them.', bad;
  END IF;

  -- Hand the pre-change state to the block after the REVOKE (transaction-local).
  PERFORM set_config('g1_3364.relacl_before', (SELECT relacl::text FROM pg_class WHERE oid = rel), true);
  PERFORM set_config('g1_3364.attacl_before',
    coalesce((SELECT string_agg(attname || '=' || coalesce(attacl::text, '-'), ';' ORDER BY attnum)
                FROM pg_attribute WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped), ''), true);
END $$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.pulse_geo_tags
  FROM anon, authenticated, PUBLIC;

DO $$
DECLARE
  rel     regclass := 'public.pulse_geo_tags'::regclass;
  before  aclitem[] := current_setting('g1_3364.relacl_before')::aclitem[];
  prior   text := obj_description('public.pulse_geo_tags'::regclass, 'pg_class');
  record  text;
  bad     text;
BEGIN
  -- In-transaction assertions: the REVOKE touched only the client roles'
  -- write privileges.
  IF current_setting('g1_3364.attacl_before') IS DISTINCT FROM
     coalesce((SELECT string_agg(attname || '=' || coalesce(attacl::text, '-'), ';' ORDER BY attnum)
                 FROM pg_attribute WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped), '') THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3364): a column-level privilege on pulse_geo_tags changed.';
  END IF;
  SELECT string_agg(e, ', ') INTO bad FROM (
    (SELECT format('%s|%s|%s|%s', x.grantor, x.grantee, x.privilege_type, x.is_grantable) AS e
       FROM aclexplode(before) x
      WHERE NOT ((x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
                 AND x.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'))
     EXCEPT
     SELECT format('%s|%s|%s|%s', x.grantor, x.grantee, x.privilege_type, x.is_grantable)
       FROM pg_class c, LATERAL aclexplode(c.relacl) x WHERE c.oid = rel)
    UNION ALL
    (SELECT format('%s|%s|%s|%s', x.grantor, x.grantee, x.privilege_type, x.is_grantable)
       FROM pg_class c, LATERAL aclexplode(c.relacl) x WHERE c.oid = rel
     EXCEPT
     SELECT format('%s|%s|%s|%s', x.grantor, x.grantee, x.privilege_type, x.is_grantable)
       FROM aclexplode(before) x)) d;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3364): the REVOKE changed a privilege it should not have: %.', bad;
  END IF;

  -- The record the rollback restores from: the whole ACL as it was, after any
  -- comment the table already had.
  record := '3364 (census-media 44.18): anon, authenticated and PUBLIC may not write this table; '
         || 'its one writer is the API as service_role (services/location/PulseGeoTagService). '
         || 'ACL before 3364, which its rollback restores: ' || before::text;
  EXECUTE format('COMMENT ON TABLE public.pulse_geo_tags IS %L',
                 CASE WHEN prior IS NULL THEN record ELSE prior || E'\n\n' || record END);
END $$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE
  rel      regclass := 'public.pulse_geo_tags'::regclass;
  descr    text := obj_description('public.pulse_geo_tags'::regclass, 'pg_class');
  recorded aclitem[];
  leak     text;
  svc      text;
BEGIN
  -- No client role, directly or through PUBLIC, may write a row, a column,
  -- or the table as a whole.
  SELECT string_agg(r || ':' || p, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['INSERT','UPDATE','REFERENCES']) p
   WHERE has_any_column_privilege(r, rel, p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364): a client role can still write columns of pulse_geo_tags: %.', leak;
  END IF;
  SELECT string_agg(r || ':' || p, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['DELETE','TRUNCATE','TRIGGER']) p
   WHERE has_table_privilege(r, rel, p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364): a client role still holds a table write privilege on pulse_geo_tags: %.', leak;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
              WHERE c.oid = rel AND x.grantee = 0
                AND x.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364): PUBLIC still holds a write privilege on pulse_geo_tags.';
  END IF;

  -- The API's writer is untouched.
  SELECT string_agg(p, ', ') INTO svc
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
   WHERE NOT has_table_privilege('service_role', rel, p);
  IF svc IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364): service_role lost % on pulse_geo_tags; the API would break.', svc;
  END IF;

  -- Reading is 3363's business and stays as it was: the client roles still
  -- read post_id (3363's grant, or the table-level SELECT without 3363).
  IF NOT has_column_privilege('anon', rel, 'post_id', 'SELECT')
     OR NOT has_column_privilege('authenticated', rel, 'post_id', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364): a client role lost SELECT on pulse_geo_tags; 3364 touches no read privilege.';
  END IF;

  -- The rollback's record is there and parses, and holds the defect it undoes.
  recorded := substring(descr FROM 'ACL before 3364, which its rollback restores: (\{[^}]*\})$')::aclitem[];
  IF recorded IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364): the ACL record the rollback restores from is missing from the table comment.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM aclexplode(recorded) x
                  WHERE x.grantee = 'authenticated'::regrole AND x.privilege_type = 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3364): the recorded ACL does not hold the client write privileges 3364 revoked.';
  END IF;
END $post$;
