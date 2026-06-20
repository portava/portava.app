-- 0012: Group chat support — trip threads and circle threads.
--
-- Extends message_threads with:
--   thread_type   — discriminator: 'direct' | 'trip' | 'circle'
--   trip_id       — FK → trips(id) for trip threads
--   circle_owner_id — FK → profiles(id): the circle owner for circle threads
--   title         — display name (trip name, circle name, etc.)
--
-- Extends message_thread_members with:
--   left_at       — when a user was removed / left the thread
--   role          — 'member' | 'owner' | 'admin' (mirrors trip role)
--
-- Unique constraints ensure one thread per trip and one per circle.
-- Backfills existing threads (all from Task #6) as 'direct'.

-- ── thread_type enum ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE thread_type_enum AS ENUM ('direct', 'trip', 'circle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Extend message_threads ───────────────────────────────────────────────────
ALTER TABLE message_threads
  ADD COLUMN IF NOT EXISTS thread_type  thread_type_enum NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS trip_id       UUID REFERENCES trips(id)    ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS circle_owner_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS title        TEXT;

-- Backfill existing rows (created by Task #6 direct-message flows).
UPDATE message_threads SET thread_type = 'direct' WHERE thread_type = 'direct';

-- ── Unique constraints (partial indexes) ─────────────────────────────────────
-- One thread per trip:
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_threads_unique_trip
  ON message_threads (trip_id)
  WHERE thread_type = 'trip' AND trip_id IS NOT NULL;

-- One thread per circle (identified by the circle owner):
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_threads_unique_circle
  ON message_threads (circle_owner_id)
  WHERE thread_type = 'circle' AND circle_owner_id IS NOT NULL;

-- ── Extend message_thread_members ────────────────────────────────────────────
ALTER TABLE message_thread_members
  ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS role    TEXT NOT NULL DEFAULT 'member';

-- ── Lookup indexes ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_message_threads_trip_id
  ON message_threads (trip_id) WHERE trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_threads_circle_owner_id
  ON message_threads (circle_owner_id) WHERE circle_owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thread_members_left_at
  ON message_thread_members (thread_id, user_id) WHERE left_at IS NULL;
