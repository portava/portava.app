-- Add optional trip_id to hidden_gems so gems can be linked to a specific trip
-- at submission time from the Add a Gem form.
ALTER TABLE hidden_gems
  ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hidden_gems_trip_id ON hidden_gems (trip_id)
  WHERE trip_id IS NOT NULL;
