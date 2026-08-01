-- Worth-It / Skip-It votes for discovery_places and hidden_gems.
--
-- One vote per user per entity (enforced by the unique constraint on
-- user_id + entity_type + entity_id). vote=null is handled by DELETE
-- rather than a null row — no null vote rows are stored.
--
-- entity_type: 'place' (discovery_places / canonical places) | 'gem' (hidden_gems)
-- vote:        'worth_it' | 'skip_it'

CREATE TABLE IF NOT EXISTS place_votes (
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entity_type  TEXT        NOT NULL CHECK (entity_type IN ('place', 'gem')),
  entity_id    TEXT        NOT NULL,
  vote         TEXT        NOT NULL CHECK (vote IN ('worth_it', 'skip_it')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT place_votes_pkey PRIMARY KEY (user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS place_votes_entity_idx
  ON place_votes (entity_type, entity_id);

-- RLS: users manage their own votes; service role reads all (for tally queries).
ALTER TABLE place_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY place_votes_own_crud ON place_votes
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
