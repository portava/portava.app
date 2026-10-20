-- Rollback for 3875_layover_discovery_consents.sql (LAYOVER 165, lane B2-CREW; census-layover L130, spec §14 L2).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3875 DID (one transaction, additive):
--   * created one service-role-only table, public.layover_discovery_consents (RLS on, a service_role policy, every
--     client privilege revoked), with its indexes, constraints and comment; foreign keys to layover_sessions (twice)
--     and profiles (three times), all ON DELETE CASCADE;
--   * created the guard trigger function layover_discovery_consent_guard() and its BEFORE INSERT OR UPDATE trigger;
--   * seeded the flag layover_mutual_discovery_enabled FALSE (ON CONFLICT DO NOTHING).
-- It read and wrote no existing row. The only other row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops the table (its indexes, constraints, policy, trigger, grants and the RI triggers its foreign
-- keys put on public.layover_sessions and public.profiles go with it) and the function, deletes the flag row and 3875's
-- ledger row, and asks PostgREST to reload its schema cache (delivered at the COMMIT). The catalog is then the one
-- before 3875. With the flag row gone the API reads mutual discovery as off: no L2 profile is served (the presence
-- roster stays consent-only; it never falls back to the global toggle).
--
-- DATA: IT REFUSES WHILE THE TABLE HOLDS A ROW. A row there is two travellers' recorded consent (or refusal) to see
-- each other; erasing it is the owner's decision, never a rollback's. With the flag FALSE, delete the rows deliberately
-- and re-run this file. The emptiness check runs twice (before any strong lock and after the table is locked).
-- IT ALSO REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG (0118's ON DELETE CASCADE).
--
-- Refuses, changing nothing, unless the installed state is exactly 3875's: the flag TRUE; audit history for the flag;
-- an object missing or doubled; any definition drift (the expected rows below, generated from 3875 applied on the
-- packet's replica, PostgreSQL 18.3); a dependent object 3875 did not make; a row in the table.
-- If none of 3875's objects exists, it changes nothing and clears only the (already absent) ledger row.
--
-- LOCK: ACCESS EXCLUSIVE on the table it drops and — inherent to removing a foreign key's RI triggers — on
-- public.layover_sessions and public.profiles, held until the COMMIT; checks first under ACCESS SHARE; catalog-only
-- strong phase; lock_timeout = 5s. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_audit   bigint;
  v_flags   int;
  v_on      text;
  v_tables  int;
  v_fns     int;
  v_rows    bigint;
  v_bad     text;
  v_dep     text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3875 rollback): public.feature_flags and public.schema_migration_ledger must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_mutual_discovery_enabled' FOR UPDATE;
  SELECT count(*), string_agg(flag, ', ' ORDER BY flag) FILTER (WHERE enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_mutual_discovery_enabled';
  IF v_on IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3875): % is TRUE. Turn it off deliberately first, then re-run this file. Nothing was changed.', v_on;
  END IF;

  SELECT count(*) INTO v_tables FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_discovery_consents');
  SELECT count(*) INTO v_fns FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_discovery_consent_guard');

  IF v_tables = 0 AND v_fns = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3875 rollback: none of 3875''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_tables <> 1 OR v_fns <> 1 OR v_flags <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3875): 3875''s objects are not each present exactly once (% of 1 tables, % of 1 functions, % of 1 flag row). 3875 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_tables, v_fns, v_flags;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_mutual_discovery_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3875): public.feature_flag_audit_log holds % row(s) recording who turned layover_mutual_discovery_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  SELECT (SELECT count(*) FROM public.layover_discovery_consents) INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3875): layover_discovery_consents holds % row(s). They are travellers'' recorded consents and exist nowhere else; erasing them is the owner''s decision, not a rollback''s (see the header). Nothing was changed.', v_rows;
  END IF;

  -- 3875's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
