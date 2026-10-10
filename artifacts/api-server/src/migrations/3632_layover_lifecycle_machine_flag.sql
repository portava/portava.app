-- 3632_layover_lifecycle_machine_flag.sql
-- One Layover capability flag (census-layover L39 / L40 / L43), seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane L-LIFE
-- 3632-3639). APPLIED TO NO DATABASE by the lane that wrote it.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` => CAPABILITY convention.
-- NO SCHEMA OBJECT IS CREATED OR CHANGED.
--
-- `layover_lifecycle_machine_enabled` — services/airport/LayoverLifecycle.ts,
--   spec §5's seventeen-state graph with guards and side-effect intents.
--   OFF / absent / unreadable (the seed): SHADOW. The graph runs beside every
--   status write and beside GET /airport/sessions/:id/overview, and where it
--   disagrees with what happened it logs one `layover_lifecycle_shadow` line.
--   No response changes.
--   ON: the overview publishes `lifecycle` (the graph's state, the
--   EVALUATING -> LANDSIDE_AVAILABLE guard and its failures, the required
--   intents, the events available) and the transition routes publish the
--   transition they made. ADVISORY in both states: no write is ever refused.
--
-- RUNTIME EFFECT OF SEEDING: NONE. FALSE, and the postcondition refuses a seed
-- that finds it ON. An absent row and a FALSE row read identically through
-- `isFlagEnabled`; the row exists so the audited toggle path can reach it.
--
-- Rollback: db/rollback/2026-10-10-3632-layover-lifecycle-machine-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3632): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_lifecycle_machine_enabled',
    false,
    'Layover lifecycle state graph (spec 5; census-layover L39/L40/L43). OFF / absent (the seed): shadow only, divergences logged. ON: GET /airport/sessions/:id/overview publishes lifecycle and transition routes publish their transition. Advisory either way: no write is refused.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'layover_lifecycle_machine_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3632): expected layover_lifecycle_machine_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'layover_lifecycle_machine_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3632): layover_lifecycle_machine_enabled is ON — it must ship OFF';
  END IF;
END $post$;
