-- 2166_intel_trail_followup_flag.sql
-- Seeds `intel_trail_followup`, DISABLED.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Follows the rule 2128 established: a flag row arrives with the unit that reads
-- it, never before. Its reader is services/intel/IntelCaptureService.ts (the
-- 'trail' capture surface) plus lib/trailFollowup.ts, added in the same change.
-- check-flag-polarity enforces this — a flag seeded but read by nothing is dead
-- config.
--
-- WHAT ENABLING IT DOES (IG-06, spec §26 flag registry — "Stop prompts; preserve
-- Trail"). It turns on the going-next Trail follow-up capture surface: POST
-- /v1/intel/observations with captureSurface:'trail' begins writing append-only
-- experience.next_move observations through the service-role grants 2130 already
-- created. Off means the trail capture path is a fail-closed no-op and no
-- follow-up prompt is issued; any Trail already declared is preserved (readers
-- ignore anything past expires_at).
--
-- PRIVACY INVARIANT UNAFFECTED BY THIS FLAG. experience.next_move is
-- aggregate-only (spec §4 "never single-user claim"): proposeClaim refuses to
-- mint a single-user movement claim regardless of this flag. The §13 movement
-- privacy threshold (15 actors / 5 groups / ≤20% single group / 30-min bucket /
-- 10-min delay) and confidence floor (0.65) gate any publication — those are
-- privacy controls, retained independently of enablement.
--
-- NO table, RLS or grant change: 2130 already created intel_observations /
-- intel_claims / intel_confirmations with RLS, the append-only triggers, the
-- (actor_id, idempotency_key) unique index and the service_role grants this path
-- uses. IG-06 adds NO new table — movement aggregates are DERIVED at read time.
--
-- RUNTIME EFFECT: NONE. Seeded false. And even enabled, capture writes nothing in
-- production until public.places is backfilled (intel_observations.subject_id FKs
-- places(id); the service fails closed with `unknown_subject` until then).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_trail_followup',
    false,
    'Runs the IG-06 going-next Trail follow-up capture surface (captureSurface:trail in services/intel/IntelCaptureService.ts; lib/trailFollowup.ts). Off means the trail capture path is a fail-closed no-op and no follow-up prompt is issued; the movement aggregate stays gated by the §13 privacy threshold and 0.65 confidence floor either way.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'intel_trail_followup';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_trail_followup not present after seed';
  END IF;
END $$;

COMMIT;

-- REVERSAL: UPDATE public.feature_flags SET enabled = false
--            WHERE flag = 'intel_trail_followup';
-- Observations already written remain; they expire on their own TTL and readers
-- ignore anything past expires_at.
