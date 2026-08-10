-- Migration 0208: add the feed-variant columns to post_media
--
-- WHY
-- ---
-- PostcardTile requests `?width=500`, but that parameter never reaches Storage.
-- `appStorageUrlInfo()` (lib/mediaUrl.ts) matches on `url.pathname` only and
-- documents "Query strings are ignored", and `/api/media/sign` runs every URL
-- through it before signing — so the param is stripped before the signed URL
-- exists. Since the buckets went private the Postcard Wall has been fetching
-- full 2048px originals and scaling them on-device.
--
-- The fix is a real derived asset (longest edge FEED_DIM = 1500, quality 82,
-- built from the already-processed buffer so it inherits the EXIF/GPS strip),
-- generated at upload time following the existing 400px thumbnail pattern.
-- Chosen over forwarding the query param because a stored object does not
-- depend on Supabase's image-transform feature being enabled.
--
-- NULLABLE ON PURPOSE — THIS IS THE WHOLE CONTRACT
-- ------------------------------------------------
-- Both columns are NULLABLE with NO default and NO backfill. Every post_media
-- row that exists today gets NULL, and NULL means "no variant — use the
-- original". The API returns the variant URL when it exists and null when it
-- does not; the client falls back.
--
-- The failure this avoids is specific: if the client derived the variant path
-- itself (append `.feed.jpg`), it would request a URL that 404s for EVERY
-- pre-existing post. Existence must be reported by the server, never inferred
-- by the client.
--
-- BACKFILL: not run, and not scheduled here. Existing rows keep serving the
-- original, which is exactly today's behaviour, so nothing regresses without
-- one. A backfill would need to re-download each original, re-derive, and
-- upload — worth doing as its own job with its own rate limiting and failure
-- accounting. Deliberately out of scope; see the report accompanying this
-- migration.

ALTER TABLE post_media
  ADD COLUMN IF NOT EXISTS feed_storage_path text,
  ADD COLUMN IF NOT EXISTS feed_url          text;

COMMENT ON COLUMN post_media.feed_storage_path IS
  'Storage path of the FEED_DIM (1500px) derived variant. NULL = no variant exists; serve the original.';
COMMENT ON COLUMN post_media.feed_url IS
  'Relay URL of the feed variant, "<bucket>/<path>". NULL = no variant exists; the client must fall back to public_url.';
