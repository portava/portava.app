-- 2091_discovery_engine_mode_flags.sql
-- Seed the two P1 DISCOVERY_ENGINE_MODE switches, both in their inert state.
--
-- Read by lib/discoveryEngineMode.ts, which is consulted in routes/discovery.ts
-- immediately above the Cache A check — the branch point for which discovery
-- execution path handles a request.
--
--
-- 1. DISCOVERY_ENGINE_MODE  (capability, enabled=false, metadata.mode='legacy')
-- =============================================================================
-- Ruling D2=A: one row carries the three-valued mode. `enabled` is the master
-- on/off; `metadata.mode` selects the path. feature_flags.enabled is boolean, so
-- a third value cannot ride on it, and `metadata` is the only column that can
-- carry one — reachable at HEAD through exactly one helper, getFlagRow
-- (lib/featureFlags.ts:73).
--
-- Ruling D1=B: the name deliberately carries NO `COMPASS_` prefix, and it must
-- therefore never be read through compass/flags.ts. That module loads flags with
-- `.like("flag", "COMPASS_%")` (compass/flags.ts:29) and then returns
-- `flags[flag] ?? false` (:53), so this flag read through it would be false with
-- no error, no warning and no log line — and its 30-second cache would hold that
-- false. A COMPASS_-prefixed name was rejected because two of the three modes
-- govern requests Compass never touches.
--
-- BOTH `enabled=false` AND `mode='legacy'` are set, which is redundant on
-- purpose. Either alone yields legacy, so the row is inert twice over, and
-- whichever field a reader looks at first tells them the same true thing.
--
-- To move the mode:
--   UPDATE feature_flags
--      SET enabled = true, metadata = jsonb_set(metadata, '{mode}', '"shadow"')
--    WHERE flag = 'DISCOVERY_ENGINE_MODE';
--
-- ⚠ `shadow` computes a second result per request and writes observations; it
--   changes nothing a user receives. `pde` CHANGES WHAT USERS ARE SERVED and is
--   the owner's call, not the operator's.
--
--
-- 2. disable_discovery_pde  (STOP, enabled=false)
-- =============================================================================
-- Ruling D3=B. Read through isKillSwitchEngaged (lib/featureFlags.ts:55), whose
-- FAILURE polarity is inverted on purpose: a genuine error ENGAGES the stop. A
-- switch that disengages precisely when the database is unhealthy is not a kill
-- switch, and the moment you most want to halt PDE is the moment a flag read is
-- least trustworthy.
--
-- A MISSING row is NOT engaged — maybeSingle() returns data=null, error=null,
-- meaning "no such stop has been configured". So this row changes nothing
-- either; what it adds is that the stop EXISTS and is visible in the admin flag
-- list before it is ever needed, rather than being created by hand during an
-- incident.
--
-- It is consulted ONLY when the resolved mode is `pde`. Reading it on every
-- request would double flag traffic to protect a path that is not running, and
-- its inverted polarity would then turn any database hiccup into a forced
-- fallback for modes that never needed the protection.
--
-- To engage:  UPDATE feature_flags SET enabled = true WHERE flag = 'disable_discovery_pde';
--
--
-- NEITHER ROW CHANGES BEHAVIOUR
-- =============================
-- Before this migration: no rows, so the mode resolves to legacy (flag_absent)
-- and the stop is not engaged. After it: mode resolves to legacy
-- (flag_disabled) and the stop is not engaged. Identical serving behaviour; the
-- switches simply now exist in the repository rather than waiting to be
-- hand-made in production, which is the drift docs/ops/flag-disposition.md
-- exists to stop.

INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES
  ('DISCOVERY_ENGINE_MODE', false,
   'P1: selects which discovery execution path handles a request — legacy | shadow | pde — resolved above the Cache A check in routes/discovery.ts. enabled=false or an unrecognised metadata.mode both resolve to legacy. Read via lib/featureFlags.ts getFlagRow, NEVER via compass/flags.ts (its LIKE COMPASS_%% loader would silently read false).',
   '{"mode":"legacy","rollout":"p1-discovery","rulings":["D1=B","D2=A","D3=B"],"modes":["legacy","shadow","pde"],"pde_changes_user_facing_results":true}'),

  ('disable_discovery_pde', false,
   'P1 EMERGENCY STOP for the discovery PDE path. Read via isKillSwitchEngaged: a genuine DB error ENGAGES this stop, a missing row does not. Consulted only when DISCOVERY_ENGINE_MODE resolves to pde.',
   '{"rollout":"p1-discovery","ruling":"D3=B","polarity":"stop","engages_on_read_error":true}')
ON CONFLICT (flag) DO UPDATE SET
  description = EXCLUDED.description,
  metadata    = EXCLUDED.metadata;
