-- 3924_post_media_backfill_create_path_uploads.sql
--
-- Give every upload that POST /posts left in posts.media_urls its post_media
-- row, and narrow media_urls back to external references (2083's ruling).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band, lane band
-- 3924-3929). Order-independent of every other file except its prerequisites,
-- all of which sort before it: 0103 (post_media), the posts table, 2083 (the
-- ruling and the shape this file repeats), 3909 (2098's moderation design: the
-- ledger and its AFTER INSERT trigger, which a 'pending' insert does not fire).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY (owner-reported 2026-10-24: "video media still not playing")
-- ══════════════════════════════════════════════════════════════════════════════
-- 2083 (2026-08-12) moved storage-backed media into post_media and made
-- posts.media_urls the home of EXTERNAL references only, enforced by
-- scripts/checkMediaUrlsExternalOnly.ts. The create path never followed it: it
-- kept writing an upload's bare key ("post-media/<uid>/<ts>.mov") into
-- media_urls and created no row. Production, read 2026-10-24: 4 posts, 4
-- entries, all bare post-media keys, every key's first segment the post's
-- author, 0 post_media rows for any of them, both videos' posters present at
-- "<key>.poster.jpg". The read side built `media` from rows only, so these
-- posts were served `media: []` and the client never mounted a video player.
-- The code fix (lib/media/storageBackedPostMedia.ts) makes the create path
-- write rows and lets the read side serve media_urls uploads meanwhile; this
-- file moves the existing ones.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT IS WRITTEN, AND WHY EACH VALUE
-- ══════════════════════════════════════════════════════════════════════════════
--   media_type          video by extension (mov mp4 m4v webm qt 3gp), image by
--                       extension (jpg jpeg png webp heic heif gif avif), else
--                       the post's own media_type (video/*) — the rule
--                       lib/media/storageBackedPostMedia.ts mediaKindForPath
--                       applies, so the row and the read fallback agree.
--   mime_type           storage.objects' recorded mimetype when the object is
--                       there; else the extension's; else the post's own.
--   file_size_bytes     storage.objects' recorded size, else NULL (never guessed).
--   thumbnail_*         "<key>.poster.jpg" ONLY when that object exists.
--   processing_status   'ready': POST /api/media/upload verified and stored the
--                       bytes before it returned the key, and the objects have
--                       been served since.
--   moderation_status   'pending': the value 2098 pins every insert to. Nobody
--                       reviewed these files, and 'pending' is servable
--                       (lib/mediaAccess, filterPostMedia), so nothing that is
--                       visible today stops being visible. (2083 wrote
--                       'approved' for its population; no decision is invented
--                       here.)
--   sort_order          the entry's position among the post's uploads, 0-based.
-- width, height, phash and duration stay NULL rather than guessed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PRECONDITIONS (each RAISES, and the whole file rolls back)
-- ══════════════════════════════════════════════════════════════════════════════
--   P1  every storage-backed media_urls entry is a BARE post-media key. Any other
--       spelling (profile-media, an absolute storage URL, the relay path) is
--       counted and refused: this file moves one shape, and anything else needs
--       a decision rather than a guess.
--   P2  every key's first path segment is the post's author (2098's
--       post_media_path_is_owned, narrowed). A key that is not the author's is
--       not attached to anything; it is reported for review.
--   P3  no key carries a verdict in post_media_moderation_ledger: a rejected or
--       flagged key must never be attached again (2098).
-- POSTCONDITIONS: A (between the insert and the strip) every moved entry has a
-- row; B no storage-backed shape is left in media_urls anywhere (the check's own
-- predicate); C every touched post's summary columns equal its rows.
--
-- IDEMPOTENT: a second run finds no entry, inserts nothing, strips nothing.
-- ROLLBACK: db/rollback/2026-10-24-3924-post-media-backfill-create-path-uploads-rollback.sql

BEGIN;

CREATE TEMP TABLE _m3924_entries ON COMMIT DROP AS
SELECT p.id AS post_id,
       p.author_id,
       p.media_type AS post_media_type,
       t.u,
       t.ord,
       substring(t.u FROM length('post-media/') + 1) AS key,
       lower(substring(t.u FROM '\.([A-Za-z0-9]+)$')) AS ext
  FROM public.posts p,
       LATERAL unnest(p.media_urls) WITH ORDINALITY AS t(u, ord)
 WHERE t.u ~ '^post-media/';

