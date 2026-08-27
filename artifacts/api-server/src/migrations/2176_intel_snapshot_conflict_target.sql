-- 2176_intel_snapshot_conflict_target.sql
-- CRITICAL FIX: the projection writer could never persist a single snapshot.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- lib/intelProjection.ts upserts intel_state_snapshots with
--   onConflict: "subject_id,zone_id,claim_type"
-- which PostgREST renders as ON CONFLICT (subject_id, zone_id, claim_type). But
-- the table's only matching unique index (2130) is on the EXPRESSION
-- (subject_id, COALESCE(zone_id,''), claim_type). Postgres arbiter inference
-- requires the conflict target to structurally match an index; a bare column
-- reference never matches a coalesce() expression, and PostgREST cannot name an
-- expression in on_conflict at all. So every upsert raised SQLSTATE 42P10, the
-- writer swallowed it as `skipped`, and intel_state_snapshots stayed empty —
-- the entire live-intelligence read path had nothing to serve. Reproduced
-- directly against the database (42P10) before writing this.
--
-- FIX: make zone_id a NOT NULL text defaulting to '' (which is exactly what the
-- expression index already normalised NULL to) and replace the expression index
-- with a plain-column unique index, so the PostgREST bare-column conflict target
-- becomes valid. The paired code change writes '' instead of NULL for a
-- zone-less snapshot. The table is currently empty (the writer never worked), so
-- the NULL backfill is a no-op in practice but is written to be correct anyway.

BEGIN;

-- Normalise any existing NULLs (none expected — the writer never persisted).
UPDATE public.intel_state_snapshots SET zone_id = '' WHERE zone_id IS NULL;

ALTER TABLE public.intel_state_snapshots ALTER COLUMN zone_id SET DEFAULT '';
ALTER TABLE public.intel_state_snapshots ALTER COLUMN zone_id SET NOT NULL;

-- Swap the expression index for a plain-column one PostgREST can target.
DROP INDEX IF EXISTS public.intel_state_snapshots_subject_claim;
CREATE UNIQUE INDEX IF NOT EXISTS intel_state_snapshots_subject_claim
  ON public.intel_state_snapshots (subject_id, zone_id, claim_type);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='intel_state_snapshots'
               AND column_name='zone_id' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: zone_id still nullable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND indexname='intel_state_snapshots_subject_claim'
      AND indexdef LIKE '%(subject_id, zone_id, claim_type)%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: plain-column unique index not present';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP INDEX IF EXISTS public.intel_state_snapshots_subject_claim;
--   CREATE UNIQUE INDEX intel_state_snapshots_subject_claim
--     ON public.intel_state_snapshots (subject_id, coalesce(zone_id,''), claim_type);
--   ALTER TABLE public.intel_state_snapshots ALTER COLUMN zone_id DROP NOT NULL;
--   ALTER TABLE public.intel_state_snapshots ALTER COLUMN zone_id DROP DEFAULT;
-- (Only reverse alongside reverting the intelProjection.ts zone_id '' change.)
