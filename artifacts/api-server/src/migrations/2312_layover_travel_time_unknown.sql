-- 2312_layover_travel_time_unknown.sql
-- Let the Layover tables say "we do not know how long that takes".
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2312.
--
-- Additive and idempotent: two DROP NOT NULL / DROP DEFAULT pairs, each guarded
-- by a catalog check. No row is written, no row is deleted, no flag is flipped,
-- no reader changes shape, and no constraint is tightened. Re-running is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- `layover_recommendations.travel_time_min` and `layover_plan_stops.travel_min`
-- are both `INTEGER NOT NULL DEFAULT 0`. That shape cannot represent an unknown
-- journey, and the code compensated by inventing one:
--
--   LayoverRecommendationService.estimateTravelTime(placeType) returned 15
--   minutes for a cafe and 25 for everything else. It never read a coordinate —
--   the candidate query does not even SELECT lat/lng, and matches its city with
--   `ilike %city%`. The safety engine doubled that constant into a round trip
--   and turned it straight into "safe" or "not recommended".
--
-- The constant is now deleted. This migration is what lets the truth be stored
-- in its place. Without it the honest value has nowhere to go: writing NULL into
-- a NOT NULL column raises 23502, and the recommendation insert is wrapped in a
-- "non-fatal" warn — so every landside suggestion would silently vanish and the
-- traveller would see an empty list with no explanation. Keeping the DEFAULT 0
-- is no better: it turns "unknown" into "no travel time at all", which reads as
-- the SAFEST possible value and would rate a cross-city trip as instant.
--
-- NULL here means exactly one thing: nobody has measured this journey. It is not
-- zero, it is not a missing write, and it must never be coalesced to a number.
-- This repo has no routing provider to measure it with — MAPBOX_TOKEN and
-- GOOGLE_MAPS_API_KEY are geocoding-only and no Directions, Distance Matrix or
-- Isochrone client exists anywhere — so today NULL is the correct value for
-- every landside candidate, and 0 remains correct for anything inside the
-- terminal, where there is genuinely no journey.
--
-- WHY THE DEFAULT GOES TOO. Leaving `DEFAULT 0` while allowing NULL would mean
-- an INSERT that simply omits the column still lands a confident zero. The
-- column must be written deliberately or not at all.
--
-- NOT WIDENED: `layover_recommendations.safety_rating`. Its CHECK vocabulary
-- (safe | possible_but_risky | not_recommended | airport_only) already contains
-- the value an unmeasurable candidate needs — `not_recommended` — and the reason
-- travels in the existing `warning_reason` column. Adding a fifth status would
-- be a new vocabulary for a state the current one already expresses.

DO $$
BEGIN
  -- layover_recommendations.travel_time_min
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'layover_recommendations'
      AND column_name  = 'travel_time_min'
      AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE public.layover_recommendations ALTER COLUMN travel_time_min DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema   = 'public'
      AND table_name     = 'layover_recommendations'
      AND column_name    = 'travel_time_min'
      AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.layover_recommendations ALTER COLUMN travel_time_min DROP DEFAULT;
  END IF;

  -- layover_plan_stops.travel_min
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'layover_plan_stops'
      AND column_name  = 'travel_min'
      AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE public.layover_plan_stops ALTER COLUMN travel_min DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema   = 'public'
      AND table_name     = 'layover_plan_stops'
      AND column_name    = 'travel_min'
      AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE public.layover_plan_stops ALTER COLUMN travel_min DROP DEFAULT;
  END IF;
END $$;

COMMENT ON COLUMN public.layover_recommendations.travel_time_min IS
  'One-way travel time in minutes, or NULL when it is not known. NULL is the honest answer, not a missing write: this repo has no routing provider, so no landside journey has been measured. Never coalesce it to 0 — 0 means "no journey", which is the safest possible value and the exact fiction this column was carrying when it defaulted.';

COMMENT ON COLUMN public.layover_plan_stops.travel_min IS
  'Minutes of travel to reach this stop, or NULL when unknown. See layover_recommendations.travel_time_min. A plan containing any NULL landside leg has an unknown total and must not be reported as fitting the layover window.';

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_rec_nullable  text;
  v_rec_default   text;
  v_stop_nullable text;
  v_stop_default  text;
BEGIN
  SELECT is_nullable, column_default INTO v_rec_nullable, v_rec_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'layover_recommendations' AND column_name = 'travel_time_min';

  IF v_rec_nullable IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_recommendations.travel_time_min is absent.';
  END IF;
  IF v_rec_nullable <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_recommendations.travel_time_min is still NOT NULL — an unmeasured journey cannot be stored and the recommendation insert would fail silently.';
  END IF;
  IF v_rec_default IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_recommendations.travel_time_min still has a DEFAULT (%) — an omitted column would land a confident number.', v_rec_default;
  END IF;

  SELECT is_nullable, column_default INTO v_stop_nullable, v_stop_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'layover_plan_stops' AND column_name = 'travel_min';

  IF v_stop_nullable IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_plan_stops.travel_min is absent.';
  END IF;
  IF v_stop_nullable <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_plan_stops.travel_min is still NOT NULL.';
  END IF;
  IF v_stop_default IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: layover_plan_stops.travel_min still has a DEFAULT (%).', v_stop_default;
  END IF;
END $$;

-- No self-registration in schema_migration_ledger. Only 2254 (which creates the
-- table) and 2258 write to it from a migration file; every migration since —
-- including 2311, the most recent — leaves registration to the apply tooling.
-- An insert here would also have failed at apply time: the ledger requires
-- `checksum` and `applied_by` (CHECK ci|manual|backfill) and names its free-text
-- column `notes`, not `note`.
