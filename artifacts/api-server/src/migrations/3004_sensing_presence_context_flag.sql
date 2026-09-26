-- 3004_sensing_presence_context_flag.sql
-- Sensing — ONE capability flag for the §19 presence aggregate as Compass
-- context (census-sensing S39), seeded OFF.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHY THIS MIGRATION EXISTS, AND WHY IT IS ONLY A THIRD OF S39 ────────────
-- `compass/CompassSensingPresence.ts` reserved this flag name and deliberately
-- did NOT read it, for a reason worth repeating because it is the whole point:
--
--   "PHANTOM FLAG — READ BUT NEVER SEEDED … The gate LOOKS deliberate and is
--    not. It cannot be turned on without shipping a migration first."
--
-- A gate nothing can flip is not a gate; it is a comment that resolves to false
-- forever. That module then named the three things decision #9 actually takes,
-- and WHO owns each:
--
--   1. a migration seeding this flag FALSE          the integration owner
--   2. the owner flipping it                        THE OWNER
--   3. a lane wiring a producer to the formatter    a lane
--
-- THIS FILE IS (1) AND NOTHING ELSE. It is shipped now so that (2) is a real,
-- one-step action the day it is taken, instead of a request that first needs a
-- migration written, reviewed and applied. (3) is not written here and is not
-- written anywhere: wiring a producer before the ruling would publish an
-- aggregate to a user-visible surface, which is exactly what decision #9 IS.
--
-- ── WHAT DECISION #9 SAYS, QUOTED RATHER THAN PARAPHRASED ──────────────────
-- docs/architecture/sensing-input-gap.md §3.2, row "Publishing any aggregate to
-- a user-visible surface":
--
--   "The ruling permits *aggregation*; a published surface is a product change.
--    `aggregateSensingCohort` returning `publishable: true` is a PERMISSION,
--    not an instruction, and there is no consumer."
--
-- That row offers no option to choose between. It states that publishing is a
-- product change, full stop. So there is no conservative arm to take here the
-- way there was for §24 (where the census named two arms and the conservative
-- one — route the bucket through `protectedLocations` — is now taken and
-- wired). The honest position is: build the switch, leave it off, and put the
-- question to the owner.
--
-- ── RUNTIME EFFECT: NONE, AND THAT IS CHECKED ──────────────────────────────
-- Nothing reads this flag today. Seeding it changes no served byte and no
-- behaviour anywhere; it makes a FALSE row exist so that `isFlagEnabled` has
-- something to answer false ABOUT rather than answering false because the row
-- is absent — and so an owner looking for the switch finds one to flip.
--
-- The distinction matters and census-sensing §13 is the precedent: production
-- has no `intel_safety_candidates_enabled` row at all, `isFlagEnabled` answers
-- false for an absent row and a FALSE row alike, so behaviour is identical —
-- but "seeded FALSE" describes a deliberate off-switch that production does not
-- have, and an owner planning the enablement would go looking for a flag to
-- flip and find nothing. This file makes that not be true of S39.
--
-- Reader: NONE YET, by design (see above). The reader arrives with (3).
-- Rollback: db/rollback/2026-09-25-3004-sensing-presence-context-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'sensing_presence_context_enabled',
    false,
    'Sensing: the §19 k-gated presence aggregate as Compass context (census-sensing S39). ON: compass/CompassSensingPresence.buildSensingPresenceLines may render an already-k-gated zone presence state into a conversation''s context — observed/unknown only, no person, no count, an UNLABELLED activity ordinal with its reduction_version beside it. OFF (the seed): nothing reads this flag and no surface consumes a sensing aggregate. ENABLING IS OWNER DECISION #9 (docs/architecture/sensing-input-gap.md §3.2, "Publishing any aggregate to a user-visible surface"), and flipping it alone does nothing: a producer must also be wired, which is deliberately not built until #9 is taken.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'sensing_presence_context_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected sensing_presence_context_enabled present, found %', present;
  END IF;

  -- Seeded ON would mean this migration took decision #9 on the owner's behalf.
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'sensing_presence_context_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_presence_context_enabled seeded ON — publishing an aggregate to a user-visible surface is owner decision #9 and this must ship OFF';
  END IF;
END $$;

COMMIT;
