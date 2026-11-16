-- Preserve the client column boundary introduced by 3362/3801. A client
-- cannot read the server-owned postcard lifecycle. Cancellation already marks
-- the post deleted; its public status is enough to refuse a late client insert.
-- Client writes serialize with cancellation using a transaction advisory lock;
-- row locks would require UPDATE privilege on posts, which clients do not have.
BEGIN;
CREATE OR REPLACE FUNCTION public.guard_cancelled_postcard_media()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE lifecycle text; post_state text; removed_at timestamptz;
BEGIN
  IF current_user IN ('service_role','postgres') THEN
    IF TG_OP='INSERT' THEN
      SELECT postcard_draft_state INTO lifecycle FROM public.posts WHERE id=NEW.post_id FOR SHARE;
      IF lifecycle='cancelled' THEN RAISE EXCEPTION 'draft_cancelled'; END IF;
    ELSIF NEW.processing_status='ready' AND EXISTS (
      SELECT 1 FROM public.posts p WHERE p.id=NEW.post_id AND p.postcard_draft_state='cancelled'
    ) THEN RAISE EXCEPTION 'draft_cancelled'; END IF;
  ELSIF TG_OP='INSERT' OR NEW.processing_status='ready' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('postcard-media:' || NEW.post_id::text, 0));
    SELECT status, deleted_at INTO post_state, removed_at
      FROM public.posts WHERE id=NEW.post_id;
    IF NOT FOUND OR post_state = 'deleted' OR removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'row-level security: post_unavailable' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
-- Add the matching lock BEFORE cancellation's post-row lock. Keep every
-- existing ownership check and cancellation side effect byte-for-byte.
DO $upgrade$
DECLARE definition text; anchor text := '  SELECT * INTO p FROM public.posts WHERE id=p_post AND author_id=p_actor FOR UPDATE;';
        lock_line text := '  PERFORM pg_advisory_xact_lock(hashtextextended(''postcard-media:'' || p_post::text, 0));';
BEGIN
  definition := pg_get_functiondef('public.cancel_postcard_draft(uuid,uuid)'::regprocedure);
  IF position(lock_line IN definition) = 0 THEN
    IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
      RAISE EXCEPTION '4034 cancellation anchor changed: review before applying';
    END IF;
    EXECUTE replace(definition,anchor,lock_line || E'\n' || anchor);
  END IF;
END;$upgrade$;
REVOKE ALL ON FUNCTION public.guard_cancelled_postcard_media() FROM PUBLIC,anon,authenticated;
DO $post$ BEGIN
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.guard_cancelled_postcard_media()'::regprocedure)
    OR has_function_privilege('authenticated','public.guard_cancelled_postcard_media()','EXECUTE')
    OR has_column_privilege('authenticated','public.posts','postcard_draft_state','SELECT') THEN
    RAISE EXCEPTION '4034 postcard guard must preserve invoker and private-column boundaries';
  END IF;
END;$post$;
COMMIT;
