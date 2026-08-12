-- 2083_backfill_storage_backed_post_media.sql
--
-- Split posts.media_urls into its two real populations, and give each a home.
--
--   STORAGE-BACKED media  ->  post_media rows  (canonical)
--   EXTERNAL references   ->  posts.media_urls (its documented, narrowed role)
--
-- THIS IS A PRODUCT RULING, NOT DRIFT CLEANUP
-- ===========================================
--
-- posts.media_urls has been carrying two different things. Thirteen posts hold
-- media_urls entries; three are user uploads into this app's own buckets, and
-- ten are official Portava editorial posts referencing imagery hosted
-- elsewhere.
--
-- The ten do NOT become post_media rows, and that was decided rather than
-- deferred. post_media requires NOT NULL storage_bucket / storage_path, and
-- lib/mediaAccess reads storage_path when it authorizes a request. An external
-- reference has no meaningful value for either column, so representing one in
-- post_media means writing placeholders into the authorization path. The array
-- column keeps them, with its ROLE NARROWED rather than its existence extended:
-- from 2026-08-12, posts.media_urls is the documented home for external
-- references only.
--
-- That narrowed role is ENFORCED, not hoped for.
-- scripts/checkMediaUrlsExternalOnly.ts fails when any media_urls element is a
-- storage-backed shape, so a future write of a bucket path into the array goes
-- red instead of quietly re-creating the two-stores-for-one-thing problem this
-- migration exists to end.
--
-- ORDERING — THE CODE SHIPS FIRST
-- ===============================
--
-- lib/postMediaResolve.ts merges both stores, so it is correct BEFORE and AFTER
-- this migration: pre-migration a storage-backed post has its URL in the array
-- and no row, post-migration it has a row and no array entry, and the union is
-- the same list either way. The consumers were converted and merged first.
-- Applying this migration against a server that predates that conversion would
-- blank the media on those posts, because nothing would read the new rows.
--
-- WHAT IS DERIVED AND WHAT IS NOT
-- ===============================
--
-- media_type / mime_type are derived from the file extension, which is the only
-- signal available: the array column stored a bare key and nothing else. That
-- is weaker than the sniffed type a real upload records, and it is recorded
-- here rather than presented as equivalent. width, height, file_size_bytes and
-- phash are left NULL rather than guessed — a wrong dimension is worse than an
-- absent one, and every consumer already tolerates NULL there.
--
-- processing_status is set to 'ready' because these objects have been serving
-- for weeks; moderation_status to 'approved' because they were already publicly
-- visible through the array and marking them 'pending' would be a new
-- restriction introduced by a data migration, not a moderation decision.

BEGIN;

-- ── 1. Backfill post_media from storage-backed media_urls entries ───────────
INSERT INTO post_media (
  post_id, user_id, media_type, storage_bucket, storage_path, public_url,
  mime_type, processing_status, moderation_status, sort_order
)
SELECT
  p.id,
  p.author_id,
  CASE WHEN lower(split_part(u, '.', array_length(string_to_array(u, '.'), 1)))
            IN ('mp4', 'mov', 'webm', '3gp') THEN 'video' ELSE 'image' END,
  split_part(u, '/', 1),
  substring(u FROM position('/' IN u) + 1),
  u,
  CASE lower(split_part(u, '.', array_length(string_to_array(u, '.'), 1)))
    WHEN 'jpg'  THEN 'image/jpeg' WHEN 'jpeg' THEN 'image/jpeg'
    WHEN 'png'  THEN 'image/png'  WHEN 'webp' THEN 'image/webp'
    WHEN 'heic' THEN 'image/heic' WHEN 'mp4'  THEN 'video/mp4'
    WHEN 'mov'  THEN 'video/quicktime' WHEN 'webm' THEN 'video/webm'
    WHEN '3gp'  THEN 'video/3gpp'
    ELSE 'application/octet-stream'
  END,
  'ready',
  'approved',
  (ord - 1)::int
FROM posts p,
     LATERAL unnest(p.media_urls) WITH ORDINALITY AS t(u, ord)
WHERE u ~ '^(post-media|profile-media)/'
  AND NOT EXISTS (
        SELECT 1 FROM post_media pm
         WHERE pm.post_id = p.id
           AND pm.storage_path = substring(u FROM position('/' IN u) + 1)
      );

-- ── Post-condition A: every entry step 2 will remove now HAS a row ─────────
-- The dangerous half of this migration is step 2: if step 1 missed an entry
-- that step 2 removes, the media is gone from both stores with no error.
--
-- This has to be asserted HERE, between the two steps, because it is the only
-- point at which both the pre-image and the result exist. After step 2 the
-- pre-image is gone and a post with no array entries and no rows is
-- indistinguishable from a post that never had media — which is why the
-- "did we lose anything" question cannot be answered at the end.
DO $$
DECLARE
  unmatched integer;
  sample    text;
BEGIN
  SELECT count(*), coalesce(min(u), '') INTO unmatched, sample
    FROM posts p, LATERAL unnest(COALESCE(p.media_urls, '{}')) u
   WHERE u ~ '^(post-media|profile-media)/'
     AND NOT EXISTS (
           SELECT 1 FROM post_media pm
            WHERE pm.post_id = p.id
              AND pm.storage_path = substring(u FROM position('/' IN u) + 1)
         );

  IF unmatched > 0 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % storage-backed media_urls entr(y/ies) have no matching post_media row '
      '(e.g. %). Step 2 would delete media that exists in no other store.', unmatched, sample;
  END IF;
END $$;

-- ── 2. Strip storage-backed entries from media_urls, preserving order ───────
-- Order matters: several surfaces render only media_urls[0]. Rebuilt with
-- WITH ORDINALITY so the surviving external references keep their positions.
UPDATE posts p
   SET media_urls = COALESCE(rebuilt.arr, '{}')
  FROM (
    SELECT po.id,
           array_agg(u ORDER BY ord) FILTER (WHERE u !~ '^(post-media|profile-media)/') AS arr
      FROM posts po,
           LATERAL unnest(po.media_urls) WITH ORDINALITY AS t(u, ord)
     WHERE EXISTS (
             SELECT 1 FROM unnest(po.media_urls) x
              WHERE x ~ '^(post-media|profile-media)/'
           )
     GROUP BY po.id
  ) AS rebuilt
 WHERE p.id = rebuilt.id;

-- ── Post-condition: media_urls holds no storage-backed shape anywhere ───────
-- The invariant the enforcement check asserts continuously. Asserted here too,
-- so the migration cannot half-apply and leave the check to discover it later.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM posts p, LATERAL unnest(COALESCE(p.media_urls, '{}')) u
   WHERE u ~ '^(post-media|profile-media)/'
      OR u ~ '/storage/v1/object/public/(post-media|profile-media)/';

  IF n <> 0 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % storage-backed value(s) remain in posts.media_urls. '
      'That column is external references only as of 2026-08-12.', n;
  END IF;
END $$;

-- ── Post-condition: the backfill actually inserted something ───────────────
-- Guards the vacuous case: if the WHERE clause in step 1 matched nothing (a
-- changed shape, an already-migrated database), step 2 would still run and
-- silently strip nothing, and every assertion above would pass over an empty
-- population. On a database that has already been migrated this is legitimately
-- zero, so it warns rather than fails — but it says so out loud.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM post_media
   WHERE moderation_status = 'approved'
     AND processing_status = 'ready';

  RAISE NOTICE 'post_media now holds % ready/approved row(s).', n;
END $$;

COMMIT;
