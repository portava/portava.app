-- Rollback for 3905_post_media_public_select_block_check_of_record.sql (census-telegraph T220 §15; wave 5,
-- docs/ops/wave5-owner-decisions-20261018.md "Migrations").
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3905 DID: re-created the policy post_media_public_select ON public.post_media (DROP + CREATE, the 2337 /
-- 2401 house form) with ONE conjunct changed. 2337's inline block read
--       AND NOT EXISTS (
--         SELECT 1 FROM public.blocks b
--          WHERE (b.blocker_id = auth.uid() AND b.blocked_id = post_media.user_id)
--             OR (b.blocker_id = post_media.user_id AND b.blocked_id = auth.uid())
--       )
-- became
--       AND NOT authz.is_blocked(auth.uid(), post_media.user_id)
-- Everything else (the owner arm, ready + not rejected/flagged, the post's status, public or trip-crew visibility
-- through authz.is_trip_crew, FOR SELECT, PERMISSIVE, TO public, no WITH CHECK) was 2337's text verbatim. No
-- table, column, row, grant or flag. The only row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops the policy and re-creates it with 2337_trip_crew_rls_membership_convergence.sql's CREATE
-- POLICY "post_media_public_select" statement (its LANE F), verbatim, then deletes 3905's ledger row so the runner
-- re-applies 3905 later. The policy is then 2337's again, as this server deparses it.
--
-- ⚠ IT RE-OPENS THE DEFECT 3905 CLOSED. A policy's subquery runs as the reading role, through blocks' own RLS,
-- and blocks shows a reader only the rows they made (blocks_select_own / users_view_own_blocks). So 2337's
-- inline read never sees "the media's owner blocked me": a signed-in person the owner blocked reads the owner's
-- ready, public post media straight from PostgREST again. Use this only to recover from a client read 3905 broke,
-- and re-apply 3905 as soon as that is understood.
--
-- Refuses unless the installed policy is exactly 3905's definition, or already 2337's (then it is re-created
-- unchanged), as THIS server deparses each: each text is re-stated on the policy with ALTER POLICY inside this
-- transaction and compared, as 3905 itself does. It also refuses unless the policy is (SELECT, PERMISSIVE, TO
-- public, no WITH CHECK), and unless anon and authenticated can still run what 2337's text needs: SELECT on
-- public.blocks (the inline read runs as the reader; without it every client read of post_media fails 42501),
-- and USAGE on authz plus EXECUTE on authz.is_trip_crew(uuid).
--
-- LOCK: ALTER, DROP and CREATE POLICY take ACCESS EXCLUSIVE on public.post_media until the COMMIT. It is a
-- catalog change (no scan), so the lock is brief, but every read of post_media waits for it.

BEGIN;

