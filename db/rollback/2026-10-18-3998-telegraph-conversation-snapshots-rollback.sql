-- Rollback for 3998_telegraph_conversation_snapshots.sql (census-telegraph T155, Telegraph §12 conversation_snapshots;
-- wave 4, the Telegraph lane). 3998 shipped with neither a rollback file nor a recipe in its header; this is the first.
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3998 DID (one transaction, additive):
--   * created public.conversation_snapshots (thread_id -> public.message_threads ON DELETE CASCADE, its CHECKs, PK
--     (thread_id, projection)), RLS on, every privilege revoked from PUBLIC, anon, authenticated and service_role,
--     then SELECT granted to service_role and one policy conversation_snapshots_service_read (FOR SELECT TO
--     service_role USING (true)), and a table comment;
--   * created public.telegraph_write_conversation_snapshot(uuid, text) (SECURITY DEFINER, service_role EXECUTE only)
--     and public.telegraph_conversation_snapshot_invalidate() (SECURITY DEFINER, no client EXECUTE), each commented;
--   * created four triggers on public.messages, all running the invalidation function:
--     telegraph_conversation_snapshot_on_insert / _on_update / _on_delete (row-level, session-kind messages only) and
--     _on_truncate (statement-level);
--   * seeded telegraph_conversation_snapshots_enabled FALSE (ON CONFLICT DO NOTHING).
-- It read and wrote no existing row. The only other row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops the four triggers on messages, the two functions and the table (its constraints, policy,
-- comment, grants and the RI triggers its foreign key put on message_threads go with it), deletes the flag row and
-- 3998's ledger row (so the runner re-applies 3998 later), and asks PostgREST to reload its schema cache (delivered at
-- the COMMIT). The catalog is then the one before 3998. No row of messages or message_threads is touched. With the
-- flag row gone, routes/telegraphCoordination.ts reads the capability as absent, which is off: GET
-- /threads/:id/coordination reads its session rows exactly as before 3998 (newest SESSION_SCAN_LIMIT, truncation
-- stated).
--
-- DATA: IT REFUSES WHILE public.conversation_snapshots HOLDS A ROW (the house rule of 2860, 2901 and 3376). Every row
-- there is a checkpoint DERIVED from public.messages (a second copy of one thread's session-kind messages, written only
-- while the flag was on), so erasing it loses nothing the messages do not still hold; it is still a deliberate step,
-- not this file's. To roll back anyway: with the flag FALSE (so nothing rewrites them), run
-- DELETE FROM public.conversation_snapshots; then re-run this file. The emptiness check runs twice: once before any
-- strong lock, and again after the table is locked, so a checkpoint written in between is not dropped either.
-- IT ALSO REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG. The admin toggle
-- (toggle_feature_flag_with_audit) writes one each time the flag is turned on or off, and 0118's foreign key from that
-- log to feature_flags is ON DELETE CASCADE, so deleting the flag row would silently erase who changed it and when.
-- Export or delete those audit rows deliberately first. (The flag row is locked FOR UPDATE first, so no toggle can add
-- one while this runs.)
--
-- Refuses, changing nothing, unless the installed state is exactly 3998's:
--   * the flag is TRUE (turn it off deliberately first), or the flag row is missing while 3998's objects stand;
--   * the flag audit log holds a row for the flag (above);
--   * 3998's objects are not each present exactly once: some are missing, or a same-named function was added (3998
--     creates them all in one transaction, so the state was made by hand);
--   * the table, a column, constraint, index, policy, privilege or comment, either function's body, attributes,
--     comment or EXECUTE, or any of the four triggers differs from 3998's own (the expected rows below, generated from
--     3998 applied on the packet's replica, PostgreSQL 18.3, and identical on PostgreSQL 16.4; compared as THIS server
--     deparses them, with search_path pinned to pg_catalog so every name prints qualified);
--   * any object 3998 did not make depends on the table or a function (a view, a foreign key into the table, a trigger
--     elsewhere using the invalidation function);
--   * the table holds a row (above).
-- If none of 3998's objects exists, it changes nothing and clears only the (already absent) ledger row: a second run
-- is a no-op, and it takes no lock on public.messages or public.message_threads.
--
-- LOCK (measured on PGlite 0.5.8 = PostgreSQL 18.3 over the packet's replica, and on PGlite 0.2.17 = PostgreSQL
-- 16.4; held until the COMMIT): ACCESS EXCLUSIVE on public.message_threads and on public.messages, and on the table it
-- drops. READS ARE BLOCKED on messages and message_threads while it runs: every thread list, message read and send
-- waits. Both are inherent to an exact undo: DROP TRIGGER takes ACCESS EXCLUSIVE on messages, and removing the foreign
-- key's RI triggers takes it on message_threads. To keep that short: every check runs first under ACCESS SHARE only;
-- the strong-lock phase is catalog-only (no scan); message_threads is locked next to last and messages last, right
-- before the COMMIT; and lock_timeout = 5s (the packet's own setting) makes a lock request that would queue behind a
-- long transaction fail instead, so readers never wait behind this file for more than 5 s. On a timeout or a deadlock
-- (possible if a thread is deleted at the same moment) the transaction aborts, nothing has changed, and the file can
-- be re-run. Also: ROW SHARE on public.feature_flags (the flag row is locked FOR UPDATE so it cannot be turned on
-- mid-rollback) and ROW EXCLUSIVE on schema_migration_ledger. Run it in its own session:
-- psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_audit   bigint;
  v_flags   int;
  v_on      boolean;
  v_table   int;
  v_fns     int;
  v_trg     int;
  v_n       bigint;
  v_bad     text;
  v_dep     text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL
     OR to_regclass('public.messages') IS NULL OR to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3998 rollback): public.feature_flags, public.schema_migration_ledger, public.messages and public.message_threads must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'telegraph_conversation_snapshots_enabled' FOR UPDATE;
  SELECT count(*), bool_or(enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'telegraph_conversation_snapshots_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3998): telegraph_conversation_snapshots_enabled is TRUE. The owner has turned checkpoints on since 3998 was applied; deleting the row would silently turn them off. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  SELECT count(*) INTO v_table FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'conversation_snapshots';
  SELECT count(*) INTO v_fns FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('telegraph_write_conversation_snapshot', 'telegraph_conversation_snapshot_invalidate');
  SELECT count(*) INTO v_trg FROM pg_trigger t
   WHERE t.tgrelid = 'public.messages'::regclass
     AND t.tgname IN ('telegraph_conversation_snapshot_on_insert', 'telegraph_conversation_snapshot_on_update',
                      'telegraph_conversation_snapshot_on_delete', 'telegraph_conversation_snapshot_on_truncate');

  IF v_table = 0 AND v_fns = 0 AND v_trg = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3998 rollback: none of 3998''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_table <> 1 OR v_fns <> 2 OR v_trg <> 4 OR v_flags <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3998): 3998''s objects are not each present exactly once (% of 1 table, % of 2 functions, % of 4 triggers on messages, % of 1 flag row). 3998 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_table, v_fns, v_trg, v_flags;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag IN ('telegraph_conversation_snapshots_enabled');
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3998): public.feature_flag_audit_log holds % row(s) recording who turned telegraph_conversation_snapshots_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM public.conversation_snapshots;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3998): public.conversation_snapshots holds % checkpoint row(s). They are derived from public.messages, but erasing them is a deliberate step, not a rollback''s: with the flag FALSE, DELETE FROM public.conversation_snapshots, then re-run this file (see the header). Nothing was changed.', v_n;
  END IF;

  -- 3998's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
