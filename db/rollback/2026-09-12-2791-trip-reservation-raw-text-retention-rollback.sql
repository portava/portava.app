-- Rollback for 2791_trip_reservation_raw_text_retention.sql
--
-- Removes the retention policy from trip_reservations: the forget function
-- and the deadline column. raw_text itself is untouched — text still held is
-- still held, and text already forgotten by the policy is gone; a rollback of
-- a policy neither deletes evidence nor restores it. The history events the
-- forget recorded (2784's `updated` rows naming raw_text) stay: they are the
-- record that the text was forgotten and when. Rehearsed on the local
-- replica: apply 2791 → this file → 2791 again.

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_reservations' AND column_name = 'raw_text_retain_until') THEN
    RAISE EXCEPTION '2791 rollback: trip_reservations.raw_text_retain_until is not present — 2791 is not applied';
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.trip_reservations_forget_raw_text();
ALTER TABLE public.trip_reservations DROP COLUMN raw_text_retain_until;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'trip_reservations' AND column_name = 'raw_text_retain_until') THEN
    RAISE EXCEPTION '2791 rollback: raw_text_retain_until survived';
  END IF;
  IF to_regprocedure('public.trip_reservations_forget_raw_text()') IS NOT NULL THEN
    RAISE EXCEPTION '2791 rollback: trip_reservations_forget_raw_text() survived';
  END IF;
END
$post$;
