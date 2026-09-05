-- 2292_intel_stmt_trigger_removal_ig_campaign.sql
-- Remove the STATEMENT-level append-only triggers that the IG campaign
-- migrations (2276, 2277, 2279) re-attached to three new intel tables. They are
-- the exact guard 2137 removed, for the exact reason 2137 removed it, and they
-- have reproduced the exact failure 2137's header describes.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2292.
-- Additive + idempotent. Safe to re-run. Changes no data.
--
-- ── THE FAILURE, OBSERVED LIVE ──────────────────────────────────────────────
-- CI job "live DB · RLS + role/is_official write boundaries", PR #402:
--
--     Error: purgeFixtures: delete profiles: intel_presence_verifications is
--            append-only: DELETE is not permitted at statement level.
--       at purgeFixtures (src/test/rlsHardening.test.ts:209:19)
--
-- All 17 tests in that suite fail before a single assertion runs, because the
-- fixture teardown cannot delete a profiles row. Credentials were present; this
-- is not the secrets path.
--
-- This is not a test problem. `DELETE FROM profiles` cascades into
-- intel_presence_verifications (2276: actor_id REFERENCES profiles ON DELETE
-- CASCADE). A BEFORE ... FOR EACH STATEMENT trigger fires when the statement
-- STARTS, before any row is examined, so it cannot distinguish "there is nothing
-- here to protect" from "someone is rewriting history". It refuses the cascade
-- whether or not the user being deleted ever produced a single verification row.
--
-- The same cascade runs in real account deletion / right-to-erasure. The
-- statement trigger therefore makes a user with — or without — presence rows
-- undeletable, and an erasure that aborts partway is the failure mode this
-- repository has already been bitten by (anonymise_profile nulling a NOT NULL
-- handle: content destroyed, then the transaction aborted).
--
-- ── WHAT 2137 ESTABLISHED, AND WHY THIS FILE ONLY REPEATS IT ────────────────
-- 2130 put three triggers on each append-only intel table:
--
--   *_no_update_delete       BEFORE UPDATE OR DELETE  FOR EACH ROW
--   *_no_update_delete_stmt  BEFORE UPDATE OR DELETE  FOR EACH STATEMENT  <-- this one
--   *_no_truncate            BEFORE TRUNCATE          FOR EACH STATEMENT
--
-- 2137_intel_stmt_trigger_removal.sql dropped the middle one from
-- intel_observations / intel_evidence / intel_confirmations after it broke this
-- very suite, and dropped public.intel_append_only_stmt() with it so no caller
-- could reappear. Its closing line reads:
--
--   "REVERSAL — do not, without first solving the zero-row cascade problem."
--
-- 2276, 2277 and 2279 reversed it for three new tables. Nothing solved the
-- zero-row cascade problem in between. (They could only do so because
-- intel_append_only_stmt() still exists on the databases those migrations were
-- applied to — 2175's header records that the environments had drifted on
-- exactly this function.)
--
-- ── WHY REMOVING IT LOSES NOTHING (2137's argument, unchanged) ──────────────
-- The ROW-level *_no_update_delete trigger is what enforces append-only. It
-- fires once per actual row, so it fires exactly when there is something to
-- protect and stays silent when there is not:
--
--   * UPDATE  — refused ALWAYS, on every row, for every role. No escape hatch.
--   * DELETE  — refused unless the transaction has declared
--               `SET LOCAL portava.erasure_in_progress = 'on'`, which only
--               erase_intel_for_actor() / the retention RPCs do. An ordinary
--               bug still cannot delete a row; a deletion worker still has to
--               say out loud that it is erasing.
--
-- The statement-level trigger added no case the row-level one misses. It only
-- added refusals where there was no row.
--
-- TRUNCATE keeps its guard and is untouched: TRUNCATE fires no row-level
-- triggers at all, so *_no_truncate is the only thing between an append-only
-- table and `TRUNCATE public.intel_attributions`. All three survive here, and
-- the postconditions below assert it.
--
-- Client roles are unaffected in either direction: none of these three tables
-- grants UPDATE, DELETE or TRUNCATE to anon or authenticated (2276/2277/2279
-- REVOKE ALL first, then GRANT only INSERT/SELECT to service_role and a
-- read-only SELECT where a policy allows it). A client DELETE is refused by the
-- missing privilege before any trigger is consulted, and by the row-level
-- trigger if a privilege were ever granted by mistake.
--
-- ── PER-TABLE CASCADE REASONING ─────────────────────────────────────────────
-- intel_presence_verifications (2276)
--   observation_id -> intel_observations ON DELETE CASCADE
--   actor_id       -> profiles           ON DELETE CASCADE
--   After this file: a profiles/auth-user delete that touches zero rows
--   succeeds (no statement trigger left to refuse it). A real erasure deletes
--   the actor's rows through the intel_observations cascade fired INSIDE
--   erase_intel_for_actor()'s declared erasure, so the row-level trigger
--   permits them. A direct client DELETE is still refused (no privilege; and
--   the row-level trigger with no declaration).
--
-- intel_attributions (2277)
--   claim_id       -> intel_claims       ON DELETE CASCADE
--   observation_id -> intel_observations ON DELETE CASCADE
--   actor_id       -> profiles           ON DELETE CASCADE
--   Same as above, and erase_intel_for_actor() (widened by 2278) additionally
--   deletes this table by actor_id explicitly inside the declaration.
--
-- intel_historical_patterns (2279)
--   subject_id -> places ON DELETE CASCADE
--   A places delete issues a DELETE against this table. Before this file the
--   statement trigger refused it unconditionally, so deleting ANY place failed
--   even when the place had no pattern rows. After this file, a zero-row place
--   cascade succeeds. A place that DOES carry pattern rows is still refused by
--   the row-level trigger unless the caller declares an erasure — the same
--   posture intel_observations / intel_claims / intel_state_snapshots have had
--   since 2130 (they carry the identical places cascade and the identical
--   row-level guard). This file deliberately does not change that posture; it
--   only stops the zero-row refusal.
--
-- intel_state_snapshot_versions (2273) is NOT in scope: it carries the
-- row-level and TRUNCATE guards only, and deliberately no FK to places, so no
-- cascade reaches it. Verified, not assumed — see the postconditions.
--
-- RUNTIME EFFECT: none for any write path. No code updates or deletes these
-- tables outside erase_intel_for_actor() and the retention RPCs, which set the
-- erasure declaration and are unaffected either way.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
-- Deliberately tolerant of a table that does not exist yet: 2279 may not have
-- been applied to every environment, and this file must be safe to apply to all
-- of them. What it is NOT tolerant of is the row-level guard being absent from
-- a table that DOES exist — dropping the statement guard there would leave the
-- table unprotected, which is the one outcome worse than the bug.
DO $$
DECLARE
  t text;
  existing int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'intel_presence_verifications',
    'intel_attributions',
    'intel_historical_patterns'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    existing := existing + 1;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
       WHERE tg.tgrelid = ('public.' || t)::regclass
         AND NOT tg.tgisinternal
         AND tg.tgname = t || '_no_update_delete'
    ) THEN
      RAISE EXCEPTION
        'PRECONDITION FAILED: public.% exists but carries no row-level append-only trigger (%_no_update_delete). Removing the statement-level guard would leave it unprotected.', t, t;
    END IF;
  END LOOP;

  IF existing = 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: none of intel_presence_verifications / intel_attributions / intel_historical_patterns exist. Apply 2276, 2277 and 2279 first — this file has nothing to correct and a vacuous pass would hide that.';
  END IF;
