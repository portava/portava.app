-- 3925_unreleased_posts_hidden_from_non_authors.sql
--
-- A delayed-publish post that has not been released is the author's alone,
-- on the database API too. Two RESTRICTIVE SELECT policies: one on posts, one
-- on post_media.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band, lane band
-- 3924-3929). Order-independent of every other file except its prerequisites,
-- all of which sort before it: the posts table and its delayed_post_status
-- enum, post_media (0103), and 3905 (post_media_public_select's current text,
-- which this file does not touch).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT (census-media §56.5, lane MEDIA; lead ruling 2026-10-24)
-- ══════════════════════════════════════════════════════════════════════════════
-- The server never serves an unreleased post to anyone but its author. The
-- authority is lib/postVisibility.ts `isPostPublished`
-- (`!post_status || post_status === "published"`), applied by the post routes'
-- `decidePostReadable` and by lib/mediaAccess.ts `postVisible`, which refuses
-- an unreleased post's bytes. The database API did not apply it:
--   posts_select (TO public, can_see_post(id)) and posts_select_policy
--     (TO authenticated) admit an active PUBLIC post whatever its post_status;
--   post_media_public_select (TO public, 3905) admits a ready row of an active
--     public post whatever its post_status.
-- So while the author was still at the place (post_status
-- 'pending_location_exit' / 'pending_delay' / 'pending_safety_review' / any
-- value but 'published'), anyone with the publishable key, signed in or not,
-- could read the post's content, media references and created time, and its
-- post_media rows (storage key, dimensions, author), through PostgREST. No
-- location column is granted to a client role, and the bytes stayed refused.
-- Production held 0 unreleased posts when this was written (2026-10-24).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIX, AND WHY RESTRICTIVE
-- ══════════════════════════════════════════════════════════════════════════════
-- A RESTRICTIVE policy is ANDed with every permissive one, so one predicate
-- closes every path at once (can_see_post, posts_select_policy and any later
-- permissive policy), without re-deriving or editing their texts.
--   posts       the author, or released: post_status IS NULL OR = 'published'.
--               This is the ONE database statement of the released rule, and it
--               is isPostPublished exactly (a NULL status is a post that never
--               entered the delayed pipeline; the column is NOT NULL DEFAULT
--               'published' today, so that arm is the mirror, not a live path).
--   post_media  the row's owner, or a parent post the reader can read. The
--               EXISTS reads posts as the querying role, so the posts policy
--               above decides it: a non-author reads a row only of a released
--               post, the author reads every row of their own posts. It restates
--               no status test, and it cannot: anon and authenticated hold no
--               SELECT on posts.post_status (column grants, 38 columns), and a
--               policy subquery is checked against the querying role's column
--               privileges — naming p.post_status there fails every client read
--               of post_media with "permission denied for table posts" (measured
--               on the real-PG harness; a policy's own-table quals are not so
--               checked, which is why the posts policy may name the column).
-- The permissive post_media_public_select already requires a readable parent
-- (its EXISTS also reads posts through RLS), so today the posts policy alone
-- closes the media read; the post_media policy holds that bound for any later
-- permissive post_media policy that would not route through posts (for example
-- one built on the SECURITY DEFINER can_see_post, which bypasses RLS).
-- The service role has BYPASSRLS, so every server path is unaffected.
--
-- WHO IS AFFECTED. Only client roles (anon, authenticated) reading through
-- PostgREST. travel-buddy-standalone reads neither table directly (its direct
-- reads are profiles, user_follows, trip_members, trips, rent_buddy_packages,
-- rent_buddy_fee_rules, event_rsvps and circles; no RPC or realtime channel on
-- either table), and its pending-posts screen reads GET /api/posts/pending.
-- The one other policy that reads posts as the querying role is
-- post_media_public_select (its EXISTS); it now sees only released posts for
-- non-authors, which is the same rule. passport_postcards' postcards_select
-- reads posts through the SECURITY DEFINER can_see_postcard and is not
-- changed by this file.
--
-- ROLLBACK: db/rollback/2026-10-24-3925-unreleased-posts-hidden-from-non-authors-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.posts') IS NULL OR to_regclass('public.post_media') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3925): public.posts and public.post_media must exist.';
  END IF;
  IF to_regtype('public.delayed_post_status') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_enum e WHERE e.enumtypid = 'public.delayed_post_status'::regtype AND e.enumlabel = 'published') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3925): the delayed_post_status enum with a ''published'' label must exist.';
  END IF;
  IF (SELECT atttypid FROM pg_attribute WHERE attrelid = 'public.posts'::regclass AND attname = 'post_status' AND NOT attisdropped)
     IS DISTINCT FROM 'public.delayed_post_status'::regtype THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3925): posts.post_status must be a delayed_post_status.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.posts'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.post_media'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3925): row-level security must be enabled on posts and post_media.';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3925): auth.uid() must exist.';
  END IF;
END $pre$;

DROP POLICY IF EXISTS posts_select_released_or_author ON public.posts;
CREATE POLICY posts_select_released_or_author ON public.posts
  AS RESTRICTIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    author_id = (SELECT auth.uid())
    OR post_status IS NULL
    OR post_status = 'published'::public.delayed_post_status
  );

COMMENT ON POLICY posts_select_released_or_author ON public.posts IS
  '3925: an unreleased delayed-publish post (post_status set and not ''published'') is visible to its author only. RESTRICTIVE, so it bounds every permissive SELECT policy. Mirrors lib/postVisibility.ts isPostPublished.';

DROP POLICY IF EXISTS post_media_select_post_readable_or_owner ON public.post_media;
CREATE POLICY post_media_select_post_readable_or_owner ON public.post_media
  AS RESTRICTIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM public.posts p WHERE p.id = post_media.post_id)
  );

COMMENT ON POLICY post_media_select_post_readable_or_owner ON public.post_media IS
  '3925: a post_media row is visible only to its owner or to a reader who can read its post. RESTRICTIVE. The EXISTS reads posts as the querying role, so posts_select_released_or_author decides release; it names no posts column a client role is not granted.';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public'
     AND ((tablename = 'posts' AND policyname = 'posts_select_released_or_author')
       OR (tablename = 'post_media' AND policyname = 'post_media_select_post_readable_or_owner'))
     AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT'
     AND roles @> ARRAY['anon', 'authenticated']::name[] AND cardinality(roles) = 2;
  IF n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3925): expected the two RESTRICTIVE SELECT policies TO anon, authenticated; found %.', n;
  END IF;
END $post$;
