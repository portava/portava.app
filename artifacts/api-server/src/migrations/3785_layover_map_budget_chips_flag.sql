-- 3785_layover_map_budget_chips_flag.sql
-- census-layover L118 (spec §13: "Changing time-budget chips triggers
-- simulation/replanning, not local visual filtering alone"). B58 lane LAY-5,
-- layover band 3784-3799 (PLAN-layover: 3785 = LAY-5). APPLIED TO NO DATABASE
-- by the lane that wrote it.
--
-- Additive + idempotent. ONE INSERT: a feature_flags row seeded FALSE with
-- ON CONFLICT DO NOTHING. No schema object is created or changed; no table,
-- column, policy or grant is touched.
--
-- `layover_map_budget_chips_enabled` — services/airport/layoverMapBudget.ts and
--   routes/layoverSimulate.ts. ON (and only together with
--   `layover_map_bands_enabled`, 3633): GET /airport/sessions/:id/overview
--   publishes `mapBudgetChips` — the time budgets the map may offer, each at or
--   above the engine's 90-minute floor and below the certified usable minutes —
--   and POST /airport/sessions/:id/simulate { budgetMinutes } re-bands the plan
--   stops SAFE / TIGHT / BLOCKED on the SERVER, through the same pipeline as the
--   overview, over the certified record with its usable minutes narrowed to the
--   budget. A budget above the certified figure or below the floor is refused.
--   Nothing is stored.
--   OFF / absent / unreadable (the seed): the overview carries no
--   `mapBudgetChips` key, the simulate route answers 404 feature_disabled, and
--   the map card renders no chip.
--   PREREQUISITE for any effect: 3633 (`layover_map_bands_enabled`) applied and
--   ON — the chips move the bands 3633 publishes.
--
-- RUNTIME EFFECT OF SEEDING: NONE. FALSE, and the postcondition refuses a seed
-- that finds it ON.
--
-- Rollback: db/rollback/2026-10-14-3785-layover-map-budget-chips-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3785): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_map_budget_chips_enabled',
    false,
    'Layover time-budget chips on the map (spec 13; census-layover L118). ON together with layover_map_bands_enabled: the overview offers budgets at or above 90 min and below the certified usable minutes, and POST /airport/sessions/:id/simulate re-bands the plan stops server-side under the chosen budget (a budget can only narrow; nothing stored). OFF / absent (the seed): no chips, the simulate route is 404.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag = 'layover_map_budget_chips_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3785): expected layover_map_budget_chips_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag = 'layover_map_budget_chips_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3785): layover_map_budget_chips_enabled is ON — it must ship OFF';
  END IF;
END $post$;
