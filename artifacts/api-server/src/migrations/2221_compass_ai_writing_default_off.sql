-- 2221_compass_ai_writing_default_off.sql
--
-- Phase 7 (Compass + AI, backend): introduce a DEDICATED opt-in capability gate
-- for AI-assisted writing (§22) + the Compass-prompt AI continuation (§56),
-- seeded OFF.
--
-- WHY A DEDICATED FLAG (not `compass_ai_enabled`)
-- ----------------------------------------------
-- AI-assisted writing is a DISTINCT capability from the Compass AI recommendation
-- engine that `compass_ai_enabled` (0117_beta_feature_flags.sql:36) nominally
-- gates. Conflating them under one flag would mean enabling the recommendation
-- engine also enables the more safety-sensitive writing path (or vice-versa).
-- This migration keeps `compass_ai_enabled` UNTOUCHED and adds a separate
-- `compass_ai_writing_enabled` gate so the two capabilities can be turned on
-- independently by an administrator.
--
-- WHY OFF BY DEFAULT
-- ------------------
-- AI-assisted writing proposes editable caption / description / title / prompt
-- text via the EXISTING Compass AI (no new provider). The suggestion is never
-- auto-applied or published, is provenance-marked (source:'ai'), and creates no
-- canonical fact — but the capability itself must be opt-in and OFF until an
-- administrator turns it on (the standing "independent-purpose gate for a
-- safety-sensitive feature" policy). lib/inputAssistance/aiWriting.ts reads this
-- flag fail-closed via the shared isFlagEnabled (unreadable ⇒ OFF, the safe
-- direction).
--
-- No tables, no data — one flag row. `ON CONFLICT DO NOTHING` so a re-run never
-- overrides an administrator's later explicit enable. Idempotent; safe to re-run.

INSERT INTO feature_flags (flag, enabled, description)
VALUES (
  'compass_ai_writing_enabled',
  false,
  'Opt-in capability gate for AI-assisted writing (§22) + Compass prompt AI continuation (§56). OFF by default until an admin enables it; read fail-closed by lib/inputAssistance/aiWriting.ts. Separate from compass_ai_enabled (the recommendation-engine gate) so the two AI capabilities gate independently.'
)
ON CONFLICT (flag) DO NOTHING;
