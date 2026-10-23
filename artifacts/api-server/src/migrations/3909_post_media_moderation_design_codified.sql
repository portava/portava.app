-- 3909_post_media_moderation_design_codified.sql
--
-- Codifies production's post_media moderation design ("2098", design label D3),
-- which the owner applied to production through the Supabase SQL editor in
-- mid-August 2026 and which no file in this repository ever created.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Order-independent of
-- every other file except its prerequisites, all of which sort before it: 0103
-- (post_media), the posts table, auth.uid(), 3365 (post_media's client column
-- grants) and 3905 (post_media_public_select).
--
-- ── WHERE THE DESIGN CAME FROM ────────────────────────────────────────────────
-- reconciliation-staging/2096-2099_OWNER_ASSERTED_APPLIED.md (2026-08-18) records
-- the owner's statement that 2096-2099 ran in production and were never
-- committed; 2098 is "a post_media write-policy split". Production carries it as
-- one batch (catalog oids 52849-52869), baseline/20260819_baseline_structure.sql
-- dumped it, and the objects' own comments say "D3" and name "migration 2098".
-- docs/architecture/census-media.md §44.15/§44.18 and 3365 already treat it as
-- production's state; audit:schema's ALLOWLIST (auditMigrationsVsLive.ts) and
-- auditSchemaAuthzResolution.test.ts already pin 0103's policy as superseded by
-- it. portava-ci, the local-db harness's chain and every environment rebuilt from
-- this tree still lacked it: portava-ci carries 0103's FOR ALL
-- post_media_owner_write and none of the objects below.
--
-- ── WHAT 2098 IS ──────────────────────────────────────────────────────────────
--   post_media_moderation_ledger           every storage key that ever carried a
--                                          rejected/flagged verdict. No foreign
--                                          keys on purpose: cascades would erase it.
--   post_media_path_is_owned(text, uuid)   lib/mediaAccess.ts ownerFromPath() in SQL.
--   post_media_path_is_moderated(text,uuid) "has this key ever been moderated?",
--                                          for the caller's own keys only.
--   post_media_record_moderation_verdict() + trg_post_media_record_moderation_verdict
--                                          records each rejected/flagged key.
--   post_media_owner_insert / _update / _delete   (TO authenticated) the owner
--                                          pins: parent-post ownership, every
--                                          storage key owned by the caller and
--                                          never moderated, insert pinned to
--                                          'pending', and no delete of a row
--                                          that carries a verdict.
--   post_media_service_role_all            (TO service_role)
-- It replaces 0103's single FOR ALL post_media_owner_write, which scoped the row
-- and nothing else: a moderated storage key could be re-attached, and a
-- rejected row deleted to undo the decision.
--
-- ── THE TEXT ─────────────────────────────────────────────────────────────────
-- Every definition below is baseline/20260819_baseline_structure.sql's text,
-- byte for byte (function bodies re-quoted from $$ to $fn$ only). The primary
-- key is written inline in CREATE TABLE rather than as the dump's ALTER TABLE;
-- the constraint and its index get the same names. Privileges are production's,
-- read 2026-10-23: the dump's GRANTs are relative to PostgreSQL's built-in
-- defaults, so restoring it under Supabase's default privileges leaves anon and
-- authenticated able to execute all three functions and write the ledger. That
-- is what the local-db harness carried.
--
-- ── WHAT IT DOES, BY STARTING SHAPE ──────────────────────────────────────────
--   production    Every object exists and matches. Creates nothing, grants and
--                 revokes nothing, and post_media_owner_write is already absent.
--                 A strict no-op: only the postconditions below do anything,
--                 and they only read.
--   portava-ci    Creates the ledger, the three functions, the trigger and the
--                 four policies; sets their privileges to production's; drops
--                 post_media_owner_write.
--   local-db      (the baseline restore) Every object exists. Narrows the
--                 over-granted privileges to production's and changes nothing else.
-- Each object is created only when ABSENT. An object that exists but differs from
-- production's is not repaired here: the postconditions refuse, and the
-- applier's transaction leaves the database as it was.
--
-- ── OUT OF SCOPE, DELIBERATELY ───────────────────────────────────────────────
-- post_media's client UPDATE column grants. 2098 also revoked UPDATE from the
-- client roles (post_media_owner_update's comment names it), and production's
-- clients hold none. The tree holds 2158's 12 descriptor columns, narrowed but
-- not removed by 3365. moderation_status is not among them, so the self-
-- moderation door that revoke closed is closed on the tree too. Removing the
-- 12 would also make 3365's rollback refuse, because it restores a privilege
-- record that would no longer match. That is a separate decision.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- None at the schema level, deliberately. On production this file changes
-- nothing, so there is nothing to undo. Elsewhere it converges to production's
-- design, and undoing that would re-open the gap described above. Deleting this
-- file's ledger row is the whole rollback.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.post_media') IS NULL OR to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3909): public.post_media and public.posts must exist (0103).';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3909): auth.uid() is missing.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.post_media'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3909): RLS is not enabled on post_media; 2098''s policies would decide nothing.';
  END IF;
  IF to_regprocedure('public.post_media_path_is_moderated(text,uuid)') IS NOT NULL
     AND to_regclass('public.post_media_moderation_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3909): post_media_path_is_moderated exists without the ledger it reads; a partial 2098 is not something this file guesses at.';
  END IF;
END $pre$;

-- ── 1. The objects, each only where absent ─────────────────────────────────────
DO $create$
BEGIN
  IF to_regclass('public.post_media_moderation_ledger') IS NULL THEN
CREATE TABLE public.post_media_moderation_ledger (
    storage_path text NOT NULL,
    storage_bucket text,
    key_role text NOT NULL,
    verdict text NOT NULL,
    subject_user_id uuid,
    post_media_id uuid,
    first_verdict_at timestamp with time zone DEFAULT now() NOT NULL,
    last_verdict_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT post_media_moderation_ledger_key_role_check CHECK ((key_role = ANY (ARRAY['original'::text, 'thumbnail'::text, 'feed'::text]))),
    CONSTRAINT post_media_moderation_ledger_verdict_check CHECK ((verdict = ANY (ARRAY['rejected'::text, 'flagged'::text]))),
    CONSTRAINT post_media_moderation_ledger_pkey PRIMARY KEY (storage_path)
);

ALTER TABLE public.post_media_moderation_ledger ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.post_media_moderation_ledger IS 'D3(a): append-only record of every storage key that has carried a rejected/flagged verdict. Consulted by post_media INSERT/UPDATE policies so a moderated object cannot be re-attached after the row carrying the verdict is deleted. Deliberately has NO foreign keys: post_media/posts/auth.users cascades bypass RLS and would otherwise erase it.';
  END IF;

  IF to_regprocedure('public.post_media_path_is_owned(text,uuid)') IS NULL THEN
CREATE FUNCTION public.post_media_path_is_owned(p text, owner_id uuid) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $fn$
  SELECT
    owner_id IS NOT NULL
    AND p IS NOT NULL
    AND p <> ''
    AND (
      -- `<uid>/…` — POST /api/media/upload (routes/posts.ts:171) and
      -- POST /api/postcards/:id/media/upload-url (routes/postcards.ts:492).
      pg_catalog.split_part(p, '/', 1) = owner_id::text
      -- `stories|memories|avatars|covers/<uid>/…` — the second branch of
      -- ownerFromPath(); reachable in post_media only for rows backfilled by
      -- 2083 from a profile-media key.
      OR (
        pg_catalog.split_part(p, '/', 1) IN ('stories', 'memories', 'avatars', 'covers')
        AND pg_catalog.split_part(p, '/', 2) = owner_id::text
      )
    );
$fn$;

COMMENT ON FUNCTION public.post_media_path_is_owned(p text, owner_id uuid) IS 'Does this storage key belong to this user? SQL transcription of lib/mediaAccess.ts ownerFromPath(): first segment is the uid, or stories|memories|avatars|covers followed by the uid.';
  END IF;

  IF to_regprocedure('public.post_media_path_is_moderated(text,uuid)') IS NULL THEN
CREATE FUNCTION public.post_media_path_is_moderated(p text, owner_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $fn$
  SELECT
    p IS NOT NULL
    AND p <> ''
    AND owner_id IS NOT NULL
    -- ⚠ THE IDENTITY GATE. The caller may only ask about themselves.
    -- `auth.uid()` is already schema-qualified, which is what makes it resolve
    -- under `search_path TO ''`; it reads the request JWT rather than the
    -- current role, so SECURITY DEFINER does not change its answer.
    AND owner_id IS NOT DISTINCT FROM (SELECT auth.uid())
    AND public.post_media_path_is_owned(p, owner_id)
    AND EXISTS (
      SELECT 1 FROM public.post_media_moderation_ledger l
       WHERE l.storage_path = p
    );
$fn$;

COMMENT ON FUNCTION public.post_media_path_is_moderated(p text, owner_id uuid) IS 'Has this storage key ever carried a rejected/flagged verdict? SECURITY DEFINER because authenticated holds no privilege on the ledger. owner_id must equal auth.uid(): the identity is read from the JWT, not accepted from the argument list, so this cannot be called over PostgREST RPC as an oracle about another user''s keys. Returns FALSE (the permissive answer) for any session without a JWT, which is why anon and service_role hold no EXECUTE on it — server-side code must read post_media_moderation_ledger directly.';
  END IF;

  IF to_regprocedure('public.post_media_record_moderation_verdict()') IS NULL THEN
CREATE FUNCTION public.post_media_record_moderation_verdict() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $fn$
DECLARE
  j   jsonb := pg_catalog.to_jsonb(NEW);
  rec record;
BEGIN
  FOR rec IN
    SELECT x.key_role, x.k
      FROM (VALUES
              ('original',  j ->> 'storage_path'),
              ('thumbnail', j ->> 'thumbnail_storage_path'),
              ('feed',      j ->> 'feed_storage_path')
           ) AS x(key_role, k)
     WHERE x.k IS NOT NULL AND x.k <> ''
  LOOP
    INSERT INTO public.post_media_moderation_ledger AS l
           (storage_path, storage_bucket, key_role, verdict, subject_user_id, post_media_id)
    VALUES (rec.k, NEW.storage_bucket, rec.key_role, NEW.moderation_status, NEW.user_id, NEW.id)
    ON CONFLICT (storage_path) DO UPDATE
       SET verdict         = EXCLUDED.verdict,
           storage_bucket  = COALESCE(EXCLUDED.storage_bucket, l.storage_bucket),
           key_role        = EXCLUDED.key_role,
           subject_user_id = COALESCE(EXCLUDED.subject_user_id, l.subject_user_id),
           post_media_id   = COALESCE(EXCLUDED.post_media_id, l.post_media_id),
           last_verdict_at = pg_catalog.now();
  END LOOP;

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$fn$;

COMMENT ON FUNCTION public.post_media_record_moderation_verdict() IS 'AFTER trigger on post_media: records every rejected/flagged storage key in post_media_moderation_ledger so the verdict outlives the row, the parent post and the account.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.post_media'::regclass
                   AND tgname = 'trg_post_media_record_moderation_verdict') THEN
CREATE TRIGGER trg_post_media_record_moderation_verdict AFTER INSERT OR UPDATE OF moderation_status ON public.post_media FOR EACH ROW WHEN ((new.moderation_status = ANY (ARRAY['rejected'::text, 'flagged'::text]))) EXECUTE FUNCTION public.post_media_record_moderation_verdict();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.post_media'::regclass
                   AND polname = 'post_media_owner_insert') THEN
