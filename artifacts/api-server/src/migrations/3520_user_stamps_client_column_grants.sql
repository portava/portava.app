-- 3520_user_stamps_client_column_grants.sql
-- user_stamps: the client roles may read only the columns that carry no
-- position. 0081's column-level REVOKE never took effect; this replaces it
-- with the form that does.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it. It changes what a signed-in client key
-- can read from a live table, so it needs the owner's production approval and
-- is sequenced by the production-rollout lane, not by this file.
--
-- 0081 IS NOT EDITED. An applied migration's bytes are pinned wherever its
-- ledger row carries a real sha256: a byte change then fails
-- check:migration-ledger AND halts scripts/src/apply-migrations.ts for every
-- lane on the shared CI database. Production's row for 0081 is the `backfill`
-- sentinel and pins nothing by itself, so the pin — if it exists — is
-- portava-ci's, which this session cannot read. That asymmetry is not a
-- licence to edit: one real sha anywhere is enough, and a comment-only edit is
-- still a byte change. This file supersedes the defect instead.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT: A COLUMN REVOKE CANNOT SUBTRACT FROM A TABLE GRANT
-- ══════════════════════════════════════════════════════════════════════════════
-- 0081_stamp_system_v2.sql:226-235 reads:
--
--     -- PostgreSQL column-level REVOKE takes precedence over table-level
--     -- GRANT, so these two statements enforce the restriction regardless of
--     -- RLS row filtering.
--     REVOKE SELECT (lat, lng) ON user_stamps FROM authenticated;
--     REVOKE SELECT (lat, lng) ON user_stamps FROM anon;
--
-- The premise is false, and the whole protection rests on it. PostgreSQL
-- privileges are ADDITIVE: a role holding table-level SELECT may read every
-- column, and `REVOKE SELECT (col)` removes only COLUMN-SPECIFIC grants. There
-- were none to remove, so both statements were no-ops. 0081 carries no
-- postcondition, so nothing failed and nothing said so for fifteen months.
--
-- 0081:49-51 states the OTHER half of the intent in the table's own comment —
-- "lat/lng columns are PRIVATE ... column exclusion is enforced at the
-- application layer" — and that half is true and is still in force: every
-- api-server read of user_stamps passes an explicit column list, and
-- routes/stamps.ts:79-87 says so in as many words — "lat/lng and metadata
-- intentionally excluded from public reads" — with OWNER_STAMP_COLS at :82-84
-- and PUBLIC_STAMP_COLS at :85-87, neither naming lat or lng. The defect is the database boundary behind it, which
-- PostgREST reaches without passing through any of that code.
--
-- ── MEASURED ON PRODUCTION (travel-buddy ajrurzioarfkagpuxfnb), READ-ONLY,
-- ── 2026-10-03, and independently on the local harness
--
--     relrowsecurity                                   t
--     policies on user_stamps                           4
--     has_table_privilege(anon|authenticated, SELECT)   t, t
--     has_column_privilege(.., 'lat'|'lng', SELECT)     t, t   ← 0081 claims f
--     information_schema.column_privileges rows for
--       anon + authenticated on user_stamps           120     (6 verbs x 20 cols)
--     rows                                             47
--     rows with lat AND lng non-null                   20
--     rows with visibility='public' AND NOT is_revoked 47
--
-- The row filter is `user_stamps_public_read`, FOR SELECT TO PUBLIC USING
-- (is_revoked = false AND visibility = 'public' AND auth.uid() <> user_id).
-- So ANY SIGNED-IN USER can read the precise coordinates of those 20 stamps
-- with the public anon key plus their own JWT:
--
--     GET /rest/v1/user_stamps?select=lat,lng,city,country
--
-- and `?lat=gt.48.85` is a range oracle that needs no SELECT list at all,
-- because PostgreSQL requires the column privilege to FILTER on a column too.
-- `anon` with no JWT cannot: auth.uid() is NULL, so `auth.uid() <> user_id` is
-- NULL and the row is filtered. The exposure is to authenticated, not anon.
--
-- The 47 rows belong to C-11 synthetic accounts, so what is wrong today is the
-- boundary, not any real person's location. That is why this is a correctness
-- fix on a normal rollout and not an incident.
--
-- Reproduced on the local harness in a rolled-back transaction, with an
-- owner-read control row first so a refusal could not pass on emptiness:
--
--     OWNER_CONTROL      lat=51.5007000 lng=-0.1246000
--     AUTHENTICATED READ lat=51.5007000 lng=-0.1246000   ← must have been refused
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A COLUMN GRANT, AND NOT A VIEW OR AN RPC
-- ══════════════════════════════════════════════════════════════════════════════
-- Column privileges cannot tell rows apart, so a column grant is the right
-- shape only if no legitimate reader needs a withheld column for SOME rows —
-- an owner reading their own coordinates, say. Surveyed across the whole repo:
--
--   * NO client-token read of user_stamps exists anywhere. All ~60 supabase-js
--     call sites are the api-server's, on the service_role client
--     (lib/supabase.ts:17 getServiceClient; lib/http.ts:272 requireUser returns
--     that same client, so even a user-authenticated route is service_role).
--     service_role bypasses RLS and column privileges and is untouched here.
--   * The mobile app (travel-buddy-standalone) has ZERO user_stamps queries.
--     Its anon client (src/lib/supabase.ts:21-40) reaches only circles,
--     message_thread_members, post, profiles, trip_members, trips,
--     user_follows, and it makes no .rpc() call at all. Every stamp byte it
--     renders arrives over HTTP from the api-server: /stamps/me,
--     /stamps/profile/:username, /me/passport/map, /me/passport/stats
--     (src/services/passportStamps.ts:175-220, 277, 287, 363, 371).
--   * NO owner read of their own lat/lng through a client token, anywhere. The
--     owner-facing column set omits them by name (routes/stamps.ts:82-84), so
--     there is no per-row exception for a column grant to get wrong.
--   * NO view, rule, SQL function or trigger reads user_stamps. Confirmed on
--     production by pg_rewrite/pg_depend (0 dependents) and by pg_proc
--     (0 functions whose body names it), and in the repo by enumerating every
--     CREATE VIEW. 0181_stamp_unified_view.sql is misnamed: it inserts a
--     feature flag, and the v1/v2 merge is application-level in
--     services/passport/UnifiedStampService.ts. So there is no
--     postgres-owned, security_invoker-off view reading around the boundary.
--   * NOT in any publication: pg_publication_rel names user_stamps in neither
--     supabase_realtime nor supabase_realtime_messages_publication on
--     production, and the repo contains no PUBLICATION statement at all. The
--     one postgres_changes subscription in the app is on generated_visuals
--     (travel-buddy-standalone/src/hooks/useVisualStatusChannel.ts:118-121).
--     (Logical replication would not honour column privileges anyway; this is
--     recorded because it would have been the one path a column grant misses.)
--   * The only named lat/lng reads in the codebase are two service_role
--     selects in the same module, compass/CompassGraphEngine.ts:681 and :2330.
--   * No `select('*')`, bare `.select()` or default select on user_stamps
--     exists under ANY client. Every call site passes an explicit column list
--     or a count/head projection. (This matters because PostgREST's
--     `select=*` emits `SELECT "user_stamps".* `, which needs the TABLE
--     privilege and would start failing.)
--
-- So no reader loses anything, a view would need an app change to be used by
-- anyone (and nobody reads the table as a client), and an RPC would invent a
-- surface with no caller. A column grant is the smallest change that makes the
-- boundary true, and it is the form this repo already standardised on for
-- exactly this defect: 3362 (posts) and 3363 (place_copies).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- REVOKE the table-level SELECT from anon and authenticated, then GRANT SELECT
-- on 17 named columns. It touches SELECT and nothing else.
--
-- ── WHAT THIS FILE DELIBERATELY LEAVES ALONE: THE WRITE GRANTS ──────────────
-- 2972_stamp_family_write_boundary.sql revokes INSERT, UPDATE, DELETE and
-- TRUNCATE on the seven stamp tables from both client roles. Measured on
-- production 2026-10-03, BY OBJECT rather than by ledger (there is no ledger
-- row for 2972 there at all): anon and authenticated still hold
-- SELECT, INSERT, UPDATE and DELETE on user_stamps, so **2972 has not reached
-- production**. 2490's effect has (REFERENCES, TRIGGER, TRUNCATE and MAINTAIN
-- are gone, with no ledger row either).
--
-- Those three write grants are 2972's to remove, not this file's, and 2972 is
-- already written and already in the chain ahead of this file. So the
-- precondition below requires the SELECT this file revokes and REPORTS
-- whatever else the client roles hold rather than refusing over it; the
-- postcondition asserts that SELECT is gone and asserts this file created no
-- column-level write of its own. What the write grants reach today is nothing:
-- user_stamps has no permissive INSERT, UPDATE or DELETE policy for a client
-- role (0081's four are three SELECT policies plus user_stamps_service_all TO
-- service_role), so RLS refuses the row before the grant matters — and a
-- `UPDATE ... RETURNING lat` would need SELECT on lat, which this file
-- removes. Applying 3520 before 2972 therefore narrows the boundary and
-- widens nothing; applying 2972 after it is unaffected, because 2972 touches
-- no SELECT and its own postcondition counts client SELECT grants across four
-- tables, of which the other three keep theirs.
--
--   WITHHELD (3):
--     lat, lng   the precise point 0081:49 says must never be exposed. This is
--                the defect.
--     metadata   an unaudited jsonb written from a caller-supplied argument
--                (services/passport/StampAwardEngine.ts:419 and :1163 pass it
--                straight through), on the same table and reachable by the
--                same roles, so a column grant cannot police what goes into
--                it. The route layer already treats it as NOT PUBLIC:
--                routes/stamps.ts:79 names it alongside lat and lng as
--                "intentionally excluded from public reads", and
--                PUBLIC_STAMP_COLS (:85-87) omits it while OWNER_STAMP_COLS
--                (:82-84) keeps it. A column privilege cannot tell an owner's
--                row from a stranger's, so the only two options are "public"
--                or "neither", and the repo's own stated intent is that it is
--                not public. It is NULL on all 47 production rows and no
--                client reads the table at all, so withholding it costs
--                nothing measurable. Stated here so it can be overruled:
--                granting metadata back is one line in a later migration.
--                The owner's own metadata is unaffected — they read it through
--                /stamps/me, on service_role.
--
--   GRANTED (17): identity, the award's provenance, the coarse place (city,
--                 country), the display and revocation state, timestamps.
--                 These are what every stamp surface renders. catalog_id
--                 (0121) is granted where it exists and skipped where it does
--                 not.
--
-- A column added to user_stamps after this is readable by NO client role until
-- a migration grants it: the default is closed. That is deliberate — an
-- unclassified column may be a position — and the precondition below refuses
-- the apply rather than guessing, exactly as 3362 does.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IT DOES NOT CHANGE
-- ══════════════════════════════════════════════════════════════════════════════
-- No policy, no row, no function, no trigger, no flag, no service_role
-- privilege, no write privilege. Every row a client role could read before, it
-- can read now; only the columns narrow. 2972's postcondition, which requires
-- at least one client SELECT grant to remain across stamp_definitions,
-- user_stamps, stamp_collections and stamp_collection_items, still passes: the
-- other three keep their table-level grant.
--
-- ── THE HALF THIS CANNOT REACH — STATED, NOT HIDDEN ─────────────────────────
-- A table-level `GRANT ALL ON TABLE public.user_stamps TO anon, authenticated`
-- run later — by a dashboard action, a schema restore, or a hand apply of a
-- file that re-grants — re-opens this in one statement, and PostgreSQL would
-- then drop the column grants as redundant. Nothing inside a migration can
-- prevent that. The standing watch is the db test
-- (src/test/db/userStampsClientColumnGrants.db.test.ts, property US-0), which
-- goes red on the replayed chain if the table grant ever comes back. The
-- broader version of the same hazard — public's TABLE default ACL handing both
-- client roles `arwd` on every NEW table — is an open decision for the owner
-- and is not this file's to settle.
--
-- Rollback: db/rollback/2026-10-03-3520-user-stamps-client-column-grants-rollback.sql
-- (restores the table-level SELECT exactly, and with it the defect).
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $pre$
DECLARE
  granted  text[] := ARRAY[
    'id','user_id','stamp_definition_id','source_type','source_id','earned_at',
    'city','country','title_override','visibility','display_on_passport',
    'is_revoked','revoked_at','revoked_reason','awarded_by_admin_id',
    'created_at','catalog_id'];
  withheld text[] := ARRAY['lat','lng','metadata'];
  optional text[] := ARRAY['catalog_id'];
  cols     text[];
  missing  text;
  unknown  text;
  bad      text;
