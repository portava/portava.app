-- 2082_canonicalize_remaining_storage_urls.sql
--
-- Second and final pass of the storage-URL canonicalization begun in 2081.
--
--   FROM  https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<path>
--   TO    <bucket>/<path>
--
-- Fifteen values across six columns, all in the two PRIVATE buckets:
--
--   passport_postcards.media_url    4   post-media
--   media_assets.public_url         3   post-media
--   media_assets.thumbnail_url      3   post-media
--   highlights.media_url            2   post-media
--   profiles.avatar_url             2   profile-media
--   profiles.cover_photo_url        1   profile-media
--
-- WHY THESE WERE NOT IN 2081
-- ==========================
--
-- 2081 fixed "the six", which was the population of the FIVE columns
-- scripts/auditMediaUrlShapes.ts scans. Production has 49 URL-bearing columns.
-- A full census on 2026-08-12 found 39 more absolute public URLs, of which
-- these 15 sit in private buckets and carry the identical defect: the project
-- ref is baked into a durable column, so on any environment whose SUPABASE_URL
-- differs the value stops parsing and the media silently disappears.
--
-- The census instrument is extended to all 49 columns in the same commit, so
-- this class cannot hide behind a five-column sample again.
--
-- WHAT IS DELIBERATELY NOT TOUCHED
-- ================================
--
-- The other 24 are stamp_artwork_versions.public_url (12) and .thumbnail_url
-- (12), and they point at the `stamp-artwork` bucket, which is `public = true`.
-- For a genuinely public bucket the absolute /object/public/ URL is CORRECT and
-- currently working, and rewriting it would BREAK it: `stamp-artwork` is not in
-- ALLOWED_BUCKETS (lib/mediaUrl.ts) or APP_MEDIA_BUCKETS (lib/postSchemas.ts),
-- so a bare `stamp-artwork/…` key fails both the parser and the validator.
--
-- That exemption is recorded in the census instrument with its reason, not left
-- to be re-derived by whoever next reads a non-zero count.
--
-- SAFETY
-- ======
--
-- Bucket-guarded, not origin-guarded, exactly as 2081: each statement fires
-- only when the extracted remainder begins with `post-media/` or
-- `profile-media/`. Hardcoding the project ref would make this a no-op in CI
-- and in every restored environment, which is where the shape problem bites.
--
-- ⚠ AUTHORIZATION DEPENDS ON THESE COLUMNS. lib/mediaAccess resolves access by
-- finding the object's URL in a column: highlights.media_url is branch 3e, and
-- profiles.* is reached through the profile-media path. Rewriting the column
-- WITHOUT teaching the matcher the new encoding is what broke three public
-- posts when 2081 landed. That fix shipped first (mediaAccess now matches both
-- the absolute form and the bare key via `urlForms`), so this migration lands
-- against a matcher that already understands both. Do not apply this migration
-- to a database whose API server predates that fix.

BEGIN;

