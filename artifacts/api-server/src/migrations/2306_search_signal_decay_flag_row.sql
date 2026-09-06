-- 2306_search_signal_decay_flag_row.sql
--
-- Seed the `SEARCH_SIGNAL_DECAY_DAYS` configuration row, seeded OFF, and say in
-- the row itself why it is off.
--
-- WHAT IS ACTUALLY WRONG HERE
-- ---------------------------
-- Compass search-signal decay is wired end to end in TypeScript
-- (compass/CompassSearchDecayService.ts + lib/compassSearchDecayFlushScheduler.ts)
-- and NONE of its database objects exist in the live schema. Its DDL —
-- the `compass_search_signal_log` table, the `upsert_compass_search_signal`
-- RPC, a `feature_flags.numeric_value` column, and this flag row — sits in
--
--     artifacts/api-server/supabase/migrations/20260812_compass_search_signal_log.sql
--
-- which is a FROZEN, never-audited migration stream (see
-- src/scripts/frozenMigrationRoots.ts:211 — "live commits through 2026-08-13,
-- never audited or documented as a tree"). Nothing in that root has been
-- applied. The generated live-schema snapshot
-- (src/test/generated/liveColumns.json) confirms it: `feature_flags` has no
-- `numeric_value`, and `compass_search_signal_log` is not a live table at all.
--
-- So three reads failed, each masking the next:
--   getDecayConfig    → 42703 on `numeric_value`      → hard-coded default
--   getDecayedWeights → 42P01 on the missing table    → weights undecayed
--   logSearchNudge    → 42883 on the missing RPC      → nothing recorded
--
-- The service is fail-soft at every step, so the whole capability has been
-- inert and silent since it shipped.
--
-- WHAT THIS MIGRATION DOES, AND DELIBERATELY DOES NOT DO
-- -----------------------------------------------------
-- It does NOT port the frozen DDL. Creating a table plus a SECURITY DEFINER
-- function is a production change that deserves its own review — that file's
-- RLS write policy is `FOR ALL USING (auth.uid() = user_id)` with no
-- WITH CHECK, and its grants predate this repo's "revoke needs anon AND
-- authenticated named explicitly" lesson. Smuggling it in as a side effect of
-- a column repair is exactly the kind of unexamined carry-over that produced
-- the defect in the first place.
--
-- It seeds the CONTROL row so the state is visible and reversible:
--
--   * `enabled = false` — the honest value. Decay cannot function without its
--     table, and a flag reading `true` for a capability that does nothing is
--     the failure mode this repo keeps finding. OFF also makes the two callers
--     short-circuit BEFORE the reads that always fail, which removes a
--     recurring 42P01 from every Compass profile build and stops the flush
--     scheduler polling a table that does not exist. The OUTCOME is unchanged:
--     weights were never decayed before this migration and are not decayed
--     after it.
--   * `metadata->>'half_life_days' = 7` — the value the code has always
--     defaulted to, so flipping `enabled` to true restores exactly today's
--     intended behaviour with no other edit. `metadata` (jsonb) is this repo's
--     existing carrier for a non-boolean flag payload — `lib/featureFlags.ts
--     getFlagRow` selects precisely `enabled, metadata` — which is why the
--     service was moved onto it rather than onto the frozen file's single-use
--     `numeric_value` column.
--
-- TO TURN THE CAPABILITY ON (both steps are required, in this order):
--   1. Port 20260812_compass_search_signal_log.sql's table + index + RLS +
--      RPC into the canonical chain, reviewed on its own merits.
--   2. UPDATE public.feature_flags SET enabled = true
--        WHERE flag = 'SEARCH_SIGNAL_DECAY_DAYS';
--
-- `ON CONFLICT DO NOTHING` so a re-run never overwrites an administrator's
-- later decision. Idempotent; safe to re-run. No tables, no DDL, one row.

INSERT INTO feature_flags (flag, enabled, description, metadata)
VALUES (
  'SEARCH_SIGNAL_DECAY_DAYS',
  false,
  'CONFIG (not a gate): time-decay of Compass search-signal category weights. `enabled` switches decay on/off; `metadata->>''half_life_days''` is the half-life in days. Read by compass/CompassSearchDecayService.ts getDecayConfig and lib/compassSearchDecayFlushScheduler.ts. SEEDED OFF because the capability''s backing table (compass_search_signal_log) and RPC (upsert_compass_search_signal) are NOT in the live schema — their DDL sits unapplied in the frozen root artifacts/api-server/supabase/migrations/. Port that DDL into the canonical chain first, then set enabled=true.',
  -- Written as a jsonb literal, NOT jsonb_build_object('half_life_days', 7):
  -- check-flag-polarity.mjs extracts seeded flag names with the row matcher
  -- /\(\s*'([A-Za-z0-9_]+)'\s*,/ , and a build_object call has exactly that
  -- shape — it would register `half_life_days` as a 149th feature flag that
  -- no code reads, and fail the guard for a key that is not a flag at all.
  '{"half_life_days": 7}'::jsonb
)
ON CONFLICT (flag) DO NOTHING;

-- Postcondition: the row the service reads exists and carries a usable
-- half-life. A seed migration that silently seeded nothing would leave the
-- control exactly as invisible as before.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag = 'SEARCH_SIGNAL_DECAY_DAYS'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: SEARCH_SIGNAL_DECAY_DAYS row missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag = 'SEARCH_SIGNAL_DECAY_DAYS'
      AND (metadata->>'half_life_days')::numeric > 0
  ) THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: SEARCH_SIGNAL_DECAY_DAYS carries no positive metadata.half_life_days';
  END IF;
END $$;

-- ROLLBACK (manual, if ever needed):
--   DELETE FROM public.feature_flags WHERE flag = 'SEARCH_SIGNAL_DECAY_DAYS';
-- Removing the row returns the service to its unconfigured fallback
-- (enabled=true, halfLifeDays=7), which is what it has been doing all along.
