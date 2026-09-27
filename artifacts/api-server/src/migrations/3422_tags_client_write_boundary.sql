-- 3422_tags_client_write_boundary.sql
-- public.tags: no client role may write it (census-discovery §62, DV-76; `12`
-- Phase 0.3, tagging Phase 0 #1).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it. It changes what the public anon key and a
-- signed-in client can write to a live table, so it needs the owner's production
-- approval (census-discovery §62.6 is the approval step: order, verification,
-- recovery).
--
-- ── THE DEFECT (census-discovery §59.1 DV-76, pinned by
--    src/test/db/discoveryVerifyPhase03.db.test.ts P1) ───────────────────────
-- The baseline gives anon and authenticated GRANT ALL on tags, and the only
-- INSERT policy is `tags_insert WITH CHECK (tagger_id = auth.uid())` — it
-- constrains who the TAGGER is, never whom or what is tagged. Executed on the
-- local harness: a signed-in client that skips POST /api/tags INSERTed a tag
-- naming a user whose tag_permission is 'nobody', on a post it does not own,
-- and the row landed with 0064's DEFAULT status 'approved'. That one statement
-- bypasses everything routes/tags.ts and TaggingService enforce: the source
-- authorization (Phase 0 #1, assertMayTagSource), tag_permission and the
-- approval gate (#2's `pending` is never written), the hourly and per-source
-- caps, and the `disable_tagging` emergency stop (#3).
--
-- ── WHO WRITES IT (census-discovery §62.4) ──────────────────────────────────
-- * The API, as service_role, and nothing else:
--     routes/tags.ts            INSERT (POST /tags), UPDATE suppressed
--                               (DELETE /tags/:id), DELETE (admin) — each on
--                               getServiceClient() / requireAdmin's client;
--     services/tagging/TaggingService.ts  the inline-@mention UPSERT, reached
--                               from routes/posts.ts (x3), routes/messaging.ts
--                               and routes/postcards.ts, every one passing a
--                               getServiceClient() or requireUser() client —
--                               and requireUser's client IS the service client
--                               (lib/http.ts). The server constructs no
--                               user-scoped (JWT) client at all: lib/supabase.ts
--                               is its only createClient outside scripts, and
--                               no script writes tags.
-- * No client code writes it: no `.from('tags')` in travel-buddy-standalone,
--   the legacy root app or any other tree; the client's tagging service calls
--   /api/tags only. No edge function exists.
-- * No function, trigger, rule or view in the database writes it (pg_proc
--   bodies searched on the harness: none names public.tags for a write; no
--   trigger is on tags; no view reads it). Its two foreign keys cascade FROM
--   profiles, and RI actions run as the table owner regardless of the caller.
-- So no client write is legitimate, and the narrow alternative (a restrictive
-- INSERT policy re-stating the route's rules in SQL) would keep a write path
-- nothing uses while duplicating rules that already drifted once (Phase 0 #1).
-- Chosen: revoke.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
-- REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.tags
-- FROM anon, authenticated and PUBLIC. INSERT, UPDATE and DELETE are the three
-- the route bypass uses. TRUNCATE is named because it ignores RLS entirely, and
-- REFERENCES and TRIGGER because 3364 set the precedent for a write boundary
-- and neither has a client use. Nothing else changes:
--   * SELECT is untouched: the parties-only reads (tags_select, tags_read_own:
--     tagger or tagged) are exactly as they were — same grant, same policies.
--   * MAINTAIN (PostgreSQL 17) is not named: it writes no data, PostgreSQL 16
--     cannot parse it, and 2490 revokes it database-wide.
--   * No policy changes. tags_insert stays and grants nothing any more to a
--     role without the privilege; tags_service_all is service_role's.
--   * service_role is untouched.
--
-- ── `10` §4 / `10` §5 ───────────────────────────────────────────────────────
-- No query path, index or table is added. `10` §5's four explicit operations for
-- a user-visible table: read = the two parties-only SELECT policies (kept);
-- insert, update and delete = refused to every client role by privilege, which
-- is explicit and checked below.
--
-- ── HOW THE ROLLBACK RESTORES THE EXACT PRIOR PRIVILEGES ────────────────────
-- What the client roles held before depends on the database: GRANT ALL
-- (arwdDxt) where 2490 is not applied (the tree, the harness), SELECT/INSERT/
-- UPDATE/DELETE where it is. So this file records the table's whole ACL, as it
-- was, in the table's comment (after any comment the table already had), and
-- the rollback restores from that record, entry by entry and in order, and
-- refuses if anything else about the ACL changed meanwhile — 3364's mechanism.
--
-- Rollback: db/rollback/2026-09-27-3422-tags-client-write-boundary-rollback.sql
-- (restores the recorded ACL byte for byte, restores the prior comment, deletes
-- this file's ledger row, and with them re-opens the defect).

BEGIN;

DO $$
DECLARE
  rel     regclass := to_regclass('public.tags');
  bad     text;
  prior   text;
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422): public.tags does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = rel) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422): RLS is not enabled on tags.';
  END IF;
  -- The rollback re-issues grants as the role applying this; it must own the
  -- table so that grantor and ACL order come back exactly.
  IF (SELECT relowner FROM pg_class WHERE oid = rel) <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422): % does not own tags; the rollback could not restore its ACL exactly.', current_user;
  END IF;

  prior := obj_description(rel, 'pg_class');
  IF prior LIKE '%3422 (census-discovery 62)%' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422): tags already carries 3422''s record; 3422 is applied.';
  END IF;

  -- The parties-only reads this must leave exactly as they are.
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = rel AND polcmd = 'r'
        AND polname IN ('tags_select', 'tags_read_own')) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422): the parties-only SELECT policies tags_select and tags_read_own are not both present; this is not the state 3422 was written against.';
  END IF;

  -- The defect is present: anon and authenticated each hold INSERT, UPDATE and
  -- DELETE at table level.
  SELECT string_agg(r || ':' || p, ', ') INTO bad
    FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['INSERT','UPDATE','DELETE']) p
   WHERE NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
                      WHERE c.oid = rel AND x.grantee = r::regrole AND x.privilege_type = p);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422): client roles do not hold the table-level write privileges this revokes (missing %).', bad;
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
    RAISE EXCEPTION 'PRECONDITION FAILED (3422): client-role write privileges not granted plainly by %: %.', current_user, bad;
  END IF;

  -- No column-level write privilege for a client role: a table-level REVOKE
  -- would remove it too, and the recorded table ACL would not bring it back.
  SELECT string_agg(a.attname || ':' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END || ':' || x.privilege_type, ', ')
    INTO bad
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = rel AND a.attnum > 0 AND x.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3422): tags carries column-level write privileges (%); the rollback could not restore them.', bad;
  END IF;

  -- Hand the pre-change state to the block after the REVOKE (transaction-local).
  PERFORM set_config('p15_3422.relacl_before', (SELECT relacl::text FROM pg_class WHERE oid = rel), true);
  PERFORM set_config('p15_3422.attacl_before',
    coalesce((SELECT string_agg(attname || '=' || coalesce(attacl::text, '-'), ';' ORDER BY attnum)
                FROM pg_attribute WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped), ''), true);
  PERFORM set_config('p15_3422.policies_before',
    (SELECT string_agg(format('%s|%s|%s|%s|%s', polname, polcmd, polroles::text,
                              coalesce(pg_get_expr(polqual, polrelid), '-'), coalesce(pg_get_expr(polwithcheck, polrelid), '-')), ';' ORDER BY polname)
       FROM pg_policy WHERE polrelid = rel), true);
