-- Rollback for 3828_layover_sessions_active_snapshot.sql (census-layover L21; Layover 165 program, lane B1-F).
-- Dated the day it was written, the db/rollback/ convention.
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3828 DID (one transaction, additive): added layover_sessions.active_snapshot_id (TEXT -> layover_certified_computations
-- (snapshot_id) ON DELETE SET NULL, constraint layover_sessions_active_snapshot_id_fkey) and layover_sessions.confidence_band (CHECK
-- layover_sessions_confidence_band_known), the index layover_sessions_active_snapshot_idx, and two SECURITY INVOKER
-- trigger functions with EXECUTE revoked from PUBLIC, anon and authenticated: layover_certcomp_track_active (AFTER INSERT
-- on layover_certified_computations; the one writer of both columns) and layover_sessions_active_snapshot_guard (BEFORE
-- INSERT OR UPDATE on layover_sessions; refuses a client role). It seeded no flag and wrote no existing row.
--
-- WHAT THIS DOES: drops the two triggers, the two functions, the index, the two constraints and the two columns, deletes
-- 3828's ledger row so the runner re-applies it later, and asks PostgREST to reload its schema cache. The catalog is then
-- the one before 3828. No row of any table is touched.
--
-- DATA. IT REFUSES WHILE ANY layover_sessions ROW CARRIES active_snapshot_id OR confidence_band. Those values are the
-- pointer from a session to the computation it is certified under; dropping them loses which snapshot is active, and
-- the stored computations would then be unreferenced history. That is the owner's decision, not a rollback's. (On a
-- database where layover_decision_persistence_enabled was never ON no computation was persisted, so no row carries one.)
--
-- Refuses, changing nothing, unless the installed state is exactly 3828's: each of its nine objects present once, and
-- the functions' bodies, the triggers, the constraints and the index as 3828 defines them (compared as this server
-- deparses them, search_path pinned to pg_catalog), and nothing 3828 did not make depending on them. With none of
-- 3828's objects present it changes nothing and clears only the (already absent) ledger row, so a second run is a no-op.
--
-- LOCK (held until the COMMIT): ACCESS EXCLUSIVE on public.layover_sessions and public.layover_certified_computations
-- (dropping a trigger, a foreign key and two columns). Every check runs first under ACCESS SHARE; lock_timeout = 5s
-- makes a lock request that would queue behind a long transaction fail instead. On a timeout nothing has changed and
-- the file can be re-run. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_present int;
  v_n       bigint;
  v_bad     text;
  v_dep     text;
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL
     OR to_regclass('public.layover_certified_computations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3828 rollback): public.layover_sessions, public.layover_certified_computations and public.schema_migration_ledger must exist.';
  END IF;

  SELECT (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass
            AND attname IN ('active_snapshot_id', 'confidence_band') AND NOT attisdropped)
       + (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.layover_sessions'::regclass
            AND conname IN ('layover_sessions_active_snapshot_id_fkey', 'layover_sessions_confidence_band_known'))
       + (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'layover_sessions_active_snapshot_idx')
       + (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
            AND proname IN ('layover_certcomp_track_active', 'layover_sessions_active_snapshot_guard'))
       + (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
            AND tgname IN ('layover_certcomp_track_active', 'layover_sessions_active_snapshot_guard'))
    INTO v_present;
  IF v_present = 0 THEN
    RAISE NOTICE '3828 rollback: none of 3828''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_present <> 9 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3828): 3828''s objects are not each present exactly once (% of 9: two columns, two constraints, one index, two functions, two triggers). 3828 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_present;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.layover_sessions WHERE active_snapshot_id IS NOT NULL OR confidence_band IS NOT NULL' INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3828): % layover_sessions row(s) point at their active certified computation or carry its confidence band. Dropping the columns loses which snapshot each session is certified under; that is the owner''s decision, not a rollback''s. Nothing was changed.', v_n;
  END IF;

  -- 3828's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
    ('col:active_snapshot_id', 'text|false|'),
    ('col:confidence_band', 'text|false|'),
    ('con:layover_sessions_active_snapshot_id_fkey', 'FOREIGN KEY (active_snapshot_id) REFERENCES public.layover_certified_computations(snapshot_id) ON DELETE SET NULL'),
    ('con:layover_sessions_confidence_band_known', 'CHECK (((confidence_band IS NULL) OR (confidence_band = ANY (ARRAY[''HIGH''::text, ''MEDIUM''::text, ''LOW''::text, ''INSUFFICIENT''::text]))))'),
    ('fn:layover_certcomp_track_active', 'e0c1152535fe432e32039635f827f74e60326b3447afa296598c021e8d0adc36|false|search_path=pg_catalog, public|---'),
    ('fn:layover_sessions_active_snapshot_guard', 'bf6be48a2a706c7b7dd28e26cef52f9817daf13d9074368732074d9f9524b1ed|false|search_path=pg_catalog, public|---'),
    ('idx:layover_sessions_active_snapshot_idx', 'CREATE INDEX layover_sessions_active_snapshot_idx ON public.layover_sessions USING btree (active_snapshot_id) WHERE (active_snapshot_id IS NOT NULL)'),
    ('trg:layover_certcomp_track_active', 'CREATE TRIGGER layover_certcomp_track_active AFTER INSERT ON public.layover_certified_computations FOR EACH ROW EXECUTE FUNCTION public.layover_certcomp_track_active()|O'),
    ('trg:layover_sessions_active_snapshot_guard', 'CREATE TRIGGER layover_sessions_active_snapshot_guard BEFORE INSERT OR UPDATE ON public.layover_sessions FOR EACH ROW EXECUTE FUNCTION public.layover_sessions_active_snapshot_guard()|O')
  ), actual(k, v) AS (
    SELECT 'col:' || a.attname, format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.layover_sessions'::regclass AND a.attname IN ('active_snapshot_id', 'confidence_band') AND NOT a.attisdropped
    UNION ALL
    SELECT 'con:' || k.conname, pg_get_constraintdef(k.oid)
      FROM pg_constraint k
     WHERE k.conrelid = 'public.layover_sessions'::regclass
       AND (k.conname IN ('layover_sessions_active_snapshot_id_fkey', 'layover_sessions_confidence_band_known')
            OR k.conkey && (SELECT array_agg(attnum) FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass
                             AND attname IN ('active_snapshot_id', 'confidence_band') AND NOT attisdropped))
    UNION ALL
    SELECT 'fn:' || p.proname, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') || '|' || p.prosecdef || '|'
             || coalesce(array_to_string(p.proconfig, ';'), '') || '|'
             || (CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                                    WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') THEN 'P' ELSE '-' END)
             || (CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'a' ELSE '-' END)
             || (CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'u' ELSE '-' END)
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_certcomp_track_active', 'layover_sessions_active_snapshot_guard')
    UNION ALL
    SELECT 'idx:' || ic.relname, pg_get_indexdef(ic.oid)
      FROM pg_class ic WHERE ic.relnamespace = 'public'::regnamespace AND ic.relname = 'layover_sessions_active_snapshot_idx'
    UNION ALL
    SELECT 'trg:' || t.tgname, pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text
      FROM pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgname IN ('layover_certcomp_track_active', 'layover_sessions_active_snapshot_guard')
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3828): the installed objects are not 3828''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3828 did not make may depend on the two columns or the two functions.
  WITH cols AS (
    SELECT attnum FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass
       AND attname IN ('active_snapshot_id', 'confidence_band') AND NOT attisdropped
  ), fns AS (
    SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('layover_certcomp_track_active', 'layover_sessions_active_snapshot_guard')
  ), mine AS (
    SELECT 'pg_constraint'::regclass::oid AS classid, k.oid AS objid FROM pg_constraint k
     WHERE k.conrelid = 'public.layover_sessions'::regclass
       AND k.conname IN ('layover_sessions_active_snapshot_id_fkey', 'layover_sessions_confidence_band_known')
    UNION ALL
    SELECT 'pg_class'::regclass::oid, c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'layover_sessions_active_snapshot_idx'
    UNION ALL
    SELECT 'pg_trigger'::regclass::oid, t.oid FROM pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgname IN ('layover_certcomp_track_active', 'layover_sessions_active_snapshot_guard')
  )
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), '; ') INTO v_dep
    FROM pg_depend d
   WHERE d.deptype IN ('n', 'a')
     AND ((d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.layover_sessions'::regclass
           AND d.refobjsubid IN (SELECT attnum FROM cols))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid IN (SELECT oid FROM fns)))
     AND (d.classid, d.objid) NOT IN (SELECT classid, objid FROM mine);
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3828): objects 3828 did not make depend on its columns or functions: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3828_layover_sessions_active_snapshot.sql';
NOTIFY pgrst, 'reload schema';

