-- Migration: 0129_post_media_stamp_overlay.sql
-- Optional Stamp Overlay on Postcard photos.
--
-- Stores the overlay as structured, non-destructive metadata on the media row
-- (the original upload is never modified). The JSON is written server-side at
-- publish time and PINS the artwork reference so later catalog artwork updates
-- do not change historical Postcard appearance:
--   {
--     "stampDefinitionId": uuid,     -- canonical universal stamp
--     "label": text,                 -- definition name at publish time
--     "city": text|null,             -- definition city/country at publish time
--     "country": text|null,
--     "artworkUrl": text|null,       -- pinned universal_artwork_url at publish
--     "artworkPinnedAt": iso8601,    -- pin timestamp (defs have no version id)
--     "style": 'original'|'white'|'dark'|'watermark',
--     "x": 0..1, "y": 0..1,          -- normalized center within the media frame
--     "scale": 0.12..0.5,            -- stamp diameter / media display width
--     "rotation": -45..45,           -- degrees (0 default)
--     "opacity": 0.05..1
--   }
-- Per-media (not per-post) so future multi-photo carousels can stamp each
-- photo independently. Nullable; no index — never queried, only projected.

ALTER TABLE post_media
  ADD COLUMN IF NOT EXISTS stamp_overlay jsonb;

COMMENT ON COLUMN post_media.stamp_overlay IS
  'Optional non-destructive stamp overlay metadata (pinned artwork ref + placement), written server-side at publish.';
