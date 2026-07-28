-- Migration 0106: Featured by Portava
-- Creates portava_featured_category enum, portava_featured table, and
-- adds featured_count to profiles.

-- ── Enum ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE portava_featured_category AS ENUM (
    'best_video',
    'best_hidden_gem',
    'best_nightlife',
    'best_restaurant',
    'best_adventure',
    'best_photo'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── portava_featured table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS portava_featured (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id                         uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  category                        portava_featured_category NOT NULL,
  featured_at                     timestamptz NOT NULL DEFAULT now(),
  approved_by                     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status                          text NOT NULL DEFAULT 'pending_permission'
                                    CHECK (status IN ('pending_permission', 'approved', 'declined', 'live')),
  creator_permission_requested_at timestamptz,
  creator_permission_granted_at   timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, category)
);

CREATE INDEX IF NOT EXISTS idx_portava_featured_status       ON portava_featured (status);
CREATE INDEX IF NOT EXISTS idx_portava_featured_category     ON portava_featured (category);
CREATE INDEX IF NOT EXISTS idx_portava_featured_post_id      ON portava_featured (post_id);
CREATE INDEX IF NOT EXISTS idx_portava_featured_featured_at  ON portava_featured (featured_at DESC);

-- ── featured_count on profiles ────────────────────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS featured_count integer NOT NULL DEFAULT 0;
