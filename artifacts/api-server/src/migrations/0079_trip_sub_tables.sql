-- =============================================================================
-- 0079_trip_sub_tables.sql
-- New trip sub-resource tables: budget, documents, join_requests, invite_links,
-- saved_places, notes, checklists, checklist_items, activity_log, reminders,
-- destinations.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- trip_budget  (one row per trip — upsert pattern)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_budget (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID        NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  currency    TEXT        NOT NULL DEFAULT 'USD',
  total_budget NUMERIC(12,2),
  spent       NUMERIC(12,2) NOT NULL DEFAULT 0,
  breakdown   JSONB        NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
ALTER TABLE trip_budget ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_budget_owner ON trip_budget;
CREATE POLICY trip_budget_owner ON trip_budget
  USING (EXISTS (
    SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- trip_documents  (private by default)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_documents (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  creator_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  content       TEXT,
  document_type TEXT        NOT NULL DEFAULT 'note'
      CHECK (document_type IN ('note','itinerary','packing_list','visa','insurance','other')),
  is_private    BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trip_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_documents_members ON trip_documents;
CREATE POLICY trip_documents_members ON trip_documents FOR SELECT
  USING (can_see_trip(trip_id) AND (is_private = false OR creator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())));
DROP POLICY IF EXISTS trip_documents_insert ON trip_documents;
CREATE POLICY trip_documents_insert ON trip_documents FOR INSERT
  WITH CHECK (creator_id = auth.uid() AND can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_documents_update ON trip_documents;
CREATE POLICY trip_documents_update ON trip_documents FOR UPDATE
  USING (creator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid()));
DROP POLICY IF EXISTS trip_documents_delete ON trip_documents;
CREATE POLICY trip_documents_delete ON trip_documents FOR DELETE
  USING (creator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid()));
CREATE INDEX IF NOT EXISTS trip_documents_trip_idx ON trip_documents(trip_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- trip_join_requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_join_requests (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','approved','declined','cancelled')),
  message      TEXT        CHECK (char_length(message) <= 500),
  reviewed_by  UUID        REFERENCES profiles(id),
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id)
);
ALTER TABLE trip_join_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_join_requests_select ON trip_join_requests;
CREATE POLICY trip_join_requests_select ON trip_join_requests FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM trip_members m WHERE m.trip_id = trip_join_requests.trip_id
               AND m.user_id = auth.uid() AND m.role IN ('co_host'))
  );
DROP POLICY IF EXISTS trip_join_requests_insert ON trip_join_requests;
CREATE POLICY trip_join_requests_insert ON trip_join_requests FOR INSERT
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS trip_join_requests_update ON trip_join_requests;
CREATE POLICY trip_join_requests_update ON trip_join_requests FOR UPDATE
  USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())
  );
CREATE INDEX IF NOT EXISTS trip_join_requests_trip_idx   ON trip_join_requests(trip_id, status);
CREATE INDEX IF NOT EXISTS trip_join_requests_user_idx   ON trip_join_requests(user_id, status);

-- ---------------------------------------------------------------------------
-- trip_invite_links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_invite_links (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE,
  created_by  UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  max_uses    INTEGER,
  use_count   INTEGER     NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trip_invite_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_invite_links_owner ON trip_invite_links;
CREATE POLICY trip_invite_links_owner ON trip_invite_links
  USING (
    created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())
  );
DROP POLICY IF EXISTS trip_invite_links_public_read ON trip_invite_links;
CREATE POLICY trip_invite_links_public_read ON trip_invite_links FOR SELECT
  USING (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()));
CREATE INDEX IF NOT EXISTS trip_invite_links_trip_idx   ON trip_invite_links(trip_id);
CREATE INDEX IF NOT EXISTS trip_invite_links_token_idx  ON trip_invite_links(token);

-- ---------------------------------------------------------------------------
-- trip_saved_places  (per-user bookmarks within a trip)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_saved_places (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  place_id    TEXT,
  place_name  TEXT        NOT NULL,
  place_type  TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  notes       TEXT        CHECK (char_length(notes) <= 500),
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id, place_id)
);
ALTER TABLE trip_saved_places ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_saved_places_members ON trip_saved_places;
CREATE POLICY trip_saved_places_members ON trip_saved_places FOR SELECT
  USING (can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_saved_places_insert ON trip_saved_places;
CREATE POLICY trip_saved_places_insert ON trip_saved_places FOR INSERT
  WITH CHECK (user_id = auth.uid() AND can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_saved_places_delete ON trip_saved_places;
CREATE POLICY trip_saved_places_delete ON trip_saved_places FOR DELETE
  USING (user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid()));
CREATE INDEX IF NOT EXISTS trip_saved_places_trip_idx  ON trip_saved_places(trip_id, saved_at DESC);
CREATE INDEX IF NOT EXISTS trip_saved_places_user_idx  ON trip_saved_places(user_id);

-- ---------------------------------------------------------------------------
-- trip_notes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_notes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  author_id  UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title      TEXT        CHECK (char_length(title) <= 200),
  content    TEXT        NOT NULL,
  is_private BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trip_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_notes_select ON trip_notes;
CREATE POLICY trip_notes_select ON trip_notes FOR SELECT
  USING (can_see_trip(trip_id) AND (
    is_private = false
    OR author_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())
  ));
