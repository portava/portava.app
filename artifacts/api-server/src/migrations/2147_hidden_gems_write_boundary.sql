-- 2147_hidden_gems_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — live authorization change (Hidden Gems is enabled).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION (portava-ci, self-rolling-back) ───────
-- As `authenticated` owning the row:
--   UPDATE hidden_gems SET status='active' WHERE submitted_by = auth.uid();
--   => 1 row affected. SELF-PUBLISH.
--
-- A user can publish their own gem (status='active'), and self-set the other
-- authority fields (verification_level, moderation_status, guide_verified_by).
-- The public discovery feed and Compass read gems where status='active', so
-- self-publish injects unmoderated, self-"verified" content into Discovery.
--
-- ROOT CAUSE (same class as 2144/2145/2146): anon+authenticated held the full
-- grant set incl. UPDATE on every column; the owner RLS policy
-- (hidden_gems_owner_update, USING submitted_by=auth.uid()) constrains the ROW,
-- not the COLUMNS. Confirmed genuinely exploitable — the owner UPDATE affected
-- 1 row (unlike discovery_places, which is RLS-blocked and was CLEARED).
--
-- ── LEGITIMATE CLIENT-EDITABLE SET, DERIVED FROM BEHAVIOUR ──────────────────
-- Every write path traced. All server writes use the service-role client:
--   create   -> HiddenGemService.submitGem (status hard-coded 'pending')
--   edit     -> PATCH /hidden-gems/:id -> updateGem / updateGemAsGuide, whose
--               editable fields are the zod `updateSchema` whitelist
--   verify   -> HiddenGemVerificationService (guide/admin)
--   moderate -> HiddenGemModerationService (reports, hide, resolve)
--   counters -> save/visit/report via service-role
-- The standalone client never references the table directly.
--
-- CLASS A — the exact 10 fields the owner-edit whitelist (updateSchema) allows.
--   These are self-description / community-knowledge content and gate nothing on
--   their own (a gem is only in Discovery when status='active', which is class B).
-- CLASS B — publication + authority: status, verification_level, moderation_status,
--   guide_verified_by, crowd_level, source_type, source_confirmation, canonical_place_id.
-- CLASS C — system/immutable/derived: id, submitted_by, save_count, visit_count,
--   report_count, merged_into, created_at, updated_at, geog, approx_geog, and the
--   create-only fields never editable via the API (category, city, country,
--   neighborhood, latitude, longitude, approx_latitude, approx_longitude,
--   image_url, accessibility, visibility).
--
-- Note: latitude/longitude and category/city are set once at CREATE (service-role)
-- and are NOT in the edit whitelist, so they are intentionally excluded from the
-- client grant — a client cannot move or re-categorise a gem after submission.
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path (all writes service-role; the edit route bypasses
-- grants). anon keeps SELECT so the public discovery feed
-- (hidden_gems_public_read: status='active' AND sensitivity_level='public') still
-- works. No column/table/enum/policy change — generated types untouched.
--
-- SAFE TO RE-RUN.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.hidden_gems') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.hidden_gems does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.hidden_gems'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on hidden_gems.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='hidden_gems'
         AND column_name IN ('name','description','safety_notes','best_time_to_go',
           'local_etiquette','vibe_tags','price_range','sensitivity_level',
           'layover_safe','minimum_layover_minutes')) <> 10 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: the class-A edit-whitelist columns do not match the live schema.';
  END IF;
  -- The public discovery feed depends on anon SELECT via hidden_gems_public_read.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='hidden_gems' AND policyname='hidden_gems_public_read') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: hidden_gems_public_read absent; anon SELECT would need re-deriving.';
  END IF;
END $$;

REVOKE ALL ON TABLE public.hidden_gems FROM anon;
REVOKE ALL ON TABLE public.hidden_gems FROM authenticated;

-- Reads: anon for the public feed, authenticated for own + public gems.
GRANT SELECT ON TABLE public.hidden_gems TO anon;
GRANT SELECT ON TABLE public.hidden_gems TO authenticated;

-- The 10 owner-editable content fields, and nothing else.
GRANT UPDATE (
  name, description, safety_notes, best_time_to_go, local_etiquette,
  vibe_tags, price_range, sensitivity_level, layover_safe, minimum_layover_minutes
) ON TABLE public.hidden_gems TO authenticated;

COMMENT ON TABLE public.hidden_gems IS
  'Hidden gem. status (publication), verification_level, moderation_status, '
  'guide_verified_by, crowd_level and provenance fields are set by verification / '
  'moderation / intel (service-role) and are NOT client-writable (2147): '
  'anon+authenticated hold SELECT, plus column-level UPDATE on the 10 owner-edit '
  'content fields for authenticated. Server paths use the service-role client.';

DO $$
DECLARE anon_privs text; auth_privs text; forbidden text; editable text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='hidden_gems' AND grantee='anon';
  IF anon_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected SELECT only', anon_privs; END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '(none)')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='hidden_gems' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated table-level "%", expected SELECT only', auth_privs; END IF;

  -- Authority/publication fields must NOT be client-updatable.
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO forbidden
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='hidden_gems'
     AND grantee IN ('anon','authenticated') AND privilege_type='UPDATE'
     AND column_name IN ('status','verification_level','moderation_status','guide_verified_by',
                         'save_count','visit_count','report_count','crowd_level','submitted_by',
                         'source_type','canonical_place_id','merged_into','latitude','longitude');
  IF forbidden IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: authority/publication columns still client-updatable: %', forbidden; END IF;

  -- Exactly the 10 content columns are editable.
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO editable
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='hidden_gems'
     AND grantee='authenticated' AND privilege_type='UPDATE';
  IF (SELECT count(*) FROM information_schema.column_privileges
       WHERE table_schema='public' AND table_name='hidden_gems'
         AND grantee='authenticated' AND privilege_type='UPDATE') <> 10 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 10 client-editable columns, got: %', editable;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='hidden_gems' AND grantee='anon' AND privilege_type='UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon retains a column-level UPDATE grant.';
  END IF;
END $$;

COMMIT;
