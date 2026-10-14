-- 3808_media_asset_renditions.sql
-- Highlights/Memories spec §20 (docs/specs/Portava_Highlights_Memories_
-- Development_Architecture_Spec_v1.txt:561): "Original, viewer, card, and tiny
-- renditions should be distinct signed derivatives." Census H182
-- (census-highlights-memories.md:550, NOT-BUILT: "`lib/mediaAssets.ts:151`
-- carries `thumbnail_path`/`thumbnail_url` only — two tiers, not four").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; B58 memories band
-- 3802-3819, cluster MEM-RENDITIONS). APPLIED TO NO DATABASE by the lane that
-- wrote it. ADDITIVE: one new table and one partial index. No flag, no trigger,
-- no function, NO ROW WRITTEN (open owner question Q-H182-2, fail-closed default:
-- no backfill — a Memory item uploaded before this file keeps the single URL it
-- has today).
--
-- ── 1. WHAT A ROW IS ────────────────────────────────────────────────────────
-- One stored object that is a named rung of one canonical media asset's ladder:
--   original  the asset's own object (media_assets.storage_path), as stored —
--             already EXIF/GPS-stripped and capped at 4096 px by /media/upload
--   viewer    the full-screen rendition: the upload's `<stem>.feed.jpg` (1500 px)
--             or, when the upload did not leave one, `<stem>.viewer.jpg`
--             generated from the stored original. For a VIDEO the viewer IS the
--             original (this tier has no transcoder, census-media MD277), and the
--             row says so by naming the original's own path.
--   card      the list/cover rendition: the upload's `<stem>.thumb.jpg` (400 px)
--             or a generated `<stem>.card.jpg`; for a video, made from its poster
--   tiny      `<stem>.tiny.jpg`, at most 64 px on its longest edge, low quality,
--             no metadata at all (lib/mediaProcessing.ts makeTinyVariant)
-- `media_asset_renditions_ladder_check` holds the rungs to their sizes, so a
-- writer cannot register a 4096 px object as a card or a 400 px one as a tiny,
-- and `media_asset_renditions_path_check` refuses an absolute path, a traversal
-- and the two prefixes an authenticated client can write to directly
-- (memories/, stories/ — never EXIF-stripped by the server; lib/mediaPosterPath
-- applies the same rule to posters).
--
-- ── 2. WHO WRITES IT ────────────────────────────────────────────────────────
-- services/memory/memoryMediaRenditions.ts, on the API's service client, after a
-- Memory's ADD_MEDIA. It registers a row only for an object it has just written
-- or has downloaded and decoded, so a registered path is never a broken one. It
-- writes with ON CONFLICT DO NOTHING: a row is never rewritten (service_role has
-- no UPDATE), so the first registration of a rung is the one that stands.
--
-- ── 3. WHO READS IT ─────────────────────────────────────────────────────────
-- The Memory reads in routes/memories.ts (detail items, list covers, the trip
-- Memory cover) attach `renditions: {viewer, card, tiny, original?}` as bare
-- `<bucket>/<path>` refs the client signs through /api/media/sign. A NON-OWNER is
-- never given the `original` ref when a distinct viewer exists (open owner
-- question Q-H182-1, fail-closed default). Byte access is unchanged:
-- lib/mediaAccess still decides every signature, and a rendition grants no read
-- that its original does not.
--
-- ── 4. WHO DELETES IT ───────────────────────────────────────────────────────
-- Rows: ON DELETE CASCADE from media_assets (AccountDeletionService's
-- delete_media_assets step deletes the account's assets), and the Memory
-- service's purge (§21 DERIVATIVES_PURGED, and REMOVE_MEDIA) once no live Memory
-- item still shows the asset. Objects: the account deletion collects every
-- registered rendition path BEFORE the assets go (collect_media_rendition_paths);
-- the Memory purge removes the objects the Memory service itself wrote (tiny,
-- and a generated viewer/card) and never the upload's own objects.
--
-- ── 5. ACCESS ───────────────────────────────────────────────────────────────
-- RLS ON with NO policy; every client privilege revoked (check:client-privilege-
-- boundary rule 4, and rule 7's SERVER_ONLY_TABLES); service_role holds exactly
-- SELECT, INSERT and DELETE.
--
-- Rollback: db/rollback/2026-10-14-3808-media-asset-renditions-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3808): public.media_assets does not exist — a rendition belongs to a canonical asset.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.media_assets'::regclass AND contype = 'p'
                    AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3808): public.media_assets has no PRIMARY KEY (id) to reference.';
  END IF;
  -- A second apply is accepted; a table of this name with another key is not.
  IF to_regclass('public.media_asset_renditions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = to_regclass('public.media_asset_renditions')
                        AND conname = 'media_asset_renditions_pkey' AND contype = 'p') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3808): public.media_asset_renditions exists without media_asset_renditions_pkey — a table nobody wrote down is in the way.';
  END IF;
END $pre$;