DROP POLICY IF EXISTS trip_notes_insert ON trip_notes;
CREATE POLICY trip_notes_insert ON trip_notes FOR INSERT
  WITH CHECK (author_id = auth.uid() AND can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_notes_update ON trip_notes;
CREATE POLICY trip_notes_update ON trip_notes FOR UPDATE
  USING (author_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid()));
DROP POLICY IF EXISTS trip_notes_delete ON trip_notes;
CREATE POLICY trip_notes_delete ON trip_notes FOR DELETE
  USING (author_id = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid()));
CREATE INDEX IF NOT EXISTS trip_notes_trip_idx ON trip_notes(trip_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- trip_checklists + trip_checklist_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_checklists (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  created_by UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trip_checklists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_checklists_members ON trip_checklists;
CREATE POLICY trip_checklists_members ON trip_checklists
  USING (can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_checklists_insert ON trip_checklists;
CREATE POLICY trip_checklists_insert ON trip_checklists FOR INSERT
  WITH CHECK (created_by = auth.uid() AND can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_checklists_delete ON trip_checklists;
CREATE POLICY trip_checklists_delete ON trip_checklists FOR DELETE
  USING (created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid()));
CREATE INDEX IF NOT EXISTS trip_checklists_trip_idx ON trip_checklists(trip_id);

CREATE TABLE IF NOT EXISTS trip_checklist_items (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id UUID        NOT NULL REFERENCES trip_checklists(id) ON DELETE CASCADE,
  trip_id      UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  label        TEXT        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 300),
  is_done      BOOLEAN     NOT NULL DEFAULT false,
  assigned_to  UUID        REFERENCES profiles(id),
  due_date     DATE,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trip_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_checklist_items_members ON trip_checklist_items;
CREATE POLICY trip_checklist_items_members ON trip_checklist_items
  USING (can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_checklist_items_insert ON trip_checklist_items;
CREATE POLICY trip_checklist_items_insert ON trip_checklist_items FOR INSERT
  WITH CHECK (can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_checklist_items_update ON trip_checklist_items;
CREATE POLICY trip_checklist_items_update ON trip_checklist_items FOR UPDATE
  USING (can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_checklist_items_delete ON trip_checklist_items;
CREATE POLICY trip_checklist_items_delete ON trip_checklist_items FOR DELETE
  USING (can_see_trip(trip_id));
CREATE INDEX IF NOT EXISTS trip_checklist_items_list_idx ON trip_checklist_items(checklist_id, sort_order);

-- ---------------------------------------------------------------------------
-- trip_activity_log  (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_activity_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  actor_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type TEXT        NOT NULL,
  metadata   JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trip_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_activity_log_select ON trip_activity_log;
CREATE POLICY trip_activity_log_select ON trip_activity_log FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM trip_members m
               WHERE m.trip_id = trip_activity_log.trip_id
               AND m.user_id = auth.uid()
               AND m.role IN ('owner','co_host'))
  );
CREATE INDEX IF NOT EXISTS trip_activity_log_trip_idx ON trip_activity_log(trip_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- trip_reminders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_reminders (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  remind_at  TIMESTAMPTZ NOT NULL,
  is_sent    BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trip_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_reminders_own ON trip_reminders;
CREATE POLICY trip_reminders_own ON trip_reminders
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS trip_reminders_insert ON trip_reminders;
CREATE POLICY trip_reminders_insert ON trip_reminders FOR INSERT
  WITH CHECK (user_id = auth.uid() AND can_see_trip(trip_id));
CREATE INDEX IF NOT EXISTS trip_reminders_trip_idx ON trip_reminders(trip_id);
CREATE INDEX IF NOT EXISTS trip_reminders_remind_idx ON trip_reminders(remind_at) WHERE is_sent = false;

-- ---------------------------------------------------------------------------
-- trip_destinations  (multi-city — schema-ready, routes cover primary only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_destinations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  city            TEXT        NOT NULL,
  country         TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  place_id        TEXT,
  arrival_date    DATE,
  departure_date  DATE,
  position        INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trip_destinations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_destinations_select ON trip_destinations;
CREATE POLICY trip_destinations_select ON trip_destinations FOR SELECT
  USING (can_see_trip(trip_id));
DROP POLICY IF EXISTS trip_destinations_manage ON trip_destinations;
CREATE POLICY trip_destinations_manage ON trip_destinations
  USING (EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id AND t.owner_id = auth.uid()));
CREATE INDEX IF NOT EXISTS trip_destinations_trip_idx ON trip_destinations(trip_id, position);
