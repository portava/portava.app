-- Rollback for 3827_layover_sessions_flight_connection.sql (census-layover L21, L33, L259, L267; Layover 165 program,
-- lane B1-F). Dated the day it was written, the db/rollback/ convention.
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3827 DID (one transaction, additive):
--   * added six nullable columns to layover_sessions: arrival_segment_id and departure_segment_id (-> trip_transport_segments
--     ON DELETE SET NULL, constraints layover_sessions_arrival_segment_id_fkey / _departure_segment_id_fkey), state,
--     connection_type, detected_source and expires_at, with four CHECKs (layover_sessions_state_known,
--     _connection_type_known, _detected_source_known, _segments_distinct) and a comment on each column;
--   * created the SECURITY INVOKER function layover_sessions_connection_guard (EXECUTE revoked from PUBLIC, anon and
--     authenticated) and its BEFORE INSERT OR UPDATE trigger on layover_sessions;
--   * created three indexes: layover_sessions_arrival_segment_idx, layover_sessions_departure_segment_idx and the unique
--     layover_sessions_live_connection_uidx;
--   * seeded layover_flight_connections_enabled FALSE (ON CONFLICT DO NOTHING).
-- It wrote no existing row. From then on its trigger stamped every session it saw written: `state` (DETECTED at birth,
-- the terminal state an ended status implies, RETURNING) and `expires_at` (= departure_time).
--
-- WHAT THIS DOES: drops the trigger and the function, the three indexes, the six constraints and the six columns;
-- deletes the flag row and 3827's ledger row so the runner re-applies 3827 later; asks PostgREST to reload its schema
-- cache. The catalog is then the one before 3827. No other row is touched.
--
-- DATA.
-- IT REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG: 0118's foreign key from that log to
-- feature_flags is ON DELETE CASCADE, so deleting the flag row would erase who changed it and when. Export or delete
-- those rows deliberately first. The flag row is locked FOR UPDATE first, so no toggle can add one while this runs.
-- IT REFUSES WHILE ANY layover_sessions ROW CARRIES A FACT THE API WROTE: a segment link (arrival_segment_id or
-- departure_segment_id), a connection_type, a detected_source of trip_itinerary, or a `state` other than the one the
-- trigger derives from the status alone (DETECTED for a live session, RETURNING for a returning one, COMPLETED /
-- CANCELLED / EXPIRED for an ended one). Those record how a layover was found, which flights it joins and where its
-- lifecycle stood; dropping them is the owner's decision, not a rollback's.
-- IT DROPS, BY DESIGN, what the trigger alone derived: `expires_at` (always the row's own departure_time), a `state`
-- equal to its status-derived value and the `manual` source stamped on a session born with no segment link. Each is
-- recomputable from columns this file leaves in place (and true of every session before 3827); the count dropped is
-- reported in a NOTICE. The checks run again under the table's lock.
--
-- Refuses, changing nothing, unless the installed state is exactly 3827's:
--   * the flag is TRUE (turn it off deliberately first), or the flag row is missing while 3827's objects stand;
--   * 3827's objects are not each present exactly once (made by hand);
--   * a column, constraint, index, trigger, comment or the function's body differs from 3827's (compared as this
--     server deparses them, search_path pinned to pg_catalog; md5 of the deparse, measured on PostgreSQL 18.3 —
--     PGlite 0.5.8 over the production packet's replica — a different deparse refuses rather than drops);
--   * any object 3827 did not make depends on a column or the function.
-- With none of 3827's objects and no flag row it changes nothing and clears only the (already absent) ledger row, so a
-- second run is a no-op.
--
-- LOCK (held until the COMMIT): ACCESS EXCLUSIVE on public.layover_sessions (DROP TRIGGER, DROP COLUMN) and on
-- public.trip_transport_segments (removing the two foreign keys' RI triggers). Every layover screen reads its session,
-- so readers wait while it runs; every check runs first under ACCESS SHARE, and lock_timeout = 5s makes a lock request
-- that would queue behind a long transaction fail instead. On a timeout nothing has changed and the file can be re-run.
-- Also ROW SHARE on public.feature_flags (the flag row FOR UPDATE) and ROW EXCLUSIVE on schema_migration_ledger.
-- Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_flags   int;
  v_on      boolean;
  v_present int;
  v_audit   bigint;
  v_n       bigint;
  v_bad     text;
  v_dep     text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL
     OR to_regclass('public.layover_sessions') IS NULL OR to_regclass('public.trip_transport_segments') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827 rollback): public.feature_flags, public.schema_migration_ledger, public.layover_sessions and public.trip_transport_segments must exist.';
  END IF;

  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_flight_connections_enabled' FOR UPDATE;
  SELECT count(*), bool_or(enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_flight_connections_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3827): layover_flight_connections_enabled is TRUE. The owner has turned flight connections on since 3827 was applied; deleting the row would silently turn them off. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  SELECT (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass AND NOT attisdropped
            AND attname IN ('arrival_segment_id', 'departure_segment_id', 'state', 'connection_type', 'detected_source', 'expires_at'))
       + (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.layover_sessions'::regclass
            AND conname IN ('layover_sessions_arrival_segment_id_fkey', 'layover_sessions_departure_segment_id_fkey',
                            'layover_sessions_state_known', 'layover_sessions_connection_type_known',
                            'layover_sessions_detected_source_known', 'layover_sessions_segments_distinct'))
       + (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
            AND relname IN ('layover_sessions_arrival_segment_idx', 'layover_sessions_departure_segment_idx', 'layover_sessions_live_connection_uidx'))
       + (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'layover_sessions_connection_guard')
       + (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.layover_sessions'::regclass AND tgname = 'layover_sessions_connection_guard')
    INTO v_present;
  IF v_present = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3827 rollback: none of 3827''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_present <> 17 OR v_flags <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3827): 3827''s objects are not each present exactly once (% of 17: six columns, six constraints, three indexes, the guard function and its trigger; % of 1 flag row). 3827 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_present, v_flags;
  END IF;

  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag IN ('layover_flight_connections_enabled');
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3827): public.feature_flag_audit_log holds % row(s) recording who turned layover_flight_connections_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  EXECUTE $q$SELECT count(*) FROM public.layover_sessions
              WHERE arrival_segment_id IS NOT NULL OR departure_segment_id IS NOT NULL
                 OR connection_type IS NOT NULL OR detected_source IS DISTINCT FROM CASE WHEN detected_source IS NULL THEN NULL ELSE 'manual' END
                 OR (state IS NOT NULL AND state <> CASE status WHEN 'completed' THEN 'COMPLETED' WHEN 'cancelled' THEN 'CANCELLED'
                                                                WHEN 'expired' THEN 'EXPIRED' WHEN 'returning' THEN 'RETURNING'
                                                                ELSE 'DETECTED' END)$q$ INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3827): % layover_sessions row(s) carry a fact the API wrote: a Trips flight-segment link, a connection type, a detected source or a lifecycle state the status alone does not imply. Dropping the columns erases how those layovers were found, which flights they join and where their lifecycle stood; that is the owner''s decision, not a rollback''s (see the header). Nothing was changed.', v_n;
  END IF;

  -- 3827's definition, exactly, as this server deparses it (md5 of each deparse; the function by its body's sha256).
  WITH expected(k, v) AS (VALUES
    ('col:arrival_segment_id', 'uuid|false||a9a8014618e58af31f88d0e44f8c401c'),
    ('col:connection_type', 'text|false||a0134ad907cd7c088e8118415c06de2e'),
    ('col:departure_segment_id', 'uuid|false||e855945c5fcb2561e4e729ba0065958c'),
    ('col:detected_source', 'text|false||bb04c7dd30dd9b21749410a0d01f7c99'),
    ('col:expires_at', 'timestamp with time zone|false||2b1d4ab3ba55fb3613f85ba0d2493124'),
    ('col:state', 'text|false||d887f7efcc7e251cc3348c6e6a25356a'),
    ('con:layover_sessions_arrival_segment_id_fkey', '34fd0f07c3377d8b8433552bb5a5d9b0'),
    ('con:layover_sessions_connection_type_known', '360e16fc7bee8b8cbc4f8040ceb51af7'),
    ('con:layover_sessions_departure_segment_id_fkey', '6aa8c17b934cf3a9868cbfb386880528'),
    ('con:layover_sessions_detected_source_known', 'e8b591f0a36a2cc92ba1af1d48771e8d'),
    ('con:layover_sessions_segments_distinct', 'c7ae8ac8b0bc6261efc68aed608c67ab'),
    ('con:layover_sessions_state_known', '9c065cdf4db2662a348af1425cab96f6'),
    ('fn:layover_sessions_connection_guard', '3b7f8858b0f5c1d8251a5551dd5564a0e24cf8796a0bfc878cf4c08833867dea|false|search_path=pg_catalog, public|---'),
    ('idx:layover_sessions_arrival_segment_idx', '40d6628a48ce35087509a9b381eaab9a'),
    ('idx:layover_sessions_departure_segment_idx', '6a2c290e0117e17e521cb9cd81862f8d'),
    ('idx:layover_sessions_live_connection_uidx', '05dd2cddab190450b504dbf225a2ed40'),
    ('trg:layover_sessions_connection_guard', '1fe90036f23ad45087e71f415e2452d8|O')
  ), cols AS (
    SELECT a.attnum, a.attname FROM pg_attribute a
     WHERE a.attrelid = 'public.layover_sessions'::regclass AND NOT a.attisdropped
       AND a.attname IN ('arrival_segment_id', 'departure_segment_id', 'state', 'connection_type', 'detected_source', 'expires_at')
  ), actual(k, v) AS (
    SELECT 'col:' || a.attname, format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|'
             || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || md5(coalesce(col_description(a.attrelid, a.attnum), ''))
      FROM pg_attribute a JOIN cols c ON c.attnum = a.attnum
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.layover_sessions'::regclass
    UNION ALL
    -- every constraint on layover_sessions that names a 3827 column, or carries a 3827 name
    SELECT 'con:' || k.conname, md5(pg_get_constraintdef(k.oid))
      FROM pg_constraint k
     WHERE k.conrelid = 'public.layover_sessions'::regclass AND k.contype <> 'n'
       AND (k.conname IN ('layover_sessions_arrival_segment_id_fkey', 'layover_sessions_departure_segment_id_fkey',
                          'layover_sessions_state_known', 'layover_sessions_connection_type_known',
                          'layover_sessions_detected_source_known', 'layover_sessions_segments_distinct')
            OR k.conkey && (SELECT array_agg(attnum) FROM cols))
    UNION ALL
    SELECT 'fn:' || p.proname, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') || '|' || p.prosecdef || '|'
             || coalesce(array_to_string(p.proconfig, ';'), '') || '|'
             || (CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                                    WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') THEN 'P' ELSE '-' END)
             || (CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'a' ELSE '-' END)
             || (CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'u' ELSE '-' END)
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'layover_sessions_connection_guard'
    UNION ALL
    -- every index on layover_sessions that involves a 3827 column, or carries a 3827 name
    SELECT 'idx:' || ic.relname, md5(pg_get_indexdef(i.indexrelid))
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = 'public.layover_sessions'::regclass
       AND (ic.relname IN ('layover_sessions_arrival_segment_idx', 'layover_sessions_departure_segment_idx', 'layover_sessions_live_connection_uidx')
            OR EXISTS (SELECT 1 FROM cols WHERE cols.attnum = ANY (i.indkey::int2[]))
            OR EXISTS (SELECT 1 FROM cols WHERE position(cols.attname IN coalesce(pg_get_expr(i.indexprs, i.indrelid), '')
                                                          || coalesce(pg_get_expr(i.indpred, i.indrelid), '')) > 0))
    UNION ALL
    SELECT 'trg:' || t.tgname, md5(pg_get_triggerdef(t.oid)) || '|' || t.tgenabled::text
      FROM pg_trigger t
     WHERE NOT t.tgisinternal
       AND (t.tgname = 'layover_sessions_connection_guard'
            OR t.tgfoid IN (SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'layover_sessions_connection_guard'))
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3827): the installed objects are not 3827''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3827 did not make may depend on its columns or its function.
  WITH cols AS (
    SELECT attnum FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass AND NOT attisdropped
       AND attname IN ('arrival_segment_id', 'departure_segment_id', 'state', 'connection_type', 'detected_source', 'expires_at')
  ), fn AS (
    SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'layover_sessions_connection_guard'
  ), mine AS (
    SELECT 'pg_constraint'::regclass::oid AS classid, k.oid AS objid FROM pg_constraint k
     WHERE k.conrelid = 'public.layover_sessions'::regclass
       AND k.conname IN ('layover_sessions_arrival_segment_id_fkey', 'layover_sessions_departure_segment_id_fkey',
                         'layover_sessions_state_known', 'layover_sessions_connection_type_known',
                         'layover_sessions_detected_source_known', 'layover_sessions_segments_distinct')
    UNION ALL
    SELECT 'pg_class'::regclass::oid, c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('layover_sessions_arrival_segment_idx', 'layover_sessions_departure_segment_idx', 'layover_sessions_live_connection_uidx')
    UNION ALL
    SELECT 'pg_trigger'::regclass::oid, t.oid FROM pg_trigger t
     WHERE t.tgrelid = 'public.layover_sessions'::regclass AND t.tgname = 'layover_sessions_connection_guard'
  )
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), '; ') INTO v_dep
    FROM pg_depend d
   WHERE d.deptype IN ('n', 'a')
     AND ((d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.layover_sessions'::regclass
           AND d.refobjsubid IN (SELECT attnum FROM cols))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid IN (SELECT oid FROM fn)))
     AND (d.classid, d.objid) NOT IN (SELECT classid, objid FROM mine);
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3827): objects 3827 did not make depend on its columns or its guard: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

