-- Rollback for 2420_trip_kernel_foundation.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2420 DID
-- =============
--   * ALTER TABLE trips ADD COLUMN version bigint NOT NULL DEFAULT 0
--   * CREATE TABLE trip_events, trip_command_receipts, trip_outbox (RLS on;
--     one crew SELECT policy on trip_events; client grants revoked)
--   * CREATE FUNCTION trip_kernel_execute(jsonb) (service_role only) and
--     trip_events_refuse_update() + its BEFORE UPDATE trigger
--   * INSERT feature_flags ('trip_kernel_enabled', false)
--
-- WHAT DROPPING IT DOES
-- =====================
-- Nothing a user can observe while trip_kernel_enabled is false, which it is
-- seeded as: the only caller of trip_kernel_execute is lib/tripKernel.ts, and
-- every route that can reach it checks the flag first and falls through to the
-- pre-2420 direct write when the flag is off or absent (isFlagEnabled is
-- fail-closed: a missing flag row reads as false). After this rollback CI
-- behaves like production, where none of these objects exists.
--
-- Data loss: every trip_events / trip_outbox / trip_command_receipts row and
-- every trips.version value written while the flag was on. Those are the
-- kernel's history, not the canonical state — trip_plan_items rows written
-- through the kernel are ordinary rows and are NOT touched here.
--
-- Idempotent: every statement is IF EXISTS.

BEGIN;

DROP FUNCTION IF EXISTS public.trip_kernel_execute(jsonb);
DROP TRIGGER  IF EXISTS trg_trip_events_append_only ON public.trip_events;
DROP FUNCTION IF EXISTS public.trip_events_refuse_update();

DROP POLICY IF EXISTS trip_events_crew_select ON public.trip_events;

DROP TABLE IF EXISTS public.trip_outbox;
DROP TABLE IF EXISTS public.trip_command_receipts;
DROP TABLE IF EXISTS public.trip_events;

ALTER TABLE public.trips DROP COLUMN IF EXISTS version;

DELETE FROM public.feature_flags WHERE flag = 'trip_kernel_enabled';

COMMIT;
