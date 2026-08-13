-- 0117_beta_feature_flags.sql
-- Seeds beta-phase kill-switch and feature-gate flags.
-- All statements use ON CONFLICT DO NOTHING so re-runs are safe and
-- existing rows (enabled or disabled) are never overwritten.
--
-- Kill switches (default: disabled / false):
--   disable_signups              — stop all new account registrations
--   disable_posting              — block POST /posts app-wide
--   disable_messaging            — block POST /threads/:id/messages app-wide
--   disable_rent_buddy_booking   — block Rent a Buddy booking creation
--   invite_only_beta             — require an invite code to register
--
-- city_launch_mode was seeded here until 2087_retire_city_launch_mode.sql
-- retired it (owner ruling 2026-08-13: banner-only kill switch, no server
-- enforcement). Its seed is removed so a replayed database never re-creates
-- the row 2087 deletes.
--
-- Feature gates (default: enabled / true):
--   compass_ai_enabled           — Compass AI recommendation engine
--
-- Note: find_your_circle_enabled and find_your_circle_disabled were seeded in
-- migration 0108_circle_schema_tracked.sql and are not repeated here.
-- COMPASS_ENABLED and other COMPASS_* flags are seeded in 0051; compass_ai_enabled
-- is the simpler alias consumed by kill-switch checks.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  -- ── Feature gates (enabled by default) ──────────────────────────────────────
  ('rent_buddy_enabled',              TRUE,  'Feature gate — Rent a Buddy is available in launch cities'),
  ('safe_return_live_share_enabled',  TRUE,  'Feature gate — Safe Return live location share'),
  ('find_your_circle_enabled',        TRUE,  'Feature gate — Find Your Circle social discovery'),
  ('compass_ai_enabled',              TRUE,  'Feature gate — Compass AI recommendation engine'),
  ('hidden_gems_enabled',             TRUE,  'Feature gate — Hidden Gems discovery feed'),
  ('push_notifications_enabled',      TRUE,  'Feature gate — push notification delivery'),
  -- ── Kill switches (disabled by default) ──────────────────────────────────────
  ('disable_signups',                 FALSE, 'Kill switch — blocks new account registrations; checked by GET /auth/signup-status'),
  ('disable_posting',                 FALSE, 'Kill switch — blocks POST /posts app-wide'),
  ('disable_messaging',               FALSE, 'Kill switch — blocks POST /threads/:id/messages app-wide'),
  ('disable_rent_buddy_booking',       FALSE, 'Kill switch — blocks Rent a Buddy booking creation (POST /api/rent-a-buddy/bookings)'),
  ('invite_only_beta',                FALSE, 'Kill switch/gate — requires invite code to register; checked by GET /auth/signup-status')
ON CONFLICT (flag) DO NOTHING;
