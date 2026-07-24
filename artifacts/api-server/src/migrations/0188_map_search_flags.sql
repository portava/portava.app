-- Migration 0188: feature flags for the unified map search + Compass map commands
--
-- Both OFF by default (fail-soft: the endpoints return { enabled:false, ... } and
-- the mobile client renders nothing until switched). No tables, no data — just
-- two flag rows. Idempotent (ON CONFLICT DO NOTHING); safe to re-run.
--
--   map_search_enabled          → GET  /api/map/search (normalized multi-entity
--                                  viewport search across travelers/gems/events)
--   map_compass_commands_enabled → POST /api/map/compass-command (validated
--                                  Compass→map command protocol)

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('map_search_enabled', FALSE,
   'Unified map search: normalized, viewport-bounded, block-filtered results across travelers, hidden gems, and events'),
  ('map_compass_commands_enabled', FALSE,
   'Compass→map structured command protocol: server-validated set-viewport/search-area/select/filter commands with server-resolved coordinates')
ON CONFLICT (flag) DO NOTHING;