-- ── P1 / P2 / P3 ──────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  other_shapes integer;
  not_owned    integer;
  moderated    integer;
BEGIN
  SELECT count(*) INTO other_shapes
    FROM public.posts p, LATERAL unnest(COALESCE(p.media_urls, '{}')) u
   WHERE (u ~ '^profile-media/'
       OR u ~ '/storage/v1/object/public/(post-media|profile-media)/'
       OR u ~* '^(https?://[^/]+)?/api/media/file/');
  IF other_shapes > 0 THEN
    RAISE EXCEPTION 'PRECONDITION P1 FAILED: % storage-backed media_urls entr(y/ies) are not bare post-media keys; this file moves only that shape.', other_shapes;
  END IF;

  SELECT count(*) INTO not_owned
    FROM _m3924_entries e
   WHERE split_part(e.key, '/', 1) IS DISTINCT FROM e.author_id::text OR e.key = '' OR e.key LIKE '%/';
  IF not_owned > 0 THEN
    RAISE EXCEPTION 'PRECONDITION P2 FAILED: % post-media key(s) in media_urls do not belong to the post''s author (first path segment); review them before moving anything.', not_owned;
  END IF;

  IF to_regclass('public.post_media_moderation_ledger') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM _m3924_entries e JOIN public.post_media_moderation_ledger l ON l.storage_path = e.key'
       INTO moderated;
    IF moderated > 0 THEN
      RAISE EXCEPTION 'PRECONDITION P3 FAILED: % key(s) carry a moderation verdict and may not be attached as post_media.', moderated;
    END IF;
  END IF;
END $pre$;

-- ── 1. One post_media row per entry that has none ─────────────────────────────
CREATE TEMP TABLE _m3924_objects (name text PRIMARY KEY, mimetype text, size bigint) ON COMMIT DROP;
DO $objects$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO _m3924_objects (name, mimetype, size)
      SELECT o.name, o.metadata ->> 'mimetype', NULLIF(o.metadata ->> 'size', '')::bigint
        FROM storage.objects o
       WHERE o.bucket_id = 'post-media'
         AND o.name IN (SELECT key FROM _m3924_entries UNION SELECT key || '.poster.jpg' FROM _m3924_entries)
      ON CONFLICT (name) DO NOTHING
    $q$;
  END IF;
END $objects$;

INSERT INTO public.post_media (
  post_id, user_id, media_type, storage_bucket, storage_path, public_url,
  mime_type, file_size_bytes, thumbnail_storage_path, thumbnail_url,
  processing_status, moderation_status, sort_order
)
SELECT e.post_id,
       e.author_id,
       k.kind,
       'post-media',
       e.key,
       'post-media/' || e.key,
       COALESCE(
         NULLIF(obj.mimetype, ''),
         CASE e.ext
           WHEN 'jpg' THEN 'image/jpeg' WHEN 'jpeg' THEN 'image/jpeg' WHEN 'png' THEN 'image/png'
           WHEN 'webp' THEN 'image/webp' WHEN 'heic' THEN 'image/heic' WHEN 'heif' THEN 'image/heif'
           WHEN 'gif' THEN 'image/gif' WHEN 'avif' THEN 'image/avif' WHEN 'mp4' THEN 'video/mp4'
           WHEN 'm4v' THEN 'video/x-m4v' WHEN 'mov' THEN 'video/quicktime' WHEN 'qt' THEN 'video/quicktime'
           WHEN 'webm' THEN 'video/webm' WHEN '3gp' THEN 'video/3gpp'
         END,
         CASE WHEN lower(COALESCE(e.post_media_type, '')) LIKE k.kind || '/%' THEN lower(e.post_media_type) END,
         CASE WHEN k.kind = 'video' THEN 'video/mp4' ELSE 'application/octet-stream' END
       ),
       obj.size,
       CASE WHEN k.kind = 'video' AND e.ext IN ('mp4', 'mov', 'webm') AND poster.name IS NOT NULL THEN poster.name END,
       CASE WHEN k.kind = 'video' AND e.ext IN ('mp4', 'mov', 'webm') AND poster.name IS NOT NULL THEN 'post-media/' || poster.name END,
       'ready',
       'pending',
       (row_number() OVER (PARTITION BY e.post_id ORDER BY e.ord) - 1)::int
  FROM _m3924_entries e
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN e.ext IN ('mov', 'mp4', 'm4v', 'webm', 'qt', '3gp') THEN 'video'
             WHEN e.ext IN ('jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'avif') THEN 'image'
             WHEN lower(COALESCE(e.post_media_type, '')) LIKE 'video%' THEN 'video'
             ELSE 'image'
           END AS kind
  ) k
  LEFT JOIN _m3924_objects obj ON obj.name = e.key
  LEFT JOIN _m3924_objects poster ON poster.name = e.key || '.poster.jpg'
 WHERE NOT EXISTS (
         SELECT 1 FROM public.post_media pm
          WHERE pm.post_id = e.post_id AND pm.storage_path = e.key
       );

