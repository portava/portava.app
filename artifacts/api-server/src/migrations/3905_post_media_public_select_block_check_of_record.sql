-- 3905_post_media_public_select_block_check_of_record.sql
-- post_media's public read policy hides a blocked person's media in BOTH
-- directions, through the definition of record (census-telegraph T220 §15 "No
-- subsystem may independently 'rediscover' a blocked relationship";
-- independent verification pass 4's boundary note: "the post_media_public_select
-- policy (last re-created by 2337) does the same"). POST-CUTOVER CANONICAL
-- FORWARD MIGRATION (3000-3999 band, gap number 3905;
-- docs/ops/wave5-owner-decisions-20261018.md "Migrations").
--
-- WRITTEN, NOT APPLIED. One policy re-created with one conjunct changed. No
-- table, column, row, grant or flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT: the inline block check is half blind
-- ══════════════════════════════════════════════════════════════════════════════
-- 2337 last re-created the policy (no later file touches it; 3363 and 3365 name
-- it in comments only). Its block conjunct reads public.blocks INLINE:
--
--   AND NOT EXISTS (SELECT 1 FROM public.blocks b
--        WHERE (b.blocker_id = auth.uid() AND b.blocked_id = post_media.user_id)
--           OR (b.blocker_id = post_media.user_id AND b.blocked_id = auth.uid()))
--
-- A policy's subquery runs as the QUERYING role, through that table's own RLS.
-- blocks admits a reader only the rows they made (baseline blocks_select_own /
-- users_view_own_blocks: blocker_id = auth.uid()). So the second direction —
-- the media's owner blocked the viewer — reads no row, NOT EXISTS is true, and
-- a signed-in person the owner blocked reads the owner's ready, public media
-- straight from PostgREST. Only the direction the viewer made bites. (The API
-- reads post_media as service_role, past RLS, and is not affected.)
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX: one conjunct, nothing else
-- ══════════════════════════════════════════════════════════════════════════════
--   AND NOT authz.is_blocked(auth.uid(), post_media.user_id)
--
-- authz.is_blocked (baseline public.is_blocked, moved by 2182) is SECURITY
-- DEFINER: it reads blocks as its owner, so both directions bite. It is the
-- house's policy form for exactly this (2401's messages_hide_blocked_sender,
-- 3502's highlights policies). auth.uid() NULL (anon) matches no row either way,
-- as before. Everything else — the owner arm, ready + not rejected/flagged, the
-- post's status, public or trip-crew visibility through authz.is_trip_crew,
-- FOR SELECT, PERMISSIVE, TO public, no WITH CHECK — is 2337's text verbatim.
-- The $mig$ block refuses unless the INSTALLED policy is exactly 2337's
-- definition as this server deparses it (or already this file's, a re-run), and
-- unless the two deparsed definitions differ in that one conjunct only.
--
-- WHAT CHANGES FOR A CLIENT: a signed-in person whom the media's owner blocked
-- no longer reads that media through PostgREST. Nothing else. The cost is one
-- indexed definer call per candidate row (a definer function is not inlined),
-- as on messages and highlights.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number: applied at 3905 on a fresh replay, after 3999
-- on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on public.post_media, public.posts, public.blocks (baseline),
-- authz.is_trip_crew (2334) and authz.is_blocked (2182). Above 3905, 3981
-- (references and a trigger), 3982 (a read) and 3999 (an index name) mention
-- post_media; none touches its policies or the columns this policy reads, and
-- none names posts' status, visibility or trip_id, blocks, is_blocked or
-- is_trip_crew's definition (3972 and 3978 require is_trip_crew; they do not
-- redefine it).
--
-- ROLLBACK (re-creates 2337's policy text exactly; reopens the defect above):
--   BEGIN;
--   DROP POLICY IF EXISTS "post_media_public_select" ON public.post_media;
--   -- then 2337_trip_crew_rls_membership_convergence.sql's CREATE POLICY
--   -- "post_media_public_select" statement, verbatim (its LANE F).
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3905_post_media_public_select_block_check_of_record.sql';
--   COMMIT;

BEGIN;

DO $pre$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.post_media') IS NULL OR to_regclass('public.posts') IS NULL OR to_regclass('public.blocks') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905): public.post_media, public.posts and public.blocks must exist.';
  END IF;
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905): authz.is_trip_crew(uuid) is absent; apply 2334 first.';
  END IF;
  IF to_regprocedure('authz.is_blocked(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905): authz.is_blocked(uuid, uuid) is absent; apply 2182 first.';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'authz.is_blocked(uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905): authz.is_blocked is not SECURITY DEFINER; it would read blocks through the reader''s RLS and stay half blind.';
  END IF;
  -- The definer sees every blocks row only as the table's owner (no FORCE) or a role past RLS.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p, pg_class c, pg_roles r
     WHERE p.oid = 'authz.is_blocked(uuid,uuid)'::regprocedure AND c.oid = 'public.blocks'::regclass AND r.oid = p.proowner
       AND (r.rolsuper OR r.rolbypassrls OR (p.proowner = c.relowner AND NOT c.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905): authz.is_blocked''s owner is subject to blocks'' RLS, so it would not see both directions.';
  END IF;
  -- The policy is TO public: anon and authenticated evaluate it with their own privileges.
  IF NOT has_schema_privilege('anon', 'authz', 'USAGE') OR NOT has_schema_privilege('authenticated', 'authz', 'USAGE')
     OR NOT has_function_privilege('anon', 'authz.is_blocked(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'authz.is_blocked(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905): anon or authenticated cannot reach authz.is_blocked; every client read of post_media would fail.';
  END IF;
  SELECT p.permissive, p.roles, p.cmd, p.with_check INTO pol
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'post_media' AND p.policyname = 'post_media_public_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905): policy post_media_public_select does not exist on public.post_media.';
  END IF;
  IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE' OR pol.roles <> '{public}'::name[] OR pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905): post_media_public_select is not (SELECT, PERMISSIVE, TO public, no WITH CHECK): cmd=% permissive=% roles=%.', pol.cmd, pol.permissive, pol.roles;
  END IF;
END $pre$;

-- The installed policy must be 2337's definition (or this file's, on a re-run),
-- as THIS server deparses each: re-state each text on the policy and compare.
DO $mig$
DECLARE
  USING_2337 constant text := $u2337$
    user_id = auth.uid()
    OR (
      processing_status = 'ready'
      AND moderation_status <> ALL (ARRAY['rejected'::text, 'flagged'::text])
      AND NOT EXISTS (
        SELECT 1 FROM public.blocks b
         WHERE (b.blocker_id = auth.uid() AND b.blocked_id = post_media.user_id)
            OR (b.blocker_id = post_media.user_id AND b.blocked_id = auth.uid())
      )
      AND EXISTS (
        SELECT 1 FROM public.posts p
         WHERE p.id = post_media.post_id
           AND p.status = 'active'::post_status
           AND ( p.visibility = 'public'::post_visibility
                 OR ( p.visibility = 'trip_only'::post_visibility
                      AND p.trip_id IS NOT NULL
                      AND authz.is_trip_crew(p.trip_id) ) )
      )
    )
  $u2337$;
  USING_3905 constant text := $u3905$
    user_id = auth.uid()
    OR (
      processing_status = 'ready'
      AND moderation_status <> ALL (ARRAY['rejected'::text, 'flagged'::text])
      AND NOT authz.is_blocked(auth.uid(), post_media.user_id)
      AND EXISTS (
        SELECT 1 FROM public.posts p
         WHERE p.id = post_media.post_id
           AND p.status = 'active'::post_status
           AND ( p.visibility = 'public'::post_visibility
                 OR ( p.visibility = 'trip_only'::post_visibility
                      AND p.trip_id IS NOT NULL
                      AND authz.is_trip_crew(p.trip_id) ) )
      )
    )
  $u3905$;
  CONJ_2337 constant text := $c2337$
    NOT EXISTS (
        SELECT 1 FROM public.blocks b
         WHERE (b.blocker_id = auth.uid() AND b.blocked_id = post_media.user_id)
            OR (b.blocker_id = post_media.user_id AND b.blocked_id = auth.uid())
      )
  $c2337$;
  CONJ_3905 constant text := $c3905$ NOT authz.is_blocked(auth.uid(), post_media.user_id) $c3905$;
  q_installed text;
  q_2337 text;
  q_3905 text;
  c_2337 text;
  c_3905 text;
BEGIN
  SELECT qual INTO q_installed FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select';

  -- Each probe re-states a text on the policy inside this transaction; the
  -- re-creation below decides the final definition.
  EXECUTE format('ALTER POLICY post_media_public_select ON public.post_media USING (%s)', CONJ_2337);
  SELECT qual INTO c_2337 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select';
  EXECUTE format('ALTER POLICY post_media_public_select ON public.post_media USING (%s)', CONJ_3905);
  SELECT qual INTO c_3905 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select';
  EXECUTE format('ALTER POLICY post_media_public_select ON public.post_media USING (%s)', USING_3905);
  SELECT qual INTO q_3905 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select';
  EXECUTE format('ALTER POLICY post_media_public_select ON public.post_media USING (%s)', USING_2337);
  SELECT qual INTO q_2337 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select';

  IF q_installed = q_3905 THEN
    RAISE NOTICE '3905: post_media_public_select already asks authz.is_blocked; it is re-created unchanged.';
  ELSIF q_installed IS DISTINCT FROM q_2337 THEN
    RAISE EXCEPTION '3905 PRECONDITION FAILED: the installed post_media_public_select is neither 2337''s definition nor this file''s, so re-creating it would change more than its block check. Installed: % || 2337 deparses as: %', q_installed, q_2337;
  END IF;

  -- One conjunct, nothing else: masking each conjunct out of its definition leaves the same text.
  IF position(c_2337 IN q_2337) = 0 OR position(c_3905 IN q_3905) = 0
     OR replace(q_2337, c_2337, '<3905>') IS DISTINCT FROM replace(q_3905, c_3905, '<3905>') THEN
    RAISE EXCEPTION '3905: 2337''s definition and this file''s differ outside the block conjunct. 2337: % || 3905: %', q_2337, q_3905;
  END IF;
END $mig$;

DROP POLICY IF EXISTS "post_media_public_select" ON public.post_media;
CREATE POLICY "post_media_public_select" ON public.post_media
  FOR SELECT USING (
    user_id = auth.uid()
    OR (
      processing_status = 'ready'
      AND moderation_status <> ALL (ARRAY['rejected'::text, 'flagged'::text])
      AND NOT authz.is_blocked(auth.uid(), post_media.user_id)
      AND EXISTS (
        SELECT 1 FROM public.posts p
         WHERE p.id = post_media.post_id
           AND p.status = 'active'::post_status
           AND ( p.visibility = 'public'::post_visibility
                 OR ( p.visibility = 'trip_only'::post_visibility
                      AND p.trip_id IS NOT NULL
                      AND authz.is_trip_crew(p.trip_id) ) )
      )
    )
  );

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  pol record;
  q text;
BEGIN
  SELECT p.permissive, p.roles, p.cmd, p.qual, p.with_check INTO pol
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'post_media' AND p.policyname = 'post_media_public_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3905): post_media_public_select is gone.';
  END IF;
  IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE' OR pol.roles <> '{public}'::name[] OR pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3905): post_media_public_select is not (SELECT, PERMISSIVE, TO public, no WITH CHECK).';
  END IF;
  q := regexp_replace(pol.qual, '\s+', ' ', 'g');
  IF (length(q) - length(replace(q, '(NOT authz.is_blocked(auth.uid(), user_id))', ''))) / length('(NOT authz.is_blocked(auth.uid(), user_id))') <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3905): the policy does not ask authz.is_blocked(auth.uid(), user_id) exactly once: %', pol.qual;
  END IF;
  IF q ~ '\mblocks\M' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3905): the policy still reads the blocks table itself: %', pol.qual;
  END IF;
  IF position('(user_id = auth.uid())' IN q) = 0
     OR position('(processing_status = ''ready''::text)' IN q) = 0
     OR position('(moderation_status <> ALL (ARRAY[''rejected''::text, ''flagged''::text]))' IN q) = 0
     OR position('(p.id = post_media.post_id)' IN q) = 0
     OR position('authz.is_trip_crew(p.trip_id)' IN q) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3905): an arm of 2337''s policy is gone: %', pol.qual;
  END IF;
  IF NOT has_function_privilege('anon', 'authz.is_blocked(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'authz.is_blocked(uuid,uuid)', 'EXECUTE')
     OR NOT has_schema_privilege('anon', 'authz', 'USAGE') OR NOT has_schema_privilege('authenticated', 'authz', 'USAGE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3905): a client role cannot reach authz.is_blocked; every client read of post_media would fail.';
  END IF;
END $post$;
