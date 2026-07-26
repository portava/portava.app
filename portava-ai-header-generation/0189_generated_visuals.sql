-- Migration 0189: AI Header Generation — generated_visuals + entity header fields
-- Part of the Portava Visual Generation System (VisualGenerationService).
-- Additive and idempotent. Does NOT alter any existing image/media behavior.
--
-- REPO-SPECIFIC BINDINGS honored here:
--   • entity_id is TEXT, not uuid — discovery_places ids are OSM/text, not uuids.
--   • Events already have cover_url + cover_media_type (0151). We DO NOT add a
--     rival header_image_url to events; we add generation METADATA only and the
--     resolver treats cover_url as the event header URL. Places get a full set
--     because discovery_places has no image column today.
--   • Feature toggles are DB feature_flags rows (fail-closed), not env booleans.

BEGIN;

-- ── Centralized generated-visual record ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS generated_visuals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id            uuid,
  entity_type              text NOT NULL,          -- 'event' | 'place' | 'trip' | 'city_guide' | 'group' | 'content'
  entity_id                text NOT NULL,          -- TEXT: holds event uuid OR place (OSM/text) id
  purpose                  text NOT NULL,          -- 'event_header' | 'place_header' | 'trip_cover' | ...
  provider                 text NOT NULL,          -- 'openai' | 'category_fallback'
  model                    text,
  prompt_version           text NOT NULL,
  prompt_hash              text NOT NULL,
  input_snapshot           jsonb NOT NULL DEFAULT '{}'::jsonb,
  final_prompt             text,
  negative_prompt          text,
  style                    text NOT NULL DEFAULT 'portava_editorial',
  aspect_ratio             text NOT NULL DEFAULT '16:9',
  status                   text NOT NULL DEFAULT 'queued',  -- queued|generating|ready|failed|blocked|replaced
  source_image_url         text,
  storage_path             text,
  thumbnail_path           text,
  card_path                text,
  hero_path                text,
  share_path               text,
  moderation_status        text,
  moderation_details       jsonb,
  failure_code             text,
  failure_message          text,
  attempt_count            integer NOT NULL DEFAULT 0,
  generation_cost_estimate numeric,
  generated_at             timestamptz,
  accepted_at              timestamptz,
  replaced_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generated_visuals_entity_idx   ON generated_visuals (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS generated_visuals_owner_idx    ON generated_visuals (owner_user_id);
CREATE INDEX IF NOT EXISTS generated_visuals_status_idx   ON generated_visuals (status);
CREATE INDEX IF NOT EXISTS generated_visuals_hash_idx     ON generated_visuals (prompt_hash);
CREATE INDEX IF NOT EXISTS generated_visuals_created_idx  ON generated_visuals (created_at);
CREATE INDEX IF NOT EXISTS generated_visuals_provider_idx ON generated_visuals (provider);

-- Idempotency: at most one *active* job per (entity, purpose, prompt_hash).
-- Terminal rows (failed/replaced) are excluded so a fresh regen is always allowed.
CREATE UNIQUE INDEX IF NOT EXISTS generated_visuals_active_uniq
  ON generated_visuals (entity_type, entity_id, purpose, prompt_hash)
  WHERE status IN ('queued', 'generating', 'ready');

-- RLS: the API server uses the service-role key (bypasses RLS). Enable RLS with
-- NO permissive policies so the anon key can neither read nor write. Matches the
-- repo's "server holds service key; tables are deny-all to anon" convention.
ALTER TABLE generated_visuals ENABLE ROW LEVEL SECURITY;

-- ── Places (discovery_places): no image column exists — add the full header set.
ALTER TABLE discovery_places ADD COLUMN IF NOT EXISTS header_image_url          text;
ALTER TABLE discovery_places ADD COLUMN IF NOT EXISTS header_image_source       text;
ALTER TABLE discovery_places ADD COLUMN IF NOT EXISTS header_image_status       text NOT NULL DEFAULT 'not_requested';
ALTER TABLE discovery_places ADD COLUMN IF NOT EXISTS header_image_generated_id uuid;
ALTER TABLE discovery_places ADD COLUMN IF NOT EXISTS header_image_attribution  text;
ALTER TABLE discovery_places ADD COLUMN IF NOT EXISTS header_image_updated_at   timestamptz;

-- ── Events: already have cover_url + cover_media_type. Add METADATA only.
--    The resolver reads cover_url as the URL; these columns record its provenance.
ALTER TABLE events ADD COLUMN IF NOT EXISTS header_image_source       text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS header_image_status       text NOT NULL DEFAULT 'not_requested';
ALTER TABLE events ADD COLUMN IF NOT EXISTS header_image_generated_id uuid;
ALTER TABLE events ADD COLUMN IF NOT EXISTS header_image_attribution  text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS header_image_updated_at   timestamptz;

-- ── Feature flags (server-authoritative, fail-closed). Seeded OFF — flip when ready.
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('ai_visual_provider_enabled',     false, 'Master switch for the AI visual generation provider'),
  ('ai_event_headers_enabled',       false, 'Allow AI-generated event header images'),
  ('ai_event_auto_suggest_enabled',  false, 'Auto-suggest an event header on create (requires ai_event_headers_enabled)'),
  ('ai_place_headers_enabled',       false, 'Allow AI-generated place representations (only after real-image sources fail)'),
  ('ai_trip_covers_enabled',         false, 'Allow AI-generated trip cover images'),
  ('ai_visual_regeneration_enabled', false, 'Allow user-initiated regeneration'),
  ('ai_visual_admin_review_enabled', false, 'Enable admin review queue for generated place representations')
ON CONFLICT (flag) DO NOTHING;

COMMIT;
