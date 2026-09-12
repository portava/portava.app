-- Rollback for 2793_trip_transport_policies.sql
--
-- Drops the policy table. Its rows are preferences, not evidence: a dropped
-- policy means "every mode allowed" again, which is the state before 2793
-- and the state the feasibility route reports when no row exists. Rehearsed
-- on the local replica: apply 2793 → this file → 2793 again.

DO $pre$
BEGIN
  IF to_regclass('public.trip_transport_policies') IS NULL THEN
    RAISE EXCEPTION '2793 rollback: trip_transport_policies is not present — 2793 is not applied';
  END IF;
END
$pre$;

DROP TABLE public.trip_transport_policies;

DO $post$
BEGIN
  IF to_regclass('public.trip_transport_policies') IS NOT NULL THEN
    RAISE EXCEPTION '2793 rollback: trip_transport_policies survived';
  END IF;
END
$post$;