CREATE POLICY post_media_owner_insert ON public.post_media FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.posts
  WHERE ((posts.id = post_media.post_id) AND (posts.author_id = auth.uid())))) AND (moderation_status = 'pending'::text) AND public.post_media_path_is_owned(storage_path, auth.uid()) AND (NOT public.post_media_path_is_moderated(storage_path, auth.uid())) AND ((thumbnail_storage_path IS NULL) OR (public.post_media_path_is_owned(thumbnail_storage_path, auth.uid()) AND (NOT public.post_media_path_is_moderated(thumbnail_storage_path, auth.uid())))) AND ((feed_storage_path IS NULL) OR (public.post_media_path_is_owned(feed_storage_path, auth.uid()) AND (NOT public.post_media_path_is_moderated(feed_storage_path, auth.uid()))))));

COMMENT ON POLICY post_media_owner_insert ON public.post_media IS 'D3: owner + parent-post ownership (from 0103), plus a pin requiring every storage key on the row to resolve to the caller under lib/mediaAccess.ts ownerFromPath(), plus a refusal of any key recorded in post_media_moderation_ledger, plus moderation_status pinned to its default.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.post_media'::regclass
                   AND polname = 'post_media_owner_update') THEN
CREATE POLICY post_media_owner_update ON public.post_media FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.posts
  WHERE ((posts.id = post_media.post_id) AND (posts.author_id = auth.uid())))) AND public.post_media_path_is_owned(storage_path, auth.uid()) AND (NOT public.post_media_path_is_moderated(storage_path, auth.uid())) AND ((thumbnail_storage_path IS NULL) OR (public.post_media_path_is_owned(thumbnail_storage_path, auth.uid()) AND (NOT public.post_media_path_is_moderated(thumbnail_storage_path, auth.uid())))) AND ((feed_storage_path IS NULL) OR (public.post_media_path_is_owned(feed_storage_path, auth.uid()) AND (NOT public.post_media_path_is_moderated(feed_storage_path, auth.uid()))))));