END $$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.tags
  FROM anon, authenticated, PUBLIC;

DO $$
DECLARE
  rel     regclass := 'public.tags'::regclass;
  before  aclitem[] := current_setting('p15_3422.relacl_before')::aclitem[];
  prior   text := obj_description('public.tags'::regclass, 'pg_class');
  record  text;
  bad     text;
BEGIN
  -- In-transaction assertions: the REVOKE touched only the client roles'
  -- write privileges, and no policy.
  IF current_setting('p15_3422.attacl_before') IS DISTINCT FROM
     coalesce((SELECT string_agg(attname || '=' || coalesce(attacl::text, '-'), ';' ORDER BY attnum)
                 FROM pg_attribute WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped), '') THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3422): a column-level privilege on tags changed.';
  END IF;
  IF current_setting('p15_3422.policies_before') IS DISTINCT FROM
     (SELECT string_agg(format('%s|%s|%s|%s|%s', polname, polcmd, polroles::text,
                               coalesce(pg_get_expr(polqual, polrelid), '-'), coalesce(pg_get_expr(polwithcheck, polrelid), '-')), ';' ORDER BY polname)
        FROM pg_policy WHERE polrelid = rel) THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3422): a policy on tags changed; 3422 changes privileges only.';
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
    RAISE EXCEPTION 'ASSERTION FAILED (3422): the REVOKE changed a privilege it should not have: %.', bad;
  END IF;

  -- The record the rollback restores from: the whole ACL as it was, after any
  -- comment the table already had.
  record := '3422 (census-discovery 62): anon, authenticated and PUBLIC may not write this table; '
         || 'its writers are the API as service_role (routes/tags.ts, services/tagging/TaggingService.ts). '
         || 'ACL before 3422, which its rollback restores: ' || before::text;
  EXECUTE format('COMMENT ON TABLE public.tags IS %L',
                 CASE WHEN prior IS NULL THEN record ELSE prior || E'\n\n' || record END);
