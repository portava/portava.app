-- 3928_memory_items_source_post_guard_post_media.sql
--
-- "Save to a Memory" from one's own post (census-media MD385, lead ruling
-- D-26j) for a post whose media lives in post_media. 2026-10-24, the "video on
-- every surface" fix stacked on #795.
--
-- WRITTEN, NOT APPLIED. One CREATE OR REPLACE of 3999's guard function; no row
-- is read or written, no grant, policy, table or trigger changes.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- 3999's memory_items_source_post_guard accepts a link only when the item's
-- media_url is among the post's own `media_urls`. 2083 made post_media the
-- store for UPLOADED media, 3924 moved the last uploads out of `media_urls`,
-- and #795's create path writes uploads as post_media rows only. So for every
-- upload post the guard refused the post's own photo or video: the reader
-- (services/memory/memoryFromOwnMedia.ts) now offers the post_media rows, and
-- without this file the database would refuse each of them with D-26j.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────
-- Exactly one disjunct is added to the "post's own media" test (c). The item's
-- media_url may now ALSO be a post_media row OF THE SAME POST that is
--   processing_status = 'ready' and moderation_status not 'rejected'/'flagged'
-- (the rows routes/posts.ts filterPostMedia serves), named by the row's
-- public_url or by `<storage_bucket>/<storage_path>`.
-- Unchanged: (a) the post's author must own the item's Memory; (b) the post
-- must be live; the re-parent arm (UPDATE moving memory_id alone) re-checks
-- ownership only; SECURITY INVOKER; the pinned search_path; no client EXECUTE;
-- the trigger and its events. The `media_urls` arm is kept as it was.
--
-- ── USER ISOLATION ───────────────────────────────────────────────────────────
-- The guard only WIDENS to the post's OWN ready, non-rejected, non-flagged
-- post_media row: the row is joined on post_id = the linked post, whose author
-- must own the Memory. Another user's post, another post's row, a row a
-- moderator rejected or flagged, and a row still processing are all refused,
-- as before. No RLS, policy or grant changes.
--
-- ── PRE / POST ───────────────────────────────────────────────────────────────
-- Preconditions: 3999's function, trigger and column exist; post_media carries
-- the six columns read here; the function's body is 3999's or already this
-- file's (re-run). Postconditions: the body is this file's, SECURITY INVOKER
-- with the pinned search_path, no client role may EXECUTE it, and the trigger
-- is still bound to it and enabled.
--
-- Rollback: db/rollback/2026-10-24-3928-memory-items-source-post-guard-post-media-rollback.sql
-- restores 3999's exact function body.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.memory_items_source_post_guard()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3928): public.memory_items_source_post_guard() does not exist (3999 is not applied)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.memory_items'::regclass AND NOT tgisinternal
                    AND tgname = 'memory_items_source_post_guard') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3928): the memory_items_source_post_guard trigger is missing';
  END IF;
  IF to_regclass('public.post_media') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3928): public.post_media does not exist';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'post_media'
         AND column_name IN ('post_id', 'public_url', 'storage_bucket', 'storage_path', 'processing_status', 'moderation_status')) <> 6 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3928): public.post_media must carry post_id, public_url, storage_bucket, storage_path, processing_status and moderation_status';
  END IF;
  -- Only 3999's body (or this file's, on a re-run) is replaced: a later change to the guard is never overwritten.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.memory_items_source_post_guard()'::regprocedure
                    AND position('NEW.media_url = ANY (p.media_urls)' IN prosrc) > 0
                    AND (position('public.post_media' IN prosrc) = 0
                         OR position('3928:' IN prosrc) > 0)) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3928): memory_items_source_post_guard() is neither 3999''s body nor 3928''s — refusing to overwrite it';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.memory_items_source_post_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.source_post_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.posts p
      JOIN public.memories m ON m.id = NEW.memory_id
     WHERE p.id = NEW.source_post_id
       AND p.author_id = m.owner_id
       -- Re-parenting (an UPDATE moving memory_id alone: 3676's split / merge) needs ownership only.
       AND ((TG_OP = 'UPDATE' AND NEW.source_post_id IS NOT DISTINCT FROM OLD.source_post_id
                              AND NEW.media_url IS NOT DISTINCT FROM OLD.media_url)
            OR (p.status = 'active' AND p.deleted_at IS NULL
                AND (NEW.media_url = ANY (p.media_urls)
                     -- 3928: or the post's OWN ready, non-rejected, non-flagged post_media row (uploads since 2083 / 3924)
                     OR EXISTS (SELECT 1
                                  FROM public.post_media pm
                                 WHERE pm.post_id = p.id
                                   AND pm.processing_status = 'ready'
                                   AND pm.moderation_status IS DISTINCT FROM 'rejected'
                                   AND pm.moderation_status IS DISTINCT FROM 'flagged'
                                   AND (NEW.media_url = pm.public_url
                                        OR NEW.media_url = coalesce(pm.storage_bucket, 'post-media') || '/' || pm.storage_path)))))
  ) THEN
    RAISE EXCEPTION 'memory_items.source_post_id: an item may be made only from a live post of the Memory''s own owner, and only from that post''s own media (D-26j)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_items_source_post_guard() FROM PUBLIC, anon, authenticated;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.memory_items_source_post_guard()'::regprocedure
                    AND position('3928:' IN prosrc) > 0
                    AND position('NEW.media_url = ANY (p.media_urls)' IN prosrc) > 0
                    AND position('pm.post_id = p.id' IN prosrc) > 0) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3928): memory_items_source_post_guard() does not carry 3928''s body';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.memory_items_source_post_guard()'::regprocedure
                    AND NOT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3928): memory_items_source_post_guard must stay SECURITY INVOKER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'public.memory_items_source_post_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_items_source_post_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3928): a client role may execute memory_items_source_post_guard';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.memory_items'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
                    AND tgname = 'memory_items_source_post_guard'
                    AND tgfoid = 'public.memory_items_source_post_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3928): the own-media guard trigger is missing or disabled on memory_items';
  END IF;
END
$post$;

COMMIT;
