-- Rollback for 4000_memory_items_source_post_guard_post_media.sql
--
-- Restores migration 3999's memory_items_source_post_guard() body EXACTLY (the
-- CREATE OR REPLACE below is copied byte for byte from
-- artifacts/api-server/src/migrations/3999_memory_items_source_post.sql). The
-- trigger, its events, the column, the indexes and the flag are 3999's and are
-- not touched: 4000 changed none of them.
--
-- EFFECT. The guard again accepts a link only to media among the post's own
-- `media_urls`. Memory items already made from a post_media row stay (the guard
-- runs on INSERT and on UPDATE of source_post_id / memory_id / media_url only);
-- a NEW one from an upload post is refused with D-26j again, and an UPDATE that
-- changes such an item's media_url or source_post_id is refused too. A move of
-- memory_id alone (3676's split / merge) still passes on ownership.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.memory_items_source_post_guard()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (rollback 4000): public.memory_items_source_post_guard() does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.memory_items_source_post_guard()'::regprocedure
                    AND (position('4000:' IN prosrc) > 0
                         OR position('public.post_media' IN prosrc) = 0)) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (rollback 4000): memory_items_source_post_guard() is neither 4000''s body nor 3999''s — refusing to overwrite it';
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
            OR (p.status = 'active' AND p.deleted_at IS NULL AND NEW.media_url = ANY (p.media_urls)))
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
                    AND position('public.post_media' IN prosrc) = 0
                    AND position('NEW.media_url = ANY (p.media_urls)' IN prosrc) > 0
                    AND NOT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (rollback 4000): memory_items_source_post_guard() is not 3999''s body';
  END IF;
  IF has_function_privilege('anon', 'public.memory_items_source_post_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_items_source_post_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (rollback 4000): a client role may execute memory_items_source_post_guard';
  END IF;
END
$post$;

COMMIT;
