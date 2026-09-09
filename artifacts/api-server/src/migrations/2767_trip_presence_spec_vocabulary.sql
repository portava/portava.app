-- 2767_trip_presence_spec_vocabulary.sql
--
-- Corrects `public.trip_presence` (2763) to the shape §10.1 specifies, BEFORE a
-- writer is built against the wrong one.
--
-- WHAT WAS WRONG
-- ==============
-- 2763 created the table with
--   CHECK (presence_state IN ('here','nearby','en_route','away','unknown'))
-- The spec, §10.1, reads:
--   "AVAILABLE | FREE | GETTING_READY | TRANSITING | AT_PLAN | RESTING |
--    RETURNING | OFFLINE"
-- Eight values, and not one of the five overlaps. §10.1 also says "Every
-- presence row carries observed_at, expires_at, source, confidence, and
-- visibility" — 2763 has no `source` column at all.
--
-- census-trips' own rule 2 decides what that means: "a table with a different
-- shape is not the specified table". Building SET_PRESENCE against the 2763
-- vocabulary would have made TR87 look satisfied while cementing a vocabulary
-- no consumer of the spec can read. This migration is the cheaper half of the
-- correction and it is only cheap now: measured on portava-ci 2026-09-09,
-- trip_presence holds 0 rows and has no writer, so there is nothing to migrate.
-- The precondition below refuses to run if that ever stops being true, because
-- a vocabulary swap with rows in the table is a data migration and this is not
-- one.
--
-- LOWERCASE, NOT THE SPEC'S CAPITALS. §10.1 writes the states as type names.
-- Every vocabulary CHECK in this tree stores lowercase ('planned', 'flexible',
-- 'pending'), and mixing the two conventions in one schema is worse than
-- differing from the spec's typography. The VALUES are the spec's.
--
-- `source` IS A READING OF §10.3, NOT A LIST THE SPEC ENUMERATES. §10.1 says a
-- row carries a source and does not say what a source may be; §10.3 names the
-- sensing methods — "geofences, significant location changes, navigation
-- callbacks, semantic checkpoints, and explicit user actions". Those five are
-- the CHECK below. That is an interpretation, it is written down here rather
-- than left implicit, and widening a CHECK is a one-line migration if it is
-- wrong.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2767 (Trips).

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_presence';
  IF n <> 1 THEN RAISE EXCEPTION '2767: requires 2763 (trip_presence)'; END IF;

  SELECT count(*) INTO n FROM public.trip_presence;
  IF n <> 0 THEN
    RAISE EXCEPTION '2767: trip_presence holds % row(s). Swapping the state vocabulary under existing rows is a DATA migration and this is not one; write the mapping first.', n;
  END IF;

  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_presence'::regclass AND attname='source' AND NOT attisdropped;
  IF n <> 0 THEN RAISE EXCEPTION '2767: source already exists; this migration has run'; END IF;
END
$pre$;

ALTER TABLE public.trip_presence DROP CONSTRAINT trip_presence_state_known;
ALTER TABLE public.trip_presence
  ADD CONSTRAINT trip_presence_state_known
  CHECK (presence_state IN ('available','free','getting_ready','transiting',
                            'at_plan','resting','returning','offline'));

ALTER TABLE public.trip_presence
  ADD COLUMN source text NOT NULL DEFAULT 'explicit';
ALTER TABLE public.trip_presence
  ADD CONSTRAINT trip_presence_source_known
  CHECK (source IN ('geofence','significant_change','navigation','checkpoint','explicit'));

COMMENT ON COLUMN public.trip_presence.presence_state IS
  'Trips spec §10.1, lowercased: available | free | getting_ready | transiting | at_plan | resting | returning | offline. Replaced 2763''s here/nearby/en_route/away/unknown, which shared no value with the spec.';
COMMENT ON COLUMN public.trip_presence.source IS
  'Trips spec §10.1 ("every presence row carries ... source"), vocabulary read from §10.3''s sensing methods: geofence | significant_change | navigation | checkpoint | explicit. The DEFAULT is ''explicit'' because a row whose provenance nobody recorded is a user action until something proves otherwise, and because §10.3''s whole argument is that explicit actions come BEFORE constant GPS.';

DO $post$
DECLARE def text; n int;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname='trip_presence_state_known' AND conrelid='public.trip_presence'::regclass;
  IF def IS NULL THEN RAISE EXCEPTION '2767: the state constraint is gone'; END IF;
  IF position('at_plan' in def) = 0 THEN RAISE EXCEPTION '2767: the spec vocabulary did not land: %', def; END IF;
  IF position('en_route' in def) > 0 THEN RAISE EXCEPTION '2767: the 2763 vocabulary survived: %', def; END IF;

  -- The eight §10.1 values, each checked by name. A count would pass on eight
  -- wrong strings.
  FOREACH def IN ARRAY ARRAY['available','free','getting_ready','transiting',
                             'at_plan','resting','returning','offline'] LOOP
    SELECT count(*) INTO n FROM pg_constraint
     WHERE conname='trip_presence_state_known' AND conrelid='public.trip_presence'::regclass
       AND position('''' || def || '''' in pg_get_constraintdef(oid)) > 0;
    IF n <> 1 THEN RAISE EXCEPTION '2767: presence state % is not accepted', def; END IF;
  END LOOP;

  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_presence'::regclass AND attname='source'
     AND attnotnull AND NOT attisdropped;
  IF n <> 1 THEN RAISE EXCEPTION '2767: source is missing or nullable'; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='public.trip_presence'::regclass AND conname='trip_presence_source_known';
  IF n <> 1 THEN RAISE EXCEPTION '2767: the source vocabulary is unconstrained'; END IF;

  -- 2763's other guarantees must be untouched.
  FOREACH def IN ARRAY ARRAY['trip_presence_visibility_known','trip_presence_confidence_range',
                             'trip_presence_expires_after_observed'] LOOP
    SELECT count(*) INTO n FROM pg_constraint
     WHERE conrelid='public.trip_presence'::regclass AND conname=def;
    IF n <> 1 THEN RAISE EXCEPTION '2767: 2763 constraint % was lost', def; END IF;
  END LOOP;
END
$post$;

COMMIT;
