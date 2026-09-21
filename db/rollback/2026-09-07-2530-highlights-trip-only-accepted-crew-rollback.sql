-- Rollback for 2530_highlights_trip_only_accepted_crew.sql
--
-- ⚠ REOPENS A SECURITY HOLE. This restores the trip_only branch of
-- highlights_select_active to the trip_members self-join that admits PENDING
-- invitees (role='member', status='invited'), pending co-hosts and REMOVED
-- members to the trip_only highlights of everyone on a trip they are not
-- accepted crew of, and denies an accepted co_host, an accepted viewer and a
-- trip owner holding no membership row. Measured on portava-ci 2026-09-07.
-- Run it only to reverse 2530 deliberately, never as routine cleanup.
--
-- Mirror of 2530: it rewrites ONE branch in place and preserves whatever
-- surrounding shape is live (0026's on production, 2313's on CI), so it is
-- correct on either database. Refuses if the branch is not found exactly once.

BEGIN;

SET LOCAL search_path = public, pg_catalog;

DO $$
DECLARE
  frag_re  constant text := $re$\(\(visibility = 'trip_only'::text\) AND authz\.shares_accepted_trip\(owner_id\)\)$re$;
  repl     constant text := $rp$((visibility = 'trip_only'::text) AND (EXISTS ( SELECT 1 FROM (trip_members tm1 JOIN trip_members tm2 ON ((tm1.trip_id = tm2.trip_id))) WHERE ((tm1.user_id = highlights.owner_id) AND (tm2.user_id = auth.uid())))))$rp$;
  pol      record;
  new_qual text;
  n_match  int;
BEGIN
  SELECT p.permissive, p.roles, p.cmd, p.qual, p.with_check INTO pol
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'highlights' AND p.policyname = 'highlights_select_active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: highlights_select_active missing.';
  END IF;
  IF pol.qual LIKE '%trip_members%' AND pol.qual NOT LIKE '%authz.shares_accepted_trip%' THEN
    RAISE NOTICE '2530 rollback: highlights_select_active already carries the self-join; nothing to do.';
    RETURN;
  END IF;
  IF pol.cmd <> 'SELECT' OR pol.permissive <> 'PERMISSIVE' OR pol.roles <> '{authenticated}'::name[] OR pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: unexpected policy shape (cmd=% permissive=% roles=%). Refusing to guess.', pol.cmd, pol.permissive, pol.roles;
  END IF;
  SELECT count(*) INTO n_match FROM regexp_matches(pol.qual, frag_re, 'g');
  IF n_match <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected the helper branch exactly once, found %. Live qual: %', n_match, pol.qual;
  END IF;
  new_qual := regexp_replace(pol.qual, frag_re, repl);
  IF regexp_replace(pol.qual, frag_re, '<branch>') IS DISTINCT FROM replace(new_qual, repl, '<branch>') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (pre-write): rewrite touched something outside the trip_only branch.';
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS highlights_select_active ON public.highlights';
  EXECUTE format('CREATE POLICY highlights_select_active ON public.highlights FOR SELECT TO authenticated USING (%s)', new_qual);
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'highlights' AND policyname = 'highlights_select_active'
       AND qual LIKE '%trip_members tm1%' AND qual NOT LIKE '%authz.shares_accepted_trip%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: self-join branch not restored.';
  END IF;
END $$;

COMMIT;