-- ── highlights.media_url  (mediaAccess branch 3e) ───────────────────────────
UPDATE highlights
   SET media_url = substring(
         media_url FROM position('/storage/v1/object/public/' IN media_url)
                             + length('/storage/v1/object/public/'))
 WHERE media_url LIKE '%/storage/v1/object/public/%'
   AND substring(media_url FROM position('/storage/v1/object/public/' IN media_url)
                                 + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── media_assets.public_url ─────────────────────────────────────────────────
UPDATE media_assets
   SET public_url = substring(
         public_url FROM position('/storage/v1/object/public/' IN public_url)
                              + length('/storage/v1/object/public/'))
 WHERE public_url LIKE '%/storage/v1/object/public/%'
   AND substring(public_url FROM position('/storage/v1/object/public/' IN public_url)
                                  + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── media_assets.thumbnail_url ──────────────────────────────────────────────
UPDATE media_assets
   SET thumbnail_url = substring(
         thumbnail_url FROM position('/storage/v1/object/public/' IN thumbnail_url)
                                 + length('/storage/v1/object/public/'))
 WHERE thumbnail_url LIKE '%/storage/v1/object/public/%'
   AND substring(thumbnail_url FROM position('/storage/v1/object/public/' IN thumbnail_url)
                                     + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── passport_postcards.media_url ────────────────────────────────────────────
UPDATE passport_postcards
   SET media_url = substring(
         media_url FROM position('/storage/v1/object/public/' IN media_url)
                             + length('/storage/v1/object/public/'))
 WHERE media_url LIKE '%/storage/v1/object/public/%'
   AND substring(media_url FROM position('/storage/v1/object/public/' IN media_url)
                                 + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── profiles.avatar_url ─────────────────────────────────────────────────────
UPDATE profiles
   SET avatar_url = substring(
         avatar_url FROM position('/storage/v1/object/public/' IN avatar_url)
                              + length('/storage/v1/object/public/'))
 WHERE avatar_url LIKE '%/storage/v1/object/public/%'
   AND substring(avatar_url FROM position('/storage/v1/object/public/' IN avatar_url)
                                  + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── profiles.cover_photo_url ────────────────────────────────────────────────
UPDATE profiles
   SET cover_photo_url = substring(
         cover_photo_url FROM position('/storage/v1/object/public/' IN cover_photo_url)
                                   + length('/storage/v1/object/public/'))
 WHERE cover_photo_url LIKE '%/storage/v1/object/public/%'
   AND substring(cover_photo_url FROM position('/storage/v1/object/public/' IN cover_photo_url)
                                       + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── Post-condition: no PRIVATE-bucket absolute URL survives, anywhere ───────
-- Scans all six columns of this migration plus the five 2081 covered, so the
-- assertion is over the union of both passes rather than this one in isolation.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT media_url       AS v FROM highlights
    UNION ALL SELECT public_url      FROM media_assets
    UNION ALL SELECT thumbnail_url   FROM media_assets
    UNION ALL SELECT media_url       FROM passport_postcards
    UNION ALL SELECT avatar_url      FROM profiles
    UNION ALL SELECT cover_photo_url FROM profiles
    UNION ALL SELECT public_url      FROM post_media
    UNION ALL SELECT feed_url        FROM post_media
    UNION ALL SELECT cover_url       FROM events
    UNION ALL SELECT cover_url       FROM trips
    UNION ALL SELECT unnest(COALESCE(media_urls, '{}')) FROM posts
  ) t
  WHERE v LIKE '%/storage/v1/object/public/%'
    AND substring(v FROM position('/storage/v1/object/public/' IN v)
                         + length('/storage/v1/object/public/'))
        ~ '^(post-media|profile-media)/';

  IF n <> 0 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % private-bucket absolute URL(s) still present.', n;
  END IF;
END $$;

-- ── Post-condition: every rewritten key resolves to a real object ───────────
DO $$
DECLARE
  missing integer;
  sample  text;
BEGIN
  SELECT count(*), coalesce(min(v), '') INTO missing, sample
    FROM (
      SELECT media_url       AS v FROM highlights
      UNION ALL SELECT public_url      FROM media_assets
      UNION ALL SELECT thumbnail_url   FROM media_assets
      UNION ALL SELECT media_url       FROM passport_postcards
      UNION ALL SELECT avatar_url      FROM profiles
      UNION ALL SELECT cover_photo_url FROM profiles
    ) t
   WHERE v ~ '^(post-media|profile-media)/'
     AND NOT EXISTS (
           SELECT 1 FROM storage.objects o
            WHERE o.bucket_id = split_part(v, '/', 1)
              AND o.name = substring(v FROM position('/' IN v) + 1)
         );

  IF missing > 0 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % bare storage key(s) do not resolve to an object (e.g. %).', missing, sample;
  END IF;
END $$;

-- ── Post-condition: the PUBLIC bucket was not canonicalized ─────────────────
-- stamp-artwork's absolute URLs are CORRECT and must survive: it is a public
-- bucket, and it appears in neither ALLOWED_BUCKETS (lib/mediaUrl.ts) nor
-- APP_MEDIA_BUCKETS (lib/postSchemas.ts), so a bare `stamp-artwork/<path>` key
-- would fail both the parser and the validator. Rewriting them is a regression.
--
-- ⚠ THIS ASSERTION WAS ORIGINALLY WRITTEN AS `IF n <> 24`, the production row
-- count. It failed immediately on the CI project, which is a schema-only
-- restore and holds zero. A migration that encodes one environment's data
-- volume is not portable, and the failure was the post-condition catching the
-- migration's own defect before it reached production — which is the argument
-- for having it.
--
-- The portable form asserts the INVARIANT rather than the count: no
-- stamp-artwork value may end up in bare-key form. True on an empty database,
-- true on production, and it fails precisely when this migration's WHERE
-- clauses are widened to catch the public bucket.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT public_url AS v FROM stamp_artwork_versions
    UNION ALL SELECT thumbnail_url FROM stamp_artwork_versions
  ) t
  WHERE v ~ '^stamp-artwork/';

  IF n <> 0 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % stamp_artwork_versions value(s) are in bare-key form. '
      'stamp-artwork is a PUBLIC bucket and its absolute /object/public/ URLs are the working '
      'form; canonicalizing them breaks them, because stamp-artwork is in neither '
      'ALLOWED_BUCKETS nor APP_MEDIA_BUCKETS.', n;
  END IF;
END $$;

COMMIT;
