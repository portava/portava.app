-- Migration: place_votes — Worth-It / Skip-It voting for places and hidden gems
-- Separate lightweight vote distinct from a star-rating review.
-- entity_type IN ('place', 'gem') maps to discovery_places and hidden_gems respectively.
-- One vote per user per entity; re-posting replaces the existing vote (upsert).

CREATE TABLE IF NOT EXISTS place_votes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT        NOT NULL,
  entity_id   TEXT        NOT NULL,
  vote        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT  place_votes_entity_type_check CHECK (entity_type IN ('place', 'gem')),
  CONSTRAINT  place_votes_vote_check        CHECK (vote IN ('worth_it', 'skip_it')),
  UNIQUE (user_id, entity_type, entity_id)
);

-- Fast aggregate queries (count by entity + vote)
CREATE INDEX IF NOT EXISTS place_votes_entity_idx
  ON place_votes (entity_type, entity_id, vote);

-- RLS: authenticated users can read all votes, write/delete only their own.
ALTER TABLE place_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "place_votes_select_all"
  ON place_votes FOR SELECT
  USING (true);

CREATE POLICY "place_votes_insert_own"
  ON place_votes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "place_votes_update_own"
  ON place_votes FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "place_votes_delete_own"
  ON place_votes FOR DELETE
  USING (auth.uid() = user_id);
