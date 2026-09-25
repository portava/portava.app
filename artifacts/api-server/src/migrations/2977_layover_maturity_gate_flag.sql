-- 2977_layover_maturity_gate_flag.sql
--
-- SEED `layover_maturity_gate_enabled` AS A ROW, FALSE.
--
-- WHAT THIS DOES NOT CHANGE. Nothing observable, on any database. The reader is
-- `lib/featureFlags.ts#isFlagEnabled`, which answers a missing row, a false row
-- and an unreadable `feature_flags` identically — false — so the §22 maturity
-- gate is already off on every request today and it stays off after this file.
-- No traveller is shown a different card because of it.
--
-- WHY IT IS WORTH A MIGRATION ANYWAY. The absence was load-bearing in one
-- direction only. It made the gate fail-closed, which is right, and it also made
-- the gate UN-ENABLEABLE through the only audited path this repository has:
-- `PATCH /api/admin/feature-flags/<flag>` goes through the
-- `toggle_feature_flag_with_audit` RPC so that the update and its audit-log
-- insert share one transaction, and that RPC cannot patch a row which does not
-- exist. The only way to turn this on without a row is a direct UPDATE, which
-- writes no audit entry at all. A gate whose only switch bypasses the audit log
-- is not a gate anyone should reach for.
--
-- ── WHAT TURNING IT ON DOES, STATED IN FULL BECAUSE IT IS LARGE ──────────────
-- `services/airport/layoverMaturityGate.ts` asks `featureAllowedAt(
-- 'landside_recommendations', level)`, and `MATURITY_FEATURES` puts that
-- feature at `L1_MAPPED`. Reaching L1 requires an `airport_profiles` row that
-- is `verified`, carries a non-empty `terminal_info` topology, AND has a
-- modelled airport-to-city transport (which on this tree means the routed
-- corridor provider is enabled, and it is enabled nowhere).
--
-- Production holds 3,206 `airport_profiles` rows. ZERO are verified and ZERO
-- carry `terminal_info` — measured, and recorded in
-- docs/architecture/census-layover.md. So with this flag ON, EVERY airport on
-- earth classifies `L0_GENERIC` and the landside half of the Layover product
-- is withdrawn: no Discovery candidates, no city-escape card. Airside guidance,
-- the certified window and the return deadline are untouched, because
-- `MATURITY_FEATURES` puts all three at L0 deliberately — "the conservative
-- generic timing IS the L0 offering; withholding it would leave nothing."
--
-- That withdrawal is exactly what spec §22 L243 asks for ("static airport +
-- conservative generic timing; AIRPORT-SIDE GUIDANCE ONLY BY DEFAULT"), and
-- census-layover has scored the divergence BUILT-BUT-WRONG since the document
-- was written. It is still a decision about what travellers are shown, so this
-- file makes it POSSIBLE and does not make it. Enabling it is an owner
-- decision, never a deployment step, and the sensible order is to curate one
-- airport to L1 first and watch that airport keep its cards.
--
-- ── WHY A CAPABILITY NAME AND NOT A KILL SWITCH NAME ────────────────────────
-- `*_enabled` is this repository's capability convention and `check-flag-
-- polarity` enforces it: fail-closed, an unreadable table leaves it OFF. The
-- capability being enabled here is "enforce the maturity policy", not "show
-- landside cards" — naming it the other way round would make an unreadable
-- `feature_flags` withdraw the product, which is the inversion that convention
-- exists to prevent.
--
-- SHAPE: deliberately the same as 2971_layover_discovery_mode_flag.sql —
-- precondition on the table and on the ON CONFLICT arbiter, INSERT ... ON
-- CONFLICT DO NOTHING, then postconditions asserting present AND off.
-- Re-runnable.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE conflict_target_ok boolean;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2977): public.feature_flags does not exist.';
  END IF;

  -- The INSERT below says ON CONFLICT (flag). Postgres needs a unique index or
  -- constraint on exactly that column to infer an arbiter; without one the
  -- statement raises 42P10 rather than doing nothing. Asserted here so a
  -- database that has drifted says so, instead of failing on a syntax error
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
    RAISE EXCEPTION 'PRECONDITION FAILED (2977): public.feature_flags has no UNIQUE or PRIMARY KEY on (flag) alone, so ON CONFLICT (flag) has no arbiter to infer.';
  END IF;
END $$;

-- ── Seed (CAPABILITY, OFF) ───────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_maturity_gate_enabled',
    false,
    'Layover airport-maturity gate (spec 22, census L249): when ON, services/airport/layoverMaturityGate.ts classifies the session airport on the six-rung maturity ladder and asks featureAllowedAt(''landside_recommendations'', level) before generateRecommendations fetches Discovery candidates or offers the city-escape card. landside_recommendations sits at L1_MAPPED, and NO production airport reaches L1 today (0 of 3,206 rows verified, 0 with terminal_info), so turning this ON withdraws every landside card everywhere until an airport is curated. Airside guidance, the certified window and the return deadline are at L0 and are untouched. OFF (the seed, and the behaviour on every database today): the gate allows unconditionally and reads no observation corpus at all. Fail-closed (isFlagEnabled) - a missing row and an unreadable feature_flags both read false, so the gate stays off rather than silently withdrawing the product. Read by services/airport/layoverMaturityGate.ts (LAYOVER_MATURITY_GATE_FLAG, literal name). Seeded as a row so the audited toggle path (PATCH /api/admin/feature-flags, via toggle_feature_flag_with_audit) can reach it; enabling it is an owner decision about what travellers are shown, never a deployment step.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (present, OFF, and no unreachable near-miss name) ────────
DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
   WHERE flag = 'layover_maturity_gate_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2977): expected layover_maturity_gate_enabled present exactly once, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
   WHERE flag = 'layover_maturity_gate_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2977): layover_maturity_gate_enabled seeded ON. This file exists to make the gate REACHABLE, not to enforce it; with it on, every one of the 3,206 production airports classifies L0_GENERIC and loses its landside cards.';
  END IF;

  -- The near-miss name. LAYOVER_MATURITY_GATE_FLAG is the literal
  -- 'layover_maturity_gate_enabled'; a row under any other spelling is a gate
  -- no code can reach, which is the defect 2922 hit with creator_attribution.
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('layover_maturity_gate', 'layover_maturity_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2977): a row exists under a short name (layover_maturity_gate / layover_maturity_enabled); no code reads either, so it is a gate nothing can reach.';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags WHERE flag = 'layover_maturity_gate_enabled';
--   Safe: the reader treats an absent row and a false row identically, so the
--   gate is OFF either way. Reversing only removes the audited toggle path.
