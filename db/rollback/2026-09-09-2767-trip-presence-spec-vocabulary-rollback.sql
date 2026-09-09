-- Rollback for 2767_trip_presence_spec_vocabulary.sql
--
-- Restores 2763's presence_state vocabulary and drops the `source` column.
--
-- This rollback UNDOES A CORRECTION. Running it puts back a vocabulary that
-- shares no value with the spec's §10.1 and removes a column §10.1 requires;
-- the only reason to run it is to get back to 2763's exact shape, e.g. to
-- withdraw 2763 itself. Nothing else should want this.
--
-- DATA: refuses if any row exists, for 2767's reason in reverse — mapping
-- 'at_plan' back onto a five-value vocabulary that has no equivalent is a data
-- decision, not a schema one.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.trip_presence;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollback 2767: trip_presence holds % row(s). The 2763 vocabulary has no value corresponding to at_plan, getting_ready, transiting, resting or returning; mapping them back is a data decision.', n;
  END IF;
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_presence'::regclass AND attname='source' AND NOT attisdropped;
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2767: source is absent; 2767 was never applied here'; END IF;
END
$pre$;

ALTER TABLE public.trip_presence DROP CONSTRAINT trip_presence_source_known;
ALTER TABLE public.trip_presence DROP COLUMN source;
ALTER TABLE public.trip_presence DROP CONSTRAINT trip_presence_state_known;
ALTER TABLE public.trip_presence
  ADD CONSTRAINT trip_presence_state_known
  CHECK (presence_state IN ('here','nearby','en_route','away','unknown'));

DO $post$
DECLARE def text; n int;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname='trip_presence_state_known' AND conrelid='public.trip_presence'::regclass;
  IF position('en_route' in def) = 0 THEN RAISE EXCEPTION 'rollback 2767: 2763''s vocabulary did not come back: %', def; END IF;
  IF position('at_plan' in def) > 0 THEN RAISE EXCEPTION 'rollback 2767: the spec vocabulary survived: %', def; END IF;
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_presence'::regclass AND attname='source' AND NOT attisdropped;
  IF n <> 0 THEN RAISE EXCEPTION 'rollback 2767: source survived'; END IF;
  FOREACH def IN ARRAY ARRAY['trip_presence_visibility_known','trip_presence_confidence_range',
                             'trip_presence_expires_after_observed'] LOOP
    SELECT count(*) INTO n FROM pg_constraint
     WHERE conrelid='public.trip_presence'::regclass AND conname=def;
    IF n <> 1 THEN RAISE EXCEPTION 'rollback 2767: 2763 constraint % was lost', def; END IF;
  END LOOP;
END
$post$;

COMMIT;
