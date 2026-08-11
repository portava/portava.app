-- 0209_retire_freeze_flags.sql
--
-- Formally retire the four freeze_* feature flags:
--   freeze_city, freeze_event, freeze_circle, freeze_booking
--
-- WHY THEY GO RATHER THAN GET A READER
-- ====================================
--
-- They were seeded by 0065_phase7_safety.sql:74-77 as parameterised emergency
-- stops: the target of the freeze was to live in feature_flags.metadata, read
-- back through getFlagRow(). getFlagRow() has zero callers. The whole
-- parameterised-stop design was seeded and never built, so these four rows have
-- never gated anything. An operator could see them in the admin list and toggle
-- them during an incident, and the thing they name would keep happening.
--
-- scripts/check-flag-polarity.mjs recorded that decision as disposition
-- `remove-from-seed` for all four. This migration is the second half of that
-- remedy; the first half (hiding them from the admin surface) shipped in
-- 4d5cc1f4e via HIDDEN_INERT_FLAGS.
--
-- THE ADMIN SURFACE BEHAVIOUR IS UNCHANGED AND MUST STAY UNCHANGED
-- ===============================================================
--
-- routes/admin.ts still filters these four out of GET /admin/feature-flags and
-- still returns 400 not_operational from PATCH /admin/feature-flags/:flag, and
-- routes/featureFlags.ts still filters them from the public endpoint. Deleting
-- the rows does NOT make those guards redundant, and they are deliberately kept:
--   * a PATCH for a deleted flag would otherwise fall through to generic
--     not-found handling, which reads as "wrong URL" rather than "this control
--     does not exist"; and
--   * the guards are what keep the behaviour identical on a database where this
--     migration has not been applied yet.
-- The red-proof tests in 2c982aab8 assert exactly that behaviour. They must keep
-- passing after this migration, on databases both with and without the rows.
--
-- ON DELETE CASCADE — READ THIS BEFORE RUNNING IT ANYWHERE
-- =======================================================
--
-- 0118_feature_flag_audit_log.sql:8 declares
--     flag TEXT NOT NULL REFERENCES feature_flags(flag) ON DELETE CASCADE
-- so deleting a flag row DESTROYS its entire toggle history: who flipped it,
-- when, and in which direction. For a flag that gated nothing that history is
-- probably uninteresting, but "probably" is not a basis for silently discarding
-- an audit trail, and the cascade gives no warning.
--
-- So this migration REFUSES rather than cascading. If any audit rows exist for
-- these four flags it raises and rolls back, and whoever runs it decides
-- deliberately whether to archive them first. A migration that quietly deletes
-- audit history is the same shape of defect as a guard that quietly passes.

BEGIN;

-- ── Fail closed on audit history ────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flag_audit_log
   WHERE flag IN ('freeze_city', 'freeze_event', 'freeze_circle', 'freeze_booking');

  IF n > 0 THEN
    RAISE EXCEPTION
      'REFUSING: % feature_flag_audit_log row(s) reference the freeze_* flags. '
      'ON DELETE CASCADE would destroy that toggle history without warning. '
      'Archive those rows first, then re-run. This is a deliberate decision, '
      'not an error to work around.', n;
  END IF;
END $$;

-- ── The retirement itself ───────────────────────────────────────────────────
DELETE FROM public.feature_flags
 WHERE flag IN ('freeze_city', 'freeze_event', 'freeze_circle', 'freeze_booking');

-- ── Post-condition: none may survive ────────────────────────────────────────
-- Cheap, and it turns a silently partial delete into a rollback.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flags
   WHERE flag IN ('freeze_city', 'freeze_event', 'freeze_circle', 'freeze_booking');

  IF n <> 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: % freeze_* row(s) still present after DELETE.', n;
  END IF;
END $$;

COMMIT;
