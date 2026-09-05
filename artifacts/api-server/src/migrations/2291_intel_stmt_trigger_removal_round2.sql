-- 2291_intel_stmt_trigger_removal_round2.sql
-- Remove the statement-level append-only triggers 2276/2277/2279 reintroduced.
-- This is 2137, applied a second time, to three tables that did not exist when
-- 2137 was written.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── THE SAME BUG, THE SECOND TIME ───────────────────────────────────────────
-- 2130 attached three guards to each append-only intel table:
--
--   *_no_update_delete       BEFORE UPDATE OR DELETE  FOR EACH ROW
--   *_no_update_delete_stmt  BEFORE UPDATE OR DELETE  FOR EACH STATEMENT   <-- this one
--   *_no_truncate            BEFORE TRUNCATE          FOR EACH STATEMENT
--
-- 2137 removed the middle one from intel_observations, intel_evidence and
-- intel_confirmations, and wrote down exactly why: a statement-level BEFORE
-- trigger fires when the statement STARTS, so it cannot know the statement will
-- touch zero rows. Deleting an auth user cascades
--
--     auth.users -> public.profiles -> public.intel_observations
--                -> public.intel_presence_verifications
--
-- and the trigger refuses the cascade whether or not the user ever recorded an
-- observation. 2137's closing line was "REVERSAL — do not, without first solving
-- the zero-row cascade problem."
--
-- Three later migrations copied 2130's trigger block onto new tables:
--
--   2276  intel_presence_verifications  ("Append-only, exactly as 2130 attached")
--   2277  intel_attributions
--   2279  intel_historical_patterns
--
-- and reproduced the fault exactly. On 2026-09-05 the
-- `live DB · RLS + role/is_official write boundaries` job was red on main with:
--
--     Error: createUser(attacker): A user with this email address has already
--            been registered
--     profile-verification-boundary: tests=8 pass=0 fail=0 skipped=0 exit=1
--
-- Every fixture teardown in the live-DB suites deletes a profiles row or an auth
-- user. Every one of them had been refused since these migrations were applied,
-- with:
--
--     intel_presence_verifications is append-only: DELETE is not permitted at
--     statement level.
--
-- 56 fixture auth users had accumulated in the CI project across 22 suites, and
-- the suite whose emails collided first went red — reporting `pass=0 fail=0`,
-- i.e. eight RLS write-boundary assertions that had stopped executing entirely.
--
-- ── WHY REMOVING IT LOSES NOTHING (unchanged from 2137) ─────────────────────
-- The row-level trigger already refuses UPDATE and DELETE on every actual row
-- unless the transaction has declared `portava.erasure_in_progress`. It fires
-- once per row: exactly when there is something to protect, and never when
-- there is not. The statement-level trigger adds no case the row-level one
-- misses. TRUNCATE fires no row-level triggers at all, so *_no_truncate stays.
--
-- ── WHAT THIS DOES *NOT* DO, AND WHY ────────────────────────────────────────
-- 2137 also dropped public.intel_append_only_stmt() itself. That turned out to
-- be a landmine: 2276 and 2277 both PRECONDITION on that function existing, so
-- a clean apply of the whole corpus in order would fail at 2276. The function
-- is therefore LEFT IN PLACE here, unattached and unused.
--
-- Leaving a function that must never be attached is only safe if something says
-- so. src/test/appendOnlyStatementTriggers.test.ts is that something: it reads
-- every migration file and fails if any of them attaches
-- intel_append_only_stmt() as a DELETE trigger. A comment would have been the
-- third copy of advice that was already written down twice.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_presence_verifications') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2276_intel_presence_verification.sql first.';
  END IF;
  IF to_regclass('public.intel_attributions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2277_intel_outcomes_attribution.sql first.';
  END IF;
  IF to_regclass('public.intel_historical_patterns') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2279_intel_historical_patterns.sql first.';
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'intel_presence_verifications',
    'intel_attributions',
    'intel_historical_patterns'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_update_delete_stmt', t);
  END LOOP;
END $$;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  tables text[] := ARRAY['intel_presence_verifications','intel_attributions','intel_historical_patterns'];
  stmt_triggers int;
  row_triggers int;
  truncate_triggers int;
BEGIN
  -- Scoped to these three tables. 2137 learned this the hard way: an unscoped
  -- LIKE also matches guards other tables carry, so the assertions counted
  -- unrelated triggers and failed for the wrong reason.
  SELECT count(*) INTO stmt_triggers
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE NOT tg.tgisinternal
     AND c.relname = ANY(tables)
     AND tg.tgname LIKE '%\_no\_update\_delete\_stmt';
  IF stmt_triggers <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % statement-level trigger(s) remain', stmt_triggers;
  END IF;

  -- The protection that matters must still be there. Removing the wrong guard
  -- is only an improvement if the right one survives.
  SELECT count(*) INTO row_triggers
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE NOT tg.tgisinternal
     AND c.relname = ANY(tables)
     AND tg.tgname LIKE '%\_no\_update\_delete';
  IF row_triggers <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 3 row-level append-only triggers, found %', row_triggers;
  END IF;

  SELECT count(*) INTO truncate_triggers
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE NOT tg.tgisinternal
     AND c.relname = ANY(tables)
     AND tg.tgname LIKE '%\_no\_truncate';
  IF truncate_triggers <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 3 TRUNCATE guards, found %', truncate_triggers;
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL — do not. This is the second removal of the same trigger for the
-- same reason. Re-attaching it breaks every account deletion that cascades
-- through profiles, including the app's own erasure path when it does not hold
-- the erasure declaration, and it does so silently: supabase-js returns the
-- refusal in `{ error }`, and callers that ignore it see a successful delete.
-- ═══════════════════════════════════════════════════════════════════════════
