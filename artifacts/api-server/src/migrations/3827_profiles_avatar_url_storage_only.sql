-- 3827_profiles_avatar_url_storage_only.sql
-- A person's avatar is their own Portava upload or nothing: no client role can point
-- profiles.avatar_url at a host of their choosing, which every viewer's device then fetched.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Lane PRIV-FIX-3 (B58 follow-up to
-- lane TM-2's adjacent finding), telegraph+media band 3825-3839 (3825 TM-1, 3826 TM-5).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT
-- ══════════════════════════════════════════════════════════════════════════════
-- `anon` and `authenticated` hold column UPDATE on profiles.avatar_url (the baseline's column
-- list, 20260819_baseline_structure.sql `GRANT SELECT(avatar_url),UPDATE(avatar_url)`, re-issued
-- by 3740), and `profiles_update` admits the owner's own row. 2078 took back `role` only
-- (2078_profiles_role_not_self_writable.sql:198-201, "ordinary profile editing (name, bio,
-- avatar_url, city, …) is untouched"). So
--   PATCH /rest/v1/profiles?id=eq.<self>   {"avatar_url": "https://tracker.example/p.gif?u=…"}
-- with the person's own JWT stored any URL, and every surface that draws the person's avatar —
-- a thread header, reader chips, an inbox row, a comment, a follower list — made each VIEWER's
-- device fetch it: the host learns every viewer's address and when they looked.
-- (The API's own door, PATCH /api/me/profile, admitted any https URL too; it is fixed in the same
-- change: lib/avatarStorageRef.ts.)
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHO WRITES avatar_url — checked before taking the grant
-- ══════════════════════════════════════════════════════════════════════════════
--   the app (travel-buddy-standalone)  POST /api/me/avatar/upload, then PATCH /api/me/profile
--                                      { avatarUrl } — the API's SERVICE client (lib/http.ts
--                                      requireUser returns getServiceClient()), never PostgREST;
--   admin                              routes/admin.ts clears it (service client);
--   seed scripts                       service-role key;
--   the root Expo tree                 src/services/trips.ts updateMyProfile wrote it through
--                                      PostgREST — a function with no caller anywhere in the
--                                      repository; the same change stops it naming the column.
-- No client tree writes the column through PostgREST after this change
-- (src/test/profileAvatarUrlStorageOnly.test.ts AV-P1 holds that premise), and handle_new_user
-- and POST /profile/ensure insert no avatar.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX — the two barriers 2078 established for `role`
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. REVOKE UPDATE (avatar_url) from PUBLIC, anon and authenticated: the narrow barrier. Sorts
--    after 3740, which re-grants the baseline's column list (the reason 3762 is numbered after it).
-- 2. A BEFORE INSERT OR UPDATE row trigger, the barrier that survives a careless re-grant
--    (2078:50-54) and the only one on INSERT (the client roles keep table-level INSERT; 3742's
--    header). For a caller caller_may_write_profile_role() does not admit, a value being SET —
--    any non-NULL value on INSERT, a value distinct from the stored one on UPDATE — must be
--    EXACTLY the row owner's own upload reference, `profile-media/avatars/<id>/<file>` (one file
--    name of [A-Za-z0-9._-], not starting with a dot, no `..`, at most 128 characters), the
--    shape POST /me/avatar/upload answers and lib/avatarStorageRef.ts admits; otherwise 42501.
--    NULL (clearing it) is always admitted. The server's service client is admitted as before:
--    the API validates its own door, and admin and seed writes are unchanged.
--    The predicate is consulted only AFTER the value has been found not to be the owner's own
--    upload, so an ordinary edit never depends on it (3742's reasoning). SECURITY INVOKER; EXECUTE
--    revoked from the client roles (a trigger fires without it).
--
-- NOTHING IS REWRITTEN. A row that already holds an outside URL keeps it through every other edit
-- (UPDATE judges only a CHANGED value) until its owner clears or replaces it; the app draws such
-- a value as nothing (travel-buddy-standalone src/lib/avatarImageUri.ts). No row, policy, flag or
-- service_role privilege changes.
--
-- ROLLBACK: db/rollback/2026-10-14-3827-profiles-avatar-url-storage-only-rollback.sql

BEGIN;

DO $pre$
DECLARE
  v_names text;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): public.profiles does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.profiles'::regclass AND attname = 'avatar_url'
                    AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): public.profiles has no avatar_url column.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): RLS is not enabled on public.profiles. Refusing.';
  END IF;
  IF to_regprocedure('public.caller_may_write_profile_role()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): public.caller_may_write_profile_role() (2078) does not exist.';
  END IF;
  -- A table-level UPDATE covers every column whatever the column grants say, so the REVOKE below
  -- would change nothing a client sees. 3740 removes it on databases built over Supabase's
  -- default ACL; production never had it.
  SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, ', ')
    INTO v_names
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
   WHERE c.oid = 'public.profiles'::regclass AND x.privilege_type = 'UPDATE'
     AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole));
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3827): % hold(s) TABLE-level UPDATE on public.profiles; a column REVOKE cannot narrow it. Apply 3740 first.', v_names;
  END IF;