-- ── Postcondition A: every entry step 2 will remove now HAS a row ─────────────
DO $postA$
DECLARE
  unmatched integer;
BEGIN
  SELECT count(*) INTO unmatched
    FROM _m3924_entries e
   WHERE NOT EXISTS (SELECT 1 FROM public.post_media pm WHERE pm.post_id = e.post_id AND pm.storage_path = e.key);
  IF unmatched > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION A FAILED: % entr(y/ies) have no post_media row; step 2 would delete media that exists in no other store.', unmatched;
  END IF;
END $postA$;

-- ── 2. Strip the moved entries from media_urls, keeping external order ────────
UPDATE public.posts p
   SET media_urls = COALESCE(rebuilt.arr, '{}')
  FROM (
    SELECT po.id,
           array_agg(t.u ORDER BY t.ord) FILTER (WHERE t.u !~ '^post-media/') AS arr
      FROM public.posts po,
           LATERAL unnest(po.media_urls) WITH ORDINALITY AS t(u, ord)
     WHERE po.id IN (SELECT DISTINCT post_id FROM _m3924_entries)
     GROUP BY po.id
  ) AS rebuilt
 WHERE p.id = rebuilt.id;

-- ── 3. The touched posts' summary columns, from their rows ────────────────────
-- routes/postcards.ts refreshMediaCounts' rule: ready rows that are distributable
-- (lib/mediaEligibility NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES), 'pending' counted.
UPDATE public.posts p
   SET media_count = s.n,
       has_video = s.has_video,
       primary_media_type = CASE WHEN s.n = 0 THEN 'none' WHEN s.has_video THEN 'video' ELSE 'image' END
  FROM (
    SELECT pm.post_id,
           count(*)::int AS n,
           bool_or(pm.media_type = 'video') AS has_video
      FROM public.post_media pm
     WHERE pm.post_id IN (SELECT DISTINCT post_id FROM _m3924_entries)
       AND pm.processing_status = 'ready'
       AND pm.moderation_status NOT IN ('flagged', 'limited', 'rejected', 'removed', 'owner_deleted')
     GROUP BY pm.post_id
  ) AS s
 WHERE p.id = s.post_id;

-- ── Postconditions B and C ────────────────────────────────────────────────────
DO $postBC$
DECLARE
  left_over integer;
  drifted   integer;
BEGIN
  SELECT count(*) INTO left_over
    FROM public.posts p, LATERAL unnest(COALESCE(p.media_urls, '{}')) u
   WHERE u ~ '^(post-media|profile-media)/'
      OR u ~ '/storage/v1/object/public/(post-media|profile-media)/';
  IF left_over > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION B FAILED: % storage-backed media_urls entr(y/ies) remain.', left_over;
  END IF;

  SELECT count(*) INTO drifted
    FROM public.posts p
   WHERE p.id IN (SELECT DISTINCT post_id FROM _m3924_entries)
     AND p.media_count IS DISTINCT FROM (
           SELECT count(*)::int FROM public.post_media pm
            WHERE pm.post_id = p.id AND pm.processing_status = 'ready'
              AND pm.moderation_status NOT IN ('flagged', 'limited', 'rejected', 'removed', 'owner_deleted'));
  IF drifted > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION C FAILED: % touched post(s) have media_count unequal to their rows.', drifted;
  END IF;
END $postBC$;

COMMIT;
