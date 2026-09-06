-- 2309_passport_stamp_type_vocabulary.sql
--
-- passport_stamps.stamp_type — one CHECK vocabulary that rejects every value
-- the v1 Passport stamp writer has ever tried to write.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2309.
--
-- Additive + idempotent. The constraint is WIDENED, never narrowed: every value
-- the previous constraint permitted is still permitted, so all existing rows
-- revalidate and no writer that works today starts failing. DROP CONSTRAINT
-- IF EXISTS … ADD CONSTRAINT, so re-running the file is a no-op. No data is
-- written, no flag is flipped, no reader changes shape.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT
-- ══════════════════════════════════════════════════════════════════════════════
-- passport_stamps_stamp_type_check (baseline 20260819_baseline_structure.sql,
-- and verified identical in production on 2026-09-05) permits exactly seven
-- values:
--
--   verification | destination | event | trip | achievement | host | rent_a_buddy
--
-- Those seven are the CATALOG vocabulary — what StampAwardEngine copies out of
-- stamp_definitions.stamp_type when it awards a catalog stamp.
--
-- There is a SECOND writer on the same table with a DIFFERENT vocabulary.
-- services/passport/PassportStampService.createStamp declares
--
--   city | neighborhood | plan | host | hidden_gem | safe_return | activity |
--   trip_crew | compass_ai | qr_checkin
--
-- and only ONE of those ten — `host` — is in the CHECK. Every production call
-- site of createStamp passes one of the nine that are not:
--
--   routes/location.ts:333     stampType: "city"          (arrive-in-a-city stamp)
--   routes/hiddenGems.ts:924   stampType: "city"          (gem check-in stamp)
--   routes/geofence.ts:633     stampType: "plan"          (plan-attendance stamp)
--   routes/safeReturn.ts:401   stampType: "safe_return"   (Safe Return stamp)
--   routes/airport.ts:456      stampType: "activity"      (airport stamp)
--
-- Each INSERT is rejected 23514. createStamp logs and returns null; every
-- caller ignores or `.catch(() => {})`s the null. So the v1 stamp writer has
-- never once written a row, invisibly, on five live routes.
--
-- The production table agrees: all 20 rows in public.passport_stamps carry a
-- catalog label (destination 8, trip 5, event 3, achievement 2, verification 1,
-- rent_a_buddy 1). Zero rows carry any of the nine service labels.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY WIDEN THE VOCABULARY RATHER THAN REMAP THE WRITER
-- ══════════════════════════════════════════════════════════════════════════════
-- The alternative was to fold the service's labels into the catalog's — writing
-- a Safe Return stamp as 'achievement', a city stamp as 'destination'. That is
-- worse than the blackout, because stamp_type is not a display string here: it
-- is the discriminator READERS branch on, and three of them make PRIVACY
-- decisions with it.
--
--   * PassportPrivacyGuard.guardStamp:144 suppresses `neighborhood` and
--     `place_id` on a 'safe_return' stamp for a public caller — a Safe Return
--     stamp says where someone slept.
--   * PassportPrivacyGuard.guardStamp:154 strips `place_id` from 'hidden_gem'
--     and 'safe_return' stamps for public callers.
--   * PassportMapService:96/154/155 counts 'hidden_gem' and 'safe_return' as
--     their own My World categories, and :96 gives 'safe_return' its own
--     precedence rank.
--   * UnifiedStampService:131 and passport_visibility_preferences.
--     show_safe_return_stamps (routes/passportStamps.ts:598) both name
--     'safe_return' as a first-class kind the owner can hide.
--
-- Remapping would make all four of those unreachable for good, and would fold a
-- location-sensitive stamp into a category whose rows are deliberately NOT
-- redacted. The labels are correct and load-bearing; the vocabulary was simply
-- written at 0042, before the Safe Return, hidden-gem, geofence, airport and
-- QR check-in surfaces existed, and no migration ever told it about them.
--
-- The two vocabularies stay distinct after this migration — a catalog award
-- still writes a catalog label and the v1 writer still writes a service label.
-- The CHECK now permits the union of the two, which is what the table has
-- actually been asked to hold since 0042.
--
-- WHAT THIS DOES NOT DO. It does not enable a feature, flip a flag, backfill a
-- row or change any reader. The five routes above remain gated exactly as they
-- were; they simply stop losing their write.
--
-- ROLLBACK (returns to the pre-2309 vocabulary; only safe while no row carries
-- one of the nine added values):
--   BEGIN;
--   ALTER TABLE public.passport_stamps
--     DROP CONSTRAINT IF EXISTS passport_stamps_stamp_type_check;
--   ALTER TABLE public.passport_stamps
--     ADD CONSTRAINT passport_stamps_stamp_type_check
--     CHECK (stamp_type = ANY (ARRAY['verification','destination','event','trip',
--       'achievement','host','rent_a_buddy']::text[]));
--   COMMIT;
--
-- TRANSACTION. Required, same reasoning as 0199/0202/2298: ALTER TABLE … ADD
-- CONSTRAINT revalidates every existing row, and without the transaction a
-- failed ADD after a committed DROP would leave the table with NO constraint at
-- all. The widened list is a strict superset of the one it replaces, so it
-- cannot fail on an existing row — the transaction is the backstop, not the plan.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.passport_stamps') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.passport_stamps must exist.';
  END IF;
END $$;

ALTER TABLE public.passport_stamps
  DROP CONSTRAINT IF EXISTS passport_stamps_stamp_type_check;

ALTER TABLE public.passport_stamps
  ADD CONSTRAINT passport_stamps_stamp_type_check
  CHECK (stamp_type = ANY (ARRAY[
    -- catalog vocabulary (StampAwardEngine ← stamp_definitions.stamp_type)
    'verification',
    'destination',
    'event',
    'trip',
    'achievement',
    'host',
    'rent_a_buddy',
    -- v1 service vocabulary (PassportStampService.StampType)
    'city',
    'neighborhood',
    'plan',
    'hidden_gem',
    'safe_return',
    'activity',
    'trip_crew',
    'compass_ai',
    'qr_checkin'
  ]::text[]));

-- ── Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  def text;
  label text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'passport_stamps_stamp_type_check'
     AND conrelid = 'public.passport_stamps'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_stamps_stamp_type_check is missing.';
  END IF;
  -- Every label of BOTH vocabularies must be permitted. A superset check, so a
  -- future edit that drops one fails here rather than silently re-blinding a
  -- writer.
  FOREACH label IN ARRAY ARRAY[
    'verification','destination','event','trip','achievement','host','rent_a_buddy',
    'city','neighborhood','plan','hidden_gem','safe_return','activity','trip_crew',
    'compass_ai','qr_checkin'
  ] LOOP
    IF position('''' || label || '''' IN def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: stamp_type vocabulary is missing %', label;
    END IF;
  END LOOP;
END $$;

COMMIT;