DO $pre$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.post_media') IS NULL OR to_regclass('public.posts') IS NULL OR to_regclass('public.blocks') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905 rollback): public.post_media, public.posts and public.blocks must exist.';
  END IF;
  IF to_regprocedure('authz.is_trip_crew(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905 rollback): authz.is_trip_crew(uuid) is absent; 2337''s policy calls it.';
  END IF;
  IF NOT has_table_privilege('anon', 'public.blocks', 'SELECT') OR NOT has_table_privilege('authenticated', 'public.blocks', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905 rollback): anon or authenticated cannot SELECT public.blocks; 2337''s inline read would make every client read of post_media fail.';
  END IF;
  IF NOT has_schema_privilege('anon', 'authz', 'USAGE') OR NOT has_schema_privilege('authenticated', 'authz', 'USAGE')
     OR NOT has_function_privilege('anon', 'authz.is_trip_crew(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'authz.is_trip_crew(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905 rollback): anon or authenticated cannot reach authz.is_trip_crew; every client read of post_media would fail.';
  END IF;
  SELECT p.permissive, p.roles, p.cmd, p.with_check INTO pol
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'post_media' AND p.policyname = 'post_media_public_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905 rollback): policy post_media_public_select does not exist on public.post_media.';
  END IF;
  IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE' OR pol.roles <> '{public}'::name[] OR pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3905 rollback): post_media_public_select is not (SELECT, PERMISSIVE, TO public, no WITH CHECK): cmd=% permissive=% roles=%.', pol.cmd, pol.permissive, pol.roles;
  END IF;
END $pre$;

-- The installed policy must be 3905's definition (or already 2337's), as THIS server deparses each: re-state each
-- text on the policy and compare. The re-creation below decides the final definition.
DO $rb$
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
  q_installed text;
  q_2337 text;
  q_3905 text;
BEGIN
  SELECT qual INTO q_installed FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select';

  -- authz.is_blocked appears in 3905's text; the probe needs it to exist, which it must wherever 3905 applied.
  IF to_regprocedure('authz.is_blocked(uuid,uuid)') IS NOT NULL THEN
    EXECUTE format('ALTER POLICY post_media_public_select ON public.post_media USING (%s)', USING_3905);
    SELECT qual INTO q_3905 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select';
  END IF;
  EXECUTE format('ALTER POLICY post_media_public_select ON public.post_media USING (%s)', USING_2337);
  SELECT qual INTO q_2337 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select';

  IF q_installed = q_2337 THEN
    RAISE NOTICE '3905 rollback: post_media_public_select is already 2337''s definition; it is re-created unchanged.';
  ELSIF q_3905 IS NULL OR q_installed IS DISTINCT FROM q_3905 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3905): the installed post_media_public_select is neither 3905''s definition nor 2337''s, so re-creating 2337''s would change more than its block check. Nothing was changed. Installed: % || 3905 deparses as: %', q_installed, q_3905;
  END IF;
END $rb$;

DROP POLICY IF EXISTS "post_media_public_select" ON public.post_media;
CREATE POLICY "post_media_public_select" ON public.post_media
  FOR SELECT USING (
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
  );

DELETE FROM public.schema_migration_ledger WHERE filename = '3905_post_media_public_select_block_check_of_record.sql';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  pol record;
  q text;
  n int;
BEGIN
  SELECT p.permissive, p.roles, p.cmd, p.qual, p.with_check INTO pol
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'post_media' AND p.policyname = 'post_media_public_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3905): post_media_public_select is gone.';
  END IF;
  IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE' OR pol.roles <> '{public}'::name[] OR pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3905): post_media_public_select is not (SELECT, PERMISSIVE, TO public, no WITH CHECK).';
  END IF;
  q := regexp_replace(pol.qual, '\s+', ' ', 'g');
  IF position('is_blocked' IN q) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3905): the policy still calls is_blocked: %', pol.qual;
  END IF;
  SELECT count(*) INTO n FROM regexp_matches(q, 'NOT \(EXISTS \( SELECT 1 FROM (public\.)?blocks b WHERE', 'g');
  IF n <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3905): the policy reads blocks inline % time(s); expected 1 (2337''s form): %', n, pol.qual;
  END IF;
  IF position('(b.blocker_id = post_media.user_id) AND (b.blocked_id = auth.uid())' IN q) = 0
     OR position('(b.blocker_id = auth.uid()) AND (b.blocked_id = post_media.user_id)' IN q) = 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3905): the inline read does not name both directions: %', pol.qual;
  END IF;
  IF position('(user_id = auth.uid())' IN q) = 0
     OR position('(processing_status = ''ready''::text)' IN q) = 0
     OR position('(moderation_status <> ALL (ARRAY[''rejected''::text, ''flagged''::text]))' IN q) = 0
     OR position('(p.id = post_media.post_id)' IN q) = 0
     OR position('authz.is_trip_crew(p.trip_id)' IN q) = 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3905): an arm of 2337''s policy is missing: %', pol.qual;
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3905_post_media_public_select_block_check_of_record.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3905): the ledger still records 3905 as applied.';
  END IF;
END $post$;
