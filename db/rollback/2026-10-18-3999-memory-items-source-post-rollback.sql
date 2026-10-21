-- Rollback for 3999_memory_items_source_post.sql (census-media MD385, lead ruling D-26j: a Memory item made from the
-- caller's OWN post; wave 4, the media lane). Replaces the header recipe at 3999:47-53, which had no refusal, no
-- transaction, no $post$ and left the ledger row (so the applier would never re-apply 3999).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3999 DID (one transaction, additive):
--   * added public.memory_items.source_post_id uuid NULL, with a column comment;
--   * added memory_items_source_post_id_fkey: FOREIGN KEY (source_post_id) REFERENCES public.posts(id) ON DELETE CASCADE;
--   * created two partial indexes: memory_items_source_post_id_idx (source_post_id) and the unique
--     memory_items_source_post_media_uniq (memory_id, source_post_id, media_url), both WHERE source_post_id IS NOT NULL;
--   * created public.memory_items_source_post_guard() (SECURITY INVOKER, search_path pinned, no client EXECUTE) and its
--     trigger memory_items_source_post_guard BEFORE INSERT OR UPDATE OF source_post_id, memory_id, media_url;
--   * seeded memory_from_own_media_enabled FALSE (ON CONFLICT DO NOTHING).
-- It read and wrote no existing row. The only other row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops the trigger, the function, the two indexes, the foreign key (its RI triggers on posts go with
-- it) and the column, deletes the flag row and 3999's ledger row (so the runner re-applies 3999 later), and asks
-- PostgREST to reload its schema cache (delivered at the COMMIT). The catalog is then the one before 3999; the column's
-- storage slot stays behind as a dropped attribute, as PostgreSQL always leaves it (invisible to every query; a
-- re-apply adds source_post_id again at the next position). No row of memory_items or posts is touched. With the flag
-- row gone, POST /memories/:id/items/from-post answers feature_disabled and reads nothing, exactly as before 3999.
--
-- DATA: IT REFUSES WHILE ANY memory_items ROW HAS source_post_id SET (the house rule for a column that carries data,
-- as 2470's rollback refuses over populated provenance columns). That column is "the only reference to the media's
-- origin a Memory item has ever had" (3999's header); dropping it would erase every made-from-a-post link, and with it
-- the cascade that removes the copy when the source post row is erased. The items themselves would stay. Whether to
-- erase the links is the owner's decision, not a rollback's: to roll back anyway, after that decision, with the flag
-- FALSE, UPDATE public.memory_items SET source_post_id = NULL WHERE source_post_id IS NOT NULL; then re-run this file.
-- The check runs twice: once before any strong lock, and again after memory_items is locked, so a link written in
-- between is not dropped either. Neither scans memory_items: both read one of 3999's partial indexes, which hold only
-- linked rows (EXPLAIN on PostgreSQL 16.4 over 20,000 unlinked items, with and without statistics for the new column,
-- chose memory_items_source_post_media_uniq).
-- IT ALSO REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG. The admin toggle
-- (toggle_feature_flag_with_audit) writes one each time the flag is turned on or off, and 0118's foreign key from that
-- log to feature_flags is ON DELETE CASCADE, so deleting the flag row would silently erase who changed it and when.
-- Export or delete those audit rows deliberately first. (The flag row is locked FOR UPDATE first, so no toggle can add
-- one while this runs.)
--
-- Refuses, changing nothing, unless the installed state is exactly 3999's:
--   * the flag is TRUE (turn it off deliberately first), or the flag row is missing while 3999's objects stand;
--   * the flag audit log holds a row for the flag (above);
--   * 3999's objects are not each present exactly once (3999 creates them all in one transaction, so the state was made
--     by hand);
--   * the column, the foreign key, either index, the trigger, or the function's body, attributes or EXECUTE differs
--     from 3999's own, or another constraint, index or trigger on memory_items involves source_post_id or runs the
--     guard (the expected rows below, generated from 3999 applied on the packet's replica, PostgreSQL 18.3, and
--     identical on PostgreSQL 16.4; compared as THIS server deparses them, with search_path pinned to pg_catalog so
--     every name prints qualified);
--   * any object 3999 did not make depends on the column or the function (a view or policy reading the column, an
--     extra index on it, a trigger elsewhere using the guard);
--   * a memory_items row has source_post_id set (above).
-- If none of 3999's objects exists, it changes nothing and clears only the (already absent) ledger row: a second run
-- is a no-op, and it takes no lock on public.memory_items or public.posts.
--
-- LOCK (measured on PGlite 0.5.8 = PostgreSQL 18.3 over the packet's replica, and on PGlite 0.2.17 = PostgreSQL
-- 16.4; held until the COMMIT): ACCESS EXCLUSIVE on public.memory_items and on public.posts. READS ARE BLOCKED on both
-- while it runs: every Memory item read and every post read (feeds, profiles, the post page) waits. Both are inherent
-- to an exact undo: DROP TRIGGER, DROP INDEX and DROP COLUMN take ACCESS EXCLUSIVE on memory_items, and removing the
-- foreign key's RI triggers takes it on posts. To keep that short: every check runs first under ACCESS SHARE only;
-- the strong-lock phase is catalog-only (no scan, no rewrite: DROP COLUMN only marks the column dropped); posts is
-- locked last, by the final ALTER TABLE, right before the COMMIT; and lock_timeout = 5s (the packet's own setting)
-- makes a lock request that would queue behind a long transaction fail instead, so readers never wait behind this
-- file for more than 5 s. On a timeout or a deadlock the transaction aborts, nothing has changed, and the file can be
-- re-run. Also: ROW SHARE on public.feature_flags (the flag row is locked FOR UPDATE so it cannot be turned on
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
  v_present int;
  v_n       bigint;
  v_bad     text;
  v_dep     text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL
     OR to_regclass('public.memory_items') IS NULL OR to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3999 rollback): public.feature_flags, public.schema_migration_ledger, public.memory_items and public.posts must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'memory_from_own_media_enabled' FOR UPDATE;
  SELECT count(*), bool_or(enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'memory_from_own_media_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3999): memory_from_own_media_enabled is TRUE. The owner has turned "Save to a Memory" from one''s own post on since 3999 was applied; deleting the row would silently turn it off and dropping the column would break it. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  -- The column, the foreign key, the two indexes, the function and the trigger: six objects.
  SELECT (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.memory_items'::regclass AND attname = 'source_post_id' AND NOT attisdropped)
       + (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.memory_items'::regclass AND conname = 'memory_items_source_post_id_fkey')
       + (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
            AND relname IN ('memory_items_source_post_id_idx', 'memory_items_source_post_media_uniq'))
       + (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'memory_items_source_post_guard')
       + (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.memory_items'::regclass AND tgname = 'memory_items_source_post_guard')
    INTO v_present;

  IF v_present = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3999 rollback: none of 3999''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_present <> 6 OR v_flags <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3999): 3999''s objects are not each present exactly once (% of its 6 objects: the column, the foreign key, two indexes, the guard function and its trigger; % of 1 flag row). 3999 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_present, v_flags;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag IN ('memory_from_own_media_enabled');
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3999): public.feature_flag_audit_log holds % row(s) recording who turned memory_from_own_media_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.memory_items WHERE source_post_id IS NOT NULL' INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3999): % memory_items row(s) record the post they were made from (source_post_id). Dropping the column erases those links and their cascade, the only record of each item''s origin; that is the owner''s decision, not a rollback''s (see the header). Nothing was changed.', v_n;
  END IF;

  -- 3999's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
-- expected:begin
    ('col:memory_items.source_post_id', 'uuid|false|||7e005a16903566282eda4c4b1389dd4a|'),
    ('con:memory_items.memory_items_source_post_id_fkey', 'f|FOREIGN KEY (source_post_id) REFERENCES public.posts(id) ON DELETE CASCADE|true|false|false'),
    ('fn:memory_items_source_post_guard()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||c0ac4950949391c1ad1b1747a3197a91131fce58cde9bce2bd0d1d2030c2fc13|d41d8cd98f00b204e9800998ecf8427e'),
    ('fx:memory_items_source_post_guard()', '---'),
    ('idx:memory_items.memory_items_source_post_id_idx', 'CREATE INDEX memory_items_source_post_id_idx ON public.memory_items USING btree (source_post_id) WHERE (source_post_id IS NOT NULL)|true|true'),
    ('idx:memory_items.memory_items_source_post_media_uniq', 'CREATE UNIQUE INDEX memory_items_source_post_media_uniq ON public.memory_items USING btree (memory_id, source_post_id, media_url) WHERE (source_post_id IS NOT NULL)|true|true'),
    ('trg:memory_items.memory_items_source_post_guard', 'CREATE TRIGGER memory_items_source_post_guard BEFORE INSERT OR UPDATE OF source_post_id, memory_id, media_url ON public.memory_items FOR EACH ROW EXECUTE FUNCTION public.memory_items_source_post_guard()|O')
-- expected:end
  ), actual(k, v) AS (
-- canon:begin
    WITH col AS (
      SELECT a.attrelid, a.attnum FROM pg_attribute a
       WHERE a.attrelid = 'public.memory_items'::regclass AND a.attname = 'source_post_id' AND NOT a.attisdropped
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'memory_items_source_post_guard'
    )
    SELECT 'col:memory_items.source_post_id', format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull
             || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || a.attidentity::text || a.attgenerated::text
             || '|' || coalesce(md5(col_description(a.attrelid, a.attnum)), '') || '|' || coalesce(a.attacl::text, '')
      FROM col JOIN pg_attribute a ON a.attrelid = col.attrelid AND a.attnum = col.attnum
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    UNION ALL
    -- every constraint on memory_items that involves the column, or carries 3999's name
    SELECT 'con:memory_items.' || k.conname, k.contype::text || '|' || pg_get_constraintdef(k.oid) || '|' || k.convalidated
             || '|' || k.condeferrable || '|' || k.condeferred
      FROM pg_constraint k
     WHERE k.conrelid = 'public.memory_items'::regclass AND k.contype <> 'n'
       AND (k.conname = 'memory_items_source_post_id_fkey' OR k.conkey && (SELECT array_agg(attnum) FROM col))
    UNION ALL
    -- every index on memory_items that involves the column (key, expression or predicate), or carries a 3999 name
    SELECT 'idx:memory_items.' || ic.relname, pg_get_indexdef(i.indexrelid) || '|' || i.indisvalid || '|' || i.indisready
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = 'public.memory_items'::regclass
       AND (ic.relname IN ('memory_items_source_post_id_idx', 'memory_items_source_post_media_uniq')
            OR (SELECT attnum FROM col) = ANY (i.indkey::int2[])
            OR position('source_post_id' IN coalesce(pg_get_expr(i.indexprs, i.indrelid), '') || coalesce(pg_get_expr(i.indpred, i.indrelid), '')) > 0)
    UNION ALL
    SELECT 'trg:' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND (t.tgfoid IN (SELECT oid FROM fn)
            OR (t.tgrelid = 'public.memory_items'::regclass AND t.tgname = 'memory_items_source_post_guard'))
    UNION ALL
    SELECT 'fn:' || f.sig, l.lanname::text || '|' || p.prokind::text || '|' || p.prosecdef || '|' || p.provolatile::text || '|' || p.proisstrict
             || '|' || p.proretset || '|' || p.prorettype::regtype::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '')
             || '|' || pg_get_function_arguments(p.oid) || '|' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
             || '|' || md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))
      FROM fn f JOIN pg_proc p ON p.oid = f.oid JOIN pg_language l ON l.oid = p.prolang
    UNION ALL
    -- EXECUTE for PUBLIC, anon, authenticated (3999 revoked all three; service_role's is the schema default's)
    SELECT 'fx:' || f.sig,
           (CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'P' ELSE '-' END)
        || (CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'a' ELSE '-' END)
        || (CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'u' ELSE '-' END)
      FROM fn f JOIN pg_proc p ON p.oid = f.oid
-- canon:end
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3999): the installed objects are not 3999''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3999 did not make may depend on the column or the function.
  WITH col AS (
    SELECT a.attnum FROM pg_attribute a
     WHERE a.attrelid = 'public.memory_items'::regclass AND a.attname = 'source_post_id' AND NOT a.attisdropped
  ), fn AS (
    SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'memory_items_source_post_guard'
  ), mine AS (
    SELECT 'pg_constraint'::regclass::oid AS classid, k.oid AS objid FROM pg_constraint k
     WHERE k.conrelid = 'public.memory_items'::regclass AND k.conname = 'memory_items_source_post_id_fkey'
    UNION ALL
    SELECT 'pg_class'::regclass::oid, c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('memory_items_source_post_id_idx', 'memory_items_source_post_media_uniq')
    UNION ALL
    SELECT 'pg_trigger'::regclass::oid, t.oid FROM pg_trigger t
     WHERE t.tgrelid = 'public.memory_items'::regclass AND t.tgname = 'memory_items_source_post_guard'
  )
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), '; ') INTO v_dep
    FROM pg_depend d
   WHERE d.deptype IN ('n', 'a')
     AND ((d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.memory_items'::regclass
           AND d.refobjsubid IN (SELECT attnum FROM col))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid IN (SELECT oid FROM fn)))
     AND (d.classid, d.objid) NOT IN (SELECT classid, objid FROM mine);
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3999): objects 3999 did not make depend on memory_items.source_post_id or its guard: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

