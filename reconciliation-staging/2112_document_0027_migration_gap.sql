-- 2112_document_0027_migration_gap.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q1 (relation census) — confirms the gap's content is in fact
--             live, which is what makes this comment-only file honest
--             rather than a guess.
--
-- ROLLBACK: none needed — comment-only, no schema change (§8 item 9a).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §7 row 2112. Canonical's `src/migrations/` has a
-- numbering gap at 0027 (also 0030-0031, 0038, 0040) with no corresponding
-- file and no docs entry explaining it. `docs/production-migration-runbook.md`
-- records the gap and its accepted explanation:
--
--   "Gaps 0027, 0030–0031, 0038, 0040 — Files missing from src/migrations/
--   with no docs entry. Content likely applied via migrations/ (root) or
--   artifacts/api-server/migrations/ during the early-series merge. Low —
--   applied content is in production; no code reads these absent files."
--
-- (0038 specifically is independently identified elsewhere in this packet
-- as `artifacts/api-server/migrations/0038_plan_geofences_rls_fix.sql` —
-- see 2100 — so "missing from src/migrations" means missing from canonical
-- specifically, not missing from the repository as a whole.)
--
-- This migration makes NO schema change — the packet is explicit: "No DDL.
-- Its value is that the runbook's open question stops being open." It exists
-- purely so that a reconciliation pass over canonical migration numbers has
-- a record explaining the 0027 gap rather than treating it as unexplained.
--
-- INTENDED FINAL STATE
-- =====================
-- No schema change. A durable record (this file, once reviewed and merged
-- into canonical) that the 0027 gap is accounted for.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
-- Nothing to check against a live catalog for a comment-only file. Recorded
-- here for shape-consistency with the rest of this package, per its own
-- house convention, not because this file has a live dependency.
DO $$
BEGIN
  RAISE NOTICE '2112: comment-only migration, no live precondition applies.';
END $$;

-- ── The change — none. Documentation only. ────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '2112: canonical migration-number gap 0027 (also 0030-0031, 0038, 0040) is explained by docs/production-migration-runbook.md — content applied via the root or legacy migrations/ trees during the early-series merge, no code reads the absent canonical files. No DDL in this migration.';
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS — unexpected for a comment-only migration; something else changed concurrently.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- None needed. No schema object was created, altered, or dropped.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- None applicable — this file changes nothing verifiable in the live
-- catalog. Its only effect is the explanatory record once reviewed into
-- canonical.
