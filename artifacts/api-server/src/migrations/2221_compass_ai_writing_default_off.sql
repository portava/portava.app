-- 2221_compass_ai_writing_default_off.sql
--
-- Phase 7 (Compass + AI, backend): wire the previously-inert `compass_ai_enabled`
-- flag as the OPT-IN capability gate for AI-assisted writing (§22) and the Compass
-- prompt AI continuation (§56), and RESTORE a safe OFF default.
--
-- WHY OFF BY DEFAULT
-- ------------------
-- AI-assisted writing is safety/product-sensitive: it proposes editable caption /
-- description / title / prompt text via the existing Compass AI. The suggestion is
-- never auto-applied or published, is provenance-marked (source:'ai'), and creates
-- no canonical fact — but the capability itself must be opt-in and off until an
-- administrator turns it on, matching the standing "keep independent-purpose gates
-- for safety-sensitive features" policy.
--
-- HISTORY
-- -------
-- 0117_beta_feature_flags.sql:36 seeds `compass_ai_enabled = TRUE`, but nothing in
-- the codebase read it — it was an inert, always-true admin-list entry (recorded
-- as a "wire or drop" item in scripts/check-flag-polarity.mjs). Phase 7 WIRES it:
-- lib/inputAssistance/aiWriting.ts reads it fail-closed via the shared isFlagEnabled
-- (an unreadable flag ⇒ AI writing OFF, the safe direction). This migration is the
-- last word on the seed and forces it FALSE (DO UPDATE, not DO NOTHING) so a fresh
-- install / restore ends with the gate OFF, superseding 0117's TRUE. An
-- administrator's later explicit enable persists in ordinary operation; only a
-- fresh install / restore resets to this safe default.
--
-- No tables, no data — one flag row. Idempotent; safe to re-run.

INSERT INTO feature_flags (flag, enabled, description)
VALUES (
  'compass_ai_enabled',
  false,
  'Opt-in capability gate for AI-assisted writing (§22) + Compass prompt AI continuation (§56) — OFF by default until an admin enables it; read fail-closed by lib/inputAssistance/aiWriting.ts. Supersedes 0117''s TRUE seed.'
)
ON CONFLICT (flag) DO UPDATE SET enabled = false;
