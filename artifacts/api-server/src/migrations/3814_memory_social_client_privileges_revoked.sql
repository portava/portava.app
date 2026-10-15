-- 3814_memory_social_client_privileges_revoked.sql
-- public.memory_saves, public.memory_likes, public.memory_tags, public.memory_items:
-- no client role holds any privilege on them. Every reader and writer of a save,
-- a like, a tag or a Memory photo is the API, on the service client
-- (lib/supabase.ts), so the public anon key and a signed-in user's key stop
-- reaching them through PostgREST at all. Follow-up to 3813 (lane MEM-ACL, PR
-- #726), which closed public.memories and listed these four as "adjacent doors,
-- not closed"; verifier VERIFY-726 confirmed them. Census-highlights-memories §BL.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane MEM-ACL-2, B58, number 3814).
-- APPLIED TO NO DATABASE by the lane that wrote it. It takes privileges away from
-- the public anon key and from every signed-in client key on four live tables, so
-- applying it — to production above all — is the owner's decision (OQ-MEM-ACL-2-1).
-- It does not depend on 3813, and 3813 does not depend on it: either may be
-- applied first, and each one's precondition accepts the other's end state.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DOORS (re-verified 2026-10-14 on origin/main aeae27499)
-- ══════════════════════════════════════════════════════════════════════════════
-- The baseline grants all four tables to both client roles:
--     GRANT ALL ON TABLE public.memory_items TO anon / authenticated;  (baseline :36647-36648)
--     GRANT ALL ON TABLE public.memory_likes TO anon / authenticated;  (baseline :36656-36657)
--     GRANT ALL ON TABLE public.memory_saves TO anon / authenticated;  (baseline :36665-36666)
--     GRANT ALL ON TABLE public.memory_tags  TO anon / authenticated;  (baseline :36674-36675)
-- 2490 took back TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from every table and
-- left SELECT, INSERT, UPDATE and DELETE. No other migration names a client role
-- on any of the four. The policies decide rows, and only rows:
--   memory_saves_own (FOR ALL, USING user_id = auth.uid(), no WITH CHECK of its
--     own): a signed-in user INSERTs a save of ANY Memory id — private, a
--     moderator-removed one, a blocked owner's. The API's POST /memories/:id/save
--     checks blocks and canReadMemory first and answers not_found either way.
--   memory_likes_own (FOR ALL, the same shape): a signed-in user INSERTs a like
--     of ANY Memory id, past the same two checks (POST /memories/:id/like), and
--     the like is counted on GET /memories/:id and listed by the likers route.
--   Both: memory_id carries a foreign key to memories, checked as the table's
--     owner, so an INSERT of an id that does not exist fails 23503 and one that
--     exists succeeds — an EXISTENCE ORACLE on every Memory id, private and
--     removed ones included. The API answers both cases not_found.
--   memory_likes_read (FOR SELECT, no auth.uid() term): any signed-in user reads
--     who liked every published public Memory, past the block filter the API's
--     likers route applies.
--   memory_tags_tagged_update (FOR UPDATE, USING and WITH CHECK tagged_user_id =
--     auth.uid()): the tagged person writes EVERY column of their tag row —
--     memory_id too. Re-pointed at another Memory, the row makes them "tagged"
--     there: GET /memories/:id/tags skips canReadMemory for a tagged caller, an
--     approved row puts them in the owner's participant list and shared history
--     and, through 3674's trigger, in the Memory graph. The same foreign key
--     answers whether the new id exists. Status written this way also skips the
--     §17 ADD_PERSON/REMOVE_PERSON command and its audit event.
--   memory_tags_owner_insert / _owner_delete, memory_items_via_memory (FOR ALL):
--     the owner of a Memory inserts tags and photos directly, past the API's
--     checks — for a photo, the §20 refusal of another user's storage object
--     (services/memory/memoryMediaOrigin.ts, census H181) and the §17 command.
--   memory_items_public_read: any client role reads the photos of a published
--     public Memory without the API's hidden-photo and gem rules.
-- 3813 (unapplied) closes every client path that runs a policy reading
-- public.memories — reads, the tag and photo inserts, any statement with a
-- WHERE — with 42501. It does not close memory_saves (its one policy never reads
-- memories), a plain INSERT into memory_likes (memory_likes_own decides it
-- alone, and the oracle with it), or an UPDATE of memory_tags that reads no
-- column (only memory_tags_tagged_update decides it). This file closes all four
-- tables whatever the state of 3813.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHO USES THESE TABLES AS A CLIENT ROLE (re-verified 2026-10-14 on aeae27499)
-- ══════════════════════════════════════════════════════════════════════════════
-- * No client code. travel-buddy-standalone names eight tables in
--   `.from('<table>')` and none of these four; it makes no `.rpc(` call, its one
--   realtime channel is on generated_visuals and its one storage bucket is
--   post-media. Its like and save buttons call POST|DELETE /memories/:id/like
--   and /save (src/hooks/useMemoryLike.ts, src/services/memories.ts). No other
--   tree (root app/ and src/, lib/, packages/, posts-ui/, the *-backend folders)
--   names them. No live suite reads them with a client key.
-- * The API builds one database client, the service client (lib/supabase.ts),
--   and service_role keeps every privilege it has. This file does not touch it.
-- * Functions: every chain function whose body reads or writes these tables is
--   EXECUTE-able by service_role only (2711 memory_kernel_execute, 3676
--   memory_graph_kernel_execute), or is a SECURITY DEFINER trigger function
--   (3674 memory_graph_on_tag_write). The baseline defines none.
-- * No view reads them; they are in no publication the chain creates; no policy
--   on another table reads them.
-- The precondition below re-checks the function, trigger, view and policy halves
-- on the database it is applied to, and refuses rather than break a reader this
-- repository does not know about.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOKE ALL ON the four tables FROM PUBLIC, anon, authenticated. A table-level
-- REVOKE takes the matching column privileges with it, so nothing is left at
-- either level. Shaped like 3813 and 2161: no privilege is granted back, because
-- no client path needs one. With no privilege, a client INSERT is refused with
-- 42501 before any foreign key is checked, so an existing id and a missing one
-- get the same answer: the oracle closes with the door.
--
-- WHAT IT DOES NOT CHANGE: no policy (RLS stays on and every policy stays: with
-- no privilege they are unreachable, and they are what a rollback leans on), no
-- row, no function, no trigger, no service_role privilege.
--
-- Precondition: refuses, for any of the four, a client or PUBLIC privilege
-- granted by a role other than the owner or carrying a grant option (this REVOKE
-- would not remove it cleanly), a session that does not act for the owner, a
-- client-readable view over it, a client-callable SECURITY INVOKER function that
-- reads or writes it, a SECURITY INVOKER trigger function that reads or writes
-- it and fires on a table a client role can write, and a policy on another table
-- a client role can use that reads it. A second apply is accepted: the end state
-- is a starting state it allows.
--
-- Rollback: db/rollback/2026-10-14-3814-memory-social-client-privileges-revoked-rollback.sql
-- (re-grants SELECT, INSERT, UPDATE, DELETE to anon and authenticated on the four
-- tables, the state 2490 left, and with it every door above).
-- Proof: src/test/db/memorySocialClientBoundary.db.test.ts (local-db tier) and
-- src/test/memorySocialClientBoundary.test.ts (static: the chain fold, the
-- client premise, the re-grant guard).

BEGIN;

DO $pre$
DECLARE
  c_tables constant text[] := ARRAY['memory_saves', 'memory_likes', 'memory_tags', 'memory_items'];
  v_t     text;
  v_rel   regclass;
  v_owner oid;
  v_bad   text;
BEGIN
  FOREACH v_t IN ARRAY c_tables LOOP
    v_rel := to_regclass('public.' || v_t);
    IF v_rel IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814): public.% does not exist.', v_t;
    END IF;
    SELECT relowner INTO v_owner FROM pg_class WHERE oid = v_rel;

    -- A REVOKE removes only what its own grantor granted, and this session must
    -- act for the owner for its REVOKE to reach the owner's grants.
    IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814): % does not act for the owner of public.% (%), so its REVOKE would remove nothing.',
        current_user, v_t, v_owner::regrole;
    END IF;

    -- Every client or PUBLIC privilege, table- or column-level, was granted by
    -- the owner and carries no grant option.
    SELECT string_agg(DISTINCT format('%s:%s%s by %s',
                                      CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
                                      x.privilege_type,
                                      CASE WHEN x.is_grantable THEN '+grant option' ELSE '' END,
                                      x.grantor::regrole::text), ', ')
      INTO v_bad
      FROM (SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
              FROM pg_class c, LATERAL aclexplode(c.relacl) a
             WHERE c.oid = v_rel
            UNION ALL
            SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
              FROM pg_attribute t, LATERAL aclexplode(t.attacl) a
             WHERE t.attrelid = v_rel AND t.attnum > 0 AND NOT t.attisdropped AND t.attacl IS NOT NULL) x
     WHERE (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
       AND (x.grantor <> v_owner OR x.is_grantable);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814): a client or PUBLIC privilege on public.% was granted by a role other than its owner, or with a grant option: %. This file''s REVOKE would not remove it cleanly, and nobody wrote that state down.', v_t, v_bad;
    END IF;

    -- No view or materialized view over the table is readable by a client role:
    -- a definer view would stay a door past this file, an invoker view would break.
    SELECT string_agg(DISTINCT format('%s (%s)', v.oid::regclass, r.rolname), ', ')
      INTO v_bad
      FROM pg_depend d
      JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
      JOIN pg_class v ON v.oid = w.ev_class
      CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
     WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = v_rel
       AND w.ev_class <> v_rel
       AND has_any_column_privilege(r.rolname, v.oid, 'SELECT');
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814): a view over public.% is readable by a client role: %. Move that reader to the API, or revoke the view, before applying this file.', v_t, v_bad;
    END IF;

    -- No SECURITY INVOKER function a client role may call reads or writes the
    -- table: it would start failing with 42501. A body is matched by the
    -- statement shapes that name a table (a SQL-standard body by its recorded
    -- dependency). Trigger functions are the next check.
    SELECT string_agg(DISTINCT p.oid::regprocedure::text, ', ')
      INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.prokind IN ('f', 'p')
       AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
       AND NOT p.prosecdef
       AND (p.prosrc ~* ('(from|join|into|update|table)\s+(only\s+)?(public\.)?"?' || v_t || '"?([^[:alnum:]_]|$)')
            OR EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                          AND d.refclassid = 'pg_class'::regclass AND d.refobjid = v_rel))
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814): a SECURITY INVOKER function a client role may call reads or writes public.%: %. It would fail after this file; move it to the API or make it SECURITY DEFINER with its own checks first.', v_t, v_bad;
    END IF;

    -- No SECURITY INVOKER trigger function that reads or writes the table fires
    -- on a table a client role can write: the client's own write would start
    -- failing with 42501 inside the trigger.
    SELECT string_agg(DISTINCT format('%s ON %s', tg.tgname, tg.tgrelid::regclass), ', ')
      INTO v_bad
      FROM pg_trigger tg
      JOIN pg_proc p ON p.oid = tg.tgfoid
     WHERE NOT tg.tgisinternal
       AND NOT p.prosecdef
       AND tg.tgrelid <> v_rel
       AND p.prosrc ~* ('(from|join|into|update|table)\s+(only\s+)?(public\.)?"?' || v_t || '"?([^[:alnum:]_]|$)')
       AND EXISTS (SELECT 1 FROM (VALUES ('anon'), ('authenticated')) r(rolname),
                                 (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) q(priv)
                    WHERE has_table_privilege(r.rolname, tg.tgrelid, q.priv));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814): a SECURITY INVOKER trigger reads or writes public.% and fires on a table a client role can write: %. That client write would fail after this file; make the trigger function SECURITY DEFINER with its own checks, or move the write to the API, first.', v_t, v_bad;
    END IF;

    -- No policy on ANOTHER table a client role can use reads this one: a client
    -- query that reaches it would start failing with 42501.
    SELECT string_agg(DISTINCT format('%s.%s', p.polrelid::regclass, p.polname), ', ')
      INTO v_bad
      FROM pg_depend d
      JOIN pg_policy p ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid
     WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = v_rel
       AND p.polrelid <> v_rel
       AND EXISTS (SELECT 1 FROM (VALUES ('anon'), ('authenticated')) r(rolname),
                                 (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) q(priv)
                    WHERE has_table_privilege(r.rolname, p.polrelid, q.priv));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3814): a policy on a table a client role can use reads public.%: %. A client query that reaches it would fail after this file; move that reader to the API first.', v_t, v_bad;
    END IF;
  END LOOP;
