-- 3742_profiles_authority_columns_server_only.sql
--
-- A signed-in user stops being able to write the columns of their own
-- `profiles` row that other code TRUSTS: the verified badge, the trust score
-- and label, the verification method, the "Featured by Portava" counter and the
-- account's age. POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band).
-- Lane G3 (mission 4, security), band 3740-3759.
--
-- Privilege and trigger only. No row, policy, flag or service_role privilege
-- changes. Idempotent: REVOKE is a no-op where the privilege is already gone,
-- and the function and trigger are replaced in place.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT (verifier F5 on PR #647, 2026-10-07; confirmed IN PRODUCTION by the
-- lead's read-only catalog query)
-- ══════════════════════════════════════════════════════════════════════════════
-- `anon` and `authenticated` hold column-level UPDATE on these profiles columns
-- (the baseline's 80-column UPDATE list; 3740 re-issues the same list):
--
--   verified, verified_at, trust_score, trust_label, verification_method,
--   featured_count, created_at, account_status
--
-- and `profiles_update` (USING / WITH CHECK id = auth.uid()) admits a user's own
-- row. No trigger guards any of them (2078 guards role, 0106/2079 is_official,
-- 2163 nine verification columns; on PR #592, 3600 guards account_status). So
-- `PATCH /rest/v1/profiles?id=eq.<self>` with the user's own JWT sets them, and
-- the server reads them as facts about the user:
--
--   verified        events.ts:715 / :3232 admit a caller to a verified-only event
--                   and its waitlist; posts.ts:2817 / :3494 let a caller comment
--                   on a verified-only post; the verified badge on every card.
--   verified_at     PassportProjectionService.ts:887 shows the verified badge for
--                   `verified === true || Boolean(verified_at)`;
--                   profileSerializers.ts:113 serves it as verifiedAt.
--   trust_score     domain/telegraph/policies/sendRateLimit.ts:174 (the Telegraph
--                   send tier); compass/CompassActiveUserRewardEngine.ts:159.
--   trust_label     the trust label shown beside the score.
--   verification_method  how the user was verified, as displayed.
--   featured_count  routes/passport.ts:877, routes/profile.ts:149 ("Featured by
--                   Portava" is GRANTED by an admin — 2331's header).
--   created_at      sendRateLimit.ts:174 again: account age. A user who sets it to
--                   2020 skips "account_under_two_days_old" (the strictest tier)
--                   and reaches "established". (Not in the verifier's list; found
--                   while tracing trust_score's reader. Proposed ruling G3-1.)
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHO LEGITIMATELY WRITES THEM — every writer is the server's service client
-- ══════════════════════════════════════════════════════════════════════════════
--   verified, verified_at   routes/admin.ts POST /admin/users/:id/verify and
--                           /unverify (requireAdmin -> getServiceClient);
--                           routes/verification.ts applyVerifiedProfile
--                           (verified_at; getServiceClient).
--   featured_count          routes/adminFeatured.ts -> portava_adjust_profile_counter
--                           (2331; EXECUTE is service_role's only).
--   account_status          routes/profile.ts deactivate / reactivate and
--                           AccountDeletionService anonymise_profile (service).
--   trust_score, trust_label, verification_method, created_at
--                           no writer in the tree: column defaults, plus seed
--                           scripts that run with the service-role key.
-- The API builds no other client (lib/supabase.ts; handRolledAuthAccountState
-- .test.ts pins it). No client tree — travel-buddy-standalone, the root Expo
-- app, posts-ui, packages, lib — writes any of these columns
-- (src/test/profileAuthorityColumns.test.ts P-1 holds that premise). The signup
-- trigger handle_new_user inserts id, handle, username and name only.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX — the two barriers 2078 established for `role`
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Column grants. REVOKE UPDATE on every profiles AUTHORITY column from
--    PUBLIC, anon and authenticated: the seven above, account_status, and the
--    columns whose trigger already exists but whose grant was never taken —
--    role (2078 took it; restated), is_official and 2163's nine. 2163 could
--    not revoke its columns ("a column-level REVOKE cannot carve these columns
--    out") because portava-ci held TABLE-level UPDATE; 3740 removes that, so
--    the column barrier now holds on every database (proposed ruling G3-2).
--    The $pre$ block refuses while any client role or PUBLIC still holds
--    table-level UPDATE on profiles, because then this REVOKE would change
--    nothing a client sees: apply 3740 first.
-- 2. A BEFORE INSERT OR UPDATE trigger, which survives a careless re-grant
--    (2078:50-54: "a single future GRANT UPDATE ON profiles TO authenticated …
--    silently re-grants every column"). It refuses, 42501, a change to any of
--    the seven columns, or a non-default value on INSERT (an upsert is an
--    INSERT first), unless caller_may_write_profile_role() admits the caller —
--    service_role, postgres, supabase_admin. A signup inserting the column
--    defaults is untouched; so is every other column.
--    SECURITY INVOKER, unlike 2078/2163/3600's guards: the predicate reads the
--    role GUC, which a definer function does not change anyway, and a trigger
--    function needs no rights of its own. EXECUTE on it is revoked from the
--    client roles (a trigger fires without it). It calls the predicate only
--    after it has found a guarded column changing, so an ordinary profile edit
--    never depends on that predicate's EXECUTE grant.
--
-- account_status: 3600 (PR #592, branch claude/creator-ledger-pseudonymised-
-- 20261004) owns its trigger (trg_profiles_account_status_privileged) and its
-- column REVOKE. This file does NOT add a second trigger for it. It DOES revoke
-- its column grant, because 3740 (which sorts after 3600) re-grants the
-- baseline's UPDATE list, account_status included, and 3600's postcondition —
-- re-run by certify:migrations stage 4 on a full-chain build — asserts that no
-- client role holds UPDATE (account_status). Without this REVOKE, a chain
-- holding both 3600 and 3740 certifies red and leaves the column granted.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER, POSTCONDITIONS, ROLLBACK, GUARD
-- ══════════════════════════════════════════════════════════════════════════════
-- Sorts after 3740 and depends on it (precondition). 3740's own postcondition
-- pins only "no MORE than the baseline's UPDATE columns", so narrowing them
-- here keeps it green when certify re-runs it (verifier F5).
-- The $post$ block, re-run after COMMIT, asserts: no client role can UPDATE any
-- present authority column (has_column_privilege, so a table-level grant or a
-- grant to PUBLIC counts); no PUBLIC column grant; the trigger is installed,
-- enabled (not REPLICA), BEFORE, FOR EACH ROW, on INSERT and UPDATE, with no
-- WHEN condition and no UPDATE OF column list; its function still compares each present guarded column and
-- reaches its 42501 refusal before any RETURN (TEXTUAL — it reads the
-- definition, it does not run it; see check 3 for what that reading cannot
-- see); caller_may_write_profile_role() is still 2078's definition in the
-- catalog (LANGUAGE sql, STABLE, SECURITY INVOKER, SET search_path TO
-- 'public', 'pg_catalog' — verifier G3b A) and still reads the role GUC and
-- session_user; and, executed with the role GUC set to anon and to
-- authenticated, it returns false (verifier G3 F1-F3).
--
-- THE EXECUTED PROBE IS ONE SAMPLE PER CLIENT ROLE (verifier G3b F). It runs
-- the predicate once as anon and once as authenticated, with the role GUC set
-- and NOTHING else: no request.jwt.* claim, no other session setting, no row.
-- A definition that admits a client only under some other condition — a JWT
-- claim PostgREST sets on every request, a time, a table's contents — passes
-- the probe. What stops such a definition is the catalog check above and
-- rule 6's full-definition pin (a chain file cannot change the predicate's
-- definition without turning rule 6 red); the probe catches a predicate that
-- admits the client role as such.
--
-- THE PROBE FAILS CLOSED (lead ruling G3-3). It needs the applying role to be
-- able to SET ROLE anon and authenticated. Where it cannot, the $pre$ block
-- refuses before anything changes and the $post$ block raises instead of
-- skipping the probe. PRE-PRESS CHECK, as the applying role:
--   select pg_has_role(current_user, 'anon', 'MEMBER'),
--          pg_has_role(current_user, 'authenticated', 'MEMBER');
-- must return true, true (docs/migrations.md, 3742).
-- Rollback: db/rollback/2026-10-07-3742-profiles-authority-columns-server-only-rollback.sql
-- (drops the trigger and re-opens the seven columns; recovery only).
-- Guard: checkClientPrivilegeBoundary.ts rule 6 (same change) replays every
-- grant and revoke on profiles, every trigger and every definition of the
-- predicate in apply order, and fails if any authority column ends
-- client-updatable or unguarded. Where it runs: src/test/profileAuthority
-- Columns.test.ts R6-1/R6-7 in ci.yml's always-run node:test job; the CLI's
-- --require line in check:security runs only in live-db.yml.
--
-- A CLIENT UPSERT MUST NOT CARRY created_at (verifier G3 F7). The INSERT side
-- admits created_at only as now(); a read-modify-upsert that echoes a row's
-- existing created_at is refused 42501 even though ON CONFLICT would change
-- nothing. No client upserts profiles today (P-1).

BEGIN;

DO $pre$
DECLARE
  v_cols constant text[] := ARRAY[
    'verified', 'verified_at', 'trust_score', 'trust_label',
    'verification_method', 'featured_count', 'created_at', 'account_status',
    'role', 'is_official', 'verification_status', 'verification_level',
    'verified_since', 'id_verified_at', 'selfie_verified_at',
    'home_country_verified_at', 'host_verified_at', 'buddy_verified_at',
    'safety_flags_count'];
  v_names text;
  v_role text;
BEGIN
  -- The applying role must be able to SET ROLE anon and authenticated: the
  -- postcondition executes caller_may_write_profile_role() as each client role
  -- and FAILS where it cannot (lead ruling G3-3). Asked first, so a database
  -- where the postcondition would fail is refused before anything changes.
  -- The role is set in a sub-transaction that is always rolled back.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    BEGIN
      PERFORM set_config('role', v_role, true);
      RAISE EXCEPTION USING ERRCODE = 'P3742', MESSAGE = '3742 role check: roll the role back';
    EXCEPTION
      WHEN SQLSTATE 'P3742' THEN NULL;
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION '3742 PRECONDITION FAILED: the applying role (session user %) cannot SET ROLE %, so the postcondition could not execute caller_may_write_profile_role() as a client. Run this file as a role that is a member of anon and authenticated: select pg_has_role(current_user, ''anon'', ''MEMBER''), pg_has_role(current_user, ''authenticated'', ''MEMBER'') must both be true.', session_user, v_role;
    END;
  END LOOP;

  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '3742 PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass) THEN
    RAISE EXCEPTION '3742 PRECONDITION FAILED: RLS is not enabled on public.profiles. Refusing.';
  END IF;
  IF to_regprocedure('public.caller_may_write_profile_role()') IS NULL THEN
    RAISE EXCEPTION '3742 PRECONDITION FAILED: public.caller_may_write_profile_role() (2078) does not exist.';
  END IF;
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_names
    FROM unnest(v_cols) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = 'public.profiles'::regclass
                        AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3742 PRECONDITION FAILED: public.profiles lacks column(s): %.', v_names;
  END IF;
  -- A table-level UPDATE covers every column whatever the column grants say,
  -- so the REVOKE below would leave a client able to write them. 3740 removes
  -- it on databases built over Supabase's default ACL; production never had it.
  SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, ', ') INTO v_names
    FROM pg_class c, LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.profiles'::regclass AND x.privilege_type = 'UPDATE'
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3742 PRECONDITION FAILED: % hold(s) TABLE-level UPDATE on public.profiles; a column REVOKE cannot narrow it. Apply 3740 first.', v_names;
  END IF;
  -- The trigger admits an INSERT carrying exactly these defaults (a signup,
  -- handle_new_user included). A different default would refuse every signup.
  SELECT string_agg(e.col || ' = ' || coalesce(pg_get_expr(d.adbin, d.adrelid), 'NULL'), ', ' ORDER BY e.col) INTO v_names
    FROM (VALUES ('verified', 'false'), ('verified_at', NULL), ('trust_score', '70'),
                 ('trust_label', '''New Traveler''::text'), ('verification_method', NULL),
                 ('featured_count', '0'), ('created_at', 'now()')) AS e(col, want)
    JOIN pg_attribute a ON a.attrelid = 'public.profiles'::regclass AND a.attname = e.col
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM e.want;
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3742 PRECONDITION FAILED: column default(s) differ from the ones this trigger admits on INSERT: %.', v_names;
  END IF;
END $pre$;

-- ── 1. The column barrier ────────────────────────────────────────────────────
REVOKE UPDATE (
  verified, verified_at, trust_score, trust_label, verification_method,
  featured_count, created_at, account_status, role, is_official,
  verification_status, verification_level, verified_since, id_verified_at,
  selfie_verified_at, home_country_verified_at, host_verified_at,
  buddy_verified_at, safety_flags_count
) ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

-- ── 2. The trigger barrier ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_profile_authority_privileged()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_changed text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A signup inserts the column defaults; only a non-default value needs
    -- privilege. now() is the transaction's timestamp, the same value the
    -- created_at default took for this row.
    v_changed := concat_ws(', ',
      CASE WHEN NEW.verified IS DISTINCT FROM false THEN 'verified' END,
      CASE WHEN NEW.verified_at IS NOT NULL THEN 'verified_at' END,
      CASE WHEN NEW.trust_score IS DISTINCT FROM 70 THEN 'trust_score' END,
      CASE WHEN NEW.trust_label IS DISTINCT FROM 'New Traveler' THEN 'trust_label' END,
      CASE WHEN NEW.verification_method IS NOT NULL THEN 'verification_method' END,
      CASE WHEN NEW.featured_count IS DISTINCT FROM 0 THEN 'featured_count' END,
      CASE WHEN NEW.created_at IS DISTINCT FROM now() THEN 'created_at' END);
  ELSIF TG_OP = 'UPDATE' THEN
    -- IS DISTINCT FROM (null-safe): writing the value already there never trips.
    v_changed := concat_ws(', ',
      CASE WHEN NEW.verified IS DISTINCT FROM OLD.verified THEN 'verified' END,
      CASE WHEN NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN 'verified_at' END,
      CASE WHEN NEW.trust_score IS DISTINCT FROM OLD.trust_score THEN 'trust_score' END,
      CASE WHEN NEW.trust_label IS DISTINCT FROM OLD.trust_label THEN 'trust_label' END,
      CASE WHEN NEW.verification_method IS DISTINCT FROM OLD.verification_method THEN 'verification_method' END,
      CASE WHEN NEW.featured_count IS DISTINCT FROM OLD.featured_count THEN 'featured_count' END,
      CASE WHEN NEW.created_at IS DISTINCT FROM OLD.created_at THEN 'created_at' END);
  END IF;

  -- concat_ws skips NULLs: an empty string means no guarded column moved, and
  -- the predicate is not consulted at all.
  IF v_changed <> '' THEN
    IF NOT public.caller_may_write_profile_role() THEN
      RAISE EXCEPTION 'profiles authority column(s) % cannot be set by this caller', v_changed
        USING ERRCODE = '42501',
              HINT = 'Written by the server only (3742). Use the service-role client.';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.enforce_profile_authority_privileged() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_authority_privileged ON public.profiles;
CREATE TRIGGER trg_profiles_authority_privileged
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_authority_privileged();

COMMIT;

-- ── Postconditions — assertion-only, re-runnable after COMMIT ────────────────
DO $post$
DECLARE
  v_revoked constant text[] := ARRAY[
    'verified', 'verified_at', 'trust_score', 'trust_label',
    'verification_method', 'featured_count', 'created_at', 'account_status',
    'role', 'is_official', 'verification_status', 'verification_level',
    'verified_since', 'id_verified_at', 'selfie_verified_at',
    'home_country_verified_at', 'host_verified_at', 'buddy_verified_at',
    'safety_flags_count'];
  v_guarded constant text[] := ARRAY[
    'verified', 'verified_at', 'trust_score', 'trust_label',
    'verification_method', 'featured_count', 'created_at'];
  v_fn   regprocedure := to_regprocedure('public.enforce_profile_authority_privileged()');
  v_pred regprocedure;
  v_def  text;
  v_src  text;
  v_guard_at  int;
  v_return_at int;
  v_probe text;
  v_names text;
  v_role text;
BEGIN
  -- 1. No client role can write a present authority column — at column level,
  --    through a table-level grant, or through PUBLIC. CASE, not AND: a column
  --    a later file dropped makes has_column_privilege raise, and AND does not
  --    promise to test existence first.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    SELECT string_agg(c, ', ' ORDER BY c) INTO v_names
      FROM unnest(v_revoked) AS c
     WHERE CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a
                              WHERE a.attrelid = 'public.profiles'::regclass
                                AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped)
                THEN has_column_privilege(v_role, 'public.profiles', c, 'UPDATE')
                ELSE false END;
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION '3742 POSTCONDITION FAILED: % can UPDATE public.profiles.%', v_role, v_names;
    END IF;
  END LOOP;
  SELECT string_agg(DISTINCT a.attname::text, ', ') INTO v_names
    FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid = 'public.profiles'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname = ANY (v_revoked) AND x.grantee = 0 AND x.privilege_type = 'UPDATE';
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: PUBLIC holds column UPDATE on public.profiles.%', v_names;
  END IF;

  -- 2. The trigger: installed, enabled ('O': not DISABLEd, not ENABLE REPLICA,
  --    which fires only under session_replication_role = replica), BEFORE,
  --    FOR EACH ROW, INSERT and UPDATE, and UNCONDITIONAL — a trigger re-created
  --    WITH a WHEN (…) clause fires only when that clause says so, and
  --    WHEN (false) never (verifier G3 F2); nor on an UPDATE OF column list. tgtype bits: 1 ROW, 2 BEFORE,
  --    4 INSERT, 16 UPDATE.
  IF v_fn IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.profiles'::regclass AND NOT t.tgisinternal
          AND t.tgname = 'trg_profiles_authority_privileged'
          AND t.tgfoid = v_fn AND t.tgenabled = 'O'
          AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2
          AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16) THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: trg_profiles_authority_privileged is not an enabled BEFORE INSERT OR UPDATE row trigger on public.profiles executing enforce_profile_authority_privileged().';
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_names
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.profiles'::regclass AND NOT t.tgisinternal
     AND t.tgname = 'trg_profiles_authority_privileged' AND t.tgqual IS NOT NULL;
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: trg_profiles_authority_privileged carries a WHEN condition, so it guards only the rows that condition admits: %', v_names;
  END IF;
  --    And UNCONDITIONAL on columns too: re-created as UPDATE OF <columns>,
  --    it fires only when the UPDATE names one of them, so `SET verified =
  --    true` alone never reaches it (BETA2 verifier F6). tgattr is the column
  --    list; the empty int2vector means every UPDATE.
  SELECT pg_get_triggerdef(t.oid) INTO v_names
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.profiles'::regclass AND NOT t.tgisinternal
     AND t.tgname = 'trg_profiles_authority_privileged' AND NOT (t.tgattr = '');
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: trg_profiles_authority_privileged fires only on UPDATE OF a column list, so an UPDATE naming none of those columns never reaches it: %', v_names;
  END IF;

  -- 3. Its function still compares every present guarded column and asks the
  --    predicate who is writing. TEXTUAL: this reads the definition, it does
  --    not run it. It refuses a body that RETURNs before the refusal (dead code
  --    after an early RETURN NEW, verifier G3 F3). Comments are removed with
  --    regular expressions — /* … */ first, then -- to end of line, as
  --    rule 6 does — and string literals are NOT tracked, because the refusal
  --    this looks for is itself written with them (ERRCODE = '42501'). So these
  --    pass it while the function refuses nothing (verifier G3b D): a body that
  --    keeps these shapes and never reaches them (IF false THEN …); a '--' or
  --    '/*' inside a string literal, which hides the code after it from this
  --    reading (v_changed := '--'; RETURN NEW;); a nested /* /* */ */ comment;
  --    the refusal wrapped in BEGIN … EXCEPTION WHEN OTHERS THEN NULL; END;
  --    and the predicate's name only inside a string literal. The executed
  --    proof is src/test/db/profileAuthorityColumns.db.test.ts PA1-PA3 on the
  --    replayed chain.
  v_def := pg_get_functiondef(v_fn);
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_names
    FROM unnest(v_guarded) AS c
   WHERE EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'public.profiles'::regclass
                    AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped)
     AND v_def !~* ('NEW\.' || c || '\s+IS\s+DISTINCT\s+FROM\s+OLD\.' || c || '\M');
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: enforce_profile_authority_privileged() no longer compares %', v_names;
  END IF;
  IF v_def !~* 'public\.caller_may_write_profile_role\(\)' THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: enforce_profile_authority_privileged() does not consult caller_may_write_profile_role().';
  END IF;
  -- The refusal comes before any RETURN: the source with its /* */ and --
  -- comments removed must reach `IF NOT public.caller_may_write_profile_role()
  -- THEN RAISE EXCEPTION … ERRCODE = '42501'` before its first RETURN. A
  -- refusal kept only inside a /* */ comment is not one (verifier G3b D).
  v_src := regexp_replace(
             regexp_replace((SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_fn), '/\*.*?\*/', ' ', 'g'),
             '--[^\n]*', '', 'g');
  v_guard_at := regexp_instr(v_src, 'IF\s+NOT\s+public\.caller_may_write_profile_role\(\)\s+THEN\s+RAISE\s+EXCEPTION', 1, 1, 0, 'i');
  v_return_at := regexp_instr(v_src, '\mRETURN\M', 1, 1, 0, 'i');
  IF v_guard_at = 0 OR v_src !~* 'ERRCODE\s*=\s*''42501''' THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: enforce_profile_authority_privileged() has no "IF NOT public.caller_may_write_profile_role() THEN RAISE EXCEPTION … ERRCODE = ''42501''" refusal.';
  END IF;
  IF v_return_at = 0 OR v_return_at < v_guard_at THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: enforce_profile_authority_privileged() returns before its refusal (first RETURN at character %, refusal at %): the comparisons after it are dead code.', v_return_at, v_guard_at;
  END IF;

  -- 4. The predicate every profiles guard trusts (2078; also 2163's, 0106/
  --    2079's and 3600's). One CREATE OR REPLACE returning true would open
  --    every authority column behind every one of those triggers, and checks
  --    2-3 would still pass (verifier G3 F1).
  --    (a) Its header is 2078's, read from the catalog: LANGUAGE sql, STABLE,
  --        SECURITY INVOKER, SET search_path TO 'public', 'pg_catalog',
  --        RETURNS boolean. The same body under another search_path resolves
  --        current_setting() elsewhere, and an IMMUTABLE one may be folded into
  --        a cached plan, so the header is part of what is trusted (verifier
  --        G3b A). Then, TEXTUAL: its body still reads the role GUC and
  --        session_user.
  v_pred := to_regprocedure('public.caller_may_write_profile_role()');
  IF v_pred IS NULL THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: public.caller_may_write_profile_role() does not exist.';
  END IF;
  SELECT concat_ws(', ',
           CASE WHEN l.lanname IS DISTINCT FROM 'sql' THEN 'LANGUAGE ' || l.lanname END,
           CASE WHEN p.provolatile IS DISTINCT FROM 's' THEN 'volatility ' || p.provolatile::text END,
           CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' END,
           CASE WHEN p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_catalog']
                THEN 'SET ' || coalesce(array_to_string(p.proconfig, '; '), '(nothing)') END,
           CASE WHEN p.prorettype IS DISTINCT FROM 'boolean'::regtype OR p.proretset
                THEN 'RETURNS ' || format_type(p.prorettype, NULL) END)
    INTO v_names
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = v_pred;
  IF v_names <> '' THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: public.caller_may_write_profile_role() no longer has 2078''s header (LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO ''public'', ''pg_catalog''): %', v_names;
  END IF;
  v_def := pg_get_functiondef(v_pred);
  IF v_def !~* 'current_setting\(\s*''role''' OR v_def !~* '\msession_user\M' THEN
    RAISE EXCEPTION '3742 POSTCONDITION FAILED: public.caller_may_write_profile_role() no longer decides on current_setting(''role'') and session_user (2078): %', v_def;
  END IF;
  --    (b) EXECUTED: with the role GUC set to each client role, as PostgREST
  --    sets it, the predicate refuses. Run in a sub-transaction that is always
  --    rolled back, so the role is restored. A client that cannot execute it
  --    at all is refused by the SECURITY INVOKER trigger as well. ONE SAMPLE
  --    per role, with the role GUC and nothing else set (no request.jwt.*
  --    claim): a definition that admits a client only under another condition
  --    passes this probe; (a) and rule 6 are what stop it (verifier G3b F).
  --    FAILS CLOSED: if the applying role may not SET ROLE to a client role,
  --    this postcondition raises — it cannot vouch for the predicate (lead
  --    ruling G3-3; the $pre$ block refuses the same database up front).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    v_probe := NULL;
    BEGIN
      PERFORM set_config('role', v_role, true);
      BEGIN
        v_probe := CASE WHEN public.caller_may_write_profile_role() THEN 'admits' ELSE 'refuses' END;
      EXCEPTION WHEN insufficient_privilege THEN
        v_probe := 'refuses';
      END;
      RAISE EXCEPTION USING ERRCODE = 'P3742', MESSAGE = '3742 predicate probe: roll the role back';
    EXCEPTION
      WHEN SQLSTATE 'P3742' THEN NULL;
      WHEN insufficient_privilege THEN v_probe := 'unprobed';
    END;
    IF v_probe = 'admits' THEN
      RAISE EXCEPTION '3742 POSTCONDITION FAILED: public.caller_may_write_profile_role() returns true for role %, so every profiles guard admits that client.', v_role;
    ELSIF v_probe IS DISTINCT FROM 'refuses' THEN
      RAISE EXCEPTION '3742 POSTCONDITION FAILED: the applying role (session user %) cannot SET ROLE %, so caller_may_write_profile_role() could not be executed as that client and this postcondition cannot vouch for it. Run this file as a role that is a member of anon and authenticated: select pg_has_role(current_user, ''anon'', ''MEMBER''), pg_has_role(current_user, ''authenticated'', ''MEMBER'') must both be true.', session_user, v_role;
    END IF;
  END LOOP;
END $post$;
