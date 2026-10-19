-- Rollback for 3997_memory_visibility_policies_and_shared_experiences.sql (census-highlights-memories H33 + H53;
-- wave 4, the Memories lane). Replaces the header recipe at 3997:77-89, which had no refusal, no transaction, no
-- $post$ and left the ledger row (so the applier would never re-apply 3997).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3997 DID (one transaction, additive):
--   * seeded two flags FALSE (ON CONFLICT DO NOTHING): memory_visibility_policies_enabled,
--     memory_shared_experiences_enabled;
--   * created three service-role-only tables (RLS on, no policy, every client privilege revoked, service_role
--     SELECT/INSERT/UPDATE/DELETE), with their indexes, constraints and table comments:
--       public.memory_visibility_policies            FK owner_id -> auth.users ON DELETE CASCADE
--       public.memory_shared_experiences              FKs host_id -> auth.users, host_memory_id -> public.memories (CASCADE)
--       public.memory_shared_experience_invitations   FKs host_id, invitee_id -> auth.users; host_memory_id -> memories
--                                                     (CASCADE); experience_id -> memory_shared_experiences (CASCADE);
--                                                     participant_memory_id -> memories (SET NULL)
--   * created seven functions, each with its search_path pinned and none executable by a client role:
--     memory_shared_experience_invite(uuid,uuid,uuid), _respond(uuid,uuid,boolean,uuid), _leave(uuid,uuid) and
--     _end(uuid,uuid) (SECURITY INVOKER, EXECUTE granted to service_role), and the trigger functions
--     _invitations_guard() and _dissolve() (SECURITY INVOKER) and _memory_gone() (SECURITY DEFINER);
--   * created three triggers: invitations_guard and dissolve on the invitations table, and
--     memory_shared_experience_memory_gone AFTER UPDATE OF state ON public.memories.
-- It read and wrote no existing row. The only other row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops the three triggers, the seven functions and the three tables (their indexes, constraints,
-- comments, grants and the RI triggers their foreign keys put on auth.users and public.memories go with them),
-- deletes the two flag rows and 3997's ledger row (so the runner re-applies 3997 later), and asks PostgREST to
-- reload its schema cache (delivered at the COMMIT). The catalog is then the one before 3997. No row of
-- public.memories, memory_tags or auth.users is touched. With the flag rows gone the API reads both capabilities as
-- absent, which is off, exactly as before 3997.
--
-- DATA: IT REFUSES WHILE ANY OF THE THREE TABLES HOLDS A ROW (the house rule of 2860, 2901 and 3376). A row there is
-- an owner's publication policy or a participant's consent record, written while a flag was on, and it exists
-- nowhere else; whether to erase it is the owner's retention decision, never a rollback's. To roll back anyway,
-- after that decision: with both flags FALSE, delete the rows deliberately (DELETE FROM the invitations, then the
-- experiences, then the policies), and re-run this file. The emptiness check runs twice: once before any strong lock,
-- and again after the three tables are locked, so a row written in between is not dropped either.
-- IT ALSO REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR EITHER FLAG. The admin toggle
-- (toggle_feature_flag_with_audit) writes one each time a flag is turned on or off, and 0118's foreign key from that
-- log to feature_flags is ON DELETE CASCADE, so deleting the flag row would silently erase who changed it and when.
-- Export or delete those audit rows deliberately first. (The two flag rows are locked FOR UPDATE first, so no toggle
-- can add one while this runs.)
--
-- Refuses, changing nothing, unless the installed state is exactly 3997's:
--   * either flag is TRUE (turn it off deliberately first), or either flag row is missing while 3997's objects stand;
--   * the flag audit log holds a row for either flag (above);
--   * 3997's objects are not each present exactly once: some are missing, or a same-named function was added (3997
--     creates them all in one transaction, so the state was made by hand);
--   * any table, column, constraint, index, trigger, policy, table privilege, comment, function body, function
--     attribute or EXECUTE privilege differs from 3997's own (the expected rows below, generated from 3997 applied on
--     the packet's replica, PostgreSQL 18.3, and identical on PostgreSQL 16.4; compared as THIS server deparses them,
--     with search_path pinned to pg_catalog so every name prints qualified);
--   * any object 3997 did not make depends on one of its tables or functions (a view, a foreign key into one of its
--     tables, a trigger elsewhere using one of its functions);
--   * a table holds a row (above).
-- If none of 3997's objects exists, it changes nothing and clears only the (already absent) ledger row: a second run
-- is a no-op, and it takes no lock on public.memories or auth.users.
--
-- LOCK (measured on PGlite 0.5.8 = PostgreSQL 18.3 over the packet's replica, and on PGlite 0.2.17 = PostgreSQL
-- 16.4; held until the COMMIT): ACCESS EXCLUSIVE on public.memories and on auth.users, and on the three tables it
-- drops. READS ARE BLOCKED on memories and auth.users while it runs: every Memory read and every Supabase Auth read
-- and write of a user row (sign-in, token refresh, sign-up) waits. Both are inherent to an exact undo: removing the
-- trigger on memories and the foreign keys' RI triggers on auth.users each take ACCESS EXCLUSIVE in PostgreSQL. To
-- keep that short: every check runs first under ACCESS SHARE only; the strong-lock phase is catalog-only (no scan);
-- memories is locked second to last and auth.users last, right before the COMMIT; and lock_timeout = 5s (the
-- packet's own setting) makes a lock request that would queue behind a long transaction fail instead, so readers
-- never wait behind this file for more than 5 s. On a timeout or a deadlock (possible if an account erasure runs at
-- the same moment) the transaction aborts, nothing has changed, and the file can be re-run. Also: ROW SHARE on
-- public.feature_flags (its two flag rows are locked FOR UPDATE so neither can be turned on mid-rollback) and ROW
-- EXCLUSIVE on schema_migration_ledger. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_audit      bigint;
  v_flags      int;
  v_on         text;
  v_tables     int;
  v_fns        int;
  v_trigger    int;
  v_n1         bigint;
  v_n2         bigint;
  v_n3         bigint;
  v_bad        text;
  v_dep        text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL
     OR to_regclass('public.memories') IS NULL OR to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3997 rollback): public.feature_flags, public.schema_migration_ledger, public.memories and auth.users must exist.';
  END IF;

  -- The flag rows, locked so neither can be turned on while this transaction runs.
  PERFORM 1 FROM public.feature_flags
   WHERE flag IN ('memory_visibility_policies_enabled', 'memory_shared_experiences_enabled') FOR UPDATE;
  SELECT count(*), string_agg(flag, ', ' ORDER BY flag) FILTER (WHERE enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags
   WHERE flag IN ('memory_visibility_policies_enabled', 'memory_shared_experiences_enabled');
  IF v_on IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3997): % is TRUE. The owner has turned it on since 3997 was applied; deleting the row would silently turn it off and dropping the tables would break it. Turn it off deliberately first, then re-run this file. Nothing was changed.', v_on;
  END IF;

  SELECT count(*) INTO v_tables FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('memory_visibility_policies', 'memory_shared_experiences', 'memory_shared_experience_invitations');
  SELECT count(*) INTO v_fns FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('memory_shared_experience_invite', 'memory_shared_experience_respond', 'memory_shared_experience_leave',
                       'memory_shared_experience_end', 'memory_shared_experience_invitations_guard',
                       'memory_shared_experience_dissolve', 'memory_shared_experience_memory_gone');
  SELECT count(*) INTO v_trigger FROM pg_trigger t
   WHERE t.tgrelid = 'public.memories'::regclass AND t.tgname = 'memory_shared_experience_memory_gone';

  IF v_tables = 0 AND v_fns = 0 AND v_trigger = 0 AND v_flags = 0 THEN
    RAISE NOTICE '3997 rollback: none of 3997''s objects exists; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF v_tables <> 3 OR v_fns <> 7 OR v_trigger <> 1 OR v_flags <> 2 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3997): 3997''s objects are not each present exactly once (% of 3 tables, % of 7 functions, % of 1 trigger on memories, % of 2 flag rows). 3997 creates them all in one transaction, so this state was made by hand. Nothing was changed.', v_tables, v_fns, v_trigger, v_flags;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag IN ('memory_visibility_policies_enabled', 'memory_shared_experiences_enabled');
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3997): public.feature_flag_audit_log holds % row(s) recording who turned a 3997 flag on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  SELECT (SELECT count(*) FROM public.memory_visibility_policies),
         (SELECT count(*) FROM public.memory_shared_experiences),
         (SELECT count(*) FROM public.memory_shared_experience_invitations)
    INTO v_n1, v_n2, v_n3;
  IF v_n1 + v_n2 + v_n3 > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3997): memory_visibility_policies holds % row(s), memory_shared_experiences % and memory_shared_experience_invitations %. They are owners'' publication policies and participants'' consent records, and they exist nowhere else; erasing them is the owner''s retention decision, not a rollback''s (see the header). Nothing was changed.', v_n1, v_n2, v_n3;
  END IF;

  -- 3997's definition, exactly, as this server deparses it.
  WITH expected(k, v) AS (VALUES
-- expected:begin
    ('col:memory_shared_experience_invitations.created_at', '8|timestamp with time zone|true|now()|||'),
    ('col:memory_shared_experience_invitations.experience_id', '6|uuid|false||||'),
    ('col:memory_shared_experience_invitations.host_id', '3|uuid|true||||'),
    ('col:memory_shared_experience_invitations.host_memory_id', '2|uuid|true||||'),
    ('col:memory_shared_experience_invitations.id', '1|uuid|true|gen_random_uuid()|||'),
    ('col:memory_shared_experience_invitations.invitee_id', '4|uuid|true||||'),
    ('col:memory_shared_experience_invitations.left_at', '10|timestamp with time zone|false||||'),
    ('col:memory_shared_experience_invitations.participant_memory_id', '7|uuid|false||||'),
    ('col:memory_shared_experience_invitations.responded_at', '9|timestamp with time zone|false||||'),
    ('col:memory_shared_experience_invitations.status', '5|text|true|''pending''::text|||'),
    ('col:memory_shared_experiences.created_at', '4|timestamp with time zone|true|now()|||'),
    ('col:memory_shared_experiences.host_id', '2|uuid|true||||'),
    ('col:memory_shared_experiences.host_memory_id', '3|uuid|true||||'),
    ('col:memory_shared_experiences.id', '1|uuid|true|gen_random_uuid()|||'),
    ('col:memory_visibility_policies.audience', '2|text|true||||'),
    ('col:memory_visibility_policies.location_precision', '3|text|true||||'),
    ('col:memory_visibility_policies.owner_id', '1|uuid|true||||'),
    ('col:memory_visibility_policies.updated_at', '4|timestamp with time zone|true|now()|||'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_answered', 'c|CHECK (((status = ''pending''::text) = (responded_at IS NULL)))|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_experience_id_fkey', 'f|FOREIGN KEY (experience_id) REFERENCES public.memory_shared_experiences(id) ON DELETE CASCADE|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_host_id_fkey', 'f|FOREIGN KEY (host_id) REFERENCES auth.users(id) ON DELETE CASCADE|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_host_memory_id_fkey', 'f|FOREIGN KEY (host_memory_id) REFERENCES public.memories(id) ON DELETE CASCADE|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_invitee_id_fkey', 'f|FOREIGN KEY (invitee_id) REFERENCES auth.users(id) ON DELETE CASCADE|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_left_stamped', 'c|CHECK (((status = ''left''::text) = (left_at IS NOT NULL)))|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_link_only_when_accepted', 'c|CHECK (((participant_memory_id IS NULL) OR (status = ''accepted''::text)))|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_member_only_when_accepted', 'c|CHECK (((status = ''accepted''::text) = (experience_id IS NOT NULL)))|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_not_self', 'c|CHECK ((host_id <> invitee_id))|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_once', 'u|UNIQUE (host_memory_id, invitee_id)|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_participant_memory_id_fkey', 'f|FOREIGN KEY (participant_memory_id) REFERENCES public.memories(id) ON DELETE SET NULL|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_pkey', 'p|PRIMARY KEY (id)|true|false|false'),
    ('con:memory_shared_experience_invitations.memory_shared_experience_invitations_status_check', 'c|CHECK ((status = ANY (ARRAY[''pending''::text, ''accepted''::text, ''declined''::text, ''left''::text])))|true|false|false'),
    ('con:memory_shared_experiences.memory_shared_experiences_host_id_fkey', 'f|FOREIGN KEY (host_id) REFERENCES auth.users(id) ON DELETE CASCADE|true|false|false'),
    ('con:memory_shared_experiences.memory_shared_experiences_host_memory_id_fkey', 'f|FOREIGN KEY (host_memory_id) REFERENCES public.memories(id) ON DELETE CASCADE|true|false|false'),
    ('con:memory_shared_experiences.memory_shared_experiences_one_per_memory', 'u|UNIQUE (host_memory_id)|true|false|false'),
    ('con:memory_shared_experiences.memory_shared_experiences_pkey', 'p|PRIMARY KEY (id)|true|false|false'),
    ('con:memory_visibility_policies.memory_visibility_policies_audience_check', 'c|CHECK ((audience = ANY (ARRAY[''public''::text, ''followers''::text, ''trip_crew''::text, ''selected_people''::text])))|true|false|false'),
    ('con:memory_visibility_policies.memory_visibility_policies_owner_id_fkey', 'f|FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE|true|false|false'),
    ('con:memory_visibility_policies.memory_visibility_policies_pkey', 'p|PRIMARY KEY (owner_id, audience)|true|false|false'),
    ('con:memory_visibility_policies.memory_visibility_policies_precision_check', 'c|CHECK ((location_precision = ANY (ARRAY[''exact''::text, ''venue''::text, ''neighborhood''::text, ''city''::text, ''country''::text, ''hidden''::text])))|true|false|false'),
    ('fn:memory_shared_experience_dissolve()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||5b305421daed2d6ea92f2ef2b3e554fed8212afeaed21641b5f8a3af19ae51a2|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:memory_shared_experience_end(uuid, uuid)', 'plpgsql|f|false|v|false|false|jsonb|search_path=pg_catalog, public|p_host_id uuid, p_memory_id uuid|7a0509e1d0e29fa53de7491971a23add411e09b7e99cb321dcfce34d27b20152|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:memory_shared_experience_invitations_guard()', 'plpgsql|f|false|v|false|false|trigger|search_path=pg_catalog, public||b7928ddb7797679a858962a01381640104547715fb3bdfc722f090fd45920c59|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:memory_shared_experience_invite(uuid, uuid, uuid)', 'plpgsql|f|false|v|false|false|jsonb|search_path=pg_catalog, public|p_host_id uuid, p_memory_id uuid, p_invitee_id uuid|e6bfe0553e6eb3c6f9ffda61fe95cda189b88ffb3e97afd95d88ea2776c4cc77|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:memory_shared_experience_leave(uuid, uuid)', 'plpgsql|f|false|v|false|false|jsonb|search_path=pg_catalog, public|p_experience_id uuid, p_user_id uuid|d2f85e692c52fa44f19b5d5e9ea4aac288025147c91b7203458a3aa3939a3a62|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:memory_shared_experience_memory_gone()', 'plpgsql|f|true|v|false|false|trigger|search_path=pg_catalog, public||b4a22562bea5b10e686d423edb77b56d983365cb25bf5062c1c5bc237f4562f0|d41d8cd98f00b204e9800998ecf8427e'),
    ('fn:memory_shared_experience_respond(uuid, uuid, boolean, uuid)', 'plpgsql|f|false|v|false|false|jsonb|search_path=pg_catalog, public|p_invitation_id uuid, p_invitee_id uuid, p_accept boolean, p_participant_memory_id uuid|b5bd20cf6abb11d25e862a066e0a360721e390c1e2610a32e15a3dc4fc6f56f5|d41d8cd98f00b204e9800998ecf8427e'),
    ('fx:memory_shared_experience_dissolve()', '---'),
    ('fx:memory_shared_experience_end(uuid, uuid)', '---'),
    ('fx:memory_shared_experience_invitations_guard()', '---'),
    ('fx:memory_shared_experience_invite(uuid, uuid, uuid)', '---'),
    ('fx:memory_shared_experience_leave(uuid, uuid)', '---'),
    ('fx:memory_shared_experience_memory_gone()', '---'),
    ('fx:memory_shared_experience_respond(uuid, uuid, boolean, uuid)', '---'),
    ('fxs:memory_shared_experience_end(uuid, uuid)', 's'),
    ('fxs:memory_shared_experience_invite(uuid, uuid, uuid)', 's'),
    ('fxs:memory_shared_experience_leave(uuid, uuid)', 's'),
    ('fxs:memory_shared_experience_respond(uuid, uuid, boolean, uuid)', 's'),
    ('idx:memory_shared_experience_invitations.memory_shared_experience_invitations_experience_idx', 'CREATE INDEX memory_shared_experience_invitations_experience_idx ON public.memory_shared_experience_invitations USING btree (experience_id)|true|true'),
    ('idx:memory_shared_experience_invitations.memory_shared_experience_invitations_invitee_idx', 'CREATE INDEX memory_shared_experience_invitations_invitee_idx ON public.memory_shared_experience_invitations USING btree (invitee_id, status)|true|true'),
    ('idx:memory_shared_experience_invitations.memory_shared_experience_invitations_link_once', 'CREATE UNIQUE INDEX memory_shared_experience_invitations_link_once ON public.memory_shared_experience_invitations USING btree (participant_memory_id) WHERE (participant_memory_id IS NOT NULL)|true|true'),
    ('idx:memory_shared_experience_invitations.memory_shared_experience_invitations_once', 'CREATE UNIQUE INDEX memory_shared_experience_invitations_once ON public.memory_shared_experience_invitations USING btree (host_memory_id, invitee_id)|true|true'),
    ('idx:memory_shared_experience_invitations.memory_shared_experience_invitations_pkey', 'CREATE UNIQUE INDEX memory_shared_experience_invitations_pkey ON public.memory_shared_experience_invitations USING btree (id)|true|true'),
    ('idx:memory_shared_experiences.memory_shared_experiences_host_idx', 'CREATE INDEX memory_shared_experiences_host_idx ON public.memory_shared_experiences USING btree (host_id)|true|true'),
    ('idx:memory_shared_experiences.memory_shared_experiences_one_per_memory', 'CREATE UNIQUE INDEX memory_shared_experiences_one_per_memory ON public.memory_shared_experiences USING btree (host_memory_id)|true|true'),
    ('idx:memory_shared_experiences.memory_shared_experiences_pkey', 'CREATE UNIQUE INDEX memory_shared_experiences_pkey ON public.memory_shared_experiences USING btree (id)|true|true'),
    ('idx:memory_visibility_policies.memory_visibility_policies_pkey', 'CREATE UNIQUE INDEX memory_visibility_policies_pkey ON public.memory_visibility_policies USING btree (owner_id, audience)|true|true'),
    ('priv:memory_shared_experience_invitations.PUBLIC', ''),
    ('priv:memory_shared_experience_invitations.anon', '--------'),
    ('priv:memory_shared_experience_invitations.authenticated', '--------'),
    ('priv:memory_shared_experience_invitations.service_role', 'siud---c'),
    ('priv:memory_shared_experiences.PUBLIC', ''),
    ('priv:memory_shared_experiences.anon', '--------'),
    ('priv:memory_shared_experiences.authenticated', '--------'),
    ('priv:memory_shared_experiences.service_role', 'siud---c'),
    ('priv:memory_visibility_policies.PUBLIC', ''),
    ('priv:memory_visibility_policies.anon', '--------'),
    ('priv:memory_visibility_policies.authenticated', '--------'),
    ('priv:memory_visibility_policies.service_role', 'siud---c'),
    ('rel:memory_shared_experience_invitations', 'r|true|false|p|2d1038bb34cd83ea4032d515616ef84d'),
    ('rel:memory_shared_experiences', 'r|true|false|p|a4a47ef8ba66d51d8328fa9a3457681e'),
    ('rel:memory_visibility_policies', 'r|true|false|p|6bcd1f16fc941df5016ae763d4200012'),
    ('trg:memories.memory_shared_experience_memory_gone', 'CREATE TRIGGER memory_shared_experience_memory_gone AFTER UPDATE OF state ON public.memories FOR EACH ROW WHEN (((new.state = ANY (ARRAY[''deleted''::text, ''removed''::text])) AND (old.state IS DISTINCT FROM new.state))) EXECUTE FUNCTION public.memory_shared_experience_memory_gone()|O'),
    ('trg:memory_shared_experience_invitations.memory_shared_experience_dissolve', 'CREATE TRIGGER memory_shared_experience_dissolve AFTER DELETE OR UPDATE OF status ON public.memory_shared_experience_invitations FOR EACH ROW EXECUTE FUNCTION public.memory_shared_experience_dissolve()|O'),
    ('trg:memory_shared_experience_invitations.memory_shared_experience_invitations_guard', 'CREATE TRIGGER memory_shared_experience_invitations_guard BEFORE INSERT OR UPDATE ON public.memory_shared_experience_invitations FOR EACH ROW EXECUTE FUNCTION public.memory_shared_experience_invitations_guard()|O')
-- expected:end
  ), actual(k, v) AS (
-- canon:begin
    WITH rel AS (
      SELECT c.oid, c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('memory_visibility_policies', 'memory_shared_experiences', 'memory_shared_experience_invitations')
    ), fn AS (
      SELECT p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('memory_shared_experience_invite', 'memory_shared_experience_respond', 'memory_shared_experience_leave',
                           'memory_shared_experience_end', 'memory_shared_experience_invitations_guard',
                           'memory_shared_experience_dissolve', 'memory_shared_experience_memory_gone')
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
            OR (t.tgrelid = 'public.memories'::regclass AND t.tgname = 'memory_shared_experience_memory_gone'))
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
    -- EXECUTE for PUBLIC, anon, authenticated (3997 revoked all three on every function) ...
    SELECT 'fx:' || f.sig,
           (CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'P' ELSE '-' END)
        || (CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'a' ELSE '-' END)
        || (CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'u' ELSE '-' END)
      FROM fn f JOIN pg_proc p ON p.oid = f.oid
    UNION ALL
    -- ... and service_role on the four it granted (the trigger functions' service_role EXECUTE is the schema default's).
    SELECT 'fxs:' || f.sig, (CASE WHEN has_function_privilege('service_role', f.oid, 'EXECUTE') THEN 's' ELSE '-' END)
      FROM fn f
     WHERE f.sig IN ('memory_shared_experience_invite(uuid, uuid, uuid)', 'memory_shared_experience_respond(uuid, uuid, boolean, uuid)',
                     'memory_shared_experience_leave(uuid, uuid)', 'memory_shared_experience_end(uuid, uuid)')
-- canon:end
  )
  SELECT string_agg(coalesce(e.k, a.k), ', ' ORDER BY coalesce(e.k, a.k)) INTO v_bad
    FROM expected e FULL JOIN actual a ON a.k = e.k
   WHERE e.v IS DISTINCT FROM a.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3997): the installed objects are not 3997''s definition; these differ (missing, extra or changed): %. Nothing was changed.', left(v_bad, 1500);
  END IF;

  -- Nothing 3997 did not make may depend on its tables or functions (DROP without CASCADE would refuse it anyway,
  -- but only after taking the strong locks; this refuses before any).
  WITH rel AS (
    SELECT c.oid FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('memory_visibility_policies', 'memory_shared_experiences', 'memory_shared_experience_invitations')
  ), fn AS (
    SELECT p.oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('memory_shared_experience_invite', 'memory_shared_experience_respond', 'memory_shared_experience_leave',
                         'memory_shared_experience_end', 'memory_shared_experience_invitations_guard',
                         'memory_shared_experience_dissolve', 'memory_shared_experience_memory_gone')
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
                     OR (t.tgrelid = 'public.memories'::regclass AND t.tgname = 'memory_shared_experience_memory_gone'))));
  IF v_dep IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3997): objects 3997 did not make depend on its tables or functions: %. Nothing was changed.', left(v_dep, 1500);
  END IF;
