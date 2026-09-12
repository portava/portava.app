-- 2803_intel_safety_candidates_flag.sql
-- Seeds `intel_safety_candidates_enabled` FALSE — the capability gate for
-- Sensing §16's SAFETY CANDIDATE stage:
--   POST /api/admin/intel/safety-candidates/scan
--   GET  /api/admin/intel/safety-candidates
-- (routes/adminSafetyCandidates.ts; lib/safetyCandidate.ts,
-- lib/safetyCandidateStore.ts).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Sensing lane 2803.
--
-- WHAT THE FLAG GATES. An admin-only stage that reads the served state of
-- places currently at `packed` through lib/liveClaimRead (the one gated
-- path) and the projection's own previous readings, detects three anomaly
-- shapes (density rising past capacity, material conflict at capacity, a
-- rapid density rise), and FILES each new candidate into the platform's
-- EXISTING review queue — a public.moderation_reports row, subject_type
-- 'place', category 'safety_concern', reporter_id NULL, status 'open' —
-- the queue GET /admin/moderation/reports already serves. It writes no
-- snapshot, projects no notice and asserts nothing: the canonical safety
-- assertion (crowd.level = unsafe_density) stays specialist-only.
--
-- NO TABLE, NO COLUMN. The candidate rides in a row shape moderation_reports
-- already accepts: reporter_id is nullable, 'place' and 'safety_concern' are
-- in its CHECK lists (baseline). The precondition below verifies exactly
-- that on the database it runs on, so a schema where those values are not
-- accepted refuses this file instead of seeding a flag for a stage that
-- would fail on its first write.
--
-- Seeded FALSE. Read fail-closed by lib/featureFlags.isFlagEnabled: absent,
-- false or unreadable all mean both routes answer feature_disabled. Enabling
-- is an owner decision — it opens a stage that writes to the moderation
-- queue — and the postcondition refuses to commit this file if the row
-- reads TRUE.
--
-- Additive: one INSERT ... ON CONFLICT DO NOTHING. It does NOT self-register
-- in schema_migration_ledger (the apply tooling's job).
BEGIN;

DO $$
DECLARE v_cat text; v_sub text; v_nullable text;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  IF to_regclass('public.moderation_reports') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.moderation_reports does not exist; a safety candidate is a row in it.';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_cat FROM pg_constraint
    WHERE conrelid = 'public.moderation_reports'::regclass AND conname = 'moderation_reports_category_check';
  IF v_cat IS NULL OR position('safety_concern' IN v_cat) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: moderation_reports_category_check does not admit safety_concern.';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_sub FROM pg_constraint
    WHERE conrelid = 'public.moderation_reports'::regclass AND conname = 'moderation_reports_subject_type_check';
  IF v_sub IS NULL OR position('place' IN v_sub) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: moderation_reports_subject_type_check does not admit place.';
  END IF;
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'moderation_reports' AND column_name = 'reporter_id';
  IF v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: moderation_reports.reporter_id is not nullable; a system-originated candidate has no reporter.';
  END IF;
  -- NOTE, not a failure: the rapid-rise shape reads 2273. Absent here means
  -- the scan reports versions_unavailable per subject until it is applied.
  IF to_regclass('public.intel_state_snapshot_versions') IS NULL THEN
    RAISE NOTICE '2803: intel_state_snapshot_versions (2273) is not present on this database; the scan will report versions_unavailable per subject here until it is applied.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('intel_safety_candidates_enabled', false,
   'Sensing §16: the SAFETY CANDIDATE stage. POST /api/admin/intel/safety-candidates/scan reads the served state of places at packed through lib/liveClaimRead and the projection''s previous readings, detects density rising past capacity / material conflict at capacity / a rapid density rise, and files each new candidate as a moderation_reports row (place, safety_concern, no reporter) into the existing review queue; GET lists the detector''s open rows. Writes no snapshot, projects no notice, asserts nothing. Admin-only. FALSE / absent / unreadable (the seed): both routes answer feature_disabled. Enabling is an owner decision.')
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'intel_safety_candidates_enabled';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_safety_candidates_enabled was not seeded.';
  END IF;
  IF v_enabled IS TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_safety_candidates_enabled reads TRUE on this database. This file seeds it FALSE and never flips it; a TRUE row here was set by hand, and this migration refuses to certify a stage an owner has not enabled.';
  END IF;
END $$;

COMMIT;
