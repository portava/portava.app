-- 2102_plan_checkins_attendance_fk_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q2 (column shape — information_schema.columns), Q6 (constraints,
--             incl. convalidated)
--
-- Q2 must confirm, for plan_checkins and plan_attendance_events, which of the
-- FK columns below actually exist live and which are NOT NULL. If BOTH
-- `geofence_id` and `plan_geofence_id` are live and NOT NULL on the same
-- table, every INSERT that doesn't populate both currently fails — this is
-- one of the packet's three candidate open live defects (§3.4.3), not
-- merely drift, and this file is the fix if Q2 confirms it.
--
-- A NOTE ON SCOPE, BEFORE THE ROLLBACK NOTE: the packet is internally
-- inconsistent about this migration's scope and I have not resolved that
-- inconsistency unilaterally — see "SCOPE DISCREPANCY" below. Flag for
-- owner review.
--
-- ROLLBACK: derivable, unlike the policy-touching migrations. Backfill and
-- DROP NOT NULL are both reversible (§8 item 9c): re-running
-- `SET NOT NULL` restores the constraint (guarded below by a check that no
-- NULL was written in the interim — if one was, the relax was load-bearing
-- and should not be rolled back), and the backfill UPDATE is idempotent.
-- No column is dropped.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §3.4(3), §4.3 (MERGED_LIVE_SHAPE), §7 row 2102.
--
-- All three trees share ONE source file, 0039_plan_geofence_full.sql, and
-- each defines a differently-named FK column on plan_checkins AND on
-- plan_attendance_events, all NOT NULL:
--
--   plan_checkins            plan_attendance_events
--   canonical  plan_item_id  REFERENCES trip_plan_items(id)   -- 0039:23 / 0039:43
--   legacy     geofence_id   REFERENCES plan_geofences(id)     -- 0039:76 / 0039:122
--   root       plan_geofence_id REFERENCES plan_geofences(id)  -- 0039:34 / 0039:63
--
-- `details` vs `metadata` (plan_attendance_events only — plan_checkins has
-- neither column in any tree): canonical is ALREADY reconciled here —
-- 0164_write_path_drift_columns_2.sql:37-38 added `metadata jsonb`
-- (nullable) to plan_attendance_events unconditionally. Root's `details`
-- (also nullable jsonb) was never adopted or backfilled by that file. This
-- migration finishes that job: if `details` is live, backfill it into
-- `metadata` wherever `metadata` is still NULL. Legacy's `metadata NOT NULL
-- DEFAULT '{}'` is a third, already-populated shape this backfill is
-- compatible with (it will simply find nothing to backfill there, since
-- `metadata` won't be NULL).
--
-- SCOPE DISCREPANCY (flagging, not resolving)
-- ============================================
-- §4.3's manifest sample row lists this as a canonical `plan_item_id` vs
-- {legacy `geofence_id`, root `plan_geofence_id`} three-way conflict. §7's
-- own migration description, verbatim, only says "designate `geofence_id`
-- canonical, backfill from `plan_geofence_id`" — it does not mention
-- `plan_item_id` or `trip_plan_items` at all. Those are two different
-- documents inside the same packet describing different scopes for the same
-- corrective ID.
--
-- I have NOT invented a resolution for that gap. `plan_item_id` references
-- `trip_plan_items` — a plan item — while `geofence_id`/`plan_geofence_id`
-- reference `plan_geofences` — a geofence. These are not obviously the same
-- relationship wearing two names (unlike, say, geofence_id vs
-- plan_geofence_id, which plainly are); collapsing a plan-item reference
-- into a geofence reference would be a real schema decision, not a rename,
-- and the packet does not make that decision anywhere. This migration
-- therefore ONLY converges `geofence_id` vs `plan_geofence_id` — the pair
-- §7 explicitly names — and leaves `plan_item_id` untouched. If `plan_item_id`
-- also needs reconciling against the geofence columns, that is a follow-up
-- requiring an owner decision this packet does not supply.
--
-- INTENDED FINAL STATE
-- =====================
-- `geofence_id` is the canonical FK on both tables (matches §7's explicit
-- text). `plan_geofence_id`, if live, is backfilled from `geofence_id` where
-- null, has its NOT NULL dropped, and is commented deprecated. `metadata` on
-- plan_attendance_events is backfilled from `details` where null. No column
-- is dropped. `plan_item_id` is not touched.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.plan_checkins') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.plan_checkins does not exist live.';
  END IF;
  IF to_regclass('public.plan_attendance_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.plan_attendance_events does not exist live.';
  END IF;

  -- At least one of the two geofence-referencing names must exist on each
  -- table, or this migration has nothing to converge and should not run.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_checkins'
      AND column_name IN ('geofence_id', 'plan_geofence_id')
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: neither geofence_id nor plan_geofence_id exists on plan_checkins live. Re-derive this migration from Q2 before proceeding — the live shape does not match any tree this file was authored against.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_attendance_events'
      AND column_name IN ('geofence_id', 'plan_geofence_id')
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: neither geofence_id nor plan_geofence_id exists on plan_attendance_events live.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────

-- plan_checkins: geofence_id canonical, backfilled from plan_geofence_id.
ALTER TABLE public.plan_checkins
  ADD COLUMN IF NOT EXISTS geofence_id uuid REFERENCES public.plan_geofences(id) ON DELETE CASCADE;

UPDATE public.plan_checkins
   SET geofence_id = plan_geofence_id
 WHERE geofence_id IS NULL
   AND plan_geofence_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_checkins' AND column_name = 'plan_geofence_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.plan_checkins ALTER COLUMN plan_geofence_id DROP NOT NULL';
    COMMENT ON COLUMN public.plan_checkins.plan_geofence_id IS
      'Deprecated 2102 — superseded by geofence_id. Root-tree name for the same relationship (both reference plan_geofences). Not dropped: backfill direction is geofence_id <- plan_geofence_id, so this column stays live and readable until a separate reviewed DROP COLUMN.';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_checkins' AND column_name = 'geofence_id' AND is_nullable = 'NO'
  ) IS FALSE THEN
    NULL; -- geofence_id remains whatever nullability it already had; this migration does not tighten it.
  END IF;
END $$;

-- plan_attendance_events: same convergence, plus the metadata/details backfill.
ALTER TABLE public.plan_attendance_events
  ADD COLUMN IF NOT EXISTS geofence_id uuid REFERENCES public.plan_geofences(id) ON DELETE CASCADE;

UPDATE public.plan_attendance_events
   SET geofence_id = plan_geofence_id
 WHERE geofence_id IS NULL
   AND plan_geofence_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_attendance_events' AND column_name = 'plan_geofence_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.plan_attendance_events ALTER COLUMN plan_geofence_id DROP NOT NULL';
    COMMENT ON COLUMN public.plan_attendance_events.plan_geofence_id IS
      'Deprecated 2102 — superseded by geofence_id. Not dropped.';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_attendance_events' AND column_name = 'details'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_attendance_events' AND column_name = 'metadata'
  ) THEN
    EXECUTE 'UPDATE public.plan_attendance_events SET metadata = details WHERE metadata IS NULL AND details IS NOT NULL';
    EXECUTE $c$COMMENT ON COLUMN public.plan_attendance_events.details IS 'Deprecated 2102 — superseded by metadata (root-tree name; canonical converged on metadata via 0164). Not dropped.'$c$;
  END IF;
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  orphaned_checkins int;
  orphaned_attendance int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_checkins' AND column_name = 'geofence_id'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: plan_checkins.geofence_id does not exist after this migration ran.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_attendance_events' AND column_name = 'geofence_id'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: plan_attendance_events.geofence_id does not exist after this migration ran.';
  END IF;

  SELECT count(*) INTO orphaned_checkins FROM public.plan_checkins WHERE geofence_id IS NULL;
  SELECT count(*) INTO orphaned_attendance FROM public.plan_attendance_events WHERE geofence_id IS NULL;
  IF orphaned_checkins > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % plan_checkins rows have no geofence_id after backfill — the backfill source column may hold values the FK cannot satisfy (orphaned plan_geofence_id).', orphaned_checkins;
  END IF;
  IF orphaned_attendance > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % plan_attendance_events rows have no geofence_id after backfill.', orphaned_attendance;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.plan_checkins ALTER COLUMN plan_geofence_id SET NOT NULL;
-- ALTER TABLE public.plan_attendance_events ALTER COLUMN plan_geofence_id SET NOT NULL;
-- -- Before restoring NOT NULL, run this — a non-zero count means the relax
-- -- was load-bearing (something inserted using only geofence_id since this
-- -- migration ran) and restoring NOT NULL would break writes, not restore
-- -- safety:
-- --   SELECT count(*) FROM public.plan_checkins WHERE plan_geofence_id IS NULL;
-- --   SELECT count(*) FROM public.plan_attendance_events WHERE plan_geofence_id IS NULL;
-- -- The geofence_id column and the metadata backfill are additive and are
-- -- not part of this rollback — no data is lost by leaving them in place.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT count(*) FILTER (WHERE geofence_id IS NULL) AS orphaned
--   FROM public.plan_checkins;                          -- expect 0
-- SELECT count(*) FILTER (WHERE geofence_id IS NULL) AS orphaned
--   FROM public.plan_attendance_events;                  -- expect 0
-- SELECT is_nullable FROM information_schema.columns
--  WHERE table_name = 'plan_checkins' AND column_name = 'plan_geofence_id'; -- expect YES, if the column exists at all
