-- 2971_layover_discovery_mode_flag.sql
--
-- SEED `layover_discovery_mode_enabled` AS A ROW, STILL FALSE.
--
-- WHAT THIS DOES NOT CHANGE. Nothing observable. `lib/featureFlags.ts` reads a
-- missing row and an unreadable `feature_flags` as the SAME answer — false — so
-- the Layover Discovery gate is already off on every request, and it stays off
-- after this file. No traveller is served a different card because of it.
--
-- WHY IT IS WORTH A MIGRATION ANYWAY. The absence was load-bearing in one
-- direction only. It made the gate fail-closed, which is right, but it also made
-- the gate UN-ENABLEABLE through the one audited path the repo offers:
-- `PATCH /api/admin/feature-flags/<flag>` goes through the
-- `toggle_feature_flag_with_audit` RPC so that the update and its audit-log
-- insert share one transaction, and it cannot patch a row that does not exist.
-- The only way to turn Layover Discovery mode on today is a direct UPDATE, which
-- writes no audit row at all. A capability whose only switch bypasses the audit
-- log is not a capability anyone should reach for in an incident.
--
-- So: seed the row OFF. Fail-closed is preserved (false is false whether the row
-- is present or absent), and the supported, audited path becomes reachable.
--
-- THE CENSUS NOTE THIS OWES. `check:census-freshness`'s own scope comment cites
-- `lib/featureFlags.ts` for the property that "a missing row and an unreadable
-- feature_flags BOTH read false, which is how layover_discovery_mode_enabled is
-- FALSE-seeded by absence rather than by a migration". That sentence describes
-- the READER and stays true. What changes is only that the row now exists and
-- reads false explicitly rather than by absence. Any row whose evidence quotes
-- "seeded by absence" as a fact about THIS FLAG needs re-wording once this
-- applies; the reader property it rests on is untouched.
--
-- SHAPE: deliberately the same as 2922_creator_attribution_flag.sql — precondition
-- on the table, INSERT ... ON CONFLICT DO NOTHING, then postconditions asserting
-- present AND off. Re-runnable.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE conflict_target_ok boolean;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2971): public.feature_flags does not exist.';
  END IF;

  -- The INSERT below says ON CONFLICT (flag). Postgres needs a unique index or
  -- constraint on exactly that column to infer an arbiter; without one the
  -- statement raises 42P10 rather than doing nothing. Verified present on both
  -- databases before this file was written -- PRIMARY KEY (flag) on
  -- feature_flags_pkey, on portava-ci AND on production -- and asserted here so
  -- a database that has drifted says so instead of failing on a syntax error
  -- whose message names neither this file nor the reason.
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'feature_flags'
       AND c.contype IN ('p','u')
       AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid = t.oid AND attname = 'flag')]::smallint[]
  ) INTO conflict_target_ok;
  IF NOT conflict_target_ok THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2971): public.feature_flags has no UNIQUE or PRIMARY KEY on (flag) alone, so ON CONFLICT (flag) has no arbiter to infer.';
  END IF;
END $$;

-- ── Seed (CAPABILITY, OFF) ───────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_discovery_mode_enabled',
    false,
    'Layover Discovery mode: when ON, a Discovery serve in an airport session is narrowed to the CERTIFIED ACTION UNIVERSE — the list `25` L269 permits, admitted by the return-aware feasibility arithmetic in LayoverEventReplanner rather than by distance alone. OFF (the seed): every Discovery serve path returns the ungated list, which is the behaviour today, because the flag has until now had no row and a missing row reads false. Fail-closed (isFlagEnabled) — an unreadable feature_flags leaves the gate OFF, never silently on. Read by services/airport/LayoverSnapshot.ts (LAYOVER_DISCOVERY_MODE_FLAG, literal name). Seeded as a row so the audited toggle path (PATCH /api/admin/feature-flags, via toggle_feature_flag_with_audit) can reach it; before this the only way to enable it was a direct UPDATE that writes no audit row.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, OFF, and the reader still fail-closed) ──────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
   WHERE flag = 'layover_discovery_mode_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2971): expected layover_discovery_mode_enabled present exactly once, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
   WHERE flag = 'layover_discovery_mode_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2971): layover_discovery_mode_enabled seeded ON. This file exists to make the flag REACHABLE, not to turn Layover Discovery mode on; enabling it is an owner decision and narrows what a traveller is shown.';
  END IF;

  -- The near-miss name. LAYOVER_DISCOVERY_MODE_FLAG is the literal
  -- 'layover_discovery_mode_enabled'; a row under any other spelling is a gate
  -- no code can reach, which is the defect 2922 hit with creator_attribution.
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_discovery_mode') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2971): a row exists under the short name layover_discovery_mode; no code reads it, so it is a gate nothing can reach.';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags WHERE flag = 'layover_discovery_mode_enabled';
--   Safe: the reader treats an absent row and a false row identically, so the
--   gate is OFF either way. Reversing only removes the audited toggle path.
