-- media_ranking_snapshots: delivery-time ranking reason snapshot per item per viewer session.
--
-- Populated by storeRankingSnapshots() in MediaFeedRankingService.ts (fire-and-forget,
-- gated by MEDIA_RANKING_ENABLED). Read by the "Why This?" surface — stored reasons are
-- returned directly, never recomputed at read time.
--
-- Columns:
--   viewer_id    — the viewing user
--   item_id      — the ranked media item (post id)
--   session_id   — opaque feed session identifier
--   surface      — feed surface (watch_feed | grid_feed | gems_feed)
--   position     — rank position in this delivery (0-indexed)
--   final_score  — composite portavaRank score at delivery time
--   reason_codes — top-3 human-readable reason codes (e.g. ["match_interests","new_creator"])
--   served_at    — server timestamp when the item was ranked and served
--
-- Primary key is (viewer_id, item_id, session_id) — matches the onConflict target in
-- storeRankingSnapshots() so a re-delivery in the same session updates the snapshot
-- rather than inserting a duplicate.

CREATE TABLE IF NOT EXISTS media_ranking_snapshots (
  viewer_id    uuid        NOT NULL,
  item_id      uuid        NOT NULL,
  session_id   text        NOT NULL,
  surface      text        NOT NULL DEFAULT 'watch_feed',
  position     int         NOT NULL DEFAULT 0,
  final_score  float       NOT NULL DEFAULT 0,
  reason_codes jsonb       NOT NULL DEFAULT '[]',
  served_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (viewer_id, item_id, session_id)
);

-- Index for "Why This?" reads (viewer looks up their own snapshot for a post)
CREATE INDEX IF NOT EXISTS media_ranking_snapshots_viewer_item_idx
  ON media_ranking_snapshots (viewer_id, item_id, served_at DESC);

-- RLS: service role writes; viewer can read their own rows
ALTER TABLE media_ranking_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'media_ranking_snapshots'
      AND policyname = 'mrs_viewer_select'
  ) THEN
    CREATE POLICY mrs_viewer_select ON media_ranking_snapshots
      FOR SELECT USING (viewer_id = auth.uid());
  END IF;
END $$;
