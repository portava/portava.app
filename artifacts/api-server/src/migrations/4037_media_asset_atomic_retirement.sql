-- Generated with Supabase CLI migration new, then moved to the repository's
-- single canonical numbered chain after verifying4036 was the current maximum.
-- One retirement transition and audit, shared by explicit deletion and source
-- lifecycle withdrawal. Storage purge stays with the existing purge worker.
BEGIN;
CREATE FUNCTION public.retire_media_asset(p_asset uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE asset public.media_assets%ROWTYPE; retired_at timestamptz;
BEGIN
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR p_actor IS NULL OR asset.owner_user_id IS DISTINCT FROM p_actor THEN
    RETURN jsonb_build_object('ok',false,'alreadyDeleted',false,'purgeScheduled',false);
  END IF;
  IF asset.purge_status='completed' OR asset.moderation_status='owner_deleted' THEN
    RETURN jsonb_build_object('ok',true,'alreadyDeleted',true,'purgeScheduled',false);
  END IF;
  retired_at := clock_timestamp();
  UPDATE public.media_assets SET moderation_status='owner_deleted', processing_status='removed',
    deleted_at=retired_at, purge_requested_at=retired_at, purge_status='pending', updated_at=retired_at
    WHERE id=asset.id;
  INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
    VALUES(asset.id,p_actor,'soft_deleted','{}'::jsonb);
  -- Any audit failure aborts this transaction. No later compensating UPDATE
  -- can overwrite a concurrent retirement, processing state or newer version.
  RETURN jsonb_build_object('ok',true,'alreadyDeleted',false,'purgeScheduled',true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.retire_media_asset(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retire_media_asset(uuid,uuid) TO service_role;
COMMENT ON FUNCTION public.retire_media_asset(uuid,uuid) IS
  'Canonical owner-authorized asset retirement and audit in one transaction; idempotent under concurrent calls. Storage deletion remains asynchronous.';
COMMIT;
