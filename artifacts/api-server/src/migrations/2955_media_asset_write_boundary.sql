-- 2955_media_asset_write_boundary.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Extends the boundary
-- 2972_stamp_family_write_boundary.sql drew, to the three media asset tables.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS TRUE TODAY — MEASURED ON portava-ci, NOT ASSUMED
-- ══════════════════════════════════════════════════════════════════════════════
-- Supabase grants ALL on schema `public` to `anon` and `authenticated` at CREATE
-- TABLE time. media_assets has carried those grants since the baseline;
-- media_processing_attempts and media_asset_lifecycle_events inherited them when
-- 2951 and 2952 created them. All three hold INSERT, UPDATE, DELETE and SELECT
-- for both client roles, identically on prod and on CI.
--
-- All three ALSO have RLS enabled and carry exactly ONE policy each, and it is a
-- SELECT policy scoped to the owner. No INSERT, UPDATE or DELETE policy exists —
-- so RLS denies those commands outright.
--
-- Probed inside a transaction aborted by a deliberate RAISE, with a real asset
-- seeded first (an earlier probe with no seeded row reported a misleading
-- "PERMITTED" on UPDATE and DELETE, because a statement matching zero rows
-- raises no error and proves nothing):
--
--   READS, rows visible for one owner's asset
--     anon, request.jwt.claims cleared, auth.uid() = NULL ...... 0 / 0 / 0
--     a different authenticated user .......................... 0 / 0 / 0
--     the OWNER (control) ..................................... 1 / 1 / 1
--       (media_asset_lifecycle_events / media_processing_attempts / media_assets)
--
--   WRITES
--     anon INSERT media_assets ............................ DENIED (42501)
--     other-user INSERT media_assets ...................... DENIED (42501)
--     other-user INSERT media_asset_lifecycle_events ...... DENIED (42501)
--     other-user INSERT media_processing_attempts ......... DENIED (42501)
--     other-user UPDATE another's media_assets ............ 0 rows affected
--     other-user DELETE another's media_assets ............ 0 rows affected
--
-- A NOTE FOR WHOEVER REPEATS THIS. set_config('request.jwt.claims', …, true) is
-- TRANSACTION-local, not statement-local. Switching to `anon` without clearing it
-- leaves the PREVIOUS branch's claims in force, and the probe then reports anon
-- reading the owner's rows. Clear the claims per branch and assert auth.uid().
--
-- ══════════════════════════════════════════════════════════════════════════════
-- SO WHY REVOKE SOMETHING RLS ALREADY DENIES
-- ══════════════════════════════════════════════════════════════════════════════
-- Because the denial rests on the ABSENCE of a policy, and absence is not a
-- decision anyone recorded. The day someone adds `FOR ALL` to one of these
-- tables — the natural shape when you want owners to manage their own media —
-- the standing table-level grants become live writes for `anon` as well, and
-- nothing in review would flag it, because the grant was made years ago by
-- CREATE TABLE and no test looks at grants. Revoking now makes the boundary a
-- statement rather than an accident.
--
-- SELECT is deliberately LEFT IN PLACE for both roles: the owner SELECT policies
-- need the table-level grant to have anything to narrow, and the probe above
-- shows they narrow it correctly.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS BREAKS NOTHING: EVERY WRITE IS ALREADY SERVER-MEDIATED
-- ══════════════════════════════════════════════════════════════════════════════
-- No client write to these tables can succeed today — the probe above is the
-- proof, and it is exhaustive over (anon, authenticated) x (INSERT, UPDATE,
-- DELETE). Revoking a grant whose every use is already refused cannot change
-- behaviour.
--
-- The server side was ENUMERATED rather than asserted. Every write site on the
-- three tables, across all of src/ outside tests, and the client each uses:
--
--   lib/mediaAssets.ts:501 ................... sc  media_assets  upsert
--   lib/mediaAssets.ts:554 ................... sc  media_assets  update
--   lib/mediaAssets.ts:668 ................... sc  media_assets  update
--   scripts/backfill-media-assets.ts:37 ...... sc  media_assets  upsert
--   services/accountDeletion/
--     AccountDeletionService.ts:1017 ......... sc  media_assets  delete
--
-- Five sites, all of them `sc`, the service-role client. Not one uses the
-- caller's RLS-scoped client. The account-deletion delete matters most and is on
-- that list: erasure keeps working. media_processing_attempts and
-- media_asset_lifecycle_events have no write site in this repository at all —
-- they are written by the out-of-band worker, also as service_role.
--
-- The CLIENT APPLICATION never references any of the three: zero matches for all
-- three table names across travel-buddy-standalone/src.
--
-- service_role and postgres keep the full privilege set and are unaffected.
--
-- REHEARSED ON CI (hwokxgbmezheskbzskfr) before being written down. After the
-- revoke, re-probed: the owner still reads their own asset (assets=1,
-- lifecycle=1), an authenticated user inserting their OWN media_assets row is
-- still refused with the same 42501 it got before (RLS then, the grant now —
-- identical from the caller's side), anon still sees 0, and the counts land at
-- 0 client write grants and 6 surviving client SELECT grants.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['media_assets','media_processing_attempts','media_asset_lifecycle_events'] LOOP
    IF to_regclass('public.'||t) IS NULL THEN
      RAISE EXCEPTION '2955 PRECONDITION FAILED: public.% does not exist (apply 2951 and 2952 first)', t;
    END IF;
  END LOOP;
END $$;

REVOKE INSERT, UPDATE, DELETE ON public.media_assets                  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.media_processing_attempts     FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.media_asset_lifecycle_events  FROM anon, authenticated;

DO $$
DECLARE v_left int; v_select int;
BEGIN
  SELECT count(*) INTO v_left
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('media_assets','media_processing_attempts','media_asset_lifecycle_events')
    AND grantee IN ('anon','authenticated')
    AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF v_left <> 0 THEN
    RAISE EXCEPTION '2955 POSTCONDITION 1 FAILED: % client write grants remain', v_left;
  END IF;

  -- SELECT must SURVIVE, or the owner policies have nothing to narrow and the
  -- owner loses sight of their own media. Six = 3 tables x 2 client roles.
  SELECT count(*) INTO v_select
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('media_assets','media_processing_attempts','media_asset_lifecycle_events')
    AND grantee IN ('anon','authenticated')
    AND privilege_type = 'SELECT';
  IF v_select <> 6 THEN
    RAISE EXCEPTION '2955 POSTCONDITION 2 FAILED: expected 6 surviving client SELECT grants, found %', v_select;
  END IF;

  -- service_role must be untouched, or the api-server cannot write at all.
  IF (SELECT count(*) FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN ('media_assets','media_processing_attempts','media_asset_lifecycle_events')
        AND grantee = 'service_role'
        AND privilege_type IN ('INSERT','UPDATE','DELETE')) <> 9 THEN
    RAISE EXCEPTION '2955 POSTCONDITION 3 FAILED: service_role write grants were disturbed';
  END IF;
END $$;

COMMIT;