COMMENT ON POLICY post_media_owner_update ON public.post_media IS 'D3: same pins as insert. Cannot constrain moderation_status (RLS cannot see OLD) — that is closed by the UPDATE privilege revoke in migration 2098.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.post_media'::regclass
                   AND polname = 'post_media_owner_delete') THEN
CREATE POLICY post_media_owner_delete ON public.post_media FOR DELETE TO authenticated USING (((user_id = auth.uid()) AND (moderation_status IS DISTINCT FROM 'rejected'::text) AND (moderation_status IS DISTINCT FROM 'flagged'::text)));

COMMENT ON POLICY post_media_owner_delete ON public.post_media IS 'D3(a2): owner may delete their own media EXCEPT rows carrying a rejected/flagged verdict — deleting one was step 1 of reversing a moderation decision. A DELETE policy USING clause sees the existing row, so unlike UPDATE this is expressible.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.post_media'::regclass
                   AND polname = 'post_media_service_role_all') THEN
CREATE POLICY post_media_service_role_all ON public.post_media TO service_role USING (true) WITH CHECK (true);
  END IF;
END $create$;

-- ── 2. Privileges: production's, set only where they differ ─────────────────────
-- The comparison is over anon, authenticated, service_role and PUBLIC, sorted.
DO $acl$
DECLARE
  have text;
