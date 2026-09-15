-- Rollback for 2745_layover_recommendation_travel_provenance.sql
-- Written 2026-09-15. NOT APPLIED ANYWHERE.
--
-- WHAT IT UNDOES. One nullable column, `layover_recommendations.travel_time_source`,
-- and the CHECK that constrains its vocabulary. 2745 wrote no row, seeded no
-- flag and altered nothing that existed, so there is nothing else to put back.
--
-- ⚠ THIS ROLLBACK DESTROYS EVERY RECORDED PROVENANCE, AND THAT IS THE POINT
-- OF IT. Dropping the column does not return the rows to some earlier truth: it
-- returns the READ PATH to answering from the row's own facts, which is where
-- it was before 2745. A row whose column said 'measured' will, afterwards, read
-- as `unknown_provenance` — an honest answer, and a LOSS of one. Nothing will
-- read as a measurement that was not measured, which is the property worth
-- preserving across the rollback.
--
-- SAFE TO RUN ONLY WHILE NO WRITER POPULATES THE COLUMN. On this tree that is
-- still true: `LAYOVER_TRAVEL_TIME_PROVIDER` is `noRoutedProvider`, every
-- landside leg is `unmeasured` and every airside one is `inside_airport`, both
-- of which the row's own columns express, so `travelTimeProvenanceColumn`
-- returns `{}` and no insert carries the key. The guard below REFUSES rather
-- than trusting that reading — if any row has been labelled, a human must
-- decide what that evidence is worth before it is deleted.
--
-- Run the whole file. It is one transaction and it aborts rather than erasing.

BEGIN;

-- ── Refuse if any row carries a recorded provenance ──────────────────────────
DO $$
DECLARE
  n BIGINT := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
      AND column_name = 'travel_time_source'
  ) THEN
    RAISE NOTICE 'ROLLBACK 2745: travel_time_source is already absent -- nothing to do.';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.layover_recommendations WHERE travel_time_source IS NOT NULL'
    INTO n;

  IF n > 0 THEN
    RAISE EXCEPTION
      'REFUSING TO ROLL BACK 2745: % recommendation row(s) carry a recorded travel_time_source. '
      'Dropping the column deletes the only record of where those travel times came from, and '
      'every one of them will afterwards read as ''unknown_provenance''. Export them, or decide '
      'deliberately that the evidence is expendable, then re-run with this guard removed.', n;
  END IF;
END $$;

-- ── Drop the constraint, then the column ─────────────────────────────────────
-- Order matters only for tidiness: DROP COLUMN takes the CHECK with it. Both
-- are IF EXISTS so a partially-applied 2745 rolls back as cleanly as a whole one.
ALTER TABLE public.layover_recommendations
  DROP CONSTRAINT IF EXISTS layover_recommendations_travel_time_source_check;

ALTER TABLE public.layover_recommendations
  DROP COLUMN IF EXISTS travel_time_source;

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
      AND column_name = 'travel_time_source'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK 2745 FAILED: travel_time_source is still present';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'layover_recommendations'
      AND c.conname = 'layover_recommendations_travel_time_source_check'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK 2745 FAILED: the travel_time_source CHECK survived the column';
  END IF;

  -- The figure itself must be untouched: 2745 was additive and so is its undo.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
      AND column_name = 'travel_time_min' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK 2745 FAILED: layover_recommendations.travel_time_min was disturbed';
  END IF;
END $$;

COMMIT;