-- Row-level work first (no strong lock): the flag row and the ledger row. NOTIFY is delivered only at the COMMIT.
DELETE FROM public.feature_flags WHERE flag = 'memory_from_own_media_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3999_memory_items_source_post.sql';
NOTIFY pgrst, 'reload schema';

-- The strong-lock phase, catalog-only: memory_items, then posts last (the foreign key's RI triggers), right before
-- the COMMIT. Skipped entirely when nothing of 3999's exists ($pre$ refused every partial state).
DO $rb$
DECLARE
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memory_items'::regclass
                  AND attname = 'source_post_id' AND NOT attisdropped) THEN
    RETURN;
  END IF;
  LOCK TABLE public.memory_items IN ACCESS EXCLUSIVE MODE;
  EXECUTE 'SELECT count(*) FROM public.memory_items WHERE source_post_id IS NOT NULL' INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3999): a source_post_id link was written while this file ran; nothing is dropped (see the header). Nothing was changed.';
  END IF;
  DROP TRIGGER memory_items_source_post_guard ON public.memory_items;
  DROP FUNCTION public.memory_items_source_post_guard();
  DROP INDEX public.memory_items_source_post_media_uniq;
  DROP INDEX public.memory_items_source_post_id_idx;
  ALTER TABLE public.memory_items
    DROP CONSTRAINT memory_items_source_post_id_fkey,
    DROP COLUMN source_post_id;
END $rb$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memory_items'::regclass
              AND attname = 'source_post_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3999): memory_items.source_post_id still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_source_post_id_fkey')
     OR to_regclass('public.memory_items_source_post_id_idx') IS NOT NULL
     OR to_regclass('public.memory_items_source_post_media_uniq') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3999): the foreign key or an index on source_post_id survived.';
  END IF;
  IF to_regprocedure('public.memory_items_source_post_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memory_items'::regclass AND tgname = 'memory_items_source_post_guard') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3999): the own-media guard or its trigger survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_from_own_media_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3999): memory_from_own_media_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3999_memory_items_source_post.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3999): the ledger still records 3999 as applied.';
  END IF;
END $post$;
