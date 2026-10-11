-- Rollback for 3623_layover_snapshot_version_and_recommendation_snapshot.sql
--
-- NOT applied to any database at the time of writing.
-- REFUSES while layover_recommendation_snapshot_enabled is TRUE: with the flag
-- ON and the column dropped every recommendation write names snapshot_id and
-- fails. Turn it off deliberately first. Then it deletes the (FALSE) flag row
-- and 3623's schema_migration_ledger row so the applier re-applies 3623.
--
-- DATA LOSS, STATED: dropping snapshot_id loses each recommendation's citation
-- of the computation it was certified under; dropping snapshot_version loses the
-- per-session sequence numbers. No computation, budget, plan or card is deleted.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_recommendation_snapshot_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3623): layover_recommendation_snapshot_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DROP INDEX IF EXISTS public.layover_recommendations_snapshot_idx;
ALTER TABLE public.layover_recommendations DROP CONSTRAINT IF EXISTS layover_recommendations_snapshot_fk;
ALTER TABLE public.layover_recommendations DROP COLUMN IF EXISTS snapshot_id;

DROP TRIGGER IF EXISTS layover_certcomp_snapshot_version ON public.layover_certified_computations;
DROP FUNCTION IF EXISTS public.layover_certcomp_assign_snapshot_version();
DROP INDEX IF EXISTS public.layover_certcomp_session_version_uidx;
ALTER TABLE public.layover_certified_computations DROP COLUMN IF EXISTS snapshot_version;

DELETE FROM public.feature_flags WHERE flag = 'layover_recommendation_snapshot_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3623_layover_snapshot_version_and_recommendation_snapshot.sql';

COMMIT;