-- ── 1. The table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.media_asset_renditions (
  asset_id     uuid        NOT NULL REFERENCES public.media_assets (id) ON DELETE CASCADE,
  rendition    text        NOT NULL,
  storage_path text        NOT NULL,
  width        integer     NULL,
  height       integer     NULL,
  mime         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_asset_renditions_pkey PRIMARY KEY (asset_id, rendition),
  CONSTRAINT media_asset_renditions_rendition_check
    CHECK (rendition IN ('original', 'viewer', 'card', 'tiny')),
  CONSTRAINT media_asset_renditions_path_check
    CHECK (length(storage_path) BETWEEN 1 AND 1024
           AND left(storage_path, 1) <> '/'
           AND strpos(storage_path, '..') = 0
           AND storage_path !~ '^(memories|stories)/'),
  CONSTRAINT media_asset_renditions_mime_check
    CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm')),
  CONSTRAINT media_asset_renditions_dims_check
    CHECK ((width IS NULL) = (height IS NULL) AND (width IS NULL OR (width > 0 AND height > 0))),
  -- The ladder: TINY_DIM 64, THUMBNAIL_DIM 400 and FEED_DIM 1500 in
  -- lib/mediaProcessing.ts (pinned equal to these by the route suite). A video's
  -- viewer and original carry whatever dimensions the probe measured, or none.
  CONSTRAINT media_asset_renditions_ladder_check
    CHECK (CASE rendition
             WHEN 'tiny'     THEN mime = 'image/jpeg' AND width IS NOT NULL AND greatest(width, height) <= 64
             WHEN 'card'     THEN mime = 'image/jpeg' AND width IS NOT NULL AND greatest(width, height) <= 400
             WHEN 'viewer'   THEN mime LIKE 'video/%' OR (mime = 'image/jpeg' AND width IS NOT NULL AND greatest(width, height) <= 1500)
             WHEN 'original' THEN mime LIKE 'video/%' OR width IS NOT NULL
             ELSE false
           END)
);

-- The read path's first question: "is this item's object a registered original?"
CREATE INDEX IF NOT EXISTS media_asset_renditions_original_path_idx
  ON public.media_asset_renditions (storage_path) WHERE rendition = 'original';

-- ── 2. Access: RLS on, no policy, no client privilege ────────────────────────
ALTER TABLE public.media_asset_renditions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_asset_renditions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.media_asset_renditions TO service_role;

COMMIT;

-- ── Postconditions (separate transaction; catalog reads only, no session state) ─
DO $post$
DECLARE
  r text;
  p text;
BEGIN
  IF to_regclass('public.media_asset_renditions') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): public.media_asset_renditions was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.media_asset_renditions'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): row level security is off on public.media_asset_renditions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.media_asset_renditions'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): public.media_asset_renditions carries a policy — it must have none (service role only)';
  END IF;

  -- No client role or PUBLIC holds anything, at table or column level.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.media_asset_renditions', p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3808): % holds % on public.media_asset_renditions — service role only', r, p;
      END IF;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(r, 'public.media_asset_renditions', p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3808): % holds column % on public.media_asset_renditions', r, p;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
              WHERE c.oid = 'public.media_asset_renditions'::regclass AND x.grantee = 0) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): PUBLIC holds a privilege on public.media_asset_renditions';
  END IF;

  -- The server registers, reads and purges; it never rewrites a registered rung.
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.media_asset_renditions', p) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3808): service_role lacks % on public.media_asset_renditions', p;
    END IF;
  END LOOP;
  FOREACH p IN ARRAY ARRAY['UPDATE', 'TRUNCATE'] LOOP
    IF has_table_privilege('service_role', 'public.media_asset_renditions', p) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3808): service_role holds % on public.media_asset_renditions — a registered rung is never rewritten', p;
    END IF;
  END LOOP;

  -- The key, the cascade from the asset, and the four constraints that define a rung.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.media_asset_renditions'::regclass
                   AND conname = 'media_asset_renditions_pkey' AND contype = 'p'
                   AND pg_get_constraintdef(oid) = 'PRIMARY KEY (asset_id, rendition)') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): PRIMARY KEY (asset_id, rendition) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.media_asset_renditions'::regclass
                   AND contype = 'f' AND confrelid = 'public.media_assets'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): the erasure cascade media_assets -> media_asset_renditions is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.media_asset_renditions'::regclass
                   AND conname = 'media_asset_renditions_rendition_check' AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%''original''%' AND pg_get_constraintdef(oid) LIKE '%''viewer''%'
                   AND pg_get_constraintdef(oid) LIKE '%''card''%' AND pg_get_constraintdef(oid) LIKE '%''tiny''%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): the rendition CHECK (original | viewer | card | tiny) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.media_asset_renditions'::regclass
                   AND conname = 'media_asset_renditions_ladder_check' AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%64%' AND pg_get_constraintdef(oid) LIKE '%400%'
                   AND pg_get_constraintdef(oid) LIKE '%1500%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): the ladder CHECK (tiny <= 64, card <= 400, image viewer <= 1500) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.media_asset_renditions'::regclass
                   AND conname = 'media_asset_renditions_path_check' AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%memories|stories%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): the path CHECK (no client-writable prefix, no traversal) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.media_asset_renditions'::regclass
                   AND conname = 'media_asset_renditions_dims_check' AND contype = 'c')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.media_asset_renditions'::regclass
                   AND conname = 'media_asset_renditions_mime_check' AND contype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): the dimension or mime CHECK is missing';
  END IF;
  IF to_regclass('public.media_asset_renditions_original_path_idx') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808): media_asset_renditions_original_path_idx is missing';
  END IF;
  RAISE NOTICE '3808 postcondition: media_asset_renditions is service-role only (SELECT, INSERT, DELETE), keyed (asset_id, rendition), cascades from media_assets, and holds each rung to its size.';
END $post$;