BEGIN
  IF to_regclass('public.user_stamps') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520): public.user_stamps does not exist. 0081_stamp_system_v2.sql must be applied before its grants can be narrowed.';
  END IF;
  -- RLS decides the ROWS. If it were off, these column grants would be the
  -- only boundary, and that is a state nobody has described.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_stamps'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520): RLS is not enabled on user_stamps; column grants would then be the only boundary. Refusing.';
  END IF;

  SELECT array_agg(attname::text ORDER BY attnum) INTO cols
    FROM pg_attribute
   WHERE attrelid = 'public.user_stamps'::regclass AND attnum > 0 AND NOT attisdropped;

  -- Every column this file names (optional ones aside) must exist ...
  SELECT string_agg(c, ', ') INTO missing
    FROM unnest(granted || withheld) c
   WHERE c <> ALL (optional) AND c <> ALL (cols);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520): user_stamps lacks column(s) this migration classifies: %. The schema is not the one this was written against.', missing;
  END IF;
  -- ... and every column that exists must be classified. An unclassified
  -- column may be a position: refuse rather than guess which side it goes.
  SELECT string_agg(c, ', ') INTO unknown
    FROM unnest(cols) c
   WHERE c <> ALL (granted) AND c <> ALL (withheld);
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520): user_stamps has column(s) this migration does not classify: %. Classify them in 3520 before applying.', unknown;
  END IF;

  -- THE DEFECT MUST BE PRESENT. Both client roles must hold table-level
  -- SELECT, without the grant option (with it, revoking would leave whatever
  -- they had re-granted onward). This is what makes 0081's column REVOKE a
  -- no-op, and it is the one privilege this file removes.
  IF (SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) a
       WHERE c.oid = 'public.user_stamps'::regclass AND a.privilege_type = 'SELECT'
         AND NOT a.is_grantable
         AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520): anon and authenticated do not both hold a plain table-level SELECT on user_stamps. Either this ran already, or something re-granted it WITH GRANT OPTION. Read pg_class.relacl before proceeding.';
  END IF;
  -- PUBLIC must hold nothing: a SELECT granted to PUBLIC survives a revoke
  -- from anon and authenticated, and would keep the defect open behind a
  -- postcondition that passed.
  SELECT string_agg(a.privilege_type, ', ')
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.user_stamps'::regclass AND a.grantee = 0;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520): PUBLIC holds table privileges on user_stamps (%); revoking from anon and authenticated would not close the read. Revoke from PUBLIC first.', bad;
  END IF;
  -- 0081's REVOKE was a no-op, so there is no column-level privilege here. If
  -- one HAS appeared since, the rollback could not restore it and this file
  -- must be re-read against whatever created it.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.user_stamps'::regclass AND attnum > 0 AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3520): user_stamps already carries column-level privileges; the rollback could not restore them. Inspect pg_attribute.attacl first.';
  END IF;
  -- Everything else the client roles hold is REPORTED, not refused: on
  -- production that is 2972's three pending write grants, and on the local
  -- harness it is also REFERENCES and TRIGGER, because 2490 is in
  -- KNOWN_UNREPLAYABLE.json (PostgreSQL 16 has no MAINTAIN privilege). This
  -- file revokes SELECT; the rest is 2490's and 2972's, and refusing over
  -- them would make 3520 unappliable on the database it is for.
  SELECT string_agg(format('%s:%s', a.grantee::regrole::text, a.privilege_type), ', ' ORDER BY format('%s:%s', a.grantee::regrole::text, a.privilege_type))
    INTO bad
    FROM pg_class c, LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.user_stamps'::regclass
     AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)
     AND a.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN
    RAISE NOTICE '3520 precondition: client roles also hold %, which 2972 (and 2490) remove and this file does not touch. No client-role policy admits a write, so they reach no row.', bad;
  ELSE
    RAISE NOTICE '3520 precondition: the client roles hold table-level SELECT and nothing else; 2972 has already run here.';
  END IF;
