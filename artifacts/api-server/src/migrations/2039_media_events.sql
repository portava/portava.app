-- media_events: analytics event log for the Media destination (Watch · Grid · Gems).
--
-- Populated by recordMediaEvent() in src/lib/mediaAnalytics.ts.
-- Write is fire-and-forget and gated by MEDIA_ANALYTICS_ENABLED feature flag.
-- Forbidden fields (captions, raw coordinates, ranking vectors, secrets) are
-- stripped by the server-side allow-list before any row is inserted here.
--
-- Columns:
--   id          — surrogate primary key
--   event_type  — MediaEventType string (impression, qualified_view, like, …)
--   payload     — JSONB safe-payload: viewer_id, media_id, session_id, watched_ms, …
--   occurred_at — server-side timestamp of the event

CREATE TABLE IF NOT EXISTS media_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for time-series queries (dashboards, retention analysis)
CREATE INDEX IF NOT EXISTS media_events_occurred_at_idx
  ON media_events (occurred_at DESC);

-- Index for per-viewer lookups (media_id is inside payload; viewer_id lookup
-- uses a partial expression index for common query patterns)
CREATE INDEX IF NOT EXISTS media_events_event_type_idx
  ON media_events (event_type);

-- RLS: service role writes only; no user-facing read policy (admin dashboards
-- query via service role directly).
ALTER TABLE media_events ENABLE ROW LEVEL SECURITY;