END $$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE
  rel      regclass := 'public.tags'::regclass;
  descr    text := obj_description('public.tags'::regclass, 'pg_class');
  recorded aclitem[];
  leak     text;
  svc      text;
BEGIN
  -- No client role, directly or through PUBLIC, may write a row, a column, or
  -- the table as a whole.
  SELECT string_agg(r || ':' || p, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['INSERT','UPDATE','REFERENCES']) p
   WHERE has_any_column_privilege(r, rel, p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422): a client role can still write columns of tags: %.', leak;
  END IF;
  SELECT string_agg(r || ':' || p, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['DELETE','TRUNCATE','TRIGGER']) p
   WHERE has_table_privilege(r, rel, p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422): a client role still holds a table write privilege on tags: %.', leak;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
              WHERE c.oid = rel AND x.grantee = 0
                AND x.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422): PUBLIC still holds a write privilege on tags.';
  END IF;

  -- The API's writer is untouched.
  SELECT string_agg(p, ', ') INTO svc
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
   WHERE NOT has_table_privilege('service_role', rel, p);
  IF svc IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422): service_role lost % on tags; the API would break.', svc;
  END IF;

  -- The parties-only reads stay exactly as they were: the client roles still
  -- hold SELECT, and the two SELECT policies still say tagger-or-tagged.
  IF NOT has_table_privilege('authenticated', rel, 'SELECT') OR NOT has_table_privilege('anon', rel, 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422): a client role lost SELECT on tags; 3422 touches no read privilege.';
  END IF;
  IF (SELECT count(*) FROM pg_policy
       WHERE polrelid = rel AND polcmd = 'r' AND polname IN ('tags_select', 'tags_read_own')
         AND pg_get_expr(polqual, polrelid) LIKE '%tagger_id = auth.uid()%'
         AND pg_get_expr(polqual, polrelid) LIKE '%tagged_user_id = auth.uid()%') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422): the parties-only SELECT policies are not intact.';
  END IF;

  -- The rollback's record is there and parses, and holds the defect it undoes.
  recorded := substring(descr FROM 'ACL before 3422, which its rollback restores: (\{[^}]*\})$')::aclitem[];
  IF recorded IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422): the ACL record the rollback restores from is missing from the table comment.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM aclexplode(recorded) x
                  WHERE x.grantee = 'authenticated'::regrole AND x.privilege_type = 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3422): the recorded ACL does not hold the client write privileges 3422 revoked.';
  END IF;
END $post$;