END $pre$;

-- Row-level work first (no strong lock): the flag rows and the ledger row. NOTIFY is delivered only at the COMMIT.
DELETE FROM public.feature_flags
 WHERE flag IN ('memory_visibility_policies_enabled', 'memory_shared_experiences_enabled') AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3997_memory_visibility_policies_and_shared_experiences.sql';
NOTIFY pgrst, 'reload schema';

-- The strong-lock phase, catalog-only, hottest relation last: the three tables (3997's own), then memories, then
-- auth.users. Skipped entirely when nothing of 3997's exists ($pre$ refused every partial state).
DO $rb$
BEGIN
  IF to_regclass('public.memory_shared_experience_invitations') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE public.memory_visibility_policies, public.memory_shared_experiences, public.memory_shared_experience_invitations
    IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.memory_visibility_policies) OR EXISTS (SELECT 1 FROM public.memory_shared_experiences)
     OR EXISTS (SELECT 1 FROM public.memory_shared_experience_invitations) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3997): a row was written to a 3997 table while this file ran; nothing is dropped (see the header). Nothing was changed.';
  END IF;
  DROP TRIGGER memory_shared_experience_invitations_guard ON public.memory_shared_experience_invitations;
  DROP TRIGGER memory_shared_experience_dissolve ON public.memory_shared_experience_invitations;
  DROP FUNCTION public.memory_shared_experience_invite(uuid, uuid, uuid);
  DROP FUNCTION public.memory_shared_experience_respond(uuid, uuid, boolean, uuid);
  DROP FUNCTION public.memory_shared_experience_leave(uuid, uuid);
  DROP FUNCTION public.memory_shared_experience_end(uuid, uuid);
  DROP FUNCTION public.memory_shared_experience_invitations_guard();
  DROP FUNCTION public.memory_shared_experience_dissolve();
  DROP TRIGGER memory_shared_experience_memory_gone ON public.memories;
  DROP FUNCTION public.memory_shared_experience_memory_gone();
  DROP TABLE public.memory_shared_experience_invitations, public.memory_shared_experiences, public.memory_visibility_policies;
END $rb$;

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_left FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('memory_visibility_policies', 'memory_shared_experiences', 'memory_shared_experience_invitations');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3997): % still exist(s).', v_left;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_left FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'memory\_shared\_experience\_%';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3997): function(s) % still exist.', v_left;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memories'::regclass AND tgname = 'memory_shared_experience_memory_gone') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3997): the memory_gone trigger is still on public.memories.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE contype = 'f' AND confrelid IN ('auth.users'::regclass, 'public.memories'::regclass)
                AND (conname LIKE 'memory\_shared\_experience%' OR conname LIKE 'memory\_visibility\_policies%')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3997): a 3997 foreign key into auth.users or public.memories survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('memory_visibility_policies_enabled', 'memory_shared_experiences_enabled')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3997): a 3997 flag row is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3997_memory_visibility_policies_and_shared_experiences.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3997): the ledger still records 3997 as applied.';
  END IF;
END $post$;
