-- ============================================================
-- Migration 0069: Collections & Saves
-- ============================================================
-- Creates a unified save/collection system across all entity
-- types. Existing user_saves (profiles) and discovery_place_saves
-- data are backfilled into the new tables.
-- ============================================================

-- Entity type enum
DO $$ BEGIN
  CREATE TYPE collection_entity_type AS ENUM (
    'post', 'event', 'trip', 'memory', 'highlight',
    'place', 'profile', 'hashtag'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── collections ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collections (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  cover_url   TEXT        NULL,
  position    INTEGER     NOT NULL DEFAULT 0,
  is_default  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collections_owner_position_idx
  ON collections (owner_id, position);

-- Only one default collection per user
CREATE UNIQUE INDEX IF NOT EXISTS collections_owner_default_idx
  ON collections (owner_id) WHERE is_default = TRUE;

ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owner manages own collections" ON collections;
CREATE POLICY "Owner manages own collections"
  ON collections FOR ALL
  USING  (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ── collection_items ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_items (
  id              UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id   UUID                    NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  entity_type     collection_entity_type  NOT NULL,
  entity_id       UUID                    NOT NULL,
  saved_at        TIMESTAMPTZ             NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS collection_items_dedup_idx
  ON collection_items (collection_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS collection_items_collection_saved_idx
  ON collection_items (collection_id, saved_at DESC);

ALTER TABLE collection_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owner manages own collection items" ON collection_items;
CREATE POLICY "Owner manages own collection items"
  ON collection_items FOR ALL
  USING  (EXISTS (
    SELECT 1 FROM collections c
    WHERE c.id = collection_items.collection_id
      AND c.owner_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM collections c
    WHERE c.id = collection_items.collection_id
      AND c.owner_id = auth.uid()
  ));

-- ── Backfill: user_saves → collection_items ───────────────────────────────────
-- For each unique saver_id in user_saves, create a default "Saved" collection
-- (if one doesn't exist yet) and insert the profile saves as items.
DO $$
DECLARE
  rec RECORD;
  col_id UUID;
BEGIN
  FOR rec IN
    SELECT DISTINCT saver_id FROM user_saves
  LOOP
    -- Ensure default collection exists
    INSERT INTO collections (owner_id, name, is_default, position)
    VALUES (rec.saver_id, 'Saved', TRUE, 0)
    ON CONFLICT DO NOTHING;

    SELECT id INTO col_id FROM collections
    WHERE owner_id = rec.saver_id AND is_default = TRUE
    LIMIT 1;

    IF col_id IS NOT NULL THEN
      INSERT INTO collection_items (collection_id, entity_type, entity_id, saved_at)
      SELECT col_id, 'profile'::collection_entity_type, saved_id, created_at
      FROM user_saves
      WHERE saver_id = rec.saver_id
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- ── Backfill: discovery_place_saves → collection_items ────────────────────────
DO $$
DECLARE
  rec RECORD;
  col_id UUID;
BEGIN
  FOR rec IN
    SELECT DISTINCT user_id FROM discovery_place_saves
  LOOP
    -- Ensure default collection exists
    INSERT INTO collections (owner_id, name, is_default, position)
    VALUES (rec.user_id, 'Saved', TRUE, 0)
    ON CONFLICT DO NOTHING;

    SELECT id INTO col_id FROM collections
    WHERE owner_id = rec.user_id AND is_default = TRUE
    LIMIT 1;

    IF col_id IS NOT NULL THEN
      INSERT INTO collection_items (collection_id, entity_type, entity_id, saved_at)
      SELECT col_id, 'place'::collection_entity_type, place_id, created_at
      FROM discovery_place_saves
      WHERE user_id = rec.user_id
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;
