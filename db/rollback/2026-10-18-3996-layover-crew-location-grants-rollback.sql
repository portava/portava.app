-- Rollback for 3996_layover_crew_location_grants.sql (census-layover L132/L158/L166/L203/L124/L277, Layover spec §14 L4;
-- wave 4, the Layover crew/location lane).
-- REPLACES db/rollback/2026-10-17-3996-layover-crew-location-grants-rollback.sql, removed in the same change. That file
-- deleted the flag row without refusing, and 0118's foreign key from feature_flag_audit_log is ON DELETE CASCADE, so it
-- silently erased the flag's audit history (on the packet's replica 2 audit rows became 0). It also checked no installed
-- state beyond the flag and the event rows, set no lock_timeout, sent no NOTIFY, and its $post$ asserted neither the
-- ledger row's removal nor the narrowed vocabulary. There is one file per number on purpose:
-- scripts/local-db/rehearse-pending-apply.ts runs a rollback only when exactly one db/rollback/ file matches the number.
-- Dated the day it was written, the db/rollback/ convention. 3996's own header (its line 81) still names the 2026-10-17
-- path: 3996 is checksummed into the ledger and the sealed packet, so its header is not edited.
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3996 DID (one transaction, additive):
--   * created public.layover_crew_location_controls ((crew_id, user_id) -> layover_crew_members ON DELETE CASCADE,
--     precise_sharing_enabled DEFAULT FALSE) and public.layover_crew_location_grants (the same membership foreign key,
--     session_id -> layover_sessions ON DELETE CASCADE, seven CHECKs, two indexes). Each has RLS on, every privilege
--     revoked from PUBLIC, anon and authenticated, SELECT/INSERT/UPDATE/DELETE granted to service_role, one service_role
--     policy and a table comment;
--   * created four SECURITY INVOKER trigger functions, with EXECUTE revoked from PUBLIC, anon and authenticated, and
--     their four triggers: layover_crew_location_grant_guard (on the grants), layover_crew_location_precise_off (on the
--     controls), layover_crew_location_member_left (on layover_crew_members) and layover_crew_location_crew_disbanded
--     (on layover_crews);
--   * rebuilt the layover_events event_type CHECK as layover_events_event_type_check: the sorted union of its values
--     plus 'crew_location_shared' and 'crew_location_stopped' (2985's technique);
--   * seeded layover_crew_location_enabled FALSE (ON CONFLICT DO NOTHING).
-- It read and wrote no existing row. The only other row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES:
--   * drops the two tables. Their constraints, indexes, policies, grants, comments and triggers go with them, and so do
--     the RI triggers their foreign keys put on layover_crew_members and layover_sessions;
--   * drops the two triggers on the crew tables and the four functions;
--   * rebuilds the event_type CHECK from every value it now holds except the two, sorted, under the same name. That is
--     the form 2985 left, so on the chain it is the CHECK from before 3996, byte for byte. A value a later file added is
--     kept;
--   * deletes the flag row, and 3996's ledger row so the runner re-applies 3996 later;
--   * asks PostgREST to reload its schema cache (delivered at the COMMIT).
-- The catalog is then the one before 3996. No row of an existing table is touched. With the flag row gone,
-- routes/layoverCrewLocation.ts reads the capability as absent, which is off: GET answers available: false and the two
-- writes answer feature_disabled. Its never-gated DELETE (stop sharing) fails as it did before 3996: there is no share
-- left to stop.
--
-- DATA.
-- IT REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG. The admin toggle
-- (toggle_feature_flag_with_audit) writes one each time the flag is turned on or off. 0118's foreign key from that log
-- to feature_flags is ON DELETE CASCADE, so deleting the flag row would silently erase who changed it and when, and that
-- history exists nowhere else. Export or delete those rows deliberately first. The flag row is locked FOR UPDATE first,
-- so no toggle (or any other writer) can add one while this runs.
-- IT REFUSES WHILE public.layover_events HOLDS A crew_location_shared OR crew_location_stopped ROW. Those rows record
-- that shares were made and ended (precision and times only). The narrowed CHECK cannot hold over them, and deleting
-- them is not a rollback's call. The check runs again under the table's lock, as the narrowed CHECK's own validation.
-- IT DROPS THE ROWS OF ITS OWN TWO TABLES, BY DESIGN, AND SAYS HOW MANY IN A NOTICE. This was decided, not defaulted:
--   * every row was built to be deleted, not kept. A share is CHECK-bounded to 4 hours and may not outlive its crew. A
--     control lives only as long as one crew membership. The member leaving, the crew disbanding or expiring, the
--     control going off, the route's purge-on-touch and the owner's stop each DELETE them (3996's header, EXPIRY). Each
--     table holds one row per member, upserted in place, so neither holds history;
--   * this file runs only with the flag FALSE, and while it is FALSE nothing reads or writes either table (the route
--     answers available: false / feature_disabled), so no traveller can see the rows it drops;
--   * the drop goes the private way. No grant row means "not sharing"; no control row means "precise sharing off", which
--     is 3996's own default. Re-applying 3996 later starts every member from off;
--   * the record that a share happened is the layover_events row above, which this file never deletes. The route writes
--     one after every share it stores, so where the feature was used, that refusal fires first.
-- Refusing here would only leave the operator to run the same DELETE by hand, for the same end state.
--
-- Refuses, changing nothing, unless the installed state is exactly 3996's:
--   * the flag is TRUE (turn it off deliberately first), or the flag row is missing while 3996's objects stand;
--   * the flag audit log holds a row for the flag (above);
--   * 3996's objects are not each present exactly once: something is missing, a same-named function was added, the
--     event_type CHECK lacks one of the two values, or more than one event_type CHECK exists. 3996 makes them all in
--     one transaction, so the state was made by hand;
--   * the event_type CHECK is not the validated layover_events_event_type_check that 3996 leaves (it was rebuilt by
--     hand since, so narrowing it would not restore the state before 3996);
--   * a table, column, constraint, index, policy, privilege or comment, a function's body, attributes, comment or
--     EXECUTE, or any of the four triggers differs from 3996's own. The expected rows below were generated from 3996
--     applied on the packet's replica (PostgreSQL 18.3) and are identical on PostgreSQL 16.4. They are compared as THIS
--     server deparses them, with search_path pinned to pg_catalog so every name prints qualified;
--   * any object 3996 did not make depends on a table or a function (a view, a foreign key into a table, a trigger
--     elsewhere using one of the functions);
--   * layover_events holds a crew_location_* row (above).
-- If none of 3996's objects exists and the CHECK admits neither value, it changes nothing and clears only the (already
-- absent) ledger row. A second run is therefore a no-op, and it locks none of the layover tables.
--
-- LOCK (measured on PGlite 0.5.8 = PostgreSQL 18.3 over the packet's replica, and on PGlite 0.2.17 = PostgreSQL 16.4;
-- held until the COMMIT): ACCESS EXCLUSIVE on public.layover_events, public.layover_crews,
-- public.layover_crew_members and public.layover_sessions, and on the two tables it drops. READS ARE BLOCKED on all four
-- while it runs: every layover screen reads its session, and every layover action writes an event, so they wait. Each
-- lock is inherent to an exact undo:
--   * narrowing the CHECK takes it on layover_events;
--   * DROP TRIGGER takes it on layover_crews and layover_crew_members;
--   * removing the foreign keys' RI triggers takes it on layover_crew_members and layover_sessions.
-- To keep that short:
--   * every check runs first, under ACCESS SHARE only;
--   * the strong-lock phase scans one table, layover_events, as the narrowed CHECK is validated. It does that scan
--     before it locks the crew tables and layover_sessions, which is locked last, right before the COMMIT;
--   * lock_timeout = 5s (the packet's own setting) makes a lock request that would queue behind a long transaction fail
--     instead, so readers never wait behind this file for more than 5 s plus that scan.
-- On a timeout or a deadlock the transaction aborts, nothing has changed, and the file can be re-run. A deadlock is
-- possible if an account erasure or a layover session delete runs at the same moment. Also: ROW SHARE on
-- public.feature_flags (the flag row is locked FOR UPDATE so it cannot be turned on mid-rollback), and ROW EXCLUSIVE on
-- public.feature_flags (the flag row's DELETE), on public.feature_flag_audit_log (the cascade path; it deletes no row
-- there, as checked) and on schema_migration_ledger. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_flags   int;
  v_on      boolean;
  v_tables  int;
  v_fns     int;
  v_trg     int;
  v_checks  int;
  v_conname text;
  v_def     text;
  v_valid   boolean;
  v_vocab   int;
  v_audit   bigint;
  v_events  bigint;
  v_bad     text;
  v_dep     text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL
     OR to_regclass('public.layover_events') IS NULL OR to_regclass('public.layover_sessions') IS NULL
     OR to_regclass('public.layover_crews') IS NULL OR to_regclass('public.layover_crew_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3996 rollback): public.feature_flags, public.schema_migration_ledger, public.layover_events, public.layover_sessions, public.layover_crews and public.layover_crew_members must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on, and no audit row can be added for it, while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled' FOR UPDATE;
  SELECT count(*), bool_or(enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): layover_crew_location_enabled is TRUE. The owner has turned crew location sharing on since 3996 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  SELECT count(*) INTO v_tables FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('layover_crew_location_controls', 'layover_crew_location_grants');
  SELECT count(*) INTO v_fns FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('layover_crew_location_grant_guard', 'layover_crew_location_precise_off',
                       'layover_crew_location_member_left', 'layover_crew_location_crew_disbanded');
  SELECT count(*) INTO v_trg FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND (c.relname::text, t.tgname::text) IN (('layover_crew_location_grants', 'layover_crew_location_grant_guard'),
                                               ('layover_crew_location_controls', 'layover_crew_location_precise_off'),
                                               ('layover_crew_members', 'layover_crew_location_member_left'),
                                               ('layover_crews', 'layover_crew_location_crew_disbanded'));
  -- The event_type CHECK 3996 widened, found the way 3996 found it.
  SELECT count(*), min(k.conname::text), min(pg_get_constraintdef(k.oid)), bool_and(k.convalidated)
    INTO v_checks, v_conname, v_def, v_valid
    FROM pg_constraint k
   WHERE k.conrelid = 'public.layover_events'::regclass AND k.contype = 'c'
     AND pg_get_constraintdef(k.oid) LIKE '%event_type%' AND pg_get_constraintdef(k.oid) LIKE '%session_created%';
  v_vocab := (CASE WHEN v_checks = 1 AND v_def LIKE '%''crew_location_shared''%' THEN 1 ELSE 0 END)
           + (CASE WHEN v_checks = 1 AND v_def LIKE '%''crew_location_stopped''%' THEN 1 ELSE 0 END);

  IF v_tables = 0 AND v_fns = 0 AND v_trg = 0 AND v_flags = 0 AND v_vocab = 0 THEN
    RAISE NOTICE '3996 rollback: none of 3996''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_tables <> 2 OR v_fns <> 4 OR v_trg <> 4 OR v_flags <> 1 OR v_checks <> 1 OR v_vocab <> 2 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): 3996''s objects are not each present exactly once (% of 2 tables, % of 4 functions, % of 4 triggers, % of 1 flag row, % of the 2 event types in % event_type CHECK(s) on layover_events, expected 1). 3996 makes them all in one transaction, so this state was made by hand. Nothing was changed.', v_tables, v_fns, v_trg, v_flags, v_vocab, v_checks;
  END IF;
  IF v_conname <> 'layover_events_event_type_check' OR NOT v_valid THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): the event_type CHECK on layover_events is % (%), not the validated layover_events_event_type_check that 3996 leaves. It was rebuilt by hand since, so narrowing it would not restore the state before 3996. Nothing was changed.', v_conname, CASE WHEN v_valid THEN 'validated' ELSE 'NOT VALID' END;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_crew_location_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3996): public.feature_flag_audit_log holds % row(s) recording who turned layover_crew_location_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  -- 3996's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
-- expected:begin
    ('col:layover_crew_location_controls.crew_id', '1|uuid|true||||'),
    ('col:layover_crew_location_controls.precise_sharing_enabled', '3|boolean|true|false|||'),
    ('col:layover_crew_location_controls.updated_at', '4|timestamp with time zone|true|now()|||'),
    ('col:layover_crew_location_controls.user_id', '2|uuid|true||||'),
    ('col:layover_crew_location_grants.crew_id', '1|uuid|true||||'),
    ('col:layover_crew_location_grants.expires_at', '10|timestamp with time zone|true||||'),
    ('col:layover_crew_location_grants.granted_at', '9|timestamp with time zone|true||||'),
    ('col:layover_crew_location_grants.label', '6|text|true||||'),
    ('col:layover_crew_location_grants.lat', '7|double precision|false||||'),
    ('col:layover_crew_location_grants.lng', '8|double precision|false||||'),
    ('col:layover_crew_location_grants.precision', '5|text|true||||'),
    ('col:layover_crew_location_grants.purpose', '4|text|true||||'),
    ('col:layover_crew_location_grants.session_id', '3|uuid|true||||'),
    ('col:layover_crew_location_grants.user_id', '2|uuid|true||||'),
    ('con:layover_crew_location_controls.layover_crew_location_controls_membership_fk', 'f|FOREIGN KEY (crew_id, user_id) REFERENCES public.layover_crew_members(crew_id, user_id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_crew_location_controls.layover_crew_location_controls_pkey', 'p|PRIMARY KEY (crew_id, user_id)|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_bounded_window', 'c|CHECK (((expires_at > granted_at) AND (expires_at <= (granted_at + ''04:00:00''::interval))))|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_coordinates_paired', 'c|CHECK (((lat IS NULL) = (lng IS NULL)))|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_label_check', 'c|CHECK (((char_length(label) >= 1) AND (char_length(label) <= 200)))|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_membership_fk', 'f|FOREIGN KEY (crew_id, user_id) REFERENCES public.layover_crew_members(crew_id, user_id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_no_coordinate_at_area', 'c|CHECK (((lat IS NULL) OR (("precision" = ANY (ARRAY[''venue''::text, ''exact''::text])) AND ((lat >= (''-90''::integer)::double precision) AND (lat <= (90)::double precision)) AND ((lng >= (''-180''::integer)::double precision) AND (lng <= (180)::double precision)))))|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_pkey', 'p|PRIMARY KEY (crew_id, user_id)|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_precision_check', 'c|CHECK (("precision" = ANY (ARRAY[''area''::text, ''venue''::text, ''exact''::text])))|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_purpose_check', 'c|CHECK ((purpose = ANY (ARRAY[''presence_in_context''::text, ''live_session_sharing''::text])))|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_purpose_matches_precision', 'c|CHECK ((("precision" = ''exact''::text) = (purpose = ''live_session_sharing''::text)))|true|false|false'),
    ('con:layover_crew_location_grants.layover_crew_location_grants_session_id_fkey', 'f|FOREIGN KEY (session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('fn:layover_crew_location_crew_disbanded()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||6e1d2ba02c55399342f6d608d3f0e9f6eb12b20b7640e5505c6e0f9f8ea6fdbe|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_crew_location_grant_guard()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||ffa8004b04fb92c34ff2b54bcad24690d8fa1f06e873c0e6c041dccc06a9c843|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_crew_location_member_left()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||5671fe6d868dbcd8b49e3b533bc95b23d4b88dbc7eb30c8e5ff5fb8de4af81bd|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:layover_crew_location_precise_off()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||9c935a982ad54a47d83a5211a4f1baa0133dcc3e7df411c6169ffe9573768144|d41d8cd98f00b204e9800998ecf8427e'),
    ('fx:layover_crew_location_crew_disbanded()', '---'),
    ('fx:layover_crew_location_grant_guard()', '---'),
    ('fx:layover_crew_location_member_left()', '---'),
    ('fx:layover_crew_location_precise_off()', '---'),
    ('idx:layover_crew_location_controls.layover_crew_location_controls_pkey', 'CREATE UNIQUE INDEX layover_crew_location_controls_pkey ON public.layover_crew_location_controls USING btree (crew_id, user_id)|true|true'),
    ('idx:layover_crew_location_grants.layover_crew_location_grants_expiry_idx', 'CREATE INDEX layover_crew_location_grants_expiry_idx ON public.layover_crew_location_grants USING btree (expires_at)|true|true'),
    ('idx:layover_crew_location_grants.layover_crew_location_grants_pkey', 'CREATE UNIQUE INDEX layover_crew_location_grants_pkey ON public.layover_crew_location_grants USING btree (crew_id, user_id)|true|true'),
    ('idx:layover_crew_location_grants.layover_crew_location_grants_session_idx', 'CREATE INDEX layover_crew_location_grants_session_idx ON public.layover_crew_location_grants USING btree (session_id)|true|true'),
    ('pol:layover_crew_location_controls.layover_crew_location_controls_service', '*|true|{service_role}|true|true'),
    ('pol:layover_crew_location_grants.layover_crew_location_grants_service', '*|true|{service_role}|true|true'),
    ('priv:layover_crew_location_controls.PUBLIC', ''),
    ('priv:layover_crew_location_controls.anon', '--------'),
    ('priv:layover_crew_location_controls.authenticated', '--------'),
    ('priv:layover_crew_location_controls.service_role', 'siudtrgc'),
    ('priv:layover_crew_location_grants.PUBLIC', ''),
    ('priv:layover_crew_location_grants.anon', '--------'),
    ('priv:layover_crew_location_grants.authenticated', '--------'),
    ('priv:layover_crew_location_grants.service_role', 'siudtrgc'),
    ('rel:layover_crew_location_controls', 'r|true|false|p|f0c4002f8d5f9390e4c0462730abb3b7'),
    ('rel:layover_crew_location_grants', 'r|true|false|p|a7b4a321688a2f9cc00039b647d8679d'),
    ('trg:layover_crew_location_controls.layover_crew_location_precise_off', 'CREATE TRIGGER layover_crew_location_precise_off AFTER INSERT OR DELETE OR UPDATE OF precise_sharing_enabled ON public.layover_crew_location_controls FOR EACH ROW EXECUTE FUNCTION public.layover_crew_location_precise_off()|O'),
    ('trg:layover_crew_location_grants.layover_crew_location_grant_guard', 'CREATE TRIGGER layover_crew_location_grant_guard BEFORE INSERT OR UPDATE ON public.layover_crew_location_grants FOR EACH ROW EXECUTE FUNCTION public.layover_crew_location_grant_guard()|O'),
    ('trg:layover_crew_members.layover_crew_location_member_left', 'CREATE TRIGGER layover_crew_location_member_left AFTER UPDATE OF left_at ON public.layover_crew_members FOR EACH ROW EXECUTE FUNCTION public.layover_crew_location_member_left()|O'),
    ('trg:layover_crews.layover_crew_location_crew_disbanded', 'CREATE TRIGGER layover_crew_location_crew_disbanded AFTER UPDATE OF status ON public.layover_crews FOR EACH ROW EXECUTE FUNCTION public.layover_crew_location_crew_disbanded()|O')
-- expected:end
  ), actual(k, v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('layover_crew_location_controls', 'layover_crew_location_grants')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('layover_crew_location_grant_guard', 'layover_crew_location_precise_off',
                           'layover_crew_location_member_left', 'layover_crew_location_crew_disbanded')
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
            OR (t.tgrelid = 'public.layover_crew_members'::regclass AND t.tgname = 'layover_crew_location_member_left')
            OR (t.tgrelid = 'public.layover_crews'::regclass AND t.tgname = 'layover_crew_location_crew_disbanded'))
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
    -- EXECUTE for PUBLIC, anon, authenticated (3996 revoked all three on all four functions; service_role's is the
    -- schema default's, not 3996's, so it is not compared).
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
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): the installed objects are not 3996''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3996 did not make may depend on its tables or functions. DROP without CASCADE would refuse it anyway, but
  -- only after taking the strong locks; this refuses before any.
  WITH rel AS (
    SELECT c.oid, c.reltype FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('layover_crew_location_controls', 'layover_crew_location_grants')
  ), fn AS (
    SELECT p.oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('layover_crew_location_grant_guard', 'layover_crew_location_precise_off',
                         'layover_crew_location_member_left', 'layover_crew_location_crew_disbanded')
  ), con AS (
    SELECT k.oid FROM pg_constraint k WHERE k.conrelid IN (SELECT oid FROM rel)
  ), typ AS (
    SELECT r.reltype AS oid FROM rel r
    UNION SELECT t.typarray FROM pg_type t WHERE t.oid IN (SELECT reltype FROM rel) AND t.typarray <> 0
  )
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), '; ') INTO v_dep
    FROM pg_depend d
   WHERE d.deptype IN ('n', 'a')
     AND ((d.refclassid = 'pg_class'::regclass AND d.refobjid IN (SELECT oid FROM rel))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid IN (SELECT oid FROM fn))
       OR (d.refclassid = 'pg_type'::regclass AND d.refobjid IN (SELECT oid FROM typ)))
     AND NOT ((d.classid = 'pg_class'::regclass
               AND (d.objid IN (SELECT oid FROM rel) OR d.objid IN (SELECT i.indexrelid FROM pg_index i WHERE i.indrelid IN (SELECT oid FROM rel))))
           OR (d.classid = 'pg_constraint'::regclass AND d.objid IN (SELECT oid FROM con))
           OR (d.classid = 'pg_attrdef'::regclass AND d.objid IN (SELECT ad.oid FROM pg_attrdef ad WHERE ad.adrelid IN (SELECT oid FROM rel)))
           OR (d.classid = 'pg_policy'::regclass AND d.objid IN (SELECT po.oid FROM pg_policy po WHERE po.polrelid IN (SELECT oid FROM rel)))
           OR (d.classid = 'pg_trigger'::regclass AND d.objid IN (
                 SELECT t.oid FROM pg_trigger t
                  WHERE t.tgrelid IN (SELECT oid FROM rel) OR t.tgconstraint IN (SELECT oid FROM con)
                     OR (t.tgrelid = 'public.layover_crew_members'::regclass AND t.tgname = 'layover_crew_location_member_left')
                     OR (t.tgrelid = 'public.layover_crews'::regclass AND t.tgname = 'layover_crew_location_crew_disbanded'))));
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): objects 3996 did not make depend on its tables or functions: %. Nothing was changed.', left(v_dep, 1500);
  END IF;

  -- Last, the one check that reads a table (a scan of layover_events, under ACCESS SHARE only).
  SELECT count(*) INTO v_events FROM public.layover_events
   WHERE event_type IN ('crew_location_shared', 'crew_location_stopped');
  IF v_events > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): layover_events carries % crew_location_* row(s) (crew_location_shared / crew_location_stopped), the record that shares were made and ended. The vocabulary cannot be narrowed under them, and deleting them is not a rollback''s call. Nothing was changed.', v_events;
  END IF;
