-- Migration 2201: feature flag for the Map Intelligence Gateway
--
-- OFF by default and fail-soft: GET /api/map/projection returns
-- { enabled:false, objects:[] } while the flag is off, and the mobile client
-- keeps its existing per-layer fetch path. Nothing changes for users until the
-- flag is switched on, so this is safe to apply ahead of the client rollout.
--
-- No tables, no data — one flag row. Idempotent; safe to re-run.
--
--   map_projection_enabled → GET /api/map/projection (Map spec §19: one
--                            server-side projection of the viewport into ranked,
--                            privacy-classed, freshness/confidence-carrying
--                            MapObjects, replacing the client-side merge of
--                            five independent per-layer fetches)

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('map_projection_enabled', FALSE,
   'Map Intelligence Gateway: one viewport-bounded projection endpoint returning ranked MapObjects with freshness, confidence band, privacy class and rendering priority, sourced from the existing privacy-complete traveler/gem/event readers')
ON CONFLICT (flag) DO NOTHING;
