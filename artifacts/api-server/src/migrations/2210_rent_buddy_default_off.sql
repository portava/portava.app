-- 2210_rent_buddy_default_off.sql
--
-- Owner decision, 2026-08-31: Rent a Buddy must remain UNAVAILABLE by default —
-- off on any fresh install or restore — until an administrator explicitly
-- enables it, and only after KYC, payments, safety controls, moderation, and SOS
-- flows are launch-ready.
--
-- This corrects a real, latent defect. The intended default was FALSE
-- (0050_rent_a_buddy.sql:225 seeds `rent_buddy_enabled = false`), but
-- 0090_rent_buddy_rollout_tables.sql:187-192 later FORCES it TRUE:
--
--     INSERT INTO feature_flags (flag, enabled, ...) VALUES ('rent_buddy_enabled', TRUE, ...)
--     ON CONFLICT (flag) DO UPDATE SET enabled = TRUE;
--
-- so every clean migration run and every restore ends with the master switch ON,
-- which is why production carried `rent_buddy_enabled = true` while the feature is
-- not launch-ready. (0117_beta_feature_flags.sql:28 also lists it TRUE, but that
-- statement is ON CONFLICT DO NOTHING, so it is an inert no-op after 0090.)
--
-- This migration is the last word on the flag and RESTORES the intended default by
-- forcing it FALSE, superseding 0090. DO UPDATE (not DO NOTHING) so it corrects a
-- pre-existing TRUE row on apply and re-asserts the safe default after any restore.
-- Migrations do not re-run on a normal deploy, so an administrator's later, explicit
-- enable persists in ordinary operation; only a fresh install / restore resets to
-- this safe OFF default, at which point the admin re-enables when launch-ready.
--
-- Idempotent and safe to re-run.

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('rent_buddy_enabled', false, 'Master switch for Rent a Buddy — OFF by default until an admin enables it post-launch-readiness (2210 supersedes 0090''s forced TRUE)')
ON CONFLICT (flag) DO UPDATE SET enabled = false;
