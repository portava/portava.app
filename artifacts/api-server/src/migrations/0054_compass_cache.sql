-- ============================================================
-- Migration 0054: Compass Phase 4 — Cache & Front Load tables
-- ============================================================
-- Tables created:
--   compass_feed_cache               — cached feed payloads with per-type TTLs
--   compass_preload_queue            — items queued for background preloading
--   compass_preload_events           — client navigation events
--   compass_cache_invalidations      — audit log of every cache invalidation
--   compass_user_navigation_patterns — aggregated nav patterns for manifest ranking
--   compass_content_freshness        — per-item staleness tracking
--   compass_media_preload_manifest   — media URLs the client should prefetch
--   compass_frontload_rules          — configurable tier-assignment rules
-- ============================================================

-- ── compass_feed_cache ────────────────────────────────────────────────────────
-- Stores cached feed/section payloads per user. TTL is enforced by expires_at;
-- a background job (or on-read check) purges stale rows.
-- entry_type drives TTL selection in the application layer:
--   'safety'     → TTL = 0  (never stored here; always live)
--   'booking'    → TTL = 30 s
--   'feed'       → TTL = 5 min
--   'section'    → TTL = 2 min
--   'city_guide' → TTL = 4 h
CREATE TABLE IF NOT EXISTS compass_feed_cache (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  cache_key   TEXT        NOT NULL,
  entry_type  TEXT        NOT NULL
                CHECK (entry_type IN ('feed','section','city_guide','booking','frontload','safety')),
  payload     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, cache_key)
);

ALTER TABLE compass_feed_cache ENABLE ROW LEVEL SECURITY;
-- Authenticated users may read only their own cached rows.
-- All writes (upsert, delete) go through the API server using the service role,
-- which bypasses RLS automatically — no service_all policy needed.
CREATE POLICY compass_feed_cache_select ON compass_feed_cache
  FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS compass_feed_cache_user_key_idx
  ON compass_feed_cache (user_id, cache_key);
CREATE INDEX IF NOT EXISTS compass_feed_cache_expires_idx
  ON compass_feed_cache (expires_at);

-- ── compass_preload_queue ─────────────────────────────────────────────────────
-- Items queued by the Front Load Engine for deferred preloading.
-- completed_at NULL means the item is still pending.
CREATE TABLE IF NOT EXISTS compass_preload_queue (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id        TEXT        NOT NULL,
  tier           INTEGER     NOT NULL CHECK (tier BETWEEN 0 AND 3),
  priority       NUMERIC(8,4) NOT NULL DEFAULT 0,
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compass_preload_queue ENABLE ROW LEVEL SECURITY;
-- Service role only — no direct auth-role access needed for this internal queue.

CREATE INDEX IF NOT EXISTS compass_preload_queue_user_pending_idx
  ON compass_preload_queue (user_id, tier) WHERE completed_at IS NULL;

-- ── compass_preload_events ────────────────────────────────────────────────────
-- Raw client navigation events sent by POST /api/compass/frontload/event.
-- Aggregated periodically into compass_user_navigation_patterns.
CREATE TABLE IF NOT EXISTS compass_preload_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  screen_name  TEXT        NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compass_preload_events ENABLE ROW LEVEL SECURITY;
-- Users may only insert their own navigation events.
-- All reads and deletes (cleanup jobs) go through the service role.
CREATE POLICY compass_preload_events_insert ON compass_preload_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS compass_preload_events_user_idx
  ON compass_preload_events (user_id, occurred_at DESC);

-- ── compass_cache_invalidations ───────────────────────────────────────────────
-- Append-only audit log. One row per invalidation call.
CREATE TABLE IF NOT EXISTS compass_cache_invalidations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason          TEXT        NOT NULL,
  affected_keys   TEXT[]      NOT NULL DEFAULT '{}',
  invalidated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compass_cache_invalidations ENABLE ROW LEVEL SECURITY;
-- Append-only audit log — service role writes only; no direct auth-role access.

CREATE INDEX IF NOT EXISTS compass_cache_invalidations_user_idx
  ON compass_cache_invalidations (user_id, invalidated_at DESC);

-- ── compass_user_navigation_patterns ─────────────────────────────────────────
-- Aggregated screen transition counts used to rank the preload manifest.
-- (user_id, from_screen, to_screen) is the natural compound key.
CREATE TABLE IF NOT EXISTS compass_user_navigation_patterns (
  user_id          UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_screen      TEXT        NOT NULL,
  to_screen        TEXT        NOT NULL,
  transition_count INTEGER     NOT NULL DEFAULT 1,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, from_screen, to_screen)
);

