-- 2132_intel_projection_flag.sql
-- Seeds `intel_claim_projection_crowd`, DISABLED.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Follows the rule 2128 established: a flag row arrives with the unit that reads
-- it, never before. Its reader is lib/intelProjection.ts, added in the same
-- change. check-flag-polarity enforces this — a flag seeded but read by nothing
-- is dead config an operator can toggle expecting an effect.
--
-- WHAT ENABLING IT DOES. lib/intelProjection.ts reads active claims, scores them
-- with the spec's confidence formula, asks lib/privacyGate.ts whether the
-- aggregate may be published, and upserts intel_state_snapshots. It writes
-- SUPPRESSED aggregates too, with privacy_eligible=false, so a suppression is a
-- recorded fact rather than a silent absence. This flag controls whether
-- projection runs at all; it does not control whether the privacy gate is
-- honoured, which is never optional.
--
-- RUNTIME EFFECT: NONE. Seeded false, and there are no claims to project until
-- IG-03 supplies a capture path — which is itself blocked on the owner's lawful
-- basis decision.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_claim_projection_crowd',
    false,
    'Runs the claim -> live-state projection (lib/intelProjection.ts). Off means no snapshot is computed or written; readers treat an absent snapshot as unknown. Suppressed aggregates are still recorded with privacy_eligible=false.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'intel_claim_projection_crowd';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_claim_projection_crowd not present after seed';
  END IF;
END $$;

COMMIT;

-- REVERSAL: UPDATE public.feature_flags SET enabled = false
--            WHERE flag = 'intel_claim_projection_crowd';
-- Snapshots already written remain; they expire on their own TTL and readers
-- ignore anything past expires_at.
