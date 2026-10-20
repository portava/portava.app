-- 3896_layover_certified_computations_immutable.sql
--
-- Layover spec §4 implementation rule: "Use normalized operational tables plus immutable/versioned snapshots"
-- (census-layover L20; also L5's "versioned, explainable and replayable" and L95/L261's "immutable snapshot").
-- Layover 165 program, lane B2-RECS-A. POST-CUTOVER CANONICAL FORWARD MIGRATION (gap number 3896).
--
-- APPLIED TO NO DATABASE by the lane that wrote it. Additive: one trigger function and one trigger. No table, column,
-- row, policy, grant or flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT (measured on the real chain by lane B1-P, handback §2 L20 / §4 M1)
-- ══════════════════════════════════════════════════════════════════════════════
-- 2992 made the snapshot-scoped CHILD rows immutable — layover_time_budgets, layover_return_plans and
-- layover_constraints each carry a BEFORE UPDATE trigger that raises — and its own header (lines 103-114) gives the
-- reason in as many words: the service role bypasses RLS, so "immutability that only holds for callers who were never
-- able to write anyway is not immutability; it is a description of the grant table". The PARENT, the certified
-- computation itself (2700's layover_certified_computations: the verdict, the deadline, the usable window, the inputs
-- the replay feeds back), was left without one. A service-role UPDATE of a stored decision succeeded on the pressed
-- chain (src/test/db/layoverPressedSnapshot.db.test.ts S6 did exactly that to prove the replay notices) and only a
-- later replay could tell. The decision a traveller was told is the one row that must never be rewritten.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX
-- ══════════════════════════════════════════════════════════════════════════════
-- public.layover_certified_computations_are_immutable(), SECURITY INVOKER with an empty search_path (it resolves no
-- name), raises for every UPDATE of every row, whoever issues it — the service role included. Trigger
-- layover_certified_computations_immutable runs it BEFORE UPDATE FOR EACH ROW.
--
-- DELETE IS NOT BLOCKED, deliberately and for 2992's reason: bounded retention / compaction (L261,
-- services/layover/LayoverDecisionService.ts's compaction) needs rows to LEAVE. UPDATE rewrites history; DELETE ends
-- it, and only the first is a lie. A superseded decision is SUPERSEDED BY WRITING A NEW ROW (3623 numbers it, 3828
-- makes it the session's active snapshot, 3873 makes that write a compare-and-swap).
--
-- NOTHING WRITES AN UPDATE TODAY, which is what makes this safe to apply (evidence, 2026-10-18):
--   * code: no `.update(` / `.upsert(` against layover_certified_computations anywhere under src/ (services, routes,
--     lib, domain, server, scripts); the only writers are LayoverDecisionStore.persistDecision (INSERT) and the
--     compaction (DELETE). src/test/layoverCertifiedComputationsImmutable.test.ts pins that by reading the source.
--   * migrations: no file UPDATEs the table; 3828's trigger on it is AFTER INSERT and writes layover_sessions.
--   * foreign keys: none of its columns references another row with ON DELETE SET NULL / SET DEFAULT (session_id is
--     ON DELETE CASCADE; user_id carries no FK), so no referential action can issue an UPDATE of it. Rows that
--     reference IT (layover_sessions.active_snapshot_id, layover_recommendations.snapshot_id) are updated by their
--     own ON DELETE SET NULL on THEIR tables, which this trigger does not see.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number: applied at 3896 on a fresh replay, after 3999 on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends only on 2700 (the table) and 2992 (its snapshot_id column, named in the refusal text), both numbered below
-- and both in the production packet's main run (steps 055 and 090), which precedes every gap file. No file numbered
-- above 3896 alters, drops, disables or adds a trigger to layover_certified_computations, or names this function
-- (grep of every file 3897-3999, 2026-10-18: the only later layover files are 3900 and 3996, which reference
-- layover_sessions by foreign key only). 3873's BEFORE INSERT trigger on the same table is independent of this
-- BEFORE UPDATE one in either order.
--
-- Rollback: db/rollback/2026-10-18-3896-layover-certified-computations-immutable-rollback.sql (drops the trigger and
-- the function; refuses unless the installed objects are exactly this file's).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3896): public.layover_certified_computations does not exist. Apply 2700 then 2992 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
                    AND column_name = 'snapshot_id') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3896): layover_certified_computations.snapshot_id does not exist (2992).';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.layover_certified_computations_are_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY INVOKER (the default, stated for check:search-path-hazard) with a pinned empty search_path: it resolves no
-- unqualified name and must not be able to.
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION
    'IMMUTABLE (3896): layover_certified_computations row % (snapshot %) may not be UPDATEd. A certified computation is the decision a traveller was told, forever (spec §4, census L20). Supersede it by writing a new computation; compact it by DELETE.',
    OLD.id, COALESCE(OLD.snapshot_id, '<no snapshot_id>')
    USING ERRCODE = '55000';
END
$fn$;
REVOKE ALL ON FUNCTION public.layover_certified_computations_are_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS layover_certified_computations_immutable ON public.layover_certified_computations;
CREATE TRIGGER layover_certified_computations_immutable
  BEFORE UPDATE ON public.layover_certified_computations
  FOR EACH ROW EXECUTE FUNCTION public.layover_certified_computations_are_immutable();

COMMIT;

-- ── Postconditions (catalog only, re-runnable standalone) ─────────────────────
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'public.layover_certified_computations'::regclass
                    AND tgname = 'layover_certified_computations_immutable' AND NOT tgisinternal AND tgenabled <> 'D'
                    AND tgtype = 19) THEN
    -- tgtype 19 = ROW (1) | BEFORE (2) | UPDATE (16)
    RAISE EXCEPTION 'POSTCONDITION FAILED (3896): the BEFORE UPDATE FOR EACH ROW trigger is missing, disabled or of another kind';
  END IF;
  IF has_function_privilege('authenticated', 'public.layover_certified_computations_are_immutable()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.layover_certified_computations_are_immutable()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3896): a client role may execute the immutability function';
  END IF;
  -- DELETE stays possible (compaction): no trigger of this file fires on DELETE.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
              WHERE tgrelid = 'public.layover_certified_computations'::regclass
                AND tgname = 'layover_certified_computations_immutable' AND (tgtype & 8) <> 0) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3896): the immutability trigger fires on DELETE; compaction (L261) must stay possible';
  END IF;
END
$post$;
