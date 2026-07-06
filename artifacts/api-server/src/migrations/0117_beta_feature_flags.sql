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
--   city_launch_mode             — restrict access to launch cities only
--   invite_only_beta             — require an invite code to register
--
-- Feature gates (default: enabled / true):
--   compass_ai_enabled           — Compass AI recommendation engine
--
-- Note: find_your_circle_enabled and find_your_circle_disabled were seeded in
-- migration 0108_circle_schema_tracked.sql and are not repeated here.
-- COMPASS_ENABLED and other COMPASS_* flags are seeded in 0051; compass_ai_enabled
-- is the simpler alias consumed by kill-switch checks.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('disable_signups',            FALSE, 'Kill switch — blocks all new account registrations'),
  ('disable_posting',            FALSE, 'Kill switch — blocks POST /posts app-wide'),
  ('disable_messaging',          FALSE, 'Kill switch — blocks POST /threads/:id/messages app-wide'),
  ('disable_rent_buddy_booking', FALSE, 'Kill switch — blocks Rent a Buddy booking creation'),
  ('city_launch_mode',           FALSE, 'Feature gate — restricts access to seeded launch cities only'),
  ('invite_only_beta',           FALSE, 'Feature gate — requires invite code to register (beta access)'),
  ('compass_ai_enabled',         TRUE,  'Feature gate — Compass AI recommendation engine')
ON CONFLICT (flag) DO NOTHING;
