-- 2169_intel_compass_rhythm_actor_gate_flag.sql
-- IG-07 Compass — the rhythm k-anonymity gate flag.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Spec §12/§13 (aggregate cohort thresholds; never single-user). Seeds
-- `intel_compass_rhythm_actor_gate`, DISABLED. Its reader is
-- lib/compassRhythmGate.ts via compass/CompassGraphEngine.buildDestinationContextLines,
-- added in the same change.
--
-- WHAT THIS CLOSES. The destination-rhythm line ("typically active around … at
-- this time") published whenever a time slice had >= MIN_SLICE_SAMPLE
-- OBSERVATIONS — but those observations carry no distinct-actor count, so a k=1
-- slice (one traveler, three visits) was published as "community history".
--
-- ⚠ THIS IS A LIVE-PATH CHANGE, NOT A PURE SHADOW ADD. With this flag OFF (the
-- deploy default) the time-sliced rhythm line is SUPPRESSED and Compass falls
-- back to the city-wide, non-time-sliced summary — i.e. deploying this removes a
-- currently-live line until it can be proven k-anonymous. Turning the flag ON
-- re-emits the line ONLY for slices with >= COMPASS_RHYTHM_K distinct
-- contributors, which requires the graph build to first record a per-slice
-- distinct-actor count. Enabling therefore needs (a) that distinct-actor
-- rebuild and (b) explicit owner review — do not enable blind.
--
-- NO table or grant change. RUNTIME EFFECT of the seed itself: the line is
-- suppressed (the safe direction); nothing else changes.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_compass_rhythm_actor_gate',
    false,
    'IG-07. true re-emits the Compass destination-rhythm line ONLY for time slices with >= COMPASS_RHYTHM_K distinct contributors (lib/compassRhythmGate.ts). Off suppresses the time-sliced line entirely (k=1 leak closed); Compass falls back to the city-wide summary. Enabling also requires a distinct-actor graph rebuild + owner review.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'intel_compass_rhythm_actor_gate';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_compass_rhythm_actor_gate not present after seed';
  END IF;
END $$;

COMMIT;

-- REVERSAL: UPDATE public.feature_flags SET enabled = false WHERE flag = 'intel_compass_rhythm_actor_gate';
-- (Off is already the safe state — the sliced rhythm line stays suppressed.)