END $$;

-- ── The correction ──────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'intel_presence_verifications',
    'intel_attributions',
    'intel_historical_patterns'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_update_delete_stmt', t);
  END LOOP;
END $$;

-- The function goes too, exactly as 2137 did it — but only once nothing on the
-- database still uses it. Leaving a callerless SECURITY-adjacent function behind
-- is how the anon-executable backlog formed; dropping one that some other table
-- still depends on would be worse. So: count first, and if any trigger anywhere
-- still executes it, leave it in place rather than guess.
DO $$
DECLARE remaining int; offenders text;
BEGIN
  IF to_regprocedure('public.intel_append_only_stmt()') IS NULL THEN
    RETURN;  -- already gone (2137 dropped it where it was ever applied)
  END IF;

  SELECT count(*), string_agg(format('%s on %s', tg.tgname, tg.tgrelid::regclass::text), ', ')
    INTO remaining, offenders
    FROM pg_trigger tg
   WHERE NOT tg.tgisinternal
     AND tg.tgfoid = 'public.intel_append_only_stmt()'::regprocedure;

  IF remaining > 0 THEN
    -- A table this file does not know about is still carrying the erasure
    -- blocker. Refuse rather than half-fix: a green migration that left one
    -- cascade broken is the worse outcome.
    RAISE EXCEPTION
      'POSTCONDITION FAILED: % trigger(s) outside this file''s scope still execute intel_append_only_stmt(): %. Add their tables to this file''s list.', remaining, offenders;
  END IF;

  DROP FUNCTION IF EXISTS public.intel_append_only_stmt();
