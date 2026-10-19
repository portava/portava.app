-- 3846_layover_compass_assistant_flag.sql
--
-- Layover §12 / §12.1 / §25 — the AI layover assistant (census-layover L100, L102–L113, L268), under the owner's
-- decision of 2026-10-18: the assistant rows are in scope, with the model and approved tool execution, behind a flag
-- seeded FALSE, with an outage path that falls back to the certified-only answer. Lead rulings L-CL02a/c/d are
-- superseded; census-compass CL-02 ("hard safety cannot be overridden by Compass prose") still binds and is held by
-- services/airport/LayoverCompassAssistant.ts (the certified text leads; tools read the certified record; the
-- envelope detector withdraws all model prose on a widening; a closed-vocabulary gate admits the rest).
--
-- APPLIED TO NO DATABASE by the lane that wrote it (layover-165 lane B1-C, 2026-10-18).
--
-- ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
-- ONE feature-flag row, `layover_compass_assistant_enabled`, seeded FALSE. Nothing else: no table, no column, no
-- function, no privilege. Its reader is POST /api/airport/sessions/:id/compass (routes/airport.ts,
-- `layoverCompassDoorAnswer`, through the fail-closed `isFlagEnabled`):
--   OFF / absent / unreadable (the seed): the door answers exactly as before — certified text + deterministic airport
--     facts — calls no model and reads none of the tool sources.
--   ON: the model (gpt-5-mini, through the same OpenAI integration as the Compass general chat:
--     AI_INTEGRATIONS_OPENAI_BASE_URL / AI_INTEGRATIONS_OPENAI_API_KEY) may add taste-led wording and comparisons of
--     certified plans with the twelve §12 tools; any model failure answers certified-only.
--
-- ── ORDER INDEPENDENCE (a gap number: applied at 3846 on a fresh replay, after 3999 on portava-ci and production) ──
-- It depends only on public.feature_flags (0118 and earlier; columns flag, enabled, description), which every file
-- above 3846 leaves in place: no file numbered above 3846 alters, drops or truncates feature_flags (3932 deletes one
-- other, named flag), and none names `layover_compass_assistant_enabled` (grep, 2026-10-18). A plain INSERT writes no
-- feature_flag_audit_log row (only toggle_feature_flag_with_audit does), so applying it leaves no history behind.
--
-- Rollback: db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql (refuses while the flag is TRUE
-- or while feature_flag_audit_log holds a row for it — 0118's ON DELETE CASCADE would erase that history).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '3846: public.feature_flags does not exist';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'feature_flags' AND column_name IN ('flag', 'enabled', 'description')) <> 3 THEN
    RAISE EXCEPTION '3846: public.feature_flags lacks one of flag / enabled / description';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_compass_assistant_enabled' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION '3846: layover_compass_assistant_enabled already exists and is not FALSE; this file seeds it OFF and will not overwrite an operator''s setting';
  END IF;
END
$pre$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_compass_assistant_enabled',
    false,
    'Layover Compass assistant (spec §12/§12.1/§25; census-layover L100, L102-L113, L268; owner decision 2026-10-18). ON: POST /api/airport/sessions/:id/compass lets the model (gpt-5-mini, the Compass OpenAI integration) add taste-led wording and comparisons of CERTIFIED plans after the certified text, using the twelve §12 tools (reads of the certified record; replan previews only; clarification asks, never writes). Every safety fact stays the certified text; model prose that widens the envelope, deadline, entry status, operational state or risk band is withdrawn (census-compass CL-02). Any model failure, timeout or rate limit answers certified-only. Costs one model call chain per question. OFF / absent / unreadable (the seed): certified text + airport facts only, no model call.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_compass_assistant_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3846): layover_compass_assistant_enabled is not present';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_compass_assistant_enabled' AND enabled IS NOT FALSE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3846): layover_compass_assistant_enabled is ON; it must ship OFF';
  END IF;
END
$post$;