BEGIN
  SELECT string_agg(g, ',' ORDER BY g) INTO have FROM (
    SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '=' || e.privilege_type AS g
      FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
     WHERE p.oid = 'public.post_media_path_is_owned(text,uuid)'::regprocedure
       AND (e.grantee = 0 OR pg_get_userbyid(e.grantee) IN ('anon', 'authenticated', 'service_role'))) x;
  IF have IS DISTINCT FROM 'authenticated=EXECUTE,service_role=EXECUTE' THEN
    REVOKE ALL ON FUNCTION public.post_media_path_is_owned(text, uuid) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.post_media_path_is_owned(text, uuid) TO authenticated, service_role;
  END IF;

  SELECT string_agg(g, ',' ORDER BY g) INTO have FROM (
    SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '=' || e.privilege_type AS g
      FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
     WHERE p.oid = 'public.post_media_path_is_moderated(text,uuid)'::regprocedure
       AND (e.grantee = 0 OR pg_get_userbyid(e.grantee) IN ('anon', 'authenticated', 'service_role'))) x;
  -- anon and service_role are withheld on purpose: without a JWT this answers
  -- FALSE, the permissive answer (see the function's comment).
  IF have IS DISTINCT FROM 'authenticated=EXECUTE' THEN
    REVOKE ALL ON FUNCTION public.post_media_path_is_moderated(text, uuid) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.post_media_path_is_moderated(text, uuid) TO authenticated;
  END IF;

  SELECT string_agg(g, ',' ORDER BY g) INTO have FROM (
    SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '=' || e.privilege_type AS g
      FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
     WHERE p.oid = 'public.post_media_record_moderation_verdict()'::regprocedure
       AND (e.grantee = 0 OR pg_get_userbyid(e.grantee) IN ('anon', 'authenticated', 'service_role'))) x;
  IF have IS DISTINCT FROM 'service_role=EXECUTE' THEN
    REVOKE ALL ON FUNCTION public.post_media_record_moderation_verdict() FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.post_media_record_moderation_verdict() TO service_role;
  END IF;

  SELECT string_agg(g, ',' ORDER BY g) INTO have FROM (
    SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '=' || e.privilege_type AS g
      FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) e
     WHERE c.oid = 'public.post_media_moderation_ledger'::regclass
       AND (e.grantee = 0 OR pg_get_userbyid(e.grantee) IN ('anon', 'authenticated', 'service_role'))) x;
  -- No DELETE for anyone but the owner role: the ledger only grows.
  IF have IS DISTINCT FROM 'service_role=INSERT,service_role=SELECT,service_role=UPDATE' THEN
    REVOKE ALL ON TABLE public.post_media_moderation_ledger FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.post_media_moderation_ledger TO service_role;
  END IF;
END $acl$;

-- ── 3. 0103's FOR ALL policy, superseded by the split above ──────────────────────
-- Absent on production, so a no-op there.
DROP POLICY IF EXISTS post_media_owner_write ON public.post_media;

COMMIT;

