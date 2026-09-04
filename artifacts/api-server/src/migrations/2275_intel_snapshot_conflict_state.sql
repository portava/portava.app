-- 2275_intel_snapshot_conflict_state.sql
-- IG unit I2 — persist the §10 material-conflict state on live-state snapshots.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS ADDS. intel_state_snapshots.conflict_state — the spec's Table 17
-- snapshot field ("conflict_state | none, contextualized, material"). Written
-- by lib/intelProjection.projectAndStore from the aggregator's §10 assessment
-- (lib/intelConflict); read by lib/liveClaimRead, which suppresses the strong
-- Live label and serves a "Reports differ" conflict block when it is
-- 'material'. Code writes 'none' | 'minor' | 'material' ('minor' is the
-- spec's 'contextualized'; the reader accepts either spelling).
--
-- IDEMPOTENT IN EITHER ORDER WITH 2273. Unit I1's migration 2273 adds this
-- same column with ADD COLUMN IF NOT EXISTS. Whichever of the two runs first
-- creates it; the other is a no-op on the ADD. Everything else here is
-- re-runnable: SET DEFAULT is idempotent, the backfill only touches NULLs, and
-- the column is deliberately left NULLABLE and UNCONSTRAINED so that neither
-- migration's writer can be broken by the other's shape — the reader
-- (normalizeConflictState) treats NULL/'' as 'none' and any unrecognised
-- non-empty value as 'material' (fail-closed for the Live label). No CHECK is
-- added for the same reason: two differently-named CHECKs from two migrations
-- would both apply and could disagree on the vocabulary.
--
-- ADDITIVE + BACKWARDS-COMPATIBLE. Every existing row reads 'none' after the
-- backfill; the upsert writer sends the column explicitly, and a writer that
-- omits it gets the default. No RLS or grant changes: intel_state_snapshots is
-- deny-default with service_role-only writes (2130) and that is unchanged —
-- no client role gains a privilege here. No feature flag is seeded or changed.
--
-- RUNTIME EFFECT: NONE on its own. Whether a snapshot serves at all is still
-- decided by privacy_eligible, expires_at, the flag chain and per-scope
-- promotion; this column can only make a served label STRICTER.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_state_snapshots') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_state_snapshots does not exist. Apply 2130 first.';
  END IF;
END $$;

ALTER TABLE public.intel_state_snapshots
  ADD COLUMN IF NOT EXISTS conflict_state text;

ALTER TABLE public.intel_state_snapshots
  ALTER COLUMN conflict_state SET DEFAULT 'none';

-- Pre-existing rows (and rows 2273 may have created before this ran) read as
-- 'none' — the honest value for a snapshot no conflict assessment has touched.
UPDATE public.intel_state_snapshots
   SET conflict_state = 'none'
 WHERE conflict_state IS NULL;

COMMENT ON COLUMN public.intel_state_snapshots.conflict_state IS
  'IG §10 material-conflict state of the projected cohort: none | minor (spec: contextualized) | material. Written by lib/intelProjection from lib/intelConflict; material suppresses the strong Live label and serves a "Reports differ" block (lib/liveClaimRead). NULL reads as none.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'intel_state_snapshots'
       AND column_name = 'conflict_state'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_state_snapshots.conflict_state not present';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.intel_state_snapshots WHERE conflict_state IS NULL
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_state_snapshots.conflict_state still NULL on some rows';
  END IF;
END $$;

COMMIT;

-- REVERSAL (only alongside reverting the intelProjection / liveClaimRead reads):
--   ALTER TABLE public.intel_state_snapshots DROP COLUMN IF EXISTS conflict_state;
