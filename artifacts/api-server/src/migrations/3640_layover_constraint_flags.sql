-- 3640_layover_constraint_flags.sql
-- Two Layover capability flags (census-layover L22/L35/L172 and L48/L230),
-- seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Layover workstream
-- 3640-3659). APPLIED TO NO DATABASE by the lane that wrote it.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention.
-- NO SCHEMA OBJECT IS CREATED OR CHANGED: the table the first flag guards
-- (`layover_constraints`) is created by 2992, which this file does not touch.
--
-- ── WHAT EACH GATES ─────────────────────────────────────────────────────────
-- `layover_constraints_enabled` — services/layover/LayoverConstraintStore.ts.
--   ON: the traveller's declared constraint set (baggage mode, self-transfer
--   re-check, airport change) is READ on every session load and a declaration
--   APPENDS a version to `layover_constraints`. The certified record then
--   computes with the declared baggage mode instead of
--   `layover_sessions.checked_bags`, and an UNKNOWN that could change the
--   verdict closes landside and asks one question (spec §6.1, §12.1, App B.2).
--   OFF / absent / unreadable: nothing touches `layover_constraints`. A
--   declaration is kept as the conservative boolean on the session only
--   (UNKNOWN is charged as collect-and-recheck), and says so.
--   PREREQUISITE: 2700 then 2992 applied. With this ON and the table absent
--   every constraint read fails; the engine takes the cautious case for every
--   traveller and GET /airport/sessions/:id/constraints answers 503. Apply the
--   tables first.
--
-- `layover_entry_forbid_landside_enabled` — the OWNER's answer to spec §6.1
--   `if entry_permission_state != CONFIRMED_ALLOWED: forbid_landside_recommendations()`.
--   ON: an entry corridor that is not confirmed allowed closes landside — the
--   certified verdict is `no`, no landside recommendation is generated and the
--   snapshot's `landsideOpen` is false.
--   OFF / absent / unreadable (the seed): today's behaviour — the verdict is
--   `entry_unverified` and landside stays open with the caveat shown.
--   READ THIS BEFORE TURNING IT ON: `entry_requirements` has no curated row, so
--   every corridor is `no_data_for_corridor` and ON closes landside for EVERY
--   traveller until corridors are curated (census-layover §45.3). That is why
--   this is a flag and not a default.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Both FALSE; the postcondition refuses a seed that finds either ON. An absent
-- row and a FALSE row read identically through `isFlagEnabled`, so behaviour is
-- unchanged; what the rows add is that the audited toggle path
-- (toggle_feature_flag_with_audit) can reach them.
--
-- Rollback: db/rollback/2026-10-04-3640-layover-constraint-flags-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3640): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_constraints_enabled',
    false,
    'Layover declared constraint set (census-layover L22/L35/L172). ON: baggage mode, self-transfer re-check and airport change are read from and appended to layover_constraints, and the certified record computes with them. REQUIRES migrations 2700 and 2992 applied first. OFF / absent (the seed): layover_constraints is not touched; a declaration is kept only as the conservative checked_bags boolean on the session.'
  ),
  (
    'layover_entry_forbid_landside_enabled',
    false,
    'Layover entry policy (spec 6.1; census-layover L48/L230). ON: an entry corridor that is not confirmed allowed forbids landside (verdict no, no landside recommendation). OFF / absent (the seed): entry_unverified stays open with its caveat. While entry_requirements is uncurated, ON closes landside for every traveller. Turning it ON in production is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag IN ('layover_constraints_enabled', 'layover_entry_forbid_landside_enabled');
  IF present <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3640): expected both flags present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag IN ('layover_constraints_enabled', 'layover_entry_forbid_landside_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3640): a Layover constraint flag is ON — production activation is an owner decision and these must ship OFF';
  END IF;
END $post$;
