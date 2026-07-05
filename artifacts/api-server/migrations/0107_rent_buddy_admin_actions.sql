-- Migration 0107: rent_buddy_admin_actions — admin audit log table
-- This table is referenced by rentABuddy.ts and rentABuddyMarketplace.ts
-- admin routes (feature, unfeature, suspend, approve, etc.) but was absent
-- from prior migrations (0047–0051).  Applied here to close the gap.
--
-- Columns:
--   notes   TEXT  — human-readable note written by route handlers
--   details JSONB — structured metadata defined in database.types.ts
-- Both are kept so the existing route inserts (which use `notes`) and the
-- type definitions (which reference `details`) remain consistent.

CREATE TABLE IF NOT EXISTS rent_buddy_admin_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,   -- 'application'|'buddy'|'profile'|'package'|'user'
  target_id   TEXT NOT NULL,   -- UUID-shaped string of the affected entity
  action      TEXT NOT NULL,   -- free-form label e.g. 'approved', 'suspended', 'featured'
  notes       TEXT,            -- human-readable note (used by route inserts)
  details     JSONB,           -- structured metadata (defined in database.types.ts)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_admin_actions ENABLE ROW LEVEL SECURITY;

-- Service role can read and write; no direct user access
CREATE POLICY rb_admin_actions_svc ON rent_buddy_admin_actions
  FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_admin_actions_admin_idx
  ON rent_buddy_admin_actions (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS rb_admin_actions_target_idx
  ON rent_buddy_admin_actions (target_type, target_id);