-- expected:begin
    ('col:conversation_snapshots.projection', '2|text|true||||'),
    ('col:conversation_snapshots.projection_version', '3|integer|true||||'),
    ('col:conversation_snapshots.row_count', '6|integer|true||||'),
    ('col:conversation_snapshots.rows', '7|jsonb|true||||'),
    ('col:conversation_snapshots.thread_id', '1|uuid|true||||'),
    ('col:conversation_snapshots.through_created_at', '4|timestamp with time zone|true||||'),
    ('col:conversation_snapshots.through_message_id', '5|uuid|true||||'),
    ('col:conversation_snapshots.written_at', '8|timestamp with time zone|true|now()|||'),
    ('con:conversation_snapshots.conversation_snapshots_count_matches', 'c|CHECK ((jsonb_array_length(rows) = row_count))|true|false|false'),
    ('con:conversation_snapshots.conversation_snapshots_pkey', 'p|PRIMARY KEY (thread_id, projection)|true|false|false'),
    ('con:conversation_snapshots.conversation_snapshots_projection_check', 'c|CHECK ((projection = ''coordination_sessions''::text))|true|false|false'),
    ('con:conversation_snapshots.conversation_snapshots_projection_version_check', 'c|CHECK ((projection_version = 1))|true|false|false'),
    ('con:conversation_snapshots.conversation_snapshots_row_count_check', 'c|CHECK (((row_count >= 1) AND (row_count <= 2000)))|true|false|false'),
    ('con:conversation_snapshots.conversation_snapshots_rows_check', 'c|CHECK ((jsonb_typeof(rows) = ''array''::text))|true|false|false'),
    ('con:conversation_snapshots.conversation_snapshots_thread_id_fkey', 'f|FOREIGN KEY (thread_id) REFERENCES public.message_threads(id) ON DELETE CASCADE|true|false|false'),
    ('fn:telegraph_conversation_snapshot_invalidate()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||6b3cf120970c3981d62d066de30e2316cdfd6aa3860eb7bbb688202ad82eaac9|376097563b70d05df99a4d83d4857b90'),
    ('fn:telegraph_write_conversation_snapshot(uuid, text)', 'plpgsql|f|true|v|false|false|jsonb|search_path=pg_catalog, public|p_thread_id uuid, p_projection text|cee594cdd284fa6237bcfd7260e5c860222fd36ae467dc5366a9bac181a13212|ae3002fd3eee8a4c9e207834e6900a31'),
    ('fx:telegraph_conversation_snapshot_invalidate()', '---'),
    ('fx:telegraph_write_conversation_snapshot(uuid, text)', '---'),
    ('fxs:telegraph_write_conversation_snapshot(uuid, text)', 's'),
    ('idx:conversation_snapshots.conversation_snapshots_pkey', 'CREATE UNIQUE INDEX conversation_snapshots_pkey ON public.conversation_snapshots USING btree (thread_id, projection)|true|true'),
    ('pol:conversation_snapshots.conversation_snapshots_service_read', 'r|true|{service_role}|true|'),
    ('priv:conversation_snapshots.PUBLIC', ''),
    ('priv:conversation_snapshots.anon', '--------'),
    ('priv:conversation_snapshots.authenticated', '--------'),
    ('priv:conversation_snapshots.service_role', 's------c'),
    ('rel:conversation_snapshots', 'r|true|false|p|379fd60064ff53dc10a8398ff438fbb9'),
    ('trg:messages.telegraph_conversation_snapshot_on_delete', 'CREATE TRIGGER telegraph_conversation_snapshot_on_delete AFTER DELETE ON public.messages FOR EACH ROW WHEN ((old.msg_type = ANY (ARRAY[''coordination_session''::text, ''coordination_transition''::text]))) EXECUTE FUNCTION public.telegraph_conversation_snapshot_invalidate()|O'),
    ('trg:messages.telegraph_conversation_snapshot_on_insert', 'CREATE TRIGGER telegraph_conversation_snapshot_on_insert AFTER INSERT ON public.messages FOR EACH ROW WHEN ((new.msg_type = ANY (ARRAY[''coordination_session''::text, ''coordination_transition''::text]))) EXECUTE FUNCTION public.telegraph_conversation_snapshot_invalidate()|O'),
    ('trg:messages.telegraph_conversation_snapshot_on_truncate', 'CREATE TRIGGER telegraph_conversation_snapshot_on_truncate AFTER TRUNCATE ON public.messages FOR EACH STATEMENT EXECUTE FUNCTION public.telegraph_conversation_snapshot_invalidate()|O'),
    ('trg:messages.telegraph_conversation_snapshot_on_update', 'CREATE TRIGGER telegraph_conversation_snapshot_on_update AFTER UPDATE OF thread_id, sender_id, created_at, msg_type, body, deleted_at ON public.messages FOR EACH ROW WHEN ((((old.msg_type = ANY (ARRAY[''coordination_session''::text, ''coordination_transition''::text])) OR (new.msg_type = ANY (ARRAY[''coordination_session''::text, ''coordination_transition''::text]))) AND ((((((old.thread_id IS DISTINCT FROM new.thread_id) OR (old.sender_id IS DISTINCT FROM new.sender_id)) OR (old.created_at IS DISTINCT FROM new.created_at)) OR (old.msg_type IS DISTINCT FROM new.msg_type)) OR (old.body IS DISTINCT FROM new.body)) OR (old.deleted_at IS DISTINCT FROM new.deleted_at)))) EXECUTE FUNCTION public.telegraph_conversation_snapshot_invalidate()|O')