END $pre$;

-- The table-level SELECT goes; with it, PostgreSQL removes any column-level
-- SELECT the two roles held (there is none, by the precondition).
REVOKE SELECT ON TABLE public.user_stamps FROM anon, authenticated;

GRANT SELECT (
  id, user_id, stamp_definition_id, source_type, source_id, earned_at,
  city, country, title_override, visibility, display_on_passport,
  is_revoked, revoked_at, revoked_reason, awarded_by_admin_id,
  created_at
) ON TABLE public.user_stamps TO anon, authenticated;

-- catalog_id (0121) is granted where it exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.user_stamps'::regclass AND attname = 'catalog_id' AND NOT attisdropped) THEN
    EXECUTE 'GRANT SELECT (catalog_id) ON TABLE public.user_stamps TO anon, authenticated';
  END IF;
END $$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE
  granted  text[] := ARRAY[
    'id','user_id','stamp_definition_id','source_type','source_id','earned_at',
    'city','country','title_override','visibility','display_on_passport',
    'is_revoked','revoked_at','revoked_reason','awarded_by_admin_id',
    'created_at','catalog_id'];
  -- Never readable by a client role, in any mode. lat and lng are 0081's
  -- claim; this is the assertion 0081 did not make.
  never    text[] := ARRAY['lat','lng','metadata'];
  leak     text;
  lost     text;
  writable text;
  svc      text;
