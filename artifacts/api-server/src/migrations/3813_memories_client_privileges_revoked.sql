-- 3813_memories_client_privileges_revoked.sql
-- public.memories: no client role holds any privilege on the table. Every reader
-- and writer of a Memory is the API, on the service client (lib/supabase.ts),
-- so the public anon key and a signed-in user's key stop reaching canonical
-- Memories through PostgREST at all. Verifier V-716, fix 2; owner question
-- OQ-716-1; census-highlights-memories §BJ.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane MEM-ACL, B58, number 3813).
-- APPLIED TO NO DATABASE by the lane that wrote it. It takes privileges away from
-- the public anon key and from every signed-in client key on a live table, so
-- applying it — to production above all — is the owner's decision (OQ-716-1).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT (verifier V-716, executed on PGlite: VERIFY-716-3bdb941e6.md fix 2)
-- ══════════════════════════════════════════════════════════════════════════════
-- The baseline grants the whole table to both client roles:
--     GRANT ALL ON TABLE public.memories TO anon;            (baseline :36638)
--     GRANT ALL ON TABLE public.memories TO authenticated;   (baseline :36639)
-- 2490 took back TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from every table and
-- left SELECT, INSERT, UPDATE and DELETE. No other migration narrows them. Two
-- baseline policies then decide ROWS, and neither looks at a column:
--   memories_public_read  FOR SELECT: any signed-in user who is not the owner
--                         reads every column of a published, public Memory;
--   memories_owner_all    FOR ALL, USING (owner_id = auth.uid()) and no WITH
--                         CHECK of its own: the owner reads and writes every
--                         column of their own rows.
-- So, with the anon key shipped in the app and their own JWT:
--   * a stranger reads, of any published public Memory, the exact location_lat
--     and location_lng, place_id, canonical_location_id, location_precision,
--     allowed_user_ids and hidden_user_ids. That skips everything the API applies
--     before it serves one: the owner's precision rung (2338, protectMemoryRow),
--     the Hidden-Gem ceiling, the owner's place corrections and rejections
--     (lead rulings H-16 / H-17, placesForViewer), and the owner's hidden list
--     and blocks (memories_public_read checks neither). A filter needs no select
--     list: `?location_lat=gt.<x>` is a range oracle on its own.
--   * an owner writes columns the API derives or guards: `state` (a Memory a
--     moderator set to 'removed' goes back to 'published'), location_precision,
--     the place references, and a hard DELETE that skips the §21 deletion
--     lifecycle (soft delete, dead letters, derivative revocation).
-- 3804 (#716, merged, unapplied) adds place_display_name_at_occurrence to what a
-- stranger reads this way, and 3803 memory_type to what an owner writes.
-- The anonymous role reads no row today (both policies compare with auth.uid(),
-- which is NULL for it), but it holds the same four privileges; they go too.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHO USES public.memories AS A CLIENT ROLE (re-verified 2026-10-14 on 9af376fa4)
-- ══════════════════════════════════════════════════════════════════════════════
-- * No client code. travel-buddy-standalone names a table in `.from('<table>')`
--   in ten files (and a storage bucket in one); none names memories, no select
--   embeds it, it makes no `.rpc(` call, and its one realtime channel is on
--   generated_visuals. No other tree in the repository (root app/ and src/,
--   lib/, packages/, posts-ui/) names it either.
-- * The API builds one database client, the service client (lib/supabase.ts),
--   and service_role keeps every privilege it has. This file does not touch it.
-- * Functions: every function whose body reads memories is EXECUTE-able by
--   service_role only (2338 memory_public_feed, 2711 memory_kernel_execute,
--   3497/3725/3726 discovery_trend_post_groups_v2, 3674
--   memory_graph_mirror_memory and memory_graph_backfill_legacy, 3676
--   memory_graph_kernel_execute), or is a trigger function, which no client can
--   call (2994 memory_relations_owner_matches_source, 3673
--   memory_corrections_guard). 3674's triggers on memories fire only on the
--   writes the API's role makes.
-- * No view reads memories; memories is in no publication the chain creates.
-- * Policies on OTHER tables read memories as the invoking role:
--   memory_items_public_read (3672), memory_items_via_memory, memory_likes_read,
--   memory_tags_owner_read / _owner_insert / _owner_delete (baseline) and
--   memory_domain_events_owner_select (2710). After this file a client query
--   that reaches one of them fails with 42501 instead of reading through
--   memories. No client queries those tables (same search); the API is
--   service_role, which bypasses RLS.
-- So no reader loses anything it uses. The precondition below re-checks the
-- view and function halves on the database it is applied to, and refuses rather
-- than break a reader this repository does not know about.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOKE ALL ON public.memories FROM PUBLIC, anon, authenticated. A table-level
-- REVOKE takes the matching column privileges with it, so nothing is left at
-- either level. Shaped like 2161 (compass_memories) and 3653: no privilege is
-- granted back, because no client path needs one.
--
-- WHAT IT DOES NOT CHANGE: no policy (RLS stays on, both policies stay: with no
-- privilege they are unreachable, and they are what a rollback leans on), no
-- row, no function, no trigger, no service_role privilege.
--
-- Precondition: refuses a client or PUBLIC privilege granted by a role other
-- than the owner or carrying a grant option (this REVOKE would not remove it
-- cleanly), a session that does not act for the owner, a client-readable view
-- over memories, and a client-callable SECURITY INVOKER function that reads it.
-- A second apply is accepted: the end state is a starting state it allows.
--
-- Rollback: db/rollback/2026-10-14-3813-memories-client-privileges-revoked-rollback.sql
-- (re-grants SELECT, INSERT, UPDATE, DELETE to anon and authenticated, the
-- state 2490 left, and with it the door).
-- Proof: src/test/db/memoriesClientBoundary.db.test.ts (local-db tier) and
-- src/test/memoriesClientBoundary.test.ts (static: the chain fold, the client
-- premise, check:client-privilege-boundary rule 7).

BEGIN;

DO $pre$
DECLARE
  v_owner oid;
  v_bad   text;
  v_note  text;
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3813): public.memories does not exist.';
  END IF;
  SELECT relowner INTO v_owner FROM pg_class WHERE oid = 'public.memories'::regclass;

  -- A REVOKE removes only what its own grantor granted, and this session must
  -- act for the owner for its REVOKE to reach the owner's grants.
  IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3813): % does not act for the owner of public.memories (%), so its REVOKE would remove nothing.',
      current_user, v_owner::regrole;
  END IF;

  -- Every client or PUBLIC privilege, table- or column-level, was granted by the
  -- owner and carries no grant option.
  SELECT string_agg(DISTINCT format('%s:%s%s by %s',
                                    CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
                                    x.privilege_type,
                                    CASE WHEN x.is_grantable THEN '+grant option' ELSE '' END,
                                    x.grantor::regrole::text), ', ')
    INTO v_bad
    FROM (SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
            FROM pg_class c, LATERAL aclexplode(c.relacl) a
           WHERE c.oid = 'public.memories'::regclass
          UNION ALL
          SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
            FROM pg_attribute t, LATERAL aclexplode(t.attacl) a
           WHERE t.attrelid = 'public.memories'::regclass AND t.attnum > 0 AND NOT t.attisdropped
             AND t.attacl IS NOT NULL) x
   WHERE (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))
     AND (x.grantor <> v_owner OR x.is_grantable);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3813): a client or PUBLIC privilege on public.memories was granted by a role other than its owner, or with a grant option: %. This file''s REVOKE would not remove it cleanly, and nobody wrote that state down.', v_bad;
  END IF;

  -- No view or materialized view over memories is readable by a client role: a
  -- definer view would stay a door past this file, an invoker view would break.
  SELECT string_agg(DISTINCT format('%s (%s)', v.oid::regclass, r.rolname), ', ')
    INTO v_bad
    FROM pg_depend d
    JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
    JOIN pg_class v ON v.oid = w.ev_class
    CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
   WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.memories'::regclass
     AND w.ev_class <> 'public.memories'::regclass
     AND has_any_column_privilege(r.rolname, v.oid, 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3813): a view over public.memories is readable by a client role: %. Move that reader to the API, or revoke the view, before applying this file.', v_bad;
  END IF;

  -- No client-callable SECURITY INVOKER function reads memories: it would start
  -- failing with 42501. A trigger function is never client-callable. A body is
  -- matched by the statement shapes that read a table (a SQL-standard body by
  -- its recorded dependency).
  SELECT string_agg(DISTINCT p.oid::regprocedure::text, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prokind IN ('f', 'p')
     AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
     AND NOT p.prosecdef
     AND (p.prosrc ~* '(from|join|into|update|table)\s+(only\s+)?(public\.)?"?memories"?([^[:alnum:]_]|$)'
          OR EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                        AND d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.memories'::regclass))
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3813): a SECURITY INVOKER function a client role may call reads public.memories: %. It would fail after this file; move it to the API or make it SECURITY DEFINER with its own checks first.', v_bad;
  END IF;

  -- For the record, not a refusal: the policies on other tables that read
  -- memories as the invoking role. A client query reaching one fails with 42501
  -- after this file instead of reading through memories.
  SELECT string_agg(q.name, ', ' ORDER BY q.name)
    INTO v_note
    FROM (SELECT DISTINCT format('%s.%s', p.polrelid::regclass, p.polname) AS name
            FROM pg_depend d
            JOIN pg_policy p ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid
           WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.memories'::regclass
             AND p.polrelid <> 'public.memories'::regclass) q;
  RAISE NOTICE '3813: policies on other tables that read public.memories as the invoking role: %', COALESCE(v_note, '(none)');
END $pre$;

REVOKE ALL ON TABLE public.memories FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
-- Re-runnable standalone on the committed database (certify:migrations stage
-- 4): catalog reads only, no temp table, nothing from the applying session.
DO $post$
DECLARE
  v_leak text;
  v_svc  text;
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813) VACUOUS: public.memories does not exist.';
  END IF;
  -- This file changes no policy; RLS stays on.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memories'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813): RLS is not enabled on public.memories.';
  END IF;

  -- 1. No client or PUBLIC entry in the table's ACL, whatever the privilege
  --    (MAINTAIN included where the server has it).
  SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO v_leak
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.memories'::regclass
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813): a client role or PUBLIC holds a table privilege on public.memories: %.', v_leak;
  END IF;

  -- 2. None in any column's ACL either.
  SELECT string_agg(format('%s.%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, a.attname, x.privilege_type), ', ')
    INTO v_leak
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = 'public.memories'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813): a client role or PUBLIC holds a column privilege on public.memories: %.', v_leak;
  END IF;

  -- 3. What the two roles can USE, through any membership: no table privilege,
  --    no column privilege.
  SELECT string_agg(r || ':' || p, ', ')
    INTO v_leak
    FROM unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE has_table_privilege(r, 'public.memories', p);
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813): a client role can still use public.memories: %.', v_leak;
  END IF;
  SELECT string_agg(r || ':column ' || p, ', ')
    INTO v_leak
    FROM unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
   WHERE has_any_column_privilege(r, 'public.memories', p);
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813): a client role can still use a column of public.memories: %.', v_leak;
  END IF;

  -- 4. No view or materialized view over memories is client-readable: it would
  --    read past RLS (definer) or be a broken reader (invoker).
  SELECT string_agg(DISTINCT format('%s (%s)', v.oid::regclass, r.rolname), ', ')
    INTO v_leak
    FROM pg_depend d
    JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
    JOIN pg_class v ON v.oid = w.ev_class
    CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
   WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.memories'::regclass
     AND w.ev_class <> 'public.memories'::regclass
     AND has_any_column_privilege(r.rolname, v.oid, 'SELECT');
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813): a view over public.memories is readable by a client role: %.', v_leak;
  END IF;

  -- 5. The API's path is untouched: service_role keeps every DML verb.
  SELECT string_agg(p, ', ')
    INTO v_svc
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
   WHERE NOT has_table_privilege('service_role', 'public.memories', p);
  IF v_svc IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813): service_role lost % on public.memories; the API would break.', v_svc;
  END IF;
  RAISE NOTICE '3813 postcondition: no client role or PUBLIC holds any privilege on public.memories; service_role keeps SELECT, INSERT, UPDATE, DELETE.';
END $post$;
