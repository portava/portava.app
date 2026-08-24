-- 2150_passport_memories_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change (passport is enabled).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- As `authenticated` owning the row, via direct PostgREST (public anon key):
--   UPDATE passport_memories SET verification_level='verified'
--    WHERE id=<own memory> AND user_id=auth.uid();   => 1 row. SELF-VERIFY.
--
-- verification_level is the platform's trust assertion on a memory (ranked as a
-- trust signal, PassportMapService.verificationRank). The memory service sets it
-- via the service-role client (default 'unverified'); a direct PostgREST write
-- with the public anon key must not.
--
-- ROOT CAUSE (same class as 2144-2149): anon+authenticated hold INSERT/UPDATE on
-- every column; the RLS policy passport_memories_own (USING/CHECK auth.uid()=
-- user_id) constrains the ROW, not the COLUMNS.
--
-- ── LEGITIMATE CLIENT-WRITABLE SET (owner decision) ─────────────────────────
-- "Users may control their passport content. Users may NOT assert platform
-- verification." status (suggested/active/dismissed — accept/dismiss a suggested
-- memory) and visibility are PROVEN legitimate owner self-service and MUST stay
-- client-writable. The client create/patch schema (routes/passportStamps.ts
-- createMemorySchema/patchMemorySchema) writes title/description/country/city/
-- neighborhood/category/visibility/photo_url/media_type; accept/dismiss writes
-- status. Every server write uses the service-role client, so this grant governs
-- only direct-PostgREST writes.
--
-- CLASS A — user content + self-service (granted): title, body, description,
--   country, city, neighborhood, category, photo_url, media_type, status,
--   visibility. user_id is INSERT-only (ownership; never UPDATE).
-- CLASS B — protected (NOT client-writable):
--   verification_level (MANDATE: platform verification / trust rank);
--   source_type, source_id, suggestion_reason (system suggestion provenance —
--     never written by the client create/patch schema);
--   plan_id, trip_id, place_id (system-set suggestion associations — not in the
--     client schema);
--   metadata (system jsonb).
-- CLASS C — system/immutable (not granted): id, created_at, updated_at, earned_at.
--
-- All CLASS B columns are nullable or safely defaulted (verification_level
-- 'unverified'), so a client INSERT omitting them yields a valid unverified row.
--
-- NOTE: status and visibility are DELIBERATELY granted (owner self-service).
-- Only verification/provenance is protected — status/visibility are NOT locked.
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path (all server writes service-role). anon keeps SELECT
-- (passport_memories_public_read: visibility='public' AND status='active'). No
-- RLS/enum/policy/default/service_role change — generated types untouched.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.passport_memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_memories does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.passport_memories'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on passport_memories.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='passport_memories' AND policyname='passport_memories_public_read') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: passport_memories_public_read absent; anon SELECT would need re-deriving.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='passport_memories'
         AND column_name IN ('verification_level','status','visibility','user_id')) <> 4 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected columns drifted.';
  END IF;
END $$;

REVOKE ALL ON TABLE public.passport_memories FROM anon;
REVOKE ALL ON TABLE public.passport_memories FROM authenticated;

GRANT SELECT ON TABLE public.passport_memories TO anon;
GRANT SELECT ON TABLE public.passport_memories TO authenticated;

GRANT INSERT (user_id, title, body, description, country, city, neighborhood, category, photo_url, media_type, status, visibility)
  ON TABLE public.passport_memories TO authenticated;
GRANT UPDATE (title, body, description, country, city, neighborhood, category, photo_url, media_type, status, visibility)
  ON TABLE public.passport_memories TO authenticated;

COMMENT ON TABLE public.passport_memories IS
  'Passport memory. verification_level (platform verification / trust rank) plus '
  'the system provenance/association columns (source_type, source_id, '
  'suggestion_reason, plan_id, trip_id, place_id, metadata) are set by the memory '
  'service (service-role) and are NOT client-writable (2150). anon+authenticated '
  'hold SELECT, plus column-level INSERT/UPDATE on user content + the self-service '
  'status (accept/dismiss) and visibility fields for authenticated.';

DO $$
DECLARE anon_privs text; auth_privs text; forbidden text; selfsvc text; ins int; upd int;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='passport_memories' AND grantee='anon';
  IF anon_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected SELECT only', anon_privs; END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='passport_memories' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated table-level "%", expected SELECT only', auth_privs; END IF;

  -- verification/provenance must NOT be client-writable.
  SELECT string_agg(DISTINCT grantee||'/'||privilege_type||'/'||column_name, ', ' ORDER BY grantee||'/'||privilege_type||'/'||column_name)
    INTO forbidden FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_memories'
     AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE')
     AND column_name IN ('verification_level','source_type','source_id','suggestion_reason','plan_id','trip_id','place_id','metadata','id','created_at','updated_at','earned_at');
  IF forbidden IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: protected columns still client-writable: %', forbidden; END IF;

  -- self-service status+visibility MUST remain client-writable (owner mandate).
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO selfsvc
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_memories'
     AND grantee='authenticated' AND privilege_type='UPDATE' AND column_name IN ('status','visibility');
  IF selfsvc IS DISTINCT FROM 'status,visibility' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: status/visibility self-service must stay writable, got: %', COALESCE(selfsvc,'(none)');
  END IF;

  SELECT count(*) INTO ins FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_memories' AND grantee='authenticated' AND privilege_type='INSERT';
  SELECT count(*) INTO upd FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='passport_memories' AND grantee='authenticated' AND privilege_type='UPDATE';
  IF ins <> 12 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 12 INSERT columns, got %', ins; END IF;
  IF upd <> 11 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 11 UPDATE columns, got %', upd; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='passport_memories' AND grantee='anon' AND privilege_type IN ('INSERT','UPDATE')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon retains a column INSERT/UPDATE grant.';
  END IF;
END $$;

COMMIT;
