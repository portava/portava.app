-- Rollback for 3924_post_media_backfill_create_path_uploads.sql
--
-- Puts the uploads 3924 moved back into posts.media_urls and removes the rows
-- it wrote, restoring the posts' summary columns.
--
-- WHICH ROWS ARE 3924'S. post_media has no provenance column, so a 3924 row is
-- recognised by every property 3924 gives it at once:
--   storage_bucket = 'post-media', public_url = 'post-media/' || storage_path,
--   a two-segment key ("<uid>/<file>", the POST /api/media/upload shape — the
--   postcard transport writes three), processing_status = 'ready',
--   moderation_status = 'pending', created on or after 2026-10-24, and created
--   MORE THAN TWO MINUTES after its post (3924 backfills old posts; the fixed
--   create path writes its row in the same request as the post).
-- A row a moderator has since decided (anything but 'pending') is left alone,
-- and so is every post that carries any rejected or flagged row: a moderated key
-- must never go back into the array (2098).
--
-- IF IT CATCHES A CREATE-PATH ROW ANYWAY (a post whose row was written later
-- than two minutes after it), restoring that upload to media_urls is lossless
-- for display: routes/posts.ts serves a post's media_urls uploads whenever it
-- has no post_media row (lib/media/storageBackedPostMedia.ts).
--
-- ORDER. The uploads go back first, in sort_order, ahead of the post's external
-- references. 3924 did not record where each upload sat among external
-- references; production's 4 moved posts had one entry each and no external one.
--
-- After this runs, scripts/checkMediaUrlsExternalOnly.ts reports those entries
-- again, as it did before 3924.

BEGIN;

CREATE TEMP TABLE _r3924 ON COMMIT DROP AS
SELECT pm.id, pm.post_id, pm.public_url, pm.sort_order
  FROM public.post_media pm
  JOIN public.posts p ON p.id = pm.post_id
 WHERE pm.storage_bucket = 'post-media'
   AND pm.public_url = 'post-media/' || pm.storage_path
   AND pm.storage_path ~ '^[^/]+/[^/]+$'
   AND pm.processing_status = 'ready'
   AND pm.moderation_status = 'pending'
   AND pm.created_at >= TIMESTAMPTZ '2026-10-24 00:00:00+00'
   AND pm.created_at > p.created_at + INTERVAL '2 minutes'
   AND NOT EXISTS (
         SELECT 1 FROM public.post_media x
          WHERE x.post_id = pm.post_id AND x.moderation_status IN ('rejected', 'flagged')
       );

-- 1. The uploads back into media_urls, ahead of the external references.
UPDATE public.posts p
   SET media_urls = r.urls || COALESCE(array(SELECT u FROM unnest(p.media_urls) u WHERE NOT (u = ANY (r.urls))), '{}')
  FROM (SELECT post_id, array_agg(public_url ORDER BY sort_order) AS urls FROM _r3924 GROUP BY post_id) r
 WHERE p.id = r.post_id;

-- 2. The rows go.
DELETE FROM public.post_media pm WHERE pm.id IN (SELECT id FROM _r3924);

-- 3. Summary columns, from whatever rows remain (none, for 3924's posts: the
--    values they carried before it — 0, false and NULL).
UPDATE public.posts p
   SET media_count = COALESCE(s.n, 0),
       has_video = COALESCE(s.has_video, false),
       primary_media_type = CASE WHEN COALESCE(s.n, 0) = 0 THEN NULL WHEN s.has_video THEN 'video' ELSE 'image' END
  FROM (SELECT DISTINCT post_id FROM _r3924) t
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n, bool_or(pm.media_type = 'video') AS has_video
      FROM public.post_media pm
     WHERE pm.post_id = t.post_id AND pm.processing_status = 'ready'
       AND pm.moderation_status NOT IN ('flagged', 'limited', 'rejected', 'removed', 'owner_deleted')
  ) s ON true
 WHERE p.id = t.post_id;

-- Postcondition: every removed row's upload is back in its post's media_urls.
DO $post$
DECLARE
  lost integer;
BEGIN
  SELECT count(*) INTO lost
    FROM _r3924 r JOIN public.posts p ON p.id = r.post_id
   WHERE NOT (r.public_url = ANY (COALESCE(p.media_urls, '{}')));
  IF lost > 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % upload(s) are in neither store.', lost;
  END IF;
END $post$;

COMMIT;
