-- Rollback for 3380_content_trails_label_cap_serialised.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3380 DID
-- =============
--   * Replaced public.content_trails_label_cap() (2910) with the same body plus
--     a per-content pg_advisory_xact_lock taken before the count.
--   * Created the partial UNIQUE index uq_content_trails_one_primary
--     (source_type, source_id) WHERE relationship = 'primary'.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores 2910's function body verbatim, drops the index, and deletes 3380's
-- schema_migration_ledger row so a later apply run re-applies it. Free and
-- lossless: no row is deleted. What it gives up is the concurrency guarantee:
-- two racing attachments can again land two primary Trails, or overshoot the
-- supporting / Signal budgets, for one piece of content (census-discovery
-- DC-02, §51; src/test/db/trailsConstraints.db.test.ts L1, L2 go red).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.content_trails') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3380 rollback): public.content_trails does not exist.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.content_trails_label_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE held int; cap int;
BEGIN
  cap := CASE NEW.relationship
           WHEN 'primary'    THEN 1
           WHEN 'supporting' THEN 3
           WHEN 'signal'     THEN 5
         END;
  SELECT count(*) INTO held
    FROM public.content_trails
   WHERE source_type = NEW.source_type
     AND source_id = NEW.source_id
     AND relationship = NEW.relationship
     AND id IS DISTINCT FROM NEW.id;
  IF held >= cap THEN
    RAISE EXCEPTION '02 §4: % label cap of % reached for %:%',
      NEW.relationship, cap, NEW.source_type, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.content_trails_label_cap() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.content_trails_label_cap() IS
  '02_Trails.md §4 "Do not let creators attach unlimited discovery labels": one primary Trail, three supporting, five Signals — three separate budgets per piece of content. Mirrored by MAX_PRIMARY_TRAILS / MAX_SUPPORTING_TRAILS / MAX_SIGNALS in lib/discoveryTrailObject.ts.';

DROP INDEX IF EXISTS public.uq_content_trails_one_primary;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3380_content_trails_label_cap_serialised.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF position('pg_advisory_xact_lock' IN pg_get_functiondef('public.content_trails_label_cap()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380 rollback): the function still takes the lock.';
  END IF;
  IF to_regclass('public.uq_content_trails_one_primary') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380 rollback): uq_content_trails_one_primary still exists.';
  END IF;
  -- 2910's trigger must survive: this rollback restores its function, not its absence.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.content_trails'::regclass
                    AND tgname = 'content_trails_label_cap_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380 rollback): content_trails_label_cap_trg is gone; this rollback must not touch 2910.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3380_content_trails_label_cap_serialised.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3380 rollback): the ledger still records 3380 as applied.';
  END IF;
END $post$;
