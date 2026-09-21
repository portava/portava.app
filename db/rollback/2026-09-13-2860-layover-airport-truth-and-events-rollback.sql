-- Rollback for artifacts/api-server/src/migrations/2860_layover_airport_truth_and_events.sql
--
-- The forward migration creates TWO tables and alters nothing that already
-- exists, so the inverse is two DROPs. That is unusually simple for a rollback
-- in this repository, and the reason is worth stating rather than leaving to be
-- inferred: 2860 was written to be droppable. It adds no column to an existing
-- table, widens no CHECK, grants nothing to a role that did not already have
-- it, and seeds no feature-flag row — the four shapes that make the other
-- layover rollbacks in this directory long.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS LOST, STATED BEFORE IT IS LOST
-- ══════════════════════════════════════════════════════════════════════════════
-- DROP TABLE destroys rows. At the time of writing both tables are guaranteed
-- empty, because 2860 lands with NO WRITER of any kind — that is recorded in
-- the forward migration's ORDERING section and is the condition under which it
-- was reviewed. The precondition block below MEASURES that rather than assuming
-- it: if either table has acquired rows, this rollback REFUSES and says how
-- many, because by then someone has built an ingest path and destroying its
-- data is a decision a human must take, not one a rollback script takes on
-- their behalf.
--
-- To roll back anyway, after deciding the rows are expendable:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c 'DROP TABLE IF EXISTS public.layover_external_events;' \
--     -c 'DROP TABLE IF EXISTS public.airport_fact_observations;'
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Neither table references the other and nothing references either, so the drop
-- order is free. They are dropped events-first only so the output reads in the
-- reverse of the order the forward file creates them.
--
-- Indexes and policies are dropped with their tables; naming them separately
-- would be a second place to keep in step with the forward file.

BEGIN;

-- ── PRECONDITION: refuse to destroy data nobody agreed to destroy ────────────
DO $$
DECLARE
  obs_rows BIGINT := 0;
  evt_rows BIGINT := 0;
BEGIN
  IF to_regclass('public.airport_fact_observations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.airport_fact_observations' INTO obs_rows;
  END IF;
  IF to_regclass('public.layover_external_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.layover_external_events' INTO evt_rows;
  END IF;
  IF obs_rows > 0 OR evt_rows > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (2860): % observation row(s) and % external event row(s) would be destroyed. 2860 shipped with no writer; if one exists now, drop these tables by hand after deciding the rows are expendable — see the header.',
      obs_rows, evt_rows;
  END IF;
END $$;

DROP TABLE IF EXISTS public.layover_external_events;
DROP TABLE IF EXISTS public.airport_fact_observations;

-- ── POSTCONDITIONS: prove the inverse is complete, not assumed ───────────────
DO $$
DECLARE
  n INTEGER;
BEGIN
  IF to_regclass('public.airport_fact_observations') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2860): airport_fact_observations survived';
  END IF;
  IF to_regclass('public.layover_external_events') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2860): layover_external_events survived';
  END IF;

  -- The indexes and policies go with the tables. Asserted because a leftover
  -- index name would collide on a re-apply, which is the failure mode a
  -- rollback rehearsal exists to find.
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relname IN ('airport_fact_obs_lookup_idx','airport_fact_obs_expiry_idx',
                       'layover_external_events_dedup_uidx','layover_external_events_pending_idx');
  IF n <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2860): % index(es) survived their table', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('airport_fact_observations','layover_external_events');
  IF n <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2860): % policy/policies survived', n;
  END IF;

  -- 2860 touched no existing object, so the rollback must not have either.
  -- layover_events keeps its own eighteen-value vocabulary and its indexes.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'layover_events'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2860): layover_events is missing -- this rollback must not touch it';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'airport_profiles'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2860): airport_profiles is missing -- this rollback must not touch it';
  END IF;
END $$;

COMMIT;
