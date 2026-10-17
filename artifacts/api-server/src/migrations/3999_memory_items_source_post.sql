-- 3999_memory_items_source_post.sql
--
-- Media Engineering Architecture and Design Spec §44 "Memory / Postcard
-- created", and §31's "Saved visual inspiration": a Memory made FROM a media
-- item. Census docs/architecture/census-media.md MD385; lead ruling D-26j
-- (docs/ops/lead-rulings-20261007-media.md): "from their own media only (§36.4
-- MD385 (a)). The server checks that the person owns the source post."
--
-- WRITTEN, NOT APPLIED. Additive: one nullable column on public.memory_items,
-- its foreign key and two indexes, one SECURITY INVOKER guard function and its
-- trigger, one flag seeded FALSE. No existing row is read or written.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────
-- public.memory_items.source_post_id uuid NULL REFERENCES public.posts(id)
--   NULL       — the item was added the way every item before this file was:
--                by URL (POST /memories/:id/items). Unchanged.
--   NOT NULL   — the item was made from that post's own media
--                (POST /memories/:id/items/from-post), and this is the only
--                reference to the media's origin a Memory item has ever had.
--
-- ── OWN MEDIA ONLY, IN THE DATABASE TOO ──────────────────────────────────────
-- memory_items_source_post_guard refuses any INSERT or any UPDATE of
-- source_post_id / memory_id / media_url whose link is not:
--   * a post whose author_id is the OWNER of the Memory the item belongs to;
--   * a live post (status 'active', deleted_at NULL);
--   * with this item's media_url among that post's own media_urls.
-- The route checks the same before it writes; the trigger is the backstop for
-- any other writer (memory_items is service-role only since 3814, so there is
-- no client writer, and this guard does not depend on that staying true).
-- SECURITY INVOKER: it reads posts and memories as whoever writes the row.
--
-- ── WITHDRAWAL ───────────────────────────────────────────────────────────────
-- ON DELETE CASCADE: when the source post ROW is erased (account erasure hard-
-- deletes posts), every Memory item made from it goes with it. A post the
-- author soft-deletes (status 'deleted') keeps its copies in that same author's
-- own Memories: the Memory is a separate thing the author made on purpose, and
-- deleting a post is not, by itself, deleting a Memory. Whether a soft delete
-- or a moderation hold on the source should also withdraw the copy is an open
-- owner question (MD385-Q1), named in the census rather than taken here.
--
-- ── FLAG ─────────────────────────────────────────────────────────────────────
-- memory_from_own_media_enabled, seeded FALSE. Off or absent: the from-post
-- route refuses feature_disabled and nothing is read. On while this column is
-- absent: the route refuses degraded_unavailable (it reads the column first),
-- never writes an unlinked item. Turning it on is the owner's call.
--
-- Rollback (nothing else depends on these objects):
--   DROP TRIGGER IF EXISTS memory_items_source_post_guard ON public.memory_items;
--   DROP FUNCTION IF EXISTS public.memory_items_source_post_guard();
--   DROP INDEX IF EXISTS public.memory_items_source_post_media_uniq;
--   DROP INDEX IF EXISTS public.memory_items_source_post_id_idx;
--   ALTER TABLE public.memory_items DROP COLUMN IF EXISTS source_post_id;
--   DELETE FROM public.feature_flags WHERE flag = 'memory_from_own_media_enabled';

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memory_items') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3999): public.memory_items does not exist';
  END IF;
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3999): public.memories does not exist';
  END IF;
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3999): public.posts does not exist';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3999): public.feature_flags does not exist';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'memory_items'
         AND column_name IN ('id', 'memory_id', 'media_url')) <> 3 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3999): public.memory_items must carry id, memory_id and media_url';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'posts'
         AND column_name IN ('id', 'author_id', 'status', 'deleted_at', 'media_urls')) <> 5 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3999): public.posts must carry id, author_id, status, deleted_at and media_urls';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'source_post_id'
                AND data_type <> 'uuid') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3999): memory_items.source_post_id exists with a type other than uuid';
  END IF;
END
$pre$;

ALTER TABLE public.memory_items ADD COLUMN IF NOT EXISTS source_post_id uuid;

DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.memory_items'::regclass
                    AND conname = 'memory_items_source_post_id_fkey') THEN
    ALTER TABLE public.memory_items
      ADD CONSTRAINT memory_items_source_post_id_fkey
      FOREIGN KEY (source_post_id) REFERENCES public.posts(id) ON DELETE CASCADE;
  END IF;
END
$fk$;

CREATE INDEX IF NOT EXISTS memory_items_source_post_id_idx
  ON public.memory_items (source_post_id) WHERE source_post_id IS NOT NULL;

-- One copy of one post photo per Memory.
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_source_post_media_uniq
  ON public.memory_items (memory_id, source_post_id, media_url) WHERE source_post_id IS NOT NULL;

COMMENT ON COLUMN public.memory_items.source_post_id IS
  '3999 (census-media MD385, ruling D-26j): the post this item was made from, when it was made from one. Only a live post whose author owns the Memory, and only that post''s own media (memory_items_source_post_guard). Cascades with the post row.';

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
       AND p.status = 'active'
       AND p.deleted_at IS NULL
       AND NEW.media_url = ANY (p.media_urls)
  ) THEN
    RAISE EXCEPTION 'memory_items.source_post_id: an item may be made only from a live post of the Memory''s own owner, and only from that post''s own media (D-26j)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.memory_items_source_post_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS memory_items_source_post_guard ON public.memory_items;
CREATE TRIGGER memory_items_source_post_guard
  BEFORE INSERT OR UPDATE OF source_post_id, memory_id, media_url ON public.memory_items
  FOR EACH ROW
  EXECUTE FUNCTION public.memory_items_source_post_guard();

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('memory_from_own_media_enabled', false,
   '3999 (census-media MD385, ruling D-26j): "Save to a Memory" from one''s OWN post. OFF / absent: POST /memories/:id/items/from-post refuses feature_disabled and reads nothing. ON: the author of a live post may add that post''s media to a Memory they own; anyone else''s post is refused, in the route and by memory_items_source_post_guard.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'source_post_id'
                    AND data_type = 'uuid' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION '3999: memory_items.source_post_id must be a nullable uuid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.memory_items'::regclass AND contype = 'f'
                    AND conname = 'memory_items_source_post_id_fkey'
                    AND confrelid = 'public.posts'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION '3999: memory_items.source_post_id must reference posts and cascade with it';
  END IF;
  IF to_regclass('public.memory_items_source_post_id_idx') IS NULL
     OR to_regclass('public.memory_items_source_post_media_uniq') IS NULL THEN
    RAISE EXCEPTION '3999: the source_post_id indexes are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.memory_items_source_post_guard()'::regprocedure
                    AND NOT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION '3999: memory_items_source_post_guard must be SECURITY INVOKER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'public.memory_items_source_post_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_items_source_post_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION '3999: a client role may execute memory_items_source_post_guard';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.memory_items'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
                    AND tgname = 'memory_items_source_post_guard'
                    AND tgfoid = 'public.memory_items_source_post_guard()'::regprocedure) THEN
    RAISE EXCEPTION '3999: the own-media guard trigger is missing or disabled on memory_items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_from_own_media_enabled') THEN
    RAISE EXCEPTION '3999: memory_from_own_media_enabled is not seeded';
  END IF;
END
$post$;

COMMIT;