-- expected:end
  ), actual(k, v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'conversation_snapshots'
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('telegraph_write_conversation_snapshot', 'telegraph_conversation_snapshot_invalidate')
    )
    SELECT 'rel:' || r.relname, c.relkind::text || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || c.relpersistence::text
             || '|' || md5(coalesce(obj_description(c.oid, 'pg_class'), ''))
      FROM rel r JOIN pg_class c ON c.oid = r.oid
    UNION ALL
    SELECT 'col:' || r.relname || '.' || a.attname, a.attnum::text || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull
             || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || a.attidentity::text || a.attgenerated::text
             || '|' || coalesce(md5(col_description(r.oid, a.attnum)), '') || '|' || coalesce(a.attacl::text, '')
      FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
    UNION ALL
    SELECT 'con:' || r.relname || '.' || k.conname, k.contype::text || '|' || pg_get_constraintdef(k.oid) || '|' || k.convalidated
             || '|' || k.condeferrable || '|' || k.condeferred
      FROM rel r JOIN pg_constraint k ON k.conrelid = r.oid WHERE k.contype <> 'n'
    UNION ALL
    SELECT 'idx:' || r.relname || '.' || ic.relname, pg_get_indexdef(i.indexrelid) || '|' || i.indisvalid || '|' || i.indisready
      FROM rel r JOIN pg_index i ON i.indrelid = r.oid JOIN pg_class ic ON ic.oid = i.indexrelid
    UNION ALL
    SELECT 'trg:' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND (t.tgrelid IN (SELECT oid FROM rel) OR t.tgfoid IN (SELECT oid FROM fn)
            OR (t.tgrelid = 'public.messages'::regclass
                AND t.tgname IN ('telegraph_conversation_snapshot_on_insert', 'telegraph_conversation_snapshot_on_update',
                                 'telegraph_conversation_snapshot_on_delete', 'telegraph_conversation_snapshot_on_truncate')))
    UNION ALL
    SELECT 'pol:' || r.relname || '.' || p.polname, p.polcmd::text || '|' || p.polpermissive || '|' || p.polroles::regrole[]::text
             || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
      FROM rel r JOIN pg_policy p ON p.polrelid = r.oid
    UNION ALL
    SELECT 'priv:' || r.relname || '.' || g.role,
           (CASE WHEN has_table_privilege(g.role, r.oid, 'SELECT') THEN 's' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'INSERT') THEN 'i' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'UPDATE') THEN 'u' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'DELETE') THEN 'd' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'TRUNCATE') THEN 't' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'REFERENCES') THEN 'r' ELSE '-' END)
        || (CASE WHEN has_table_privilege(g.role, r.oid, 'TRIGGER') THEN 'g' ELSE '-' END)
        || (CASE WHEN has_any_column_privilege(g.role, r.oid, 'SELECT, INSERT, UPDATE, REFERENCES') THEN 'c' ELSE '-' END)
      FROM rel r CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) g(role)
    UNION ALL
    SELECT 'priv:' || r.relname || '.PUBLIC',
           coalesce((SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
                       FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0), '')
      FROM rel r JOIN pg_class c ON c.oid = r.oid
    UNION ALL
    SELECT 'fn:' || f.sig, l.lanname::text || '|' || p.prokind::text || '|' || p.prosecdef || '|' || p.provolatile::text || '|' || p.proisstrict
             || '|' || p.proretset || '|' || p.prorettype::regtype::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '')
             || '|' || pg_get_function_arguments(p.oid) || '|' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
             || '|' || md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))
      FROM fn f JOIN pg_proc p ON p.oid = f.oid JOIN pg_language l ON l.oid = p.prolang
    UNION ALL
    -- EXECUTE for PUBLIC, anon, authenticated (3998 revoked all three on both functions) ...
    SELECT 'fx:' || f.sig,
           (CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'P' ELSE '-' END)
        || (CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'a' ELSE '-' END)
        || (CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'u' ELSE '-' END)
      FROM fn f JOIN pg_proc p ON p.oid = f.oid
    UNION ALL
    -- ... and service_role on the writer it granted (the trigger function's is the schema default's).
    SELECT 'fxs:' || f.sig, (CASE WHEN has_function_privilege('service_role', f.oid, 'EXECUTE') THEN 's' ELSE '-' END)
      FROM fn f WHERE f.sig = 'telegraph_write_conversation_snapshot(uuid, text)'
