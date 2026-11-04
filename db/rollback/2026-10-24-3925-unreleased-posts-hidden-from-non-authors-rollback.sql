-- Rollback for 3925_unreleased_posts_hidden_from_non_authors.sql.
-- Removes the two RESTRICTIVE policies. REOPENS the defect 3925 closed: an
-- unreleased delayed-publish post, and its post_media rows, become readable
-- through PostgREST by anyone the permissive policies admit.
BEGIN;
DROP POLICY IF EXISTS post_media_select_post_readable_or_owner ON public.post_media;
DROP POLICY IF EXISTS posts_select_released_or_author ON public.posts;
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND policyname IN ('posts_select_released_or_author', 'post_media_select_post_readable_or_owner')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3925): a 3925 policy remains.';
  END IF;
END $post$;
COMMIT;