-- expected:begin
    ('col:layover_discovery_consents.ended_at', '9|timestamp with time zone|false||||'),
    ('col:layover_discovery_consents.ended_by_user_id', '10|uuid|false||||'),
    ('col:layover_discovery_consents.expires_at', '11|timestamp with time zone|true||||'),
    ('col:layover_discovery_consents.id', '1|uuid|true|gen_random_uuid()|||'),
    ('col:layover_discovery_consents.requested_at', '7|timestamp with time zone|true|now()|||'),
    ('col:layover_discovery_consents.requester_session_id', '2|uuid|true||||'),
    ('col:layover_discovery_consents.requester_user_id', '4|uuid|true||||'),
    ('col:layover_discovery_consents.responded_at', '8|timestamp with time zone|false||||'),
    ('col:layover_discovery_consents.status', '6|text|true|''requested''::text|||'),
    ('col:layover_discovery_consents.target_session_id', '3|uuid|true||||'),
    ('col:layover_discovery_consents.target_user_id', '5|uuid|true||||'),
    ('con:layover_discovery_consents.layover_discovery_consents_ended_by_user_id_fkey', 'f|FOREIGN KEY (ended_by_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_expiry_after_request', 'c|CHECK ((expires_at > requested_at))|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_pkey', 'p|PRIMARY KEY (id)|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_requester_session_id_fkey', 'f|FOREIGN KEY (requester_session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_requester_user_id_fkey', 'f|FOREIGN KEY (requester_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_state_shape', 'c|CHECK ((((status = ''requested''::text) AND (responded_at IS NULL) AND (ended_at IS NULL) AND (ended_by_user_id IS NULL)) OR ((status = ''accepted''::text) AND (responded_at IS NOT NULL) AND (ended_at IS NULL) AND (ended_by_user_id IS NULL)) OR ((status = ''declined''::text) AND (responded_at IS NOT NULL) AND (ended_at IS NOT NULL) AND (ended_by_user_id = target_user_id)) OR ((status = ''withdrawn''::text) AND (responded_at IS NULL) AND (ended_at IS NOT NULL) AND (ended_by_user_id = requester_user_id)) OR ((status = ''revoked''::text) AND (responded_at IS NOT NULL) AND (ended_at IS NOT NULL) AND ((ended_by_user_id = requester_user_id) OR (ended_by_user_id = target_user_id)))))|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_status_check', 'c|CHECK ((status = ANY (ARRAY[''requested''::text, ''accepted''::text, ''declined''::text, ''withdrawn''::text, ''revoked''::text])))|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_target_session_id_fkey', 'f|FOREIGN KEY (target_session_id) REFERENCES public.layover_sessions(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_target_user_id_fkey', 'f|FOREIGN KEY (target_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_two_people', 'c|CHECK ((requester_user_id <> target_user_id))|true|false|false'),
    ('con:layover_discovery_consents.layover_discovery_consents_two_sessions', 'c|CHECK ((requester_session_id <> target_session_id))|true|false|false'),
    ('fn:layover_discovery_consent_guard()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||a9b8eb902c723259fd55241f6766aa7dd249599c05015dd687334240ff455309|d41d8cd98f00b204e9800998ecf8427e'),
    ('fx:layover_discovery_consent_guard()', '---s'),
    ('idx:layover_discovery_consents.layover_discovery_consents_ended_by_idx', 'CREATE INDEX layover_discovery_consents_ended_by_idx ON public.layover_discovery_consents USING btree (ended_by_user_id) WHERE (ended_by_user_id IS NOT NULL)|true|true'),
    ('idx:layover_discovery_consents.layover_discovery_consents_live_pair_idx', 'CREATE UNIQUE INDEX layover_discovery_consents_live_pair_idx ON public.layover_discovery_consents USING btree (LEAST(requester_session_id, target_session_id), GREATEST(requester_session_id, target_session_id)) WHERE (status = ANY (ARRAY[''requested''::text, ''accepted''::text]))|true|true'),
    ('idx:layover_discovery_consents.layover_discovery_consents_pkey', 'CREATE UNIQUE INDEX layover_discovery_consents_pkey ON public.layover_discovery_consents USING btree (id)|true|true'),
    ('idx:layover_discovery_consents.layover_discovery_consents_requester_idx', 'CREATE INDEX layover_discovery_consents_requester_idx ON public.layover_discovery_consents USING btree (requester_session_id) WHERE (status = ANY (ARRAY[''requested''::text, ''accepted''::text]))|true|true'),
    ('idx:layover_discovery_consents.layover_discovery_consents_requester_user_idx', 'CREATE INDEX layover_discovery_consents_requester_user_idx ON public.layover_discovery_consents USING btree (requester_user_id)|true|true'),
    ('idx:layover_discovery_consents.layover_discovery_consents_target_idx', 'CREATE INDEX layover_discovery_consents_target_idx ON public.layover_discovery_consents USING btree (target_session_id) WHERE (status = ANY (ARRAY[''requested''::text, ''accepted''::text]))|true|true'),
    ('idx:layover_discovery_consents.layover_discovery_consents_target_user_idx', 'CREATE INDEX layover_discovery_consents_target_user_idx ON public.layover_discovery_consents USING btree (target_user_id)|true|true'),
    ('pol:layover_discovery_consents.layover_discovery_consents_service', '*|true'),
    ('priv:layover_discovery_consents.PUBLIC', ''),
    ('priv:layover_discovery_consents.anon', '--------'),
    ('priv:layover_discovery_consents.authenticated', '--------'),
    ('priv:layover_discovery_consents.service_role', 'siudtrgc'),
    ('rel:layover_discovery_consents', 'r|true|false|p|9806093f2bf3a1dbbc3c3f7a066aab21'),
    ('trg:layover_discovery_consents.layover_discovery_consent_guard', 'CREATE TRIGGER layover_discovery_consent_guard BEFORE INSERT OR UPDATE ON public.layover_discovery_consents FOR EACH ROW EXECUTE FUNCTION public.layover_discovery_consent_guard()|O')