-- canon:end
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3998): the installed objects are not 3998''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3998 did not make may depend on its table or functions (DROP without CASCADE would refuse it anyway, but
  -- only after taking the strong locks; this refuses before any).
  WITH rel AS (
    SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'conversation_snapshots'
  ), fn AS (
    SELECT p.oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('telegraph_write_conversation_snapshot', 'telegraph_conversation_snapshot_invalidate')
  ), con AS (
    SELECT k.oid FROM pg_constraint k WHERE k.conrelid IN (SELECT oid FROM rel)
  )
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), '; ') INTO v_dep
    FROM pg_depend d
   WHERE d.deptype IN ('n', 'a')
     AND ((d.refclassid = 'pg_class'::regclass AND d.refobjid IN (SELECT oid FROM rel))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid IN (SELECT oid FROM fn))
       OR (d.refclassid = 'pg_type'::regclass AND d.refobjid IN (SELECT c.reltype FROM pg_class c WHERE c.oid IN (SELECT oid FROM rel))))
     AND NOT ((d.classid = 'pg_class'::regclass
               AND (d.objid IN (SELECT oid FROM rel) OR d.objid IN (SELECT i.indexrelid FROM pg_index i WHERE i.indrelid IN (SELECT oid FROM rel))))
           OR (d.classid = 'pg_constraint'::regclass AND d.objid IN (SELECT oid FROM con))
           OR (d.classid = 'pg_attrdef'::regclass AND d.objid IN (SELECT ad.oid FROM pg_attrdef ad WHERE ad.adrelid IN (SELECT oid FROM rel)))
           OR (d.classid = 'pg_policy'::regclass AND d.objid IN (SELECT po.oid FROM pg_policy po WHERE po.polrelid IN (SELECT oid FROM rel)))
           OR (d.classid = 'pg_trigger'::regclass AND d.objid IN (
                 SELECT t.oid FROM pg_trigger t
                  WHERE t.tgrelid IN (SELECT oid FROM rel) OR t.tgconstraint IN (SELECT oid FROM con)
                     OR (t.tgrelid = 'public.messages'::regclass
                         AND t.tgname IN ('telegraph_conversation_snapshot_on_insert', 'telegraph_conversation_snapshot_on_update',
                                          'telegraph_conversation_snapshot_on_delete', 'telegraph_conversation_snapshot_on_truncate')))));
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3998): objects 3998 did not make depend on its table or functions: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