END $pre$;

-- ── 1. The column barrier ────────────────────────────────────────────────────
REVOKE UPDATE (avatar_url) ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

-- ── 2. The trigger barrier ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_profile_avatar_url_storage_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_set boolean;
BEGIN
  -- Only a value being SET is judged: any non-NULL value on INSERT, a changed non-NULL value on
  -- UPDATE (IS DISTINCT FROM: writing the value already there never trips, and a row that already
  -- holds an outside URL keeps it through every other edit).
  IF TG_OP = 'INSERT' THEN
    v_set := NEW.avatar_url IS NOT NULL;
  ELSE
    v_set := NEW.avatar_url IS DISTINCT FROM OLD.avatar_url AND NEW.avatar_url IS NOT NULL;
  END IF;

  IF v_set THEN
    -- The owner's own upload reference, and nothing wider (lib/avatarStorageRef.ts states the same
    -- rule for the API). NEW.id::text is the lowercase uuid; it holds only hex digits and hyphens.
    IF NOT (NEW.avatar_url ~ ('^profile-media/avatars/' || NEW.id::text || '/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$')
            AND strpos(NEW.avatar_url, '..') = 0) THEN
      -- Consulted only now, so an ordinary edit never depends on the predicate.
      IF NOT public.caller_may_write_profile_role() THEN
        RAISE EXCEPTION 'profiles.avatar_url must be the owner''s own upload (profile-media/avatars/%/<file>) or NULL', NEW.id
          USING ERRCODE = '42501',
                HINT = 'Upload through POST /api/me/avatar/upload and save the reference it answers (3827).';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.enforce_profile_avatar_url_storage_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_avatar_url_storage_only ON public.profiles;
CREATE TRIGGER trg_profiles_avatar_url_storage_only
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_avatar_url_storage_only();

COMMIT;

-- ── Postconditions — assertion-only, re-runnable after COMMIT, catalog only ────
DO $post$
DECLARE
  r text;
  v_fn regprocedure := to_regprocedure('public.enforce_profile_avatar_url_storage_only()');
  v_def text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- 1. The column: no UPDATE through any path (table, column or PUBLIC).
    IF has_column_privilege(r, 'public.profiles', 'avatar_url', 'UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3827): % can still UPDATE public.profiles.avatar_url.', r;
    END IF;
    -- 2. Anti-vacuity: one column narrowed, not the table — an ordinary profile edit still works.
    IF NOT has_column_privilege(r, 'public.profiles', 'bio', 'UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3827): % lost UPDATE on public.profiles.bio; this file narrows one column only.', r;
    END IF;
    -- 3. Nobody but the trigger mechanism runs the function.
    IF has_function_privilege(r, 'public.enforce_profile_avatar_url_storage_only()', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3827): % can EXECUTE enforce_profile_avatar_url_storage_only().', r;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
              WHERE a.attrelid = 'public.profiles'::regclass AND a.attname = 'avatar_url'
                AND x.grantee = 0 AND x.privilege_type = 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): PUBLIC holds column UPDATE on public.profiles.avatar_url.';
  END IF;
  -- 4. The server is untouched.
  IF NOT has_column_privilege('service_role', 'public.profiles', 'avatar_url', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): service_role cannot UPDATE public.profiles.avatar_url.';
  END IF;
  -- 5. The trigger: installed on this function, enabled ('O': not DISABLEd, not ENABLE REPLICA or
  --    ALWAYS), BEFORE, FOR EACH ROW, INSERT and UPDATE, no WHEN condition, no UPDATE OF list.
  --    tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 16 UPDATE; tgattr is the column list.
  IF v_fn IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.profiles'::regclass AND NOT t.tgisinternal
          AND t.tgname = 'trg_profiles_avatar_url_storage_only'
          AND t.tgfoid = v_fn AND t.tgenabled = 'O'
          AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2
          AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16
          AND t.tgqual IS NULL AND t.tgattr = '') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): trg_profiles_avatar_url_storage_only is not an enabled, unconditional BEFORE INSERT OR UPDATE row trigger on public.profiles executing enforce_profile_avatar_url_storage_only().';
  END IF;
  -- 6. The function is still this file's: invoker rights, pinned search_path, and it still states
  --    the owner's own upload path and consults the 2078 predicate (TEXTUAL; the executed proof is
  --    src/test/db/profileAvatarUrlStorageOnly.db.test.ts).
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): enforce_profile_avatar_url_storage_only() is not SECURITY INVOKER with search_path public, pg_catalog.';
  END IF;
  v_def := pg_get_functiondef(v_fn);
  IF strpos(v_def, '''^profile-media/avatars/'' || NEW.id::text || ''/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$''') = 0
     OR strpos(v_def, 'NEW.avatar_url IS DISTINCT FROM OLD.avatar_url') = 0
     OR strpos(v_def, 'public.caller_may_write_profile_role()') = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3827): enforce_profile_avatar_url_storage_only() no longer states the owner''s own upload path, the changed-value test and the 2078 predicate: %', v_def;
  END IF;
END $post$;