END $pre$;

REVOKE ALL ON TABLE public.memory_saves, public.memory_likes, public.memory_tags, public.memory_items
  FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
-- Re-runnable standalone on the committed database (certify:migrations stage
-- 4): catalog reads only, no temp table, nothing from the applying session.
DO $post$
DECLARE
  c_tables constant text[] := ARRAY['memory_saves', 'memory_likes', 'memory_tags', 'memory_items'];
  v_t    text;
  v_rel  regclass;
  v_leak text;
  v_svc  text;
BEGIN
  FOREACH v_t IN ARRAY c_tables LOOP
    v_rel := to_regclass('public.' || v_t);
    IF v_rel IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3814) VACUOUS: public.% does not exist.', v_t;
    END IF;
    -- This file changes no policy; RLS stays on.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3814): RLS is not enabled on public.%.', v_t;
    END IF;

    -- 1. No client or PUBLIC entry in the table's ACL, whatever the privilege
    --    (MAINTAIN included where the server has it).
    SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
      INTO v_leak
      FROM pg_class c, LATERAL aclexplode(c.relacl) x
     WHERE c.oid = v_rel
       AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
    IF v_leak IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3814): a client role or PUBLIC holds a table privilege on public.%: %.', v_t, v_leak;
    END IF;

    -- 2. None in any column's ACL either.
    SELECT string_agg(format('%s.%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, a.attname, x.privilege_type), ', ')
      INTO v_leak
      FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = v_rel AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
       AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
    IF v_leak IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3814): a client role or PUBLIC holds a column privilege on public.%: %.', v_t, v_leak;
    END IF;

    -- 3. What the two roles can USE, through any membership: no table privilege,
    --    no column privilege.
    SELECT string_agg(r || ':' || p, ', ')
      INTO v_leak
      FROM unnest(ARRAY['anon', 'authenticated']) r,
           unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(r, v_rel::oid, p);
    IF v_leak IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3814): a client role can still use public.%: %.', v_t, v_leak;
    END IF;
    SELECT string_agg(r || ':column ' || p, ', ')
      INTO v_leak
      FROM unnest(ARRAY['anon', 'authenticated']) r,
           unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
     WHERE has_any_column_privilege(r, v_rel::oid, p);
    IF v_leak IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3814): a client role can still use a column of public.%: %.', v_t, v_leak;
    END IF;

    -- 4. No view or materialized view over the table is client-readable: it
    --    would read past RLS (definer) or be a broken reader (invoker).
    SELECT string_agg(DISTINCT format('%s (%s)', v.oid::regclass, r.rolname), ', ')
      INTO v_leak
      FROM pg_depend d
      JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
      JOIN pg_class v ON v.oid = w.ev_class
      CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
     WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = v_rel
       AND w.ev_class <> v_rel
       AND has_any_column_privilege(r.rolname, v.oid, 'SELECT');
    IF v_leak IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3814): a view over public.% is readable by a client role: %.', v_t, v_leak;
    END IF;

    -- 5. The API's path is untouched: service_role keeps every DML verb.
    SELECT string_agg(p, ', ')
      INTO v_svc
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
     WHERE NOT has_table_privilege('service_role', v_rel::oid, p);
    IF v_svc IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3814): service_role lost % on public.%; the API would break.', v_svc, v_t;
    END IF;
  END LOOP;
  RAISE NOTICE '3814 postcondition: no client role or PUBLIC holds any privilege on memory_saves, memory_likes, memory_tags or memory_items; service_role keeps SELECT, INSERT, UPDATE, DELETE on each.';
END $post$;