BEGIN
  -- VACUITY GUARD. A sweep over no columns must not report success, and a
  -- table whose column set is not the one classified above is not the table
  -- this migration was written for.
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.user_stamps'::regclass AND attnum > 0 AND NOT attisdropped) < 19 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520) VACUOUS: user_stamps has fewer than 19 live columns; expected 19 (without catalog_id) or 20 (with it). A sweep over nothing proves nothing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.user_stamps'::regclass
                    AND attname IN ('lat','lng') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520) VACUOUS: user_stamps has neither lat nor lng, so the claim below is about nothing.';
  END IF;

  -- NO TABLE-LEVEL SELECT survives for the client roles, and PUBLIC holds
  -- nothing. This is the load-bearing one: a table-level SELECT covers every
  -- column, so it would silently restore the defect while every
  -- has_column_privilege claim below still passed. It is checked first so
  -- that its own message is the one raised.
  SELECT string_agg(format('%s:%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, x.privilege_type), ', ')
    INTO leak
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.user_stamps'::regclass
     AND ((x.grantee = 0) OR (x.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND x.privilege_type = 'SELECT'));
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520): a table-level privilege that covers every column survives on user_stamps: %. The column grants below it would then be decorative.', leak;
  END IF;

  -- THE NEGATIVE, ASSERTED. has_column_privilege(role, table oid, attnum, ...)
  -- is used throughout: by attnum it cannot raise on a column name, whatever
  -- order the planner runs the quals in.
  SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r,
         pg_attribute a
   WHERE a.attrelid = 'public.user_stamps'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (never)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520): a client role can still read a private user_stamps column: %. This is the exact state 0081 believed it had prevented.', leak;
  END IF;

  -- Exactly the granted set is readable: nothing more (a leak), nothing less
  -- (a reader this file broke).
  SELECT string_agg(r || '.' || a.attname, ', ') INTO leak
    FROM unnest(ARRAY['anon','authenticated']) r,
         pg_attribute a
   WHERE a.attrelid = 'public.user_stamps'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text <> ALL (granted)
     AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520): a client role can read a withheld user_stamps column: %.', leak;
  END IF;
  SELECT string_agg(r || '.' || a.attname, ', ') INTO lost
    FROM unnest(ARRAY['anon','authenticated']) r,
         pg_attribute a
   WHERE a.attrelid = 'public.user_stamps'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text = ANY (granted)
     AND NOT has_column_privilege(r, a.attrelid, a.attnum, 'SELECT');
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520): a client role lost a column it must keep: %.', lost;
  END IF;

  -- This file created no COLUMN-LEVEL privilege other than SELECT, and none
  -- with the grant option. Read from pg_attribute.attacl, not
  -- has_column_privilege: the latter is true for INSERT and UPDATE wherever
  -- 2972's table-level write grants are still pending (production today),
  -- which is 2972's business and not evidence that this file granted anything.
  SELECT string_agg(DISTINCT format('%s/%s', x.grantee::regrole::text, x.privilege_type), ', ') INTO writable
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = 'public.user_stamps'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND (x.privilege_type <> 'SELECT' OR x.is_grantable);
  IF writable IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520): a column-level privilege on user_stamps is not a plain SELECT: %. This file grants SELECT, without the grant option, and nothing else.', writable;
  END IF;

  -- The server's path is untouched: service_role reads every column, which is
  -- how all ~60 api-server call sites and the two CompassGraphEngine lat/lng
  -- reads reach this table.
  SELECT string_agg(a.attname, ', ') INTO svc
    FROM pg_attribute a
   WHERE a.attrelid = 'public.user_stamps'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT');
  IF svc IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3520): service_role cannot read user_stamps column(s) %; the award pipeline and every stamp route would break.', svc;
  END IF;

  RAISE NOTICE '3520 OK: anon and authenticated can read neither lat, lng nor metadata on user_stamps, hold no table-level SELECT on it, and read exactly the granted columns; service_role reads all of them. Any table-level write grant still present is 2972''s, reported by the precondition above.';
END $post$;
