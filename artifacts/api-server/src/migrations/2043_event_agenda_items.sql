-- event_agenda_items: places and notes attached to an event by hosts or attendees.
--
-- Populated by POST /api/events/:id/agenda-items.
-- Any event host, co-host, or RSVP'd attendee can add an agenda item.
-- Items are visible to all event participants.
--
-- Columns:
--   id            — surrogate primary key
--   event_id      — parent event (cascade-deleted with the event)
--   added_by      — user who attached the item (nullable; SET NULL when user deleted)
--   title         — display name of the place or note
--   location_name — human-readable address / location string
--   location_lat  — WGS-84 latitude (nullable)
--   location_lng  — WGS-84 longitude (nullable)
--   place_id      — optional reference to a canonical place record
--   created_at    — insertion timestamp

CREATE TABLE IF NOT EXISTS event_agenda_items (
  id             uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid             NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  added_by       uuid             REFERENCES auth.users(id) ON DELETE SET NULL,
  title          text             NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  location_name  text,
  location_lat   double precision,
  location_lng   double precision,
  place_id       text,
  created_at     timestamptz      NOT NULL DEFAULT now()
);

-- Index for listing all items on an event (the primary access pattern)
CREATE INDEX IF NOT EXISTS event_agenda_items_event_id_idx
  ON event_agenda_items (event_id, created_at DESC);

-- RLS: row-level security mirrors event_posts (participant-scoped reads,
-- service-role writes from the API server).
ALTER TABLE event_agenda_items ENABLE ROW LEVEL SECURITY;

-- Service role bypass (API server uses service key)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'event_agenda_items'
      AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON event_agenda_items
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