-- expected:end
  ), actual(k, v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('layover_discovery_consents')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_discovery_consent_guard')
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
     WHERE NOT t.tgisinternal AND (t.tgrelid IN (SELECT oid FROM rel) OR t.tgfoid IN (SELECT oid FROM fn))
    UNION ALL
    SELECT 'pol:' || r.relname || '.' || p.polname, p.polcmd::text || '|' || p.polpermissive
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
    SELECT 'fx:' || f.sig,
           (CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'P' ELSE '-' END)
        || (CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'a' ELSE '-' END)
        || (CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'u' ELSE '-' END)
        || (CASE WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN 's' ELSE '-' END)
      FROM fn f JOIN pg_proc p ON p.oid = f.oid
-- canon:end
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3875): the installed objects are not 3875''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3875 did not make may depend on its tables or its functions.
  WITH rel AS (
    SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_discovery_consents')
  ), fn AS (
    SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_discovery_consent_guard')
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
                 SELECT t.oid FROM pg_trigger t WHERE t.tgrelid IN (SELECT oid FROM rel) OR t.tgconstraint IN (SELECT oid FROM con))));
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3875): objects 3875 did not make depend on its tables or its functions: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

-- Row-level work first (no strong lock): the flag row and the ledger row. NOTIFY is delivered only at the COMMIT.
DELETE FROM public.feature_flags WHERE flag = 'layover_mutual_discovery_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3875_layover_discovery_consents.sql';
NOTIFY pgrst, 'reload schema';

-- The strong-lock phase, catalog-only. Skipped entirely when nothing of 3875's exists ($pre$ refused every partial state).
DO $rb$
BEGIN
  IF to_regclass('public.layover_discovery_consents') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.layover_discovery_consents IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.layover_discovery_consents) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3875): a row was written to a 3875 table while this file ran; nothing is dropped (see the header). Nothing was changed.';
  END IF;
  DROP TABLE public.layover_discovery_consents;
  DROP FUNCTION public.layover_discovery_consent_guard();
END $rb$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_left FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('layover_discovery_consents');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3875): % still exist(s).', v_left;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_left FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('layover_discovery_consent_guard');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3875): % still exist(s).', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_mutual_discovery_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3875): the 3875 flag row is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3875_layover_discovery_consents.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3875): the ledger still records 3875 as applied.';
  END IF;
END $post$;
