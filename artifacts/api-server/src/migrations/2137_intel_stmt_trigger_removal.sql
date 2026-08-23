-- 2137_intel_stmt_trigger_removal.sql
-- Remove the statement-level append-only trigger. It refuses deletes that would
-- delete nothing, and that turned out to break unrelated things.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT WENT WRONG, CONCRETELY ─────────────────────────────────────────────
-- 2130 put THREE triggers on each append-only intel table:
--
--   *_no_update_delete       BEFORE UPDATE OR DELETE  FOR EACH ROW
--   *_no_update_delete_stmt  BEFORE UPDATE OR DELETE  FOR EACH STATEMENT   <-- this one
--   *_no_truncate            BEFORE TRUNCATE          FOR EACH STATEMENT
--
-- A statement-level BEFORE trigger fires when the statement STARTS. It cannot
-- know how many rows the statement will touch, so it fires even when the answer
-- is zero. On a schema where profiles cascades from auth.users, deleting any
-- user cascades into intel_observations — and the statement trigger refuses,
-- whether or not that user ever recorded an observation.
--
-- This was not theoretical. Applying 2130 to portava-ci broke the live-DB RLS
-- suite, which had passed for weeks:
--
--     purgeFixtures: delete profiles: intel_observations is append-only:
--     DELETE is not permitted at statement level.
--
-- Its fixture teardown deletes profiles rows. The teardown failed, the fixture
-- users survived, and the next run's setup then failed with "A user with this
-- email address has already been registered" — so a security suite went red for
-- a reason that had nothing to do with security.
--
-- ── WHY REMOVING IT LOSES NOTHING ───────────────────────────────────────────
-- The row-level trigger already refuses UPDATE and DELETE on every actual row
-- unless the transaction has declared `portava.erasure_in_progress`. It fires
-- once per row, which means it fires exactly when there is something to protect
-- and stays quiet when there is not. Append-only is enforced by that trigger;
-- the statement-level one added no case the row-level one misses.
--
-- TRUNCATE is different and keeps its guard: TRUNCATE fires no row-level
-- triggers at all, so *_no_truncate is the only thing standing between an
-- append-only table and `TRUNCATE intel_observations`. It is untouched here.
--
-- ── THE GENERAL LESSON, WRITTEN DOWN ────────────────────────────────────────
-- A guard that cannot distinguish "nothing to protect" from "attack in progress"
-- will eventually refuse legitimate work, and the refusal will surface somewhere
-- that looks unrelated. That is what happened: the failure appeared in an RLS
-- test about anonymous profile reads, three subsystems away from the trigger
-- that caused it.
--
-- RUNTIME EFFECT: none for any real write path. No code updates or deletes these
-- tables outside erase_intel_for_actor(), which sets the erasure declaration and
-- is unaffected either way.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2130_intel_storage.sql first.';
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_observations','intel_evidence','intel_confirmations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_update_delete_stmt', t);
  END LOOP;
END $$;

-- The function itself is dropped too: with the trigger gone it has no caller,
-- and leaving an unused SECURITY-adjacent function behind is how the anon-
-- executable backlog formed in the first place.
DROP FUNCTION IF EXISTS public.intel_append_only_stmt();

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  stmt_triggers int;
  row_triggers int;
  truncate_triggers int;
BEGIN
  -- Scoped to the intel tables. An unscoped LIKE also matches guards other
  -- tables carry (saved_places has its own TRUNCATE guard from 0074), which
  -- would make these assertions count unrelated triggers and fail for the wrong
  -- reason. The first run of this migration did exactly that.
  SELECT count(*) INTO stmt_triggers
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE NOT tg.tgisinternal
     AND c.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND tg.tgname LIKE '%\_no\_update\_delete\_stmt';
  IF stmt_triggers <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % statement-level trigger(s) remain', stmt_triggers;
  END IF;

  -- The protection that matters must still be there. Removing the wrong guard
  -- is only an improvement if the right one survives.
  SELECT count(*) INTO row_triggers
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE NOT tg.tgisinternal
     AND c.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND tg.tgname LIKE '%\_no\_update\_delete';
  IF row_triggers <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 3 row-level append-only triggers, found %', row_triggers;
  END IF;

  SELECT count(*) INTO truncate_triggers
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE NOT tg.tgisinternal
     AND c.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND tg.tgname LIKE '%\_no\_truncate';
  IF truncate_triggers <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 3 TRUNCATE guards, found %', truncate_triggers;
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL — do not, without first solving the zero-row cascade problem.
-- ═══════════════════════════════════════════════════════════════════════════
-- Recreating the statement-level trigger reintroduces the fault above.