DO $rb$
DECLARE
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass
                  AND attname = 'active_snapshot_id' AND NOT attisdropped) THEN
    RETURN;
  END IF;
  LOCK TABLE public.layover_certified_computations IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.layover_sessions IN ACCESS EXCLUSIVE MODE;
  EXECUTE 'SELECT count(*) FROM public.layover_sessions WHERE active_snapshot_id IS NOT NULL OR confidence_band IS NOT NULL' INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3828): a session was pointed at a snapshot while this file ran; nothing is dropped. Nothing was changed.';
  END IF;
  DROP TRIGGER layover_certcomp_track_active ON public.layover_certified_computations;
  DROP TRIGGER layover_sessions_active_snapshot_guard ON public.layover_sessions;
  DROP FUNCTION public.layover_certcomp_track_active();
  DROP FUNCTION public.layover_sessions_active_snapshot_guard();
  DROP INDEX public.layover_sessions_active_snapshot_idx;
  ALTER TABLE public.layover_sessions
    DROP CONSTRAINT layover_sessions_confidence_band_known,
    DROP CONSTRAINT layover_sessions_active_snapshot_id_fkey,
    DROP COLUMN confidence_band,
    DROP COLUMN active_snapshot_id;
END $rb$;

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass
              AND attname IN ('active_snapshot_id', 'confidence_band') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3828): a 3828 column still exists on layover_sessions.';
  END IF;
  IF to_regclass('public.layover_sessions_active_snapshot_idx') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('layover_sessions_active_snapshot_id_fkey', 'layover_sessions_confidence_band_known')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3828): the index or a constraint survived.';
  END IF;
  IF to_regprocedure('public.layover_certcomp_track_active()') IS NOT NULL
     OR to_regprocedure('public.layover_sessions_active_snapshot_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('layover_certcomp_track_active', 'layover_sessions_active_snapshot_guard')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3828): a function or trigger survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3828_layover_sessions_active_snapshot.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3828): the ledger still records 3828 as applied.';
  END IF;
END $post$;
