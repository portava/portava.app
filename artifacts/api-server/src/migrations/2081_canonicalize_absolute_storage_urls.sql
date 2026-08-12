-- 2081_canonicalize_absolute_storage_urls.sql
--
-- Rewrite every stored absolute Supabase public-storage URL to the canonical
-- bare storage key.
--
--   FROM  https://<ref>.supabase.co/storage/v1/object/public/post-media/<path>
--   TO    post-media/<path>
--
-- Six rows in production as of 2026-08-12, across three columns:
--   posts.media_urls   3 elements   (the array every render surface reads)
--   events.cover_url   2 rows
--   post_media.public_url 1 row
--
-- WHAT IS ACTUALLY WRONG WITH THEM
-- ================================
--
-- Not that they are broken today. They are not. `appStorageUrlInfo`
-- (lib/mediaUrl.ts) accepts both the absolute public form and the bare key, so
-- POST /api/media/sign resolves these six, authorizes them and returns signed
-- URLs exactly as it does for a bare key. The client's own `extractBucket`
-- (travel-buddy-standalone/src/services/mediaUrl.ts) parses both shapes too.
-- Nothing is currently rendering broken because of them.
--
-- What is wrong is that the absolute form is a DURABLE DEPENDENCY sitting in a
-- column, and it has two parts:
--
--   1. THE PROJECT REF IS BAKED IN. All six embed
--      `ajrurzioarfkagpuxfnb.supabase.co`. appStorageUrlInfo's Format-1 branch
--      only matches when the URL's origin equals `new URL(SUPABASE_URL).origin`
--      — so on any environment whose SUPABASE_URL differs (a restore into a new
--      project, the CI project, a DR environment) these six stop parsing,
--      `signed[url]` comes back null, and the media silently disappears. The
--      bare key has no origin in it and survives the move.
--
--   2. THE PATH SEGMENT SAYS `public`. post-media is `public=false`. The stored
--      string asserts a bucket state that is no longer true, which is exactly
--      what auditMediaUrlShapes.ts flags: "a durable dependency on the bucket
--      being public, sitting in a column, immune to any code change."
--
-- So this is a shape migration, not a repair. Stating that plainly matters: if
-- someone later finds media missing, this migration is not the cause and not
-- the fix.
--
-- WHY BARE KEY AND NOT A RELAY PATH
-- =================================
--
-- Three shapes are accepted by `appMediaRef` (lib/postSchemas.ts): bare key,
-- relay path `/api/media/file/<bucket>/<path>`, and absolute URL. The bare key
-- is canonical because it is what the upload endpoints already return after the
-- bucket-privacy cutover, and because it is the only one of the three that
-- encodes neither an origin nor a serving strategy — the relay path bakes in
-- the assumption that the relay is how this object gets served, which is a
-- decision the render layer should keep making per request.
--
-- SAFETY: THE REWRITE IS BUCKET-GUARDED, NOT ORIGIN-GUARDED
-- =========================================================
--
-- Every statement rewrites only when the extracted remainder begins with a
-- bucket this app actually owns (`post-media/` or `profile-media/`), mirroring
-- ALLOWED_BUCKETS in lib/mediaUrl.ts. That is deliberately not a hardcoded
-- project ref: hardcoding `ajrurzioarfkagpuxfnb` would make this migration a
-- no-op in CI and in every restored environment, which is where the shape
-- problem actually bites. A foreign URL that happens to contain
-- `/storage/v1/object/public/` but resolves to a bucket we do not own is left
-- alone.
--
-- ORDER IS PRESERVED IN posts.media_urls
-- ======================================
--
-- media_urls is a text[] and several surfaces render only `media_urls[0]` (see
-- .agents/memory/posts-media-urls-vs-post-media.md). Rebuilding the array with
-- array_agg WITHOUT an explicit ordering would be free to permute it, silently
-- changing which image those surfaces show. `WITH ORDINALITY` + `ORDER BY ord`
-- is what makes the rewrite order-preserving, and it is the reason this is not
-- a one-line regexp_replace over the whole column.

BEGIN;

