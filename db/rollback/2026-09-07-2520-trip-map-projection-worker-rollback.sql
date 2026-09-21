-- Rollback for 2520_trip_map_projection_worker.sql
-- NOT applied anywhere as of 2026-09-07: 2520 itself has not been applied to
-- portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
-- It was rehearsed on portava-ci inside a transaction that ended in
-- RAISE EXCEPTION.
--
-- WHAT 2520 DID
-- =============
--   * CREATE TABLE trip_map_projections, trip_map_projection_applied
--     (RLS on, zero policies, client grants revoked)
--   * CREATE FUNCTION trip_map_projection_body(uuid),
--                     trip_map_projection_drain(integer, boolean),
--                     trip_map_projection_rebuild(uuid, boolean)
--     (service_role only)
--   * INSERT feature_flags ('trip_map_projection_worker_enabled', false)
--
-- WHAT DROPPING IT DOES
-- =====================
-- Nothing a user can observe while trip_map_projection_worker_enabled is
-- false, which it is seeded as: no reader consumes trip_map_projections, and
-- lib/mapTripProjectionWorker.ts checks the flag fail-closed before calling
-- the drain (a missing flag row reads as false, a missing function is never
-- reached). trip_outbox rows the worker had marked published keep their
-- published_at — that column is 2420's and is not touched here; if the
-- worker is later re-applied those rows are simply not re-consumed, which is
-- the correct reading (they WERE consumed). Re-apply 2520 and call
-- trip_map_projection_rebuild(trip_id) per trip to regenerate what was dropped.
--
-- Data loss: every trip_map_projections / trip_map_projection_applied row.
-- Both are projections, regenerable from canonical state (§19.4).
--
-- Idempotent: every statement is IF EXISTS.

BEGIN;

DROP FUNCTION IF EXISTS public.trip_map_projection_drain(integer, boolean);
DROP FUNCTION IF EXISTS public.trip_map_projection_rebuild(uuid, boolean);
DROP FUNCTION IF EXISTS public.trip_map_projection_body(uuid);

DROP TABLE IF EXISTS public.trip_map_projection_applied;
DROP TABLE IF EXISTS public.trip_map_projections;

DELETE FROM public.feature_flags WHERE flag = 'trip_map_projection_worker_enabled';

COMMIT;