END $pre$;

-- Row-level work first (no strong lock): the flag row and the ledger row. The flag delete cascades to no audit row
-- ($pre$ refused any, under the flag row's lock). NOTIFY is delivered only at the COMMIT.
DELETE FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3996_layover_crew_location_grants.sql';
NOTIFY pgrst, 'reload schema';

-- The strong-lock phase: 3996's own two tables, then layover_events (the vocabulary, the one scan), then layover_crews
-- and layover_crew_members (the two triggers, and the RI triggers of both tables' membership foreign key), and
-- layover_sessions (the grants' session foreign key) last. Skipped entirely when nothing of 3996's exists ($pre$
-- refused every partial state).
DO $rb$
DECLARE
  v_grants   bigint;
  v_controls bigint;
  v_conname  text;
  v_def      text;
  v_vals     text;
BEGIN
  IF to_regclass('public.layover_crew_location_grants') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.layover_crew_location_grants, public.layover_crew_location_controls IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO v_grants FROM public.layover_crew_location_grants;
  SELECT count(*) INTO v_controls FROM public.layover_crew_location_controls;
  IF v_grants + v_controls > 0 THEN
    RAISE NOTICE '3996 rollback: dropping % crew location share(s) and % precise-sharing control(s). With the flag off none is visible to anyone; see DATA in the header.', v_grants, v_controls;
  END IF;

  LOCK TABLE public.layover_events IN ACCESS EXCLUSIVE MODE;
  SELECT k.conname::text, pg_get_constraintdef(k.oid) INTO v_conname, v_def
    FROM pg_constraint k
   WHERE k.conrelid = 'public.layover_events'::regclass AND k.contype = 'c'
     AND pg_get_constraintdef(k.oid) LIKE '%event_type%' AND pg_get_constraintdef(k.oid) LIKE '%session_created%';
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO v_vals
    -- Every quoted literal in the definition, whatever its characters ('' is an escaped quote inside one), so a value a
    -- later file added is kept even if it is not spelled [a-z_]+.
    FROM (SELECT DISTINCT replace((regexp_matches(v_def, '''((?:[^'']|'''')*)''', 'g'))[1], '''''', '''') AS v) s
   WHERE v NOT IN ('crew_location_shared', 'crew_location_stopped');
  EXECUTE format('ALTER TABLE public.layover_events DROP CONSTRAINT %I', v_conname);
  BEGIN
    -- Validating the narrowed CHECK reads every layover_events row under this lock: the re-check of $pre$'s refusal.
    EXECUTE format('ALTER TABLE public.layover_events ADD CONSTRAINT layover_events_event_type_check CHECK (event_type IN (%s))', v_vals);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3996): a layover_events row does not fit the narrowed vocabulary (a crew_location_* row written while this file ran, or a value no CHECK literal names); it cannot be narrowed under it (see the header). Nothing was changed.';
  END;

  DROP TRIGGER layover_crew_location_crew_disbanded ON public.layover_crews;
  DROP TRIGGER layover_crew_location_member_left ON public.layover_crew_members;
  DROP TABLE public.layover_crew_location_controls;
  DROP TABLE public.layover_crew_location_grants;
  DROP FUNCTION public.layover_crew_location_grant_guard();
  DROP FUNCTION public.layover_crew_location_precise_off();
  DROP FUNCTION public.layover_crew_location_member_left();
  DROP FUNCTION public.layover_crew_location_crew_disbanded();
END $rb$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_left text;
  v_n    int;
BEGIN
  SELECT string_agg(c.relname::text, ', ') INTO v_left FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('layover_crew_location_controls', 'layover_crew_location_grants');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): % still exist(s).', v_left;
  END IF;
  SELECT string_agg(p.proname::text, ', ') INTO v_left FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('layover_crew_location_grant_guard', 'layover_crew_location_precise_off',
                       'layover_crew_location_member_left', 'layover_crew_location_crew_disbanded');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): function(s) % still exist.', v_left;
  END IF;
  SELECT string_agg(c.relname || '.' || t.tgname, ', ') INTO v_left FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgname LIKE 'layover\_crew\_location\_%';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): trigger(s) % still exist.', v_left;
  END IF;
  SELECT count(*), string_agg(pg_get_constraintdef(k.oid), ' | ') INTO v_n, v_left
    FROM pg_constraint k
   WHERE k.conrelid = 'public.layover_events'::regclass AND k.contype = 'c'
     AND pg_get_constraintdef(k.oid) LIKE '%event_type%' AND pg_get_constraintdef(k.oid) LIKE '%session_created%';
  IF v_n <> 1 OR position('crew_location_' IN v_left) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): layover_events must carry exactly one event_type CHECK, admitting neither crew_location_* type; found % : %', v_n, v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_crew_location_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): layover_crew_location_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3996_layover_crew_location_grants.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3996): the ledger still records 3996 as applied.';
  END IF;
END $post$;