-- ── post_media.public_url ───────────────────────────────────────────────────
UPDATE post_media
   SET public_url = substring(
         public_url FROM position('/storage/v1/object/public/' IN public_url)
                              + length('/storage/v1/object/public/'))
 WHERE public_url LIKE '%/storage/v1/object/public/%'
   AND substring(public_url FROM position('/storage/v1/object/public/' IN public_url)
                                  + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── post_media.feed_url ─────────────────────────────────────────────────────
-- Zero rows match today (both live values are NULL). Included so the column is
-- not left as the one member of this family that keeps the old shape the next
-- time a row is written by an older code path.
UPDATE post_media
   SET feed_url = substring(
         feed_url FROM position('/storage/v1/object/public/' IN feed_url)
                            + length('/storage/v1/object/public/'))
 WHERE feed_url LIKE '%/storage/v1/object/public/%'
   AND substring(feed_url FROM position('/storage/v1/object/public/' IN feed_url)
                                + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── events.cover_url ────────────────────────────────────────────────────────
UPDATE events
   SET cover_url = substring(
         cover_url FROM position('/storage/v1/object/public/' IN cover_url)
                             + length('/storage/v1/object/public/'))
 WHERE cover_url LIKE '%/storage/v1/object/public/%'
   AND substring(cover_url FROM position('/storage/v1/object/public/' IN cover_url)
                                 + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── trips.cover_url ─────────────────────────────────────────────────────────
-- Zero rows match today. Same reasoning as feed_url above.
UPDATE trips
   SET cover_url = substring(
         cover_url FROM position('/storage/v1/object/public/' IN cover_url)
                             + length('/storage/v1/object/public/'))
 WHERE cover_url LIKE '%/storage/v1/object/public/%'
   AND substring(cover_url FROM position('/storage/v1/object/public/' IN cover_url)
                                 + length('/storage/v1/object/public/'))
       ~ '^(post-media|profile-media)/';

-- ── posts.media_urls (text[], order-preserving) ─────────────────────────────
UPDATE posts p
   SET media_urls = rebuilt.arr
  FROM (
    SELECT po.id,
           array_agg(
             CASE
               WHEN u LIKE '%/storage/v1/object/public/%'
                AND substring(u FROM position('/storage/v1/object/public/' IN u)
                                     + length('/storage/v1/object/public/'))
                    ~ '^(post-media|profile-media)/'
               THEN substring(u FROM position('/storage/v1/object/public/' IN u)
                                    + length('/storage/v1/object/public/'))
               ELSE u
             END
             ORDER BY ord
           ) AS arr
      FROM posts po,
           LATERAL unnest(po.media_urls) WITH ORDINALITY AS t(u, ord)
     WHERE EXISTS (
             SELECT 1
               FROM unnest(po.media_urls) x
              WHERE x LIKE '%/storage/v1/object/public/%'
                AND substring(x FROM position('/storage/v1/object/public/' IN x)
                                     + length('/storage/v1/object/public/'))
                    ~ '^(post-media|profile-media)/'
           )
     GROUP BY po.id
  ) AS rebuilt
 WHERE p.id = rebuilt.id;

-- ── Post-condition: no absolute app-storage URL survives anywhere ───────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT public_url AS v FROM post_media
    UNION ALL SELECT feed_url FROM post_media
    UNION ALL SELECT cover_url FROM events
    UNION ALL SELECT cover_url FROM trips
    UNION ALL SELECT unnest(COALESCE(media_urls, '{}')) FROM posts
  ) t
  WHERE v LIKE '%/storage/v1/object/public/%'
    AND substring(v FROM position('/storage/v1/object/public/' IN v)
                         + length('/storage/v1/object/public/'))
        ~ '^(post-media|profile-media)/';

  IF n <> 0 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % absolute app-storage URL(s) still present after the rewrite.', n;
  END IF;
END $$;

-- ── Post-condition: every rewritten value still points at a real object ─────
-- A shape migration that leaves a column pointing at nothing is worse than the
-- shape it fixed, so the new keys are checked against storage.objects rather
-- than assumed. Only bare keys are checked; anything else in these columns
-- (external hosts, nulls) is out of scope and left alone.
DO $$
DECLARE
  missing integer;
  sample  text;
BEGIN
  SELECT count(*), coalesce(min(v), '') INTO missing, sample
    FROM (
      SELECT public_url AS v FROM post_media
      UNION ALL SELECT cover_url FROM events
      UNION ALL SELECT cover_url FROM trips
      UNION ALL SELECT unnest(COALESCE(media_urls, '{}')) FROM posts
    ) t
   WHERE v ~ '^(post-media|profile-media)/'
     AND NOT EXISTS (
           SELECT 1 FROM storage.objects o
            WHERE o.bucket_id = split_part(v, '/', 1)
              AND o.name = substring(v FROM position('/' IN v) + 1)
         );

  IF missing > 0 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % bare storage key(s) do not resolve to an object in storage.objects (e.g. %). '
      'This migration must not leave a column pointing at nothing.', missing, sample;
  END IF;
END $$;

COMMIT;
