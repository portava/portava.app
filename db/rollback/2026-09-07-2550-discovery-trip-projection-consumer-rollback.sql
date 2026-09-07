-- Rollback for 2550_discovery_trip_projection_consumer_flag.sql
-- NOT applied anywhere as of 2026-09-07: 2550 itself has not been applied to
-- portava-ci (hwokxgbmezheskbzskfr) or production (ajrurzioarfkagpuxfnb).
-- It was rehearsed on portava-ci inside a transaction that ended in ROLLBACK.
--
-- WHAT 2550 DID
-- =============
--   * INSERT feature_flags ('discovery_trip_projection_enabled', false)
--
-- WHAT DELETING IT DOES
-- =====================
-- Nothing a user can observe: lib/discoveryTripProjectionConsumer.ts reads the
-- flag fail-closed (isFlagEnabled), so an absent row is exactly the seeded
-- FALSE — routes/discoverySearch.ts searchTrips / searchPlans keep issuing
-- their legacy `trips` reads. If an owner had flipped the flag ON, deleting
-- the row switches trips/plans search back to the legacy path within the
-- consumer's 30 s flag cache.
--
-- Data loss: the one flag row (and any description edit an operator made).
--
-- Idempotent.

BEGIN;

DELETE FROM public.feature_flags WHERE flag = 'discovery_trip_projection_enabled';

COMMIT;