END $$;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  stmt_triggers int;
  row_triggers int;
  truncate_triggers int;
  client_writes int;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'intel_presence_verifications',
    'intel_attributions',
    'intel_historical_patterns'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    -- 1. The zero-row refusal is gone.
    SELECT count(*) INTO stmt_triggers
      FROM pg_trigger tg
     WHERE tg.tgrelid = ('public.' || t)::regclass
       AND NOT tg.tgisinternal
       AND tg.tgname = t || '_no_update_delete_stmt';
    IF stmt_triggers <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: statement-level append-only trigger still on public.%', t;
    END IF;

    -- 2. The guard that matters is still there. Removing the wrong trigger is
    --    only an improvement if the right one survives.
    SELECT count(*) INTO row_triggers
      FROM pg_trigger tg
     WHERE tg.tgrelid = ('public.' || t)::regclass
       AND NOT tg.tgisinternal
       AND tg.tgname = t || '_no_update_delete';
    IF row_triggers <> 1 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: expected 1 row-level append-only trigger on public.%, found %', t, row_triggers;
    END IF;

    -- 3. TRUNCATE is still refused. Nothing else stands between these tables
    --    and a TRUNCATE, which fires no row-level trigger at all.
    SELECT count(*) INTO truncate_triggers
      FROM pg_trigger tg
     WHERE tg.tgrelid = ('public.' || t)::regclass
       AND NOT tg.tgisinternal
       AND tg.tgname = t || '_no_truncate';
    IF truncate_triggers <> 1 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: expected 1 TRUNCATE guard on public.%, found %', t, truncate_triggers;
    END IF;

    -- 4. The append-only guarantee for CLIENT roles is not weakened. Privilege
    --    is the first line and it must still be absent; a client DELETE must
    --    never depend on a trigger to be refused.
    SELECT count(*) INTO client_writes
      FROM (VALUES ('anon'), ('authenticated')) r(role),
           (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
     WHERE has_table_privilege(r.role, 'public.' || t, p.priv);
    IF client_writes <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: % client write privilege(s) on public.% — append-only weakened', client_writes, t;
    END IF;
  END LOOP;

  -- 5. 2137's own work is still in force. If a statement-level guard has crept
  --    back onto the 2130 family, this file has fixed three tables and left the
  --    original three broken.
  SELECT count(*) INTO stmt_triggers
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE NOT tg.tgisinternal
     AND c.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND tg.tgname LIKE '%\_no\_update\_delete\_stmt';
  IF stmt_triggers <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % statement-level trigger(s) back on the 2130 intel family', stmt_triggers;
  END IF;

  -- 6. Nothing anywhere still executes intel_append_only_stmt(). Matched by
  --    FUNCTION, not by trigger NAME: 2137's header records that an unscoped
  --    name LIKE also counts guards other tables legitimately carry
  --    (saved_places' TRUNCATE guard from 0074, discovery_shadow_serves'
  --    UPDATE-only statement guard from 2092, canonical_events' from 2120) and
  --    fails for the wrong reason. The first run of 2137 did exactly that.
  --    Those three are correct as they stand: 2092's fires on UPDATE only, and
  --    2120's table deliberately carries no foreign key, so no cascade reaches
  --    either.
  SELECT count(*) INTO stmt_triggers
    FROM pg_trigger tg
    JOIN pg_proc p ON p.oid = tg.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE NOT tg.tgisinternal
     AND n.nspname = 'public'
     AND p.proname = 'intel_append_only_stmt';
  IF stmt_triggers <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % trigger(s) still execute intel_append_only_stmt()', stmt_triggers;
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL — do not.
-- ═══════════════════════════════════════════════════════════════════════════
-- Recreating any *_no_update_delete_stmt trigger reintroduces the zero-row
-- cascade refusal and breaks account deletion again. This is the second time;
-- src/test/appendOnlyCascade.test.ts now fails the build if a migration adds
-- one back.