-- ── Postconditions (separate transaction; they read and raise, nothing else) ───
-- Each object's fingerprint must equal production's, read 2026-10-23 with this
-- same expression: function body, language, volatility, SECURITY DEFINER,
-- search_path, result type, client privileges and comment; policy command, roles,
-- predicates (whitespace-normalised) and comment; the trigger definition; the
-- ledger's columns, constraints, index, RLS flags, client privileges and comment.
DO $$
DECLARE
  r record;
  got text;
  pols text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', '"$user", public, extensions', true);

  FOR r IN SELECT * FROM (VALUES
      ('fn:post_media_path_is_moderated', 'e85b1eaaf70130c408359ad93689029f'),
      ('fn:post_media_path_is_owned', '6c33866a445e6bf49d78274d6b5908d7'),
      ('fn:post_media_record_moderation_verdict', 'b832376b5af8a2bb4dc54257055be4d3'),
      ('pol:post_media_owner_delete', '2cdcada400b2a54a2952fb1c795f602b'),
      ('pol:post_media_owner_insert', 'a30ce0a042156e4f2e024ee091c37de8'),
      ('pol:post_media_owner_update', 'c27edd183ca38d03cbbf72d856eb3e97'),
      ('pol:post_media_service_role_all', '652a16e5cbcdcb4cb5dd01a584b9c48e'),
      ('tbl:post_media_moderation_ledger', 'cff0a2ba42d661e53a4f109471a46deb'),
      ('trg:trg_post_media_record_moderation_verdict', 'c66909eb426b01a114058570161e3d82')
    ) AS x(k, want)
  LOOP
    got := CASE split_part(r.k, ':', 1)
      WHEN 'fn' THEN (
        SELECT md5(concat_ws('|', p.oid::regprocedure::text, p.prosrc, l.lanname, p.provolatile::text, p.prosecdef::text,
                 coalesce(array_to_string(p.proconfig, ','), ''), pg_get_function_result(p.oid),
                 (SELECT string_agg(g, ',' ORDER BY g) FROM (
                    SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '=' || e.privilege_type AS g
                      FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
                     WHERE e.grantee = 0 OR pg_get_userbyid(e.grantee) IN ('anon', 'authenticated', 'service_role')) a),
                 coalesce(obj_description(p.oid, 'pg_proc'), '')))
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname = 'public' AND p.proname = split_part(r.k, ':', 2))
      WHEN 'pol' THEN (
        SELECT md5(concat_ws('|', p.polcmd::text, p.polpermissive::text,
                 (SELECT string_agg(rn, ',' ORDER BY rn) FROM (
                    SELECT CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x) END AS rn FROM unnest(p.polroles) x) rr),
                 regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), '\s+', ' ', 'g'),
                 regexp_replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g'),
                 coalesce(obj_description(p.oid, 'pg_policy'), '')))
          FROM pg_policy p
         WHERE p.polrelid = 'public.post_media'::regclass AND p.polname = split_part(r.k, ':', 2))
      WHEN 'trg' THEN (
        SELECT md5(pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text)
          FROM pg_trigger t
         WHERE t.tgrelid = 'public.post_media'::regclass AND t.tgname = split_part(r.k, ':', 2))
      WHEN 'tbl' THEN (
        SELECT md5(concat_ws('|',
                 (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':'
                                    || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
                    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
                 (SELECT string_agg(k.conname || '=' || pg_get_constraintdef(k.oid), ',' ORDER BY k.conname)
                    FROM pg_constraint k WHERE k.conrelid = c.oid),
                 (SELECT string_agg(pg_get_indexdef(i.indexrelid), ',' ORDER BY pg_get_indexdef(i.indexrelid))
                    FROM pg_index i WHERE i.indrelid = c.oid),
                 c.relrowsecurity::text, c.relforcerowsecurity::text,
                 (SELECT string_agg(g, ',' ORDER BY g) FROM (
                    SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '=' || e.privilege_type AS g
                      FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) e
                     WHERE e.grantee = 0 OR pg_get_userbyid(e.grantee) IN ('anon', 'authenticated', 'service_role')) a),
                 coalesce(obj_description(c.oid, 'pg_class'), '')))
          FROM pg_class c WHERE c.oid = to_regclass('public.' || split_part(r.k, ':', 2)))
    END;
    IF got IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3909): % is absent.', r.k;
    END IF;
    IF got <> r.want THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3909): % differs from production''s 2098 definition (fingerprint % , production %).', r.k, got, r.want;
    END IF;
  END LOOP;

  -- The policy set is exactly production's: the split, the service-role policy
  -- and 3905's public read. Anything else permissive would widen the split.
  SELECT string_agg(polname, ',' ORDER BY polname) INTO pols
    FROM pg_policy WHERE polrelid = 'public.post_media'::regclass;
  IF pols IS DISTINCT FROM 'post_media_owner_delete,post_media_owner_insert,post_media_owner_update,post_media_public_select,post_media_service_role_all' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3909): post_media''s policies are [%], not 2098''s five.', pols;
  END IF;
END $$;