ALTER TABLE compass_user_navigation_patterns ENABLE ROW LEVEL SECURITY;
-- Service role only — pattern aggregation is internal to the API server.

CREATE INDEX IF NOT EXISTS compass_user_navigation_patterns_user_count_idx
  ON compass_user_navigation_patterns (user_id, transition_count DESC);

-- ── compass_content_freshness ─────────────────────────────────────────────────
-- Tracks when an item was last confirmed fresh, enabling cheap staleness checks.
CREATE TABLE IF NOT EXISTS compass_content_freshness (
  item_id         TEXT        PRIMARY KEY,
  item_type       TEXT        NOT NULL,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_stale        BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compass_content_freshness ENABLE ROW LEVEL SECURITY;
-- Service role only — staleness tracking is internal; no client reads needed.

-- ── compass_media_preload_manifest ────────────────────────────────────────────
-- Media URLs (images, video thumbnails) the client should prefetch.
-- Populated by the Front Load Engine for Tier 1+ items on Wi-Fi.
CREATE TABLE IF NOT EXISTS compass_media_preload_manifest (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  media_type  TEXT        NOT NULL CHECK (media_type IN ('image','video','audio')),
  priority    INTEGER     NOT NULL DEFAULT 0,
  tier        INTEGER     NOT NULL CHECK (tier BETWEEN 0 AND 3),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compass_media_preload_manifest ENABLE ROW LEVEL SECURITY;
-- Users may read only their own preload manifest entries.
-- All writes go through the service role.
CREATE POLICY compass_media_preload_manifest_select ON compass_media_preload_manifest
  FOR SELECT USING (auth.uid() = user_id);

-- Plain index on expires_at (no partial index predicate — now() is not immutable in Postgres)
CREATE INDEX IF NOT EXISTS compass_media_preload_manifest_user_tier_idx
  ON compass_media_preload_manifest (user_id, tier, priority DESC);
CREATE INDEX IF NOT EXISTS compass_media_preload_manifest_expires_idx
  ON compass_media_preload_manifest (expires_at);

-- ── compass_frontload_rules ───────────────────────────────────────────────────
-- Operator-configurable rules controlling which data goes in which tier.
CREATE TABLE IF NOT EXISTS compass_frontload_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name   TEXT        NOT NULL UNIQUE,
  tier        INTEGER     NOT NULL CHECK (tier BETWEEN 0 AND 3),
  conditions  JSONB       NOT NULL DEFAULT '{}',
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compass_frontload_rules ENABLE ROW LEVEL SECURITY;
-- Authenticated users may read operator-configured tier rules (public config).
-- Only the service role may write rules.
CREATE POLICY compass_frontload_rules_select ON compass_frontload_rules
  FOR SELECT USING (true);

-- Seed default tier rules
INSERT INTO compass_frontload_rules (rule_name, tier, conditions) VALUES
  ('safety_state',      0, '{"description": "auth, blocks, suspensions, privacy settings"}'),
  ('feature_flags',     0, '{"description": "all COMPASS_* feature flags"}'),
  ('active_booking',    0, '{"description": "current rent-a-buddy booking status"}'),
  ('first_feed_page',   1, '{"description": "first 20 items of the for_you section"}'),
  ('city_pulse',        1, '{"description": "last 5 pulse posts from current city"}'),
  ('notifications',     1, '{"description": "unread notification count and top 3 items"}'),
  ('top_events',        2, '{"description": "top 3 upcoming events in current city"}'),
  ('top_buddies',       2, '{"description": "top 3 available buddy profiles"}'),
  ('saved_places',      2, '{"description": "user wishlist / saved discovery places"}'),
  ('extra_feed_pages',  3, '{"description": "pages 2+ of feed sections"}'),
  ('maps_data',         3, '{"description": "map tile hints for current area"}')
ON CONFLICT (rule_name) DO NOTHING;
