-- Rollback for 3486_trail_moderation_audit.sql (census-discovery §86, lane W10-T).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- REFUSES while the audit or review tables hold any row: those are records of
-- admin actions (`11` §10), and dropping them is a retention decision, not a
-- rollback. REFUSES while a Trail carries merged_into_trail_id or a trail_edges row
-- is not 'accepted' (dropping the column would make a pending or rejected
-- relation navigable). Otherwise drops the five functions, the stamp trigger, the
-- two tables and the four columns, and 3486's ledger row. Merged Trails stay
-- archived; members moved by a merge stay where they are.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.discovery_admin_audit_events') IS NOT NULL AND EXISTS (SELECT 1 FROM public.discovery_admin_audit_events) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3486): discovery_admin_audit_events holds admin action records.';
  END IF;
  IF to_regclass('public.trend_integrity_reviews') IS NOT NULL AND EXISTS (SELECT 1 FROM public.trend_integrity_reviews) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3486): trend_integrity_reviews holds review records.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trail_edges' AND column_name = 'review_state')
     AND EXISTS (SELECT 1 FROM public.trail_edges WHERE review_state <> 'accepted') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3486): a pending or rejected relation would become navigable. Delete those edges first.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.trail_admin_curate(uuid, text, uuid, text, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.trend_integrity_review_record(text, text, text, jsonb, uuid, text, text);
DROP FUNCTION IF EXISTS public.trail_admin_review_edge(uuid, uuid, text, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.trail_admin_merge(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.trail_admin_move_lifecycle(uuid, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.discovery_admin_replay(text, text, text, jsonb);
DROP TABLE IF EXISTS public.trend_integrity_reviews;
DROP TABLE IF EXISTS public.discovery_admin_audit_events;
DROP FUNCTION IF EXISTS public.discovery_admin_audit_append_only();
DROP TRIGGER IF EXISTS content_trails_state_stamp_trg ON public.content_trails;
DROP FUNCTION IF EXISTS public.content_trails_state_stamp();
ALTER TABLE public.trail_edges DROP CONSTRAINT IF EXISTS trail_edges_review_state_known;
ALTER TABLE public.trail_edges DROP COLUMN IF EXISTS review_state;
ALTER TABLE public.trail_edges DROP COLUMN IF EXISTS declared_by;
ALTER TABLE public.content_trails DROP COLUMN IF EXISTS content_state_changed_at;
ALTER TABLE public.trails DROP CONSTRAINT IF EXISTS trails_merged_is_archived;
ALTER TABLE public.trails DROP CONSTRAINT IF EXISTS trails_not_merged_into_self;
ALTER TABLE public.trails DROP COLUMN IF EXISTS merged_into_trail_id;

DELETE FROM public.schema_migration_ledger WHERE filename = '3486_trail_moderation_audit.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.trail_admin_merge(uuid,uuid,uuid,text,text)') IS NOT NULL OR to_regclass('public.discovery_admin_audit_events') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3486 rollback): an object survived.';
  END IF;
END $post$;