DELETE FROM public.feature_flags WHERE flag = 'layover_flight_connections_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3827_layover_sessions_flight_connection.sql';
NOTIFY pgrst, 'reload schema';

DO $rb$
DECLARE
  v_n       bigint;
  v_derived bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass
                  AND attname = 'arrival_segment_id' AND NOT attisdropped) THEN
    RETURN;
  END IF;
  LOCK TABLE public.trip_transport_segments IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.layover_sessions IN ACCESS EXCLUSIVE MODE;
  EXECUTE $q$SELECT count(*) FROM public.layover_sessions
              WHERE arrival_segment_id IS NOT NULL OR departure_segment_id IS NOT NULL
                 OR connection_type IS NOT NULL OR detected_source IS DISTINCT FROM CASE WHEN detected_source IS NULL THEN NULL ELSE 'manual' END
                 OR (state IS NOT NULL AND state <> CASE status WHEN 'completed' THEN 'COMPLETED' WHEN 'cancelled' THEN 'CANCELLED'
                                                                WHEN 'expired' THEN 'EXPIRED' WHEN 'returning' THEN 'RETURNING'
                                                                ELSE 'DETECTED' END)$q$ INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3827): a session was linked, labelled or moved through its lifecycle while this file ran; nothing is dropped. Nothing was changed.';
  END IF;
  EXECUTE 'SELECT count(*) FROM public.layover_sessions WHERE state IS NOT NULL OR expires_at IS NOT NULL OR detected_source IS NOT NULL' INTO v_derived;
  RAISE NOTICE '3827 rollback: dropping the trigger-derived state / expires_at / manual source of % session row(s); each is recomputable from status, departure_time and the absent segment link.', v_derived;
  DROP TRIGGER layover_sessions_connection_guard ON public.layover_sessions;
  DROP FUNCTION public.layover_sessions_connection_guard();
  DROP INDEX public.layover_sessions_live_connection_uidx;
  DROP INDEX public.layover_sessions_departure_segment_idx;
  DROP INDEX public.layover_sessions_arrival_segment_idx;
  ALTER TABLE public.layover_sessions
    DROP CONSTRAINT layover_sessions_segments_distinct,
    DROP CONSTRAINT layover_sessions_detected_source_known,
    DROP CONSTRAINT layover_sessions_connection_type_known,
    DROP CONSTRAINT layover_sessions_state_known,
    DROP CONSTRAINT layover_sessions_departure_segment_id_fkey,
    DROP CONSTRAINT layover_sessions_arrival_segment_id_fkey,
    DROP COLUMN expires_at,
    DROP COLUMN detected_source,
    DROP COLUMN connection_type,
    DROP COLUMN state,
    DROP COLUMN departure_segment_id,
    DROP COLUMN arrival_segment_id;
END $rb$;

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.layover_sessions'::regclass AND NOT attisdropped
              AND attname IN ('arrival_segment_id', 'departure_segment_id', 'state', 'connection_type', 'detected_source', 'expires_at')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3827): a 3827 column still exists on layover_sessions.';
  END IF;
  IF to_regclass('public.layover_sessions_arrival_segment_idx') IS NOT NULL
     OR to_regclass('public.layover_sessions_departure_segment_idx') IS NOT NULL
     OR to_regclass('public.layover_sessions_live_connection_uidx') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3827): an index survived.';
  END IF;
  IF to_regprocedure('public.layover_sessions_connection_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.layover_sessions'::regclass AND tgname = 'layover_sessions_connection_guard') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3827): the guard or its trigger survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_flight_connections_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3827): layover_flight_connections_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3827_layover_sessions_flight_connection.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3827): the ledger still records 3827 as applied.';
  END IF;
END $post$;
