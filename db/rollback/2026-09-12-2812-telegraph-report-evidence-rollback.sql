-- Rollback for src/migrations/2812_telegraph_report_evidence.sql
-- Telegraph §22 — restricted moderation storage for reported content.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- Every row in public.telegraph_report_evidence, and this is the one rollback
-- in the Telegraph lane whose loss is NOT recomputable in principle. The whole
-- purpose of the table is to hold content that no longer exists anywhere else:
-- a message reported and then deleted has had `messages.body` blanked in place
-- (routes/groupChat.ts), so the snapshot IS the content. Dropping this table
-- destroys evidence attached to open reports.
--
-- CHECK BEFORE RUNNING — and check the report state, not just the row count:
--
--     SELECT e.capture_status, r.status, count(*)
--       FROM public.telegraph_report_evidence e
--       JOIN public.reports r ON r.id = e.report_id
--      GROUP BY 1, 2 ORDER BY 3 DESC;
--
-- Any row joined to a report that is not resolved is evidence for a decision
-- somebody still has to make.
--
-- THERE IS A FLAG, AND IT IS ALMOST CERTAINLY WHAT YOU WANT INSTEAD:
--
--     UPDATE public.feature_flags
--        SET enabled = false
--      WHERE flag = 'telegraph_report_evidence_enabled';
--
-- That stops new snapshots immediately and keeps the ones already taken. Use
-- this file only when the intent is to remove the retained content itself —
-- for example because a retention decision went the other way — and in that
-- case the deletion is the point rather than a side effect.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT TOUCH
-- ══════════════════════════════════════════════════════════════════════════════
-- public.reports is untouched: reports survive, they simply lose their
-- attached content. The flag row is left in place so that re-applying 2812
-- finds it already seeded FALSE rather than resurrecting a capability whose
-- state an operator had already chosen.

BEGIN;

DROP INDEX IF EXISTS public.idx_tg_report_evidence_target;
DROP INDEX IF EXISTS public.idx_tg_report_evidence_report;

DROP TABLE IF EXISTS public.telegraph_report_evidence;

-- Postcondition: the table is gone, and reports is not.
DO $$
BEGIN
  IF to_regclass('public.telegraph_report_evidence') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: telegraph_report_evidence still exists.';
  END IF;
  IF to_regclass('public.reports') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.reports was removed — this rollback must not touch it.';
  END IF;
END $$;

COMMIT;
