-- 0101_search_history.sql
-- Creates search_history table for storing per-user recent search terms.
-- Service role writes via POST /api/me/search-history.
-- Users read/delete their own rows via RLS.

CREATE TABLE IF NOT EXISTS search_history (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  query        text        NOT NULL CHECK (char_length(query) >= 1 AND char_length(query) <= 200),
  search_type  text        NOT NULL DEFAULT 'all',
  searched_at  timestamptz NOT NULL DEFAULT now()
);

-- Unique per user+query+type so upsert (ON CONFLICT) refreshes searched_at
CREATE UNIQUE INDEX IF NOT EXISTS search_history_user_q_type_uidx
  ON search_history(user_id, query, search_type);

-- Fast descending lookup for the recent-searches list
CREATE INDEX IF NOT EXISTS search_history_user_searched_at_idx
  ON search_history(user_id, searched_at DESC);

ALTER TABLE search_history ENABLE ROW LEVEL SECURITY;

-- Users read and delete their own rows; service role handles all writes
DO $$ BEGIN
  DROP POLICY IF EXISTS "sh_own_select" ON search_history;
  CREATE POLICY "sh_own_select" ON search_history
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "sh_own_delete" ON search_history;
  CREATE POLICY "sh_own_delete" ON search_history
    FOR DELETE USING (user_id = auth.uid());
EXCEPTION WHEN others THEN NULL; END $$;
