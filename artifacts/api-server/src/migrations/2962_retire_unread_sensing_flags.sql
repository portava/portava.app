-- 2962_retire_unread_sensing_flags.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Deletes two
-- feature_flags rows that 2956 seeded and that nothing reads, following the
-- precedent 0209_retire_freeze_flags.sql set for exactly this shape.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THESE TWO CANNOT SIMPLY BE GIVEN READERS
-- ══════════════════════════════════════════════════════════════════════════════
-- check:flag-polarity's remedy menu is write-reader, remove-from-seed, or
-- owner-decision. write-reader was tried first and is not available, and the
-- reason is a design rule rather than an inconvenience:
--
--   intel_sensing_credentials_enabled — its two readers on the source branch
--     (routes/intel.ts and services/intel/IntelCaptureService.ts) both guard
--     blocks whose entire body calls deviceContributionCredential.ts, which the
--     port rejected: it authorises a credential AGAINST AN ACTOR ID, where this
--     repository's own sensingContributionSession keeps no identity at rest.
--     Re-pointing the flag at that stronger module is not available either.
--     lib/sensingAuthPosture.ts fixes SENSING_AUTH_POSTURE = "undecided" and
--     says plainly that "there is deliberately no environment variable or flag
--     that can flip it at runtime". A flag whose job is to enable credential
--     acceptance is precisely the thing that module forbids.
--
--   intel_sensing_device_enrollment_enabled — its route IS portable in
--     isolation, and was deliberately not ported anyway: it writes
--     intel_sensing_device_eligibility(actor_id, device_id, ...), a PERSISTENT
--     IDENTITY-TO-DEVICE LINK AT REST, which is the thing the sensing design
--     exists to eliminate. Its only consumer is is_sensing_device_eligible,
--     called by the rejected issuance route, so porting it would have created an
--     identity-linked write path feeding nothing.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY 2956 IS NOT EDITED TO DROP THE SEED
-- ══════════════════════════════════════════════════════════════════════════════
-- remove-from-seed would normally mean deleting the INSERT from the migration
-- that wrote it, as 0209's own note records doing for the four freeze flags.
-- That is not available here. 2956 is an IMPORTED RECORD of a migration that
-- already ran in production and in CI under a different filename; its committed
-- text has to keep matching what executed, and src/test/migrationImportedRecords.test.ts
-- asserts exactly that. So the seed stays and this migration removes the rows.
--
-- The consequence is stated rather than hidden: check:flag-polarity scans
-- migration TEXT for seeds, so it will still see 2956 seeding these two and will
-- still require an INERT_SEEDED_FLAGS declaration. That declaration is added in
-- the same commit and names this file as the executed remedy.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS ACTUALLY FIXES
-- ══════════════════════════════════════════════════════════════════════════════
-- The hazard the rule names is operator-facing: "an operator can see it in the
-- admin list and toggle it; toggling it changes no code path." Deleting the rows
-- removes the switch. routes/admin.ts HIDDEN_INERT_FLAGS and
-- routes/featureFlags.ts INERT_FLAGS are extended in the same commit, which is
-- what makes the behaviour identical on a database where this has not been
-- applied yet — the same pairing 0209 used.
--
-- NO DATA IS LOST. Both rows were seeded FALSE by 2956 and no code has ever read
-- either, so nothing observable changes. The tables and functions 2956 created
-- are deliberately LEFT ALONE: they are a larger loose end, they hold zero rows
-- in production, and dropping schema is not this migration's business.
BEGIN;

DELETE FROM public.feature_flags
 WHERE flag IN ('intel_sensing_credentials_enabled',
                'intel_sensing_device_enrollment_enabled');

DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left FROM public.feature_flags
   WHERE flag IN ('intel_sensing_credentials_enabled',
                  'intel_sensing_device_enrollment_enabled');
  IF v_left <> 0 THEN
    RAISE EXCEPTION '2962 POSTCONDITION FAILED: % unread sensing flag row(s) remain', v_left;
  END IF;

  -- The sensing TABLES must survive. Deleting a flag row must never be mistaken
  -- for retiring the feature's schema.
  IF to_regclass('public.intel_sensing_credentials') IS NULL
     OR to_regclass('public.intel_sensing_device_eligibility') IS NULL THEN
    RAISE EXCEPTION '2962 POSTCONDITION FAILED: this migration must not disturb 2956 schema';
  END IF;
END $$;

COMMIT;