-- Row-level work first (no strong lock): the flag row and the ledger row. NOTIFY is delivered only at the COMMIT.
DELETE FROM public.feature_flags WHERE flag = 'telegraph_conversation_snapshots_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3998_telegraph_conversation_snapshots.sql';
NOTIFY pgrst, 'reload schema';

-- The strong-lock phase, catalog-only: the table (3998's own), then message_threads (its foreign key's RI triggers),
-- then messages (the four triggers) last. Skipped entirely when nothing of 3998's exists ($pre$ refused every partial
-- state).
DO $rb$
BEGIN
  IF to_regclass('public.conversation_snapshots') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.conversation_snapshots IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.conversation_snapshots) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3998): a checkpoint was written while this file ran; nothing is dropped (see the header). Nothing was changed.';
  END IF;
  DROP TABLE public.conversation_snapshots;
  DROP TRIGGER telegraph_conversation_snapshot_on_insert ON public.messages;
  DROP TRIGGER telegraph_conversation_snapshot_on_update ON public.messages;
  DROP TRIGGER telegraph_conversation_snapshot_on_delete ON public.messages;
  DROP TRIGGER telegraph_conversation_snapshot_on_truncate ON public.messages;
  DROP FUNCTION public.telegraph_conversation_snapshot_invalidate();
  DROP FUNCTION public.telegraph_write_conversation_snapshot(uuid, text);
END $rb$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_left text;
BEGIN
  IF to_regclass('public.conversation_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3998): public.conversation_snapshots still exists.';
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_left FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('telegraph_write_conversation_snapshot', 'telegraph_conversation_snapshot_invalidate');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3998): function(s) % still exist.', v_left;
  END IF;
  SELECT string_agg(t.tgname, ', ') INTO v_left FROM pg_trigger t
   WHERE t.tgrelid = 'public.messages'::regclass AND t.tgname LIKE 'telegraph\_conversation\_snapshot\_%';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3998): trigger(s) % are still on public.messages.', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_conversation_snapshots_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3998): telegraph_conversation_snapshots_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3998_telegraph_conversation_snapshots.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3998): the ledger still records 3998 as applied.';
  END IF;
END $post$;
