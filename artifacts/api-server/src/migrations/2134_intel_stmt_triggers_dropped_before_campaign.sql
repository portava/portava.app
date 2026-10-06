-- 2134_intel_stmt_triggers_dropped_before_campaign.sql
-- Drop 2130's three STATEMENT-level append-only triggers — and nothing else.
-- 2137's trigger removal, re-issued WITHOUT its function drop.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Written 2026-10-06
-- at the free prefix 2134 ON PURPOSE: it must sort after 2130 (which creates the
-- triggers) and before 2276 (which needs the function this file keeps).
-- Idempotent (DROP TRIGGER IF EXISTS). Changes no data.
--
-- ── WHY IT EXISTS ───────────────────────────────────────────────────────────
-- 2137_intel_stmt_trigger_removal.sql does two things in one transaction: it
-- drops the *_no_update_delete_stmt triggers 2130 put on intel_observations,
-- intel_evidence and intel_confirmations, AND it drops
-- public.intel_append_only_stmt(). Its header explains why the triggers had to
-- go (a statement trigger refuses a zero-row profiles cascade). That reasoning
-- is unchanged and this file does not revisit it.
--
-- The function drop is the problem. 2276, 2277 and 2279 require the function
-- (2276's preconditions at its lines 73-74 refuse without it) and each attaches
-- one more statement trigger that executes it; 2292 then removes those three and
-- is the file that drops the function, refusing while ANY trigger still executes
-- it. So the end state the reference database holds is reachable only if 2130's
-- three statement triggers are gone BEFORE 2292 while the function survives
-- UNTIL 2292 — and 2137, which removes both at once, cannot sit anywhere in the
-- chain to give that. Measured on the CI local-db job (ci.yml
-- api-server-local-db, postgis/postgis:16-3.4):
--
--   * 2137 before 2276 (byte order) — 2276 refuses "2130 append-only trigger
--     functions are missing"; 2277, 2278, 2279, 2292, 3002, 3003 and 3310 fail
--     after it (run 37442240254);
--   * 2137 after 2279 — "cannot drop function intel_append_only_stmt() because
--     other objects depend on it" (run 37445105786);
--   * 2137 after 2292 — 2292's postcondition refuses: 2130's three statement
--     triggers still execute the function (follows from 2292's own body).
--
-- This file is the trigger half of 2137 at a position where it is correct;
-- ORDER_OVERRIDES.json then declares 2137 SKIPPED (never applied, superseded by
-- this file and 2292). Replayed, the chain is: 2130 creates the function and the
-- triggers -> 2134 drops the three triggers, keeps the function -> 2276, 2277,
-- 2279 find the function and attach their own statement triggers -> 2292
-- removes those, finds no other executor, drops the function -> 3002, 3003,
-- 3310 follow.
--
-- ── WHAT IT MUST NEVER DO ───────────────────────────────────────────────────
-- Drop, replace or alter public.intel_append_only_stmt(). 2276/2277/2279 depend
-- on it existing and 2292 owns its removal. Nor touch the ROW-level
-- *_no_update_delete triggers or the *_no_truncate guards: those are the
-- append-only enforcement, and the postconditions below assert all six survive.
--
-- ── ON portava-ci THIS IS A NO-OP ───────────────────────────────────────────
-- Read on the reference database on 2026-10-06: public.intel_append_only_stmt()
-- is absent, public.intel_append_only() exists, no *_no_update_delete_stmt
-- trigger exists on any intel table, and the *_no_truncate guards are present.
-- Its ledger: 2137 applied_by='backfill' (unverified); 2276 applied_by='ci'
-- 2026-09-04 15:27:27 (so the function existed then, as its precondition
-- requires); 2292 applied_by='manual' 2026-09-05 11:36:06 (so no other trigger
-- executed the function by then). Every DROP below is IF EXISTS; the
-- postconditions are 2137's, and they are what this file asserts on apply.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_observations') IS NULL
     OR to_regclass('public.intel_evidence') IS NULL
     OR to_regclass('public.intel_confirmations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2130_intel_storage.sql first — intel_observations / intel_evidence / intel_confirmations must exist.';
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_observations','intel_evidence','intel_confirmations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_update_delete_stmt', t);
  END LOOP;
END $$;

-- ── Postconditions ──────────────────────────────────────────────────────────
-- Scoped to the three 2130 tables, like 2137's: an unscoped LIKE also matches
-- guards other tables carry (saved_places has its own TRUNCATE guard from 0074).
DO $$
DECLARE
  stmt_triggers int;
  row_triggers int;
  truncate_triggers int;
BEGIN
  SELECT count(*) INTO stmt_triggers
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE NOT tg.tgisinternal
     AND c.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND tg.tgname LIKE '%\_no\_update\_delete\_stmt';
  IF stmt_triggers <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % statement-level trigger(s) remain on the 2130 intel tables', stmt_triggers;
  END IF;

  -- The protection that matters must still be there.
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
-- REVERSAL — do not, without first solving the zero-row cascade problem
-- (2137's header). Recreating a statement-level trigger reintroduces the fault.
-- ═══════════════════════════════════════════════════════════════════════════
