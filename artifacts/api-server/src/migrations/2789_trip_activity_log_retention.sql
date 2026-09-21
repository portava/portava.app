-- 2789_trip_activity_log_retention.sql
--
-- Trips spec §5.3 — the historical evidence class is policy-controlled with
-- minimised payloads; §20.2 — closeout preserves decision / audit evidence
-- PER POLICY. census-trips TR100, TR387 (and the activity-log half of TR97).
--
-- trip_activity_log (0079) has kept eleven event types indefinitely, with a
-- free-form jsonb `metadata` nobody minimised: evidence preserved by default
-- rather than by policy, which is exactly what the two rows say. This file
-- gives the table the same two things 2781 gave the decision ledger:
--
--   retain_until  — the policy as a column: a year from the row's own
--                   created_at by default, never before it (CHECK), and
--                   public.trip_activity_log_prune() deletes past it and
--                   reports how many. service_role only; nothing in the
--                   database schedules it (the server does, like the ledger).
--   minimised     — a CHECK that `metadata` carries no coordinate key
--                   (lat / lng / latitude / longitude). Added NOT VALID: it
--                   binds every row written from now on, and the legacy rows
--                   are counted below rather than silently promised clean —
--                   a VALIDATE CONSTRAINT is the owner's call once that count
--                   is known on production (0 on the local replica).
--
-- Additive. No row changes value. The twelve logActivity writers
-- (routes/trips-expansion.ts) name no coordinate, so nothing they write is
-- refused; a future one that does is refused at the table, not reviewed
-- into existence. Applied on scripts/local-db; rehearsed by
-- src/test/db/tripActivityLogRetention.db.test.ts.

DO $pre$
BEGIN
  IF to_regclass('public.trip_activity_log') IS NULL THEN
    RAISE EXCEPTION '2789: public.trip_activity_log does not exist (0079)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'trip_activity_log' AND column_name = 'retain_until') THEN
    RAISE EXCEPTION '2789: trip_activity_log.retain_until already exists — this file was applied, or a sibling added it';
  END IF;
END
$pre$;

ALTER TABLE public.trip_activity_log
  ADD COLUMN retain_until timestamptz NOT NULL DEFAULT now() + interval '365 days';

-- Existing rows get a year from THEIR creation, not from today: the policy is
-- the row's age, and a row written two years ago is already past it.
UPDATE public.trip_activity_log SET retain_until = created_at + interval '365 days';

ALTER TABLE public.trip_activity_log
  ADD CONSTRAINT trip_activity_log_retention_after_create CHECK (retain_until >= created_at);

ALTER TABLE public.trip_activity_log
  ADD CONSTRAINT trip_activity_log_metadata_minimised
  CHECK (NOT (metadata ? 'lat' OR metadata ? 'lng' OR metadata ? 'latitude' OR metadata ? 'longitude'))
  NOT VALID;

CREATE INDEX IF NOT EXISTS idx_trip_activity_log_retain ON public.trip_activity_log (retain_until);

COMMENT ON COLUMN public.trip_activity_log.retain_until IS
  'Trips spec §5.3: the retention policy as a column — a year from created_at by default; trip_activity_log_prune() deletes past it. Closeout evidence is preserved PER POLICY (§20.2), not by default.';
COMMENT ON CONSTRAINT trip_activity_log_metadata_minimised ON public.trip_activity_log IS
  'Trips spec §5.3 minimised payloads: no coordinate key in metadata. NOT VALID on purpose — binds new rows; legacy rows are counted by 2789''s postcondition and validated by the owner.';

CREATE OR REPLACE FUNCTION public.trip_activity_log_prune()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE n bigint;
BEGIN
  DELETE FROM public.trip_activity_log WHERE retain_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'pruned', n, 'at', now());
END;
$fn$;
REVOKE ALL ON FUNCTION public.trip_activity_log_prune() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.trip_activity_log_prune() IS
  'Trips spec §5.3: deletes trip_activity_log rows past retain_until and reports the count. service_role only; nothing in the database schedules it.';

DO $post$
DECLARE legacy bigint; def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_activity_log' AND column_name = 'retain_until') THEN
    RAISE EXCEPTION '2789: retain_until was not added';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trip_activity_log WHERE retain_until < created_at) THEN
    RAISE EXCEPTION '2789: a row retains before it was created';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'trip_activity_log_metadata_minimised' AND conrelid = 'public.trip_activity_log'::regclass;
  IF def IS NULL OR position('lat' in def) = 0 THEN
    RAISE EXCEPTION '2789: trip_activity_log_metadata_minimised is missing or names no coordinate key';
  END IF;
  IF to_regprocedure('public.trip_activity_log_prune()') IS NULL THEN
    RAISE EXCEPTION '2789: trip_activity_log_prune() is missing';
  END IF;
  -- The legacy count, said out loud: the NOT VALID CHECK does not cover these.
  SELECT count(*) INTO legacy FROM public.trip_activity_log
   WHERE metadata ? 'lat' OR metadata ? 'lng' OR metadata ? 'latitude' OR metadata ? 'longitude';
  RAISE NOTICE '2789: % legacy trip_activity_log row(s) carry a coordinate key; VALIDATE CONSTRAINT trip_activity_log_metadata_minimised once they are 0', legacy;
END
$post$;
