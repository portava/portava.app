-- Enable passport stamps and memories feature flags.
-- Migrations 0037 and 0042 seeded passport_stamps_enabled and
-- passport_memories_enabled as false (feature-gate defaults for initial
-- rollout). Enable them here for all environments reaching this migration.
-- Also enables stamp_system_v2_enabled and stamp_admin_award_enabled seeded
-- as false by migration 0081.
-- Safe to re-run: ON CONFLICT DO UPDATE is idempotent.

INSERT INTO feature_flags (flag, enabled, description)
VALUES
  ('passport_stamps_enabled',    true, 'Passport stamps feature'),
  ('passport_memories_enabled',  true, 'Passport memories feature'),
  ('stamp_system_v2_enabled',    true, 'Stamp system v2 (user_stamps table)'),
  ('stamp_admin_award_enabled',  true, 'Admin stamp award endpoint')
ON CONFLICT (flag) DO UPDATE SET enabled = true;
