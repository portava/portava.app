-- 2165_intel_capture_quick_signal_flag.sql
-- Seeds `intel_capture_quick_signal`, DISABLED.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Follows the rule 2128 established: a flag row arrives with the unit that reads
-- it, never before. Its reader is services/intel/IntelCaptureService.ts (via
-- routes/intel.ts), added in the same change. check-flag-polarity enforces this
-- — a flag seeded but read by nothing is dead config.
--
-- WHAT ENABLING IT DOES. It turns on the observation-capture path: POST
-- /v1/intel/observations (and the claim propose/approve/confirm/correct
-- endpoints) begin writing append-only intel_observations rows through the
-- service-role grants migration 2130 already created. Off means every capture
-- call is a fail-closed no-op that stores nothing. This flag is the head of the
-- INTEL_FLAG_DEPENDENCIES chain (intelContracts.ts): projection and the live
-- label may only be honoured when this is on.
--
-- NO table, RLS or grant change: 2130 already created intel_observations /
-- intel_claims / intel_confirmations with RLS, the append-only triggers, the
-- (actor_id, idempotency_key) unique index and the service_role INSERT/SELECT/
-- UPDATE grants this path uses.
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
    'intel_capture_quick_signal',
    false,
    'Runs the Intelligence Gathering capture path (services/intel/IntelCaptureService.ts via routes/intel.ts). Off means every capture/confirm/correct call is a fail-closed no-op that stores nothing. Head of the intel flag dependency chain.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'intel_capture_quick_signal';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_capture_quick_signal not present after seed';
  END IF;
END $$;

COMMIT;

-- REVERSAL: UPDATE public.feature_flags SET enabled = false
--            WHERE flag = 'intel_capture_quick_signal';
-- Observations already written remain; they expire on their own TTL and readers
-- ignore anything past expires_at.
