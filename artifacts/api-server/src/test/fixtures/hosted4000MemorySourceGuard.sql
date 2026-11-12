-- Read-only catalog snapshot, project ajrurzioarfkagpuxfnb, 2026-11-05.
-- This is the observed function/trigger, NOT a reconstructed migration file or
-- a claim about migration4000's original checksum. Never apply this fixture to production.
CREATE OR REPLACE FUNCTION public.memory_items_source_post_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
                     -- 4000: or the post's OWN ready, non-rejected, non-flagged post_media row (uploads since 2083 / 3924)
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
$function$;
CREATE TRIGGER memory_items_source_post_guard BEFORE INSERT OR UPDATE OF source_post_id, memory_id, media_url ON public.memory_items FOR EACH ROW EXECUTE FUNCTION memory_items_source_post_guard();
