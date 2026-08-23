-- 2141_post_tombstones.sql
-- Owner ruling 4 of 2026-08-23: shared history survives; the deleted person's
-- identity and authored payload do not.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
-- 2139 left posts.author_id as CASCADE, matching what executeAccountDeletion
-- already does (step 2 deletes the user's posts outright). I flagged it there as
-- the one judgement call in the file, because a post carries other people's
-- comments and reactions and they go with it. The owner has now ruled the other
-- way, and specifically:
--
--   "Posts become tombstones whenever other people have contributed to their
--    thread ... Preserve other users' comments and their conversation structure.
--    Hard-delete a post only when it has no third-party comments, moderation
--    dependency, dispute hold, or shared-history dependency."
--
-- ── WHAT A FOREIGN KEY CAN AND CANNOT DO HERE ──────────────────────────────
-- That rule is conditional — it depends on whether anyone else has replied — and
-- a delete rule cannot ask a question. So the FK's job is only to STOP the
-- database deciding: author_id becomes SET NULL, which keeps the row alive and
-- hands the decision to the worker. The worker then either blanks the payload
-- (tombstone) or deletes the row outright (no third-party involvement).
--
-- Trying to express the condition in the constraint is what would go wrong: a
-- CASCADE deletes unconditionally, and there is no third option in SQL.
--
-- ── THE COMMENT CASCADE, WHICH IS WORSE THAN THE POST ONE ──────────────────
-- posts_comments has BOTH:
--     user_id          -> auth.users        CASCADE
--     parent_comment_id -> posts_comments   CASCADE
--
-- Chain them. A departing user's comment is deleted, and every reply underneath
-- it is deleted too — other people's replies, to a comment that is going anyway.
-- The ruling names this case: "Tombstone the departing user's own comments where
-- removing the row would break replies." user_id becomes SET NULL so the comment
-- row survives as a tombstone and the reply chain stays intact. The
-- parent_comment_id CASCADE is then harmless, because no comment is deleted for
-- being authored by a departing user.
--
-- ── ONE AUDITABLE PATH, NOT SCATTERED UPDATE STATEMENTS ────────────────────
-- tombstone_post() blanks the authored payload in one place: text, media,
-- location in all its forms, venue, canonical place, buckets and filters. It is
-- SECURITY DEFINER with an empty search_path and granted only to service_role,
-- following erase_intel_for_actor. A worker that assembles its own UPDATE for
-- this will miss a column the day someone adds one — this table has 70.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.posts does not exist.';
  END IF;
  IF to_regclass('public.posts_comments') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.posts_comments does not exist.';
  END IF;
END $$;

-- ── 1. Stop the database deciding ──────────────────────────────────────────
ALTER TABLE public.posts ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_author_id_fkey;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.posts_comments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.posts_comments DROP CONSTRAINT IF EXISTS posts_comments_user_id_fkey;
ALTER TABLE public.posts_comments
  ADD CONSTRAINT posts_comments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── 2. A tombstone must be legible as one ──────────────────────────────────
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;
ALTER TABLE public.posts_comments
  ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;

COMMENT ON COLUMN public.posts.tombstoned_at IS
  'Set when the author deleted their account and the post was kept as structure because others had contributed to its thread. Distinct from deleted_at, which means the post itself was removed. A surface should render "Post removed." and no author.';
COMMENT ON COLUMN public.posts.author_id IS
  'NULL once the author deletes their account. The row may survive as a tombstone so other people''s comments keep their thread (owner ruling 4, 2026-08-23). After convergence there is no profiles row to join for a name, so surfaces must render an absent author rather than look one up.';
COMMENT ON COLUMN public.posts_comments.user_id IS
  'NULL once the commenter deletes their account. The comment row survives as a tombstone rather than being deleted, because parent_comment_id CASCADEs and deleting it would take other people''s replies with it.';

-- ── 3. The single blanking path ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tombstone_post(p_post_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  found int;
BEGIN
  IF p_post_id IS NULL THEN
    RAISE EXCEPTION 'tombstone_post: post id is required';
  END IF;

  UPDATE public.posts SET
    -- authored payload
    content                 = 'Post removed.',
    media_urls              = '{}',
    media_thumbnail_url     = NULL,
    media_type              = NULL,
    primary_media_type      = NULL,
    media_count             = 0,
    has_video               = false,
    media_duration_seconds  = NULL,
    -- NOT NULL with defaults, so they are RESET rather than nulled. Writing
    -- NULL here raised 23502 on the first run — the same defect class
    -- check:not-null-writes exists to catch, committed by the very function
    -- meant to clean a post up. Reset to the column default so the row stays
    -- valid and carries no authored choice.
    filter_id               = DEFAULT,
    filter_intensity        = DEFAULT,
    original_language       = NULL,
    -- every form of location this table keeps
    location_name           = NULL,
    location_place_id       = NULL,
    location_city           = NULL,
    location_country        = NULL,
    location_lat            = NULL,
    location_lng            = NULL,
    user_gps_lat            = NULL,
    user_gps_lng            = NULL,
    original_lat            = NULL,
    original_lng            = NULL,
    public_lat              = NULL,
    public_lng              = NULL,
    public_location_label   = NULL,
    venue_id                = NULL,
    venue_name              = NULL,
    canonical_location_id   = NULL,
    canonical_place_id      = NULL,
    -- `geog` is deliberately absent: it is a GENERATED column derived from the
    -- lat/lng above, so Postgres refuses to set it ("can only be updated to
    -- DEFAULT") and it clears itself once its inputs are NULL. Listing it looked
    -- more thorough and was simply wrong — the first run failed on it.
    
    -- derived personalisation
    post_buckets            = NULL,
    bucket_classified       = false,
    -- identity and marker
    author_id               = NULL,
    tombstoned_at           = now(),
    updated_at              = now()
  WHERE id = p_post_id;

  GET DIAGNOSTICS found = ROW_COUNT;
  RETURN found > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION public.tombstone_post(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tombstone_post(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.tombstone_post(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tombstone_post(uuid) TO service_role;

COMMENT ON FUNCTION public.tombstone_post(uuid) IS
  'Blanks a post''s authored payload in one auditable place — text, media, every location column, venue, canonical place, buckets and filters — sets the "Post removed." placeholder, severs author_id and stamps tombstoned_at. Used when the author deletes their account and other people have contributed to the thread. A worker assembling this UPDATE itself would miss a column the day one is added; this table has 70.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE bad text := '';
BEGIN
  IF (SELECT c.confdeltype FROM pg_constraint c
       WHERE c.conrelid='public.posts'::regclass AND c.conname='posts_author_id_fkey') <> 'n' THEN
    bad := bad || ' posts.author_id is not SET NULL — the database would still decide;';
  END IF;
  IF (SELECT c.confdeltype FROM pg_constraint c
       WHERE c.conrelid='public.posts_comments'::regclass AND c.conname='posts_comments_user_id_fkey') <> 'n' THEN
    bad := bad || ' posts_comments.user_id is not SET NULL — replies would be destroyed with the comment;';
  END IF;
  IF to_regprocedure('public.tombstone_post(uuid)') IS NULL THEN
    bad := bad || ' tombstone_post is missing;';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='posts'
                AND column_name='author_id' AND is_nullable='NO') THEN
    bad := bad || ' posts.author_id is still NOT NULL;';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'POSTCONDITION FAILED:%', bad; END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- Restoring CASCADE on either column re-arms the destruction of other people's
-- comments and replies. Re-adding NOT NULL is only possible while nothing has
-- been tombstoned.
