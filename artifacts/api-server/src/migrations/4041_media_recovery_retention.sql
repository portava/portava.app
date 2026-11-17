-- Generated with Supabase CLI, moved to the sole canonical migration chain.
-- Retention is not proof that bytes survive: restore must verify its source.
-- Rollout requires quiescing old purge workers and revoking old object URLs.
BEGIN;
-- Retained objects and caption JSON are service-owned material. A future
-- permissive bucket policy must not expose or permit planting/renaming keys.
CREATE POLICY media_retention_namespace ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated
  USING(split_part(name,'/',1) NOT IN ('_retained','_recovered','manual-captions')) WITH CHECK(split_part(name,'/',1) NOT IN ('_retained','_recovered','manual-captions'));
ALTER TABLE public.media_assets DROP CONSTRAINT media_assets_purge_status_check;
ALTER TABLE public.media_assets ADD CONSTRAINT media_assets_purge_status_check
  CHECK(purge_status IN ('not_requested','retained','pending','completed','failed'));
ALTER TABLE public.media_assets ADD COLUMN recovery_generation uuid,
  ADD COLUMN recovery_snapshot jsonb;
ALTER TABLE public.post_media ADD COLUMN recovery_snapshot jsonb;
-- A Memory item references the existing canonical source; no duplicate media
-- or attachment store. Hard source erasure is already admin-authorized and
-- cascades its item just as source_post_id and video selection sources do.
ALTER TABLE public.memory_items ADD COLUMN media_asset_id uuid REFERENCES public.media_assets(id) ON DELETE CASCADE;
CREATE INDEX memory_items_media_asset_idx ON public.memory_items(media_asset_id) WHERE media_asset_id IS NOT NULL;

ALTER TABLE public.media_asset_lifecycle_events DROP CONSTRAINT media_asset_lifecycle_events_event_type_check;
ALTER TABLE public.media_asset_lifecycle_events ADD CONSTRAINT media_asset_lifecycle_events_event_type_check
  CHECK(event_type IN ('soft_deleted','purge_succeeded','purge_failed','permanent_deletion_authorized','retention_original_prepared','retention_original_copy_started','retention_original_copied','retention_original_removal_started','retention_original_removed','purge_object_started','purge_object_absent','restoration_prepared','restoration_cancelled','restoration_copy_started','restoration_copied','restoration_dependencies_verified','restoration_dependency_copy_started','restoration_dependency_copied','restoration_abort_requested','restoration_cleanup_started','restoration_cleanup_absent','restoration_caption_prepared','restoration_caption_started','restoration_caption_written','restoration_activated'));
-- Containment lookups revoke exact historical original/sidecar keys without
-- scanning the lifecycle history or storing a second path ledger.
CREATE INDEX media_recovery_retired_paths ON public.media_asset_lifecycle_events
  USING gin(details jsonb_path_ops) WHERE event_type IN ('retention_original_prepared','restoration_prepared');
CREATE UNIQUE INDEX media_retention_original_generation ON public.media_asset_lifecycle_events
  (media_asset_id,(details->>'generation')) WHERE event_type='retention_original_prepared';
CREATE UNIQUE INDEX media_retention_original_transfer_phase ON public.media_asset_lifecycle_events
  (media_asset_id,event_type,(details->>'generation')) WHERE event_type IN ('retention_original_copy_started','retention_original_copied','retention_original_removal_started','retention_original_removed');


-- Bounded index key only; authorization and receipts always compare full paths.
CREATE UNIQUE INDEX media_purge_object_phase ON public.media_asset_lifecycle_events
  (media_asset_id,event_type,(md5(details->>'path'))) WHERE event_type IN ('purge_object_started','purge_object_absent');
CREATE UNIQUE INDEX media_restoration_copy_phase ON public.media_asset_lifecycle_events
  (media_asset_id,event_type,(details->>'reservationId')) WHERE event_type IN ('restoration_copy_started','restoration_copied');
-- Generated destination keys are bounded even for long UTF8 source paths.
CREATE UNIQUE INDEX media_restoration_dependency_copy ON public.media_asset_lifecycle_events
  (media_asset_id,event_type,(details->>'reservationId'),(details->>'destinationPath'))
  WHERE event_type IN ('restoration_dependency_copy_started','restoration_dependency_copied');
CREATE UNIQUE INDEX media_restoration_dependencies ON public.media_asset_lifecycle_events
  (media_asset_id,(details->>'reservationId')) WHERE event_type='restoration_dependencies_verified';
CREATE INDEX media_restoration_transaction ON public.media_asset_lifecycle_events
  ((details->>'transactionId')) WHERE event_type='restoration_activated';
CREATE UNIQUE INDEX media_restoration_activation ON public.media_asset_lifecycle_events
  (media_asset_id,(details->>'generation')) WHERE event_type='restoration_activated';
CREATE UNIQUE INDEX media_restoration_caption ON public.media_asset_lifecycle_events
  (media_asset_id,event_type,(details->>'reservationId')) WHERE event_type IN ('restoration_caption_prepared','restoration_caption_started','restoration_caption_written');
CREATE UNIQUE INDEX media_restoration_abort ON public.media_asset_lifecycle_events
  (media_asset_id,(details->>'reservationId')) WHERE event_type='restoration_abort_requested';
CREATE UNIQUE INDEX media_restoration_cleanup ON public.media_asset_lifecycle_events
  (media_asset_id,event_type,(details->>'reservationId'),(details->>'path'))
  WHERE event_type IN ('restoration_cleanup_started','restoration_cleanup_absent');
CREATE UNIQUE INDEX media_restoration_cancellation ON public.media_asset_lifecycle_events
  (media_asset_id,(details->>'reservationId')) WHERE event_type='restoration_cancelled';
CREATE UNIQUE INDEX media_verified_purge_completion ON public.media_asset_lifecycle_events
  (media_asset_id) WHERE event_type='purge_succeeded' AND details->>'purgeProtocol'='verified-objects-v1';

-- Settled means copy/removal outcomes have durable receipts and no pending
-- restoration owns the source. Uncertain writes and uncancelled reservations
-- cannot be outlived by a permanent-deletion claim.
CREATE FUNCTION public.media_retention_transfer_settled(p_asset uuid,p_generation uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
  SELECT NOT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events p
    WHERE p.media_asset_id=p_asset AND p.event_type='retention_original_prepared'
      AND NOT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events c JOIN public.media_asset_lifecycle_events r
        ON r.media_asset_id=c.media_asset_id AND r.event_type='retention_original_removed'
          AND r.details->>'copyId'=c.id::text AND r.details->>'preparationId'=p.id::text
          AND r.details->>'generation'=p.details->>'generation' AND r.details->'sourceAbsent'='true'::jsonb
        WHERE c.media_asset_id=p_asset AND c.event_type='retention_original_copied'
          AND c.details->>'preparationId'=p.id::text AND c.details->>'generation'=p.details->>'generation'))
    AND NOT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events p WHERE p.media_asset_id=p_asset
      AND p.event_type='restoration_prepared'
      AND NOT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events c WHERE c.media_asset_id=p_asset
        AND c.event_type IN ('restoration_cancelled','restoration_activated') AND c.details->>'reservationId'=p.id::text));
$fn$;
REVOKE ALL ON FUNCTION public.media_retention_transfer_settled(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.media_retention_transfer_settled(uuid,uuid) TO service_role;

-- Keep every declared locator, including history and reserved destinations.
-- A missing copy acknowledgement is not evidence that its key is empty. The
-- transfer barrier still prevents erasure while any dispatched write is unresolved.
-- NULL marks unresolved provenance and makes the purge command fail closed.
CREATE FUNCTION public.media_permanent_purge_paths(p_asset uuid)
RETURNS SETOF text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
  WITH asset AS (SELECT * FROM public.media_assets WHERE id=p_asset),
  sources AS (SELECT s.* FROM public.post_media s JOIN asset a
    ON s.storage_bucket=a.storage_bucket AND s.storage_path=a.storage_path),
  journal AS (SELECT e.* FROM public.media_asset_lifecycle_events e WHERE e.media_asset_id=p_asset),
  reservations AS (SELECT * FROM journal WHERE event_type='restoration_prepared'),
  paths AS (
    SELECT a.storage_path AS path FROM asset a
    UNION ALL SELECT a.thumbnail_path FROM asset a WHERE NULLIF(a.thumbnail_path,'') IS NOT NULL
    UNION ALL SELECT s.thumbnail_storage_path FROM sources s WHERE NULLIF(s.thumbnail_storage_path,'') IS NOT NULL
    UNION ALL SELECT s.feed_storage_path FROM sources s WHERE NULLIF(s.feed_storage_path,'') IS NOT NULL
    UNION ALL SELECT NULL FROM sources s WHERE
      (NULLIF(s.recovery_snapshot->>'thumbnail_url','') IS NOT NULL AND NULLIF(s.thumbnail_storage_path,'') IS NULL)
      OR (NULLIF(s.recovery_snapshot->>'feed_url','') IS NOT NULL AND NULLIF(s.feed_storage_path,'') IS NULL)
    UNION ALL SELECT NULL FROM sources s,asset a WHERE s.user_id IS DISTINCT FROM a.owner_user_id
    UNION ALL SELECT CASE WHEN e.details->>'bucket'=a.storage_bucket THEN locator.path ELSE NULL END
      FROM journal e CROSS JOIN asset a CROSS JOIN LATERAL
        (VALUES(e.details->>'sourcePath'),(e.details->>'retainedPath')) locator(path)
      WHERE e.event_type IN ('retention_original_prepared','restoration_prepared')
    UNION ALL SELECT CASE WHEN r.details->>'bucket'=a.storage_bucket THEN r.details->>'destinationPath' ELSE NULL END
      FROM reservations r CROSS JOIN asset a
    UNION ALL SELECT CASE WHEN d->>'bucket'=a.storage_bucket THEN d->>'sourcePath' ELSE NULL END
      FROM reservations r CROSS JOIN asset a CROSS JOIN LATERAL jsonb_array_elements(r.details->'dependencies') d
    UNION ALL SELECT '_recovered/'||p_asset::text||'/'||r.id::text||'/objects/'||encode(sha256(convert_to(d->>'sourcePath','UTF8')),'hex')
      FROM reservations r CROSS JOIN LATERAL jsonb_array_elements(r.details->'dependencies') d
      WHERE d->>'sourcePath' IS DISTINCT FROM r.details->>'sourcePath'
    UNION ALL SELECT e.details->>'destinationPath' FROM journal e
      WHERE e.event_type IN ('restoration_dependency_copy_started','restoration_dependency_copied','restoration_caption_prepared')
  ) SELECT DISTINCT path FROM paths;
$fn$;
REVOKE ALL ON FUNCTION public.media_permanent_purge_paths(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.media_permanent_purge_paths(uuid) TO service_role;

-- Logical video ranges and labels are authored content, not disposable cache.
-- Keep the existing rows (and their old source version) while the canonical
-- source is retained. Existing readers still reject withdrawn/version-mismatched
-- sources. Explicit permanent authorization and ordinary live-source edits
-- retain the original invalidation behavior. Install before holding legacy rows.
DO $segment_retention$
DECLARE definition text; anchor text:='  IF TG_TABLE_NAME = ''media_assets'' THEN';
BEGIN
  definition:=pg_get_functiondef('memory_video_segments_private.erase_with_source()'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4041 segment retention anchor changed'; END IF;
  EXECUTE replace(definition,anchor,anchor||E'\n    IF NEW.purge_status=''retained'' AND NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;');
END;$segment_retention$;

-- Quiesce old workers before applying. A queued/failed purge is uncertain:
-- stop further automatic erasure, but do not invent a recoverable snapshot.
DO $hold_legacy_purges$
BEGIN
  UPDATE public.media_assets SET purge_status='retained',processing_status='removed',
    recovery_generation=gen_random_uuid(),recovery_snapshot=NULL,purge_requested_at=NULL,updated_at=clock_timestamp()
    WHERE deleted_at IS NOT NULL AND moderation_status IN ('owner_deleted','removed')
      AND purge_status IN ('pending','failed') AND recovery_generation IS NULL;
END;$hold_legacy_purges$;

-- Reuse the committed activation receipt for a live or subsequently retained
-- canonical version. A namespace spelling alone proves no ownership. Source
-- withdrawal additionally names the exact post_media row changed by activation.
CREATE FUNCTION public.restored_media_object_owned(p_asset uuid,p_bucket text,p_path text,p_source uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
  SELECT EXISTS(SELECT 1 FROM public.media_assets a JOIN public.media_asset_lifecycle_events e ON e.media_asset_id=a.id
    WHERE a.id=p_asset AND a.storage_bucket=p_bucket AND p_bucket='post-media'
      AND starts_with(a.storage_path,'_recovered/'||a.id::text||'/')
      AND e.event_type='restoration_activated' AND e.details->>'bucket'=p_bucket
      AND e.details->>'destinationPath'=a.storage_path
      AND e.details->>'version'=COALESCE(a.recovery_snapshot->>'version',a.version::text)
      AND starts_with(p_path,'_recovered/'||a.id::text||'/'||(e.details->>'reservationId')||'/')
      AND e.details->'objects' @> jsonb_build_array(jsonb_build_object('path',p_path))
      AND (p_source IS NULL OR (p_path=a.storage_path AND e.details->'changes' @>
        jsonb_build_array(jsonb_build_object('table','post_media','id',p_source)))))
$fn$;
REVOKE ALL ON FUNCTION public.restored_media_object_owned(uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.restored_media_object_owned(uuid,text,text,uuid) TO service_role;

-- Upgrade the existing source and parent retirement triggers. Shared library
-- attachments still do not own the asset's lifecycle; only a source explicitly
-- rebound by activation inherits its original retirement responsibility.
DO $restored_source_retirement$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition:=pg_get_functiondef('public.retire_postcard_media_source()'::regprocedure);
  anchor:=$anchor$OLD.storage_path NOT ILIKE
     OLD.user_id::text||'/'||OLD.post_id::text||'/'||OLD.id::text||'.%'$anchor$;
  replacement:=$replacement$(OLD.storage_path NOT ILIKE
     OLD.user_id::text||'/'||OLD.post_id::text||'/'||OLD.id::text||'.%' AND NOT EXISTS(
       SELECT 1 FROM public.media_assets a WHERE a.storage_bucket=OLD.storage_bucket
         AND a.storage_path=OLD.storage_path AND a.owner_user_id=OLD.user_id
         AND public.restored_media_object_owned(a.id,OLD.storage_bucket,OLD.storage_path,OLD.id)))$replacement$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4041 restored source retirement anchor changed'; END IF;
  EXECUTE replace(definition,anchor,replacement);
  definition:=pg_get_functiondef('public.retire_withdrawn_postcard_assets()'::regprocedure);
  anchor:=$anchor$AND storage_path ILIKE user_id::text||'/'||post_id::text||'/'||id::text||'.%'$anchor$;
  replacement:=$replacement$AND (storage_path ILIKE user_id::text||'/'||post_id::text||'/'||id::text||'.%' OR EXISTS(
        SELECT 1 FROM public.media_assets a WHERE a.storage_bucket=post_media.storage_bucket
          AND a.storage_path=post_media.storage_path AND a.owner_user_id=post_media.user_id
          AND public.restored_media_object_owned(a.id,post_media.storage_bucket,post_media.storage_path,post_media.id)))$replacement$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4041 restored parent retirement anchor changed'; END IF;
  EXECUTE replace(definition,anchor,replacement);
END;$restored_source_retirement$;

CREATE OR REPLACE FUNCTION public.retire_media_asset(p_asset uuid,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE asset public.media_assets%ROWTYPE; retired_at timestamptz:=clock_timestamp(); generation uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR p_actor IS NULL OR asset.owner_user_id IS DISTINCT FROM p_actor THEN
    RETURN jsonb_build_object('ok',false,'alreadyDeleted',false,'purgeScheduled',false);
  END IF;
  -- Old pending/failed/completed receipts may already have lost bytes. Never
  -- relabel them recoverable or replace their generation after an uncertain run.
  IF asset.deleted_at IS NOT NULL OR asset.moderation_status='owner_deleted' OR asset.purge_status='completed' THEN
    RETURN jsonb_build_object('ok',true,'alreadyDeleted',true,'purgeScheduled',false);
  END IF;
  UPDATE public.media_assets SET moderation_status='owner_deleted',processing_status='removed',
    deleted_at=retired_at,purge_requested_at=NULL,purge_status='retained',updated_at=retired_at,
    recovery_generation=generation,recovery_snapshot=jsonb_build_object(
      'moderation_status',asset.moderation_status,'processing_status',asset.processing_status,
      'version',asset.version,'public_url',asset.public_url,'thumbnail_path',asset.thumbnail_path)
    WHERE id=asset.id;
  INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
    VALUES(asset.id,p_actor,'soft_deleted',jsonb_build_object('generation',generation,'retained',true));
  RETURN jsonb_build_object('ok',true,'alreadyDeleted',false,'purgeScheduled',false);
END;$fn$;
REVOKE ALL ON FUNCTION public.retire_media_asset(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retire_media_asset(uuid,uuid) TO service_role;

-- Completed Postcard metadata stays on its existing source row. This runs
-- after the existing withdrawal guard and before source retirement. It also
-- covers cancellation moving a completed slot back to pending.
CREATE FUNCTION public.retain_postcard_media_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  IF NEW.recovery_snapshot IS DISTINCT FROM OLD.recovery_snapshot THEN
    RAISE EXCEPTION 'postcard_retention_snapshot_immutable';
  END IF;
  IF OLD.recovery_snapshot IS NULL AND
     ((OLD.processing_status='ready' AND (NEW.processing_status='pending' OR NEW.deleted_at IS NOT NULL)) OR
      (NEW.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.moderation_actions a
        WHERE a.action_type='content_removed' AND a.metadata->>'target_id'=OLD.id::text
          AND a.metadata->>'retained'='true' AND (a.metadata->>'deleted_at')::timestamptz=NEW.deleted_at))) THEN
    NEW.recovery_snapshot:=jsonb_build_object('processing_status',OLD.processing_status,
      'moderation_status',OLD.moderation_status,'public_url',OLD.public_url,
      'thumbnail_url',OLD.thumbnail_url,'feed_url',OLD.feed_url);
  END IF;
  RETURN NEW;
END;$fn$;
CREATE TRIGGER zz_postcard_retention_snapshot BEFORE UPDATE ON public.post_media
  FOR EACH ROW EXECUTE FUNCTION public.retain_postcard_media_snapshot();
REVOKE ALL ON FUNCTION public.retain_postcard_media_snapshot() FROM PUBLIC,anon,authenticated;

-- A source is the retained record, not disposable projection data. Prevent
-- legacy DELETE, parent cascades and locator replacement from bypassing the
-- existing withdrawal command. Only an executing admin account receipt may
-- erase completed sources; uncompleted, unregistered uploads remain sweepable.
CREATE FUNCTION public.guard_postcard_retention_source()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.post_id,NEW.user_id,NEW.storage_bucket,NEW.storage_path) IS DISTINCT FROM
       (OLD.id,OLD.post_id,OLD.user_id,OLD.storage_bucket,OLD.storage_path) THEN
      RAISE EXCEPTION 'postcard_retention_identity_immutable' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  -- Ordinary clients never gain permanent-delete authority from row ownership.
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'postcard_permanent_deletion_requires_admin' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.user_deletion_requests r WHERE r.user_id=OLD.user_id
      AND r.status='executing' AND r.execution_token IS NOT NULL AND r.execution_started_at IS NOT NULL) THEN RETURN OLD; END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'postcard_lifecycle_requires_read_committed';
  END IF;
  -- Source row lock serializes this read with canonical insertion's SHARE lock.
  IF OLD.processing_status<>'pending' OR OLD.recovery_snapshot IS NOT NULL OR EXISTS(
      SELECT 1 FROM public.media_assets a WHERE a.storage_bucket=OLD.storage_bucket AND a.storage_path=OLD.storage_path) THEN
    RAISE EXCEPTION 'postcard_permanent_deletion_requires_admin' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END;$fn$;
CREATE TRIGGER postcard_retention_source_guard BEFORE DELETE OR UPDATE ON public.post_media
  FOR EACH ROW EXECUTE FUNCTION public.guard_postcard_retention_source();
REVOKE ALL ON FUNCTION public.guard_postcard_retention_source() FROM PUBLIC,anon,authenticated;

-- Extend the existing definer-owned moderation guard: clients can update
-- thumbnail locators but their RLS cannot reliably inspect retained assets.
-- This owner already performs the terminal canonical lookup; keep one path.
DO $dependency_guard$
DECLARE definition text; anchor text:='BEGIN'||chr(10)||'  IF NEW.deleted_at IS NULL AND NEW.moderation_status';
BEGIN
  definition:=pg_get_functiondef('public.guard_removed_media_legacy_publication()'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4041 dependency guard anchor changed'; END IF;
  EXECUTE replace(definition,anchor,$guard$BEGIN
  IF TG_OP='UPDATE' AND (NEW.thumbnail_storage_path,NEW.feed_storage_path) IS DISTINCT FROM
     (OLD.thumbnail_storage_path,OLD.feed_storage_path) THEN
    IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
      RAISE EXCEPTION 'postcard_lifecycle_requires_read_committed';
    END IF;
    IF OLD.deleted_at IS NOT NULL OR OLD.recovery_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'postcard_retained_dependency_immutable';
    END IF;
    -- Source -> canonical is the existing lock order. Exclusive row locks
    -- also avoid lock upgrades when a moderation update retires the asset.
    PERFORM 1 FROM public.media_assets a WHERE a.storage_bucket=OLD.storage_bucket
      AND a.storage_path=OLD.storage_path ORDER BY a.id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.media_assets a WHERE a.storage_bucket=OLD.storage_bucket
      AND a.storage_path=OLD.storage_path AND (a.deleted_at IS NOT NULL OR a.purge_status<>'not_requested'
        OR a.moderation_status IN ('owner_deleted','removed'))) THEN
      RAISE EXCEPTION 'postcard_retained_dependency_immutable';
    END IF;
  END IF;
  IF NEW.deleted_at IS NULL AND NEW.moderation_status$guard$);
END;$dependency_guard$;

DO $sweep_guard$
DECLARE definition text; anchor text:='IF p_before IS NOT NULL THEN';
BEGIN
  definition:=pg_get_functiondef('public.withdraw_postcard_media(uuid,uuid,uuid,text,timestamptz,text,uuid)'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4041 withdrawal anchor changed'; END IF;
  EXECUTE replace(definition,anchor,anchor||E'\n    IF source.recovery_snapshot IS NOT NULL OR EXISTS(SELECT 1 FROM public.media_assets a WHERE a.storage_bucket=source.storage_bucket AND a.storage_path=source.storage_path) THEN RETURN false; END IF;');
END;$sweep_guard$;

-- Retention cannot be released by an old worker's ordinary UPDATE. Existing
-- account erasure already owns an explicitly admin-authorized execution receipt.
CREATE FUNCTION public.guard_retained_media_purge()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE account_erasure boolean; media_erasure boolean;
BEGIN
  -- Retention authority is never supplied by an ordinary row owner. Invoker
  -- execution retains the existing service-only lifecycle boundary.
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'media_retention_service_only' USING ERRCODE='42501';
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.user_deletion_requests r
    WHERE r.user_id IN (OLD.owner_user_id,OLD.uploader_user_id) AND r.status='executing'
      AND r.execution_token IS NOT NULL AND r.execution_started_at IS NOT NULL) INTO account_erasure;
  SELECT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events e WHERE e.media_asset_id=OLD.id
    AND e.event_type='permanent_deletion_authorized' AND e.details->>'generation'=OLD.recovery_generation::text) INTO media_erasure;
  IF TG_OP='DELETE' THEN
    -- The account executor confirms object/derivative erasure before removing
    -- its source. Per-content erasure keeps the existing canonical tombstone
    -- and its audit; deleting it would cascade away its authorization receipt.
    IF account_erasure AND OLD.purge_status='completed' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'media_permanent_deletion_requires_admin';
  END IF;
  IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR
     OLD.purge_status<>'not_requested' OR NEW.purge_status<>'not_requested' THEN
    IF (NEW.id,NEW.owner_user_id,NEW.uploader_user_id,NEW.storage_bucket,NEW.storage_path,NEW.thumbnail_path) IS DISTINCT FROM
       (OLD.id,OLD.owner_user_id,OLD.uploader_user_id,OLD.storage_bucket,OLD.storage_path,OLD.thumbnail_path) THEN
      RAISE EXCEPTION 'media_retention_identity_immutable';
    END IF;
  END IF;
  IF OLD.recovery_generation IS NOT NULL AND
     ((NEW.recovery_generation,NEW.recovery_snapshot,NEW.deleted_at) IS DISTINCT FROM
      (OLD.recovery_generation,OLD.recovery_snapshot,OLD.deleted_at) OR
      ((NEW.moderation_status,NEW.processing_status) IS DISTINCT FROM (OLD.moderation_status,OLD.processing_status) AND
       NOT (account_erasure AND NEW.moderation_status='owner_deleted' AND NEW.processing_status='removed'))) THEN
    RAISE EXCEPTION 'media_retention_generation_immutable';
  END IF;
  -- Keep the original content metadata, not just its locator. Queue health,
  -- version and purge receipts may advance; late processors cannot rewrite
  -- what a future recovery would restore.
  IF OLD.recovery_generation IS NOT NULL AND
     (to_jsonb(NEW)-ARRAY['version','updated_at','purge_status','purge_requested_at','purged_at','purge_error','processing_status','moderation_status']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['version','updated_at','purge_status','purge_requested_at','purged_at','purge_error','processing_status','moderation_status']) THEN
    RAISE EXCEPTION 'media_retained_metadata_immutable';
  END IF;
  IF NEW.purge_status IN ('pending','failed','completed') AND NOT (account_erasure OR media_erasure) THEN
    RAISE EXCEPTION 'media_permanent_deletion_requires_admin';
  END IF;
  IF NEW.purge_status IN ('pending','failed','completed') AND
     NOT public.media_retention_transfer_settled(OLD.id,OLD.recovery_generation) THEN
    RAISE EXCEPTION 'media_retention_transfer_pending';
  END IF;
  IF NEW.purge_status='completed' AND EXISTS(SELECT 1 FROM public.media_permanent_purge_paths(OLD.id) path
    WHERE NOT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events e WHERE e.media_asset_id=OLD.id
      AND e.event_type='purge_object_absent' AND e.details->>'path'=path
      AND e.details->>'bucket'=OLD.storage_bucket AND e.details->>'generation' IS NOT DISTINCT FROM OLD.recovery_generation::text)) THEN
    RAISE EXCEPTION 'media_purge_objects_unverified';
  END IF;
  IF NEW.purge_status='completed' AND OLD.purge_status NOT IN ('pending','failed','completed') THEN
    RAISE EXCEPTION 'media_purge_completion_requires_claim';
  END IF;
  IF OLD.purge_status IN ('pending','failed','completed') AND OLD.recovery_generation IS NOT NULL AND
     NEW.purge_status NOT IN ('pending','failed','completed') THEN
    RAISE EXCEPTION 'media_permanent_deletion_already_authorized';
  END IF;
  IF OLD.purge_status='completed' AND NEW.purge_status<>'completed' THEN
    RAISE EXCEPTION 'media_purge_completed';
  END IF;
  IF OLD.purge_status='retained' AND NEW.purge_status NOT IN ('retained','pending') THEN
    RAISE EXCEPTION 'media_permanent_deletion_requires_admin';
  END IF;
  RETURN NEW;
END;$fn$;
CREATE TRIGGER retained_media_purge_guard BEFORE UPDATE OR DELETE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_retained_media_purge();
REVOKE ALL ON FUNCTION public.guard_retained_media_purge() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.authorize_media_permanent_deletion(p_actor uuid,p_asset uuid,p_generation uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE asset public.media_assets%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'media_recovery_requires_read_committed';
  END IF;
  IF p_actor IS NULL OR NULLIF(btrim(p_reason),'') IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended','deactivated')
      AND (expires_at IS NULL OR expires_at>clock_timestamp())) THEN
    RETURN jsonb_build_object('ok',false,'error','admin_required');
  END IF;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR p_generation IS NULL OR asset.recovery_generation IS DISTINCT FROM p_generation THEN
    RETURN jsonb_build_object('ok',false,'error','retention_changed');
  END IF;
  IF asset.purge_status IN ('pending','failed','completed') AND EXISTS(
    SELECT 1 FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='permanent_deletion_authorized' AND details->>'generation'=p_generation::text) THEN
    RETURN jsonb_build_object('ok',true,'alreadyAuthorized',true);
  END IF;
  IF asset.purge_status<>'retained' THEN RETURN jsonb_build_object('ok',false,'error','retention_changed'); END IF;
  IF NOT public.media_retention_transfer_settled(p_asset,p_generation) THEN
    RETURN jsonb_build_object('ok',false,'error','retention_transfer_pending');
  END IF;
  INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
    VALUES(p_asset,p_actor,'permanent_deletion_authorized',jsonb_build_object('generation',p_generation,'reason',btrim(p_reason)));
  UPDATE public.media_assets SET purge_status='pending',purge_requested_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=p_asset;
  RETURN jsonb_build_object('ok',true,'alreadyAuthorized',false);
END;$fn$;
REVOKE ALL ON FUNCTION public.authorize_media_permanent_deletion(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_media_permanent_deletion(uuid,uuid,uuid,text) TO service_role;

-- Reserve exactly one original-object transfer on the existing lifecycle
-- journal. The object hash/version are measured by the service before this RPC;
-- destinations and source locators are derived here, never supplied by a client.
-- A prepared receipt is not proof of a copy, revocation, or successful restore.
CREATE FUNCTION public.prepare_media_original_retention(p_asset uuid,p_generation uuid,
  p_object_id uuid,p_object_version text,p_sha256 text,p_size bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE asset public.media_assets%ROWTYPE; initial public.media_assets%ROWTYPE;
  account_id uuid; receipt public.media_asset_lifecycle_events%ROWTYPE; identity jsonb;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'media_recovery_requires_read_committed';
  END IF;
  IF p_generation IS NULL OR p_object_id IS NULL OR p_object_version IS NULL OR
     length(btrim(p_object_version)) NOT BETWEEN 1 AND 200 OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
     OR p_size IS NULL OR p_size<=0 THEN RETURN jsonb_build_object('ok',false,'error','invalid_object_identity'); END IF;
  SELECT * INTO initial FROM public.media_assets WHERE id=p_asset;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','retention_changed'); END IF;
  -- Match the existing account deletion lock before taking the media row lock.
  -- Include uploader-owned deletion as well as the canonical owner's account.
  FOR account_id IN SELECT DISTINCT value FROM unnest(ARRAY[initial.owner_user_id,initial.uploader_user_id]) value
      WHERE value IS NOT NULL ORDER BY value LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||account_id::text,0));
  END LOOP;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR (asset.owner_user_id,asset.uploader_user_id) IS DISTINCT FROM (initial.owner_user_id,initial.uploader_user_id)
     OR asset.recovery_generation IS DISTINCT FROM p_generation OR asset.purge_status<>'retained'
     OR asset.deleted_at IS NULL OR asset.recovery_snapshot IS NULL OR asset.size_bytes IS DISTINCT FROM p_size THEN
    RETURN jsonb_build_object('ok',false,'error','retention_changed');
  END IF;
  IF EXISTS(SELECT 1 FROM public.user_deletion_requests WHERE user_id IN (asset.owner_user_id,asset.uploader_user_id)
      AND (execution_started_at IS NOT NULL OR status IN ('executing','failed','completed','executed'))) THEN
    RETURN jsonb_build_object('ok',false,'error','permanent_deletion_started');
  END IF;
  IF starts_with(asset.storage_path,'_recovered/') AND NOT public.restored_media_object_owned(asset.id,asset.storage_bucket,asset.storage_path) THEN
    RETURN jsonb_build_object('ok',false,'error','restored_source_identity_unverified');
  END IF;
  identity:=jsonb_build_object('generation',p_generation,'bucket',asset.storage_bucket,'sourcePath',asset.storage_path,
    'retainedPath','_retained/'||asset.id::text||'/'||p_generation::text||'/original',
    'objectId',p_object_id,'objectVersion',p_object_version,'sha256',p_sha256,'size',p_size);
  SELECT * INTO receipt FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='retention_original_prepared' AND details->>'generation'=p_generation::text;
  IF FOUND THEN
    IF receipt.details IS DISTINCT FROM identity THEN RETURN jsonb_build_object('ok',false,'error','object_identity_changed'); END IF;
    RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
  END IF;
  INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
    VALUES(p_asset,asset.owner_user_id,'retention_original_prepared',identity) RETURNING * INTO receipt;
  RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
END;$fn$;
REVOKE ALL ON FUNCTION public.prepare_media_original_retention(uuid,uuid,uuid,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_media_original_retention(uuid,uuid,uuid,text,text,bigint) TO service_role;

-- Dispatch authority is granted only once. A repeated/lost claim can reconcile
-- the deterministic destination, but cannot issue another provider copy. No age
-- or lease expiry changes an uncertain operation into new write authority.
CREATE FUNCTION public.advance_media_original_retention(p_asset uuid,p_generation uuid,p_preparation uuid,
  p_phase text,p_token uuid,p_object_id uuid DEFAULT NULL,p_object_version text DEFAULT NULL,p_sha256 text DEFAULT NULL,p_size bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE asset public.media_assets%ROWTYPE; prepared public.media_asset_lifecycle_events%ROWTYPE;
  started public.media_asset_lifecycle_events%ROWTYPE; copied public.media_asset_lifecycle_events%ROWTYPE; removed public.media_asset_lifecycle_events%ROWTYPE; identity jsonb;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'media_recovery_requires_read_committed';
  END IF;
  IF p_phase IS NULL OR p_phase NOT IN ('copy_started','copied','removal_started','removed') OR p_token IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_transfer_phase');
  END IF;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR asset.recovery_generation IS DISTINCT FROM p_generation OR asset.purge_status<>'retained' OR asset.deleted_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','retention_changed');
  END IF;
  SELECT * INTO prepared FROM public.media_asset_lifecycle_events WHERE id=p_preparation AND media_asset_id=p_asset
    AND event_type='retention_original_prepared' AND details->>'generation'=p_generation::text;
  IF NOT FOUND OR prepared.details->>'bucket' IS DISTINCT FROM asset.storage_bucket
     OR prepared.details->>'sourcePath' IS DISTINCT FROM asset.storage_path THEN
    RETURN jsonb_build_object('ok',false,'error','preparation_changed');
  END IF;
  IF EXISTS(SELECT 1 FROM public.user_deletion_requests WHERE user_id IN (asset.owner_user_id,asset.uploader_user_id)
      AND (execution_started_at IS NOT NULL OR status IN ('executing','failed','completed','executed'))) THEN
    RETURN jsonb_build_object('ok',false,'error','permanent_deletion_started');
  END IF;
  IF p_phase IN ('removal_started','removed') THEN
    -- Removal is authorized only against the verified copy, never a destination
    -- merely reserved by preparation. The same asset lock serializes claims.
    SELECT * INTO copied FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='retention_original_copied' AND details->>'generation'=p_generation::text;
    IF NOT FOUND OR copied.details->>'preparationId' IS DISTINCT FROM p_preparation::text
       OR copied.details->>'objectId' IS DISTINCT FROM p_object_id::text
       OR copied.details->>'objectVersion' IS DISTINCT FROM p_object_version
       OR copied.details->>'sha256' IS DISTINCT FROM p_sha256
       OR (copied.details->>'size')::bigint IS DISTINCT FROM p_size THEN
      RETURN jsonb_build_object('ok',false,'error','retained_copy_changed');
    END IF;
    SELECT * INTO started FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='retention_original_removal_started' AND details->>'generation'=p_generation::text;
    IF p_phase='removal_started' THEN
      IF FOUND THEN RETURN jsonb_build_object('ok',true,'execute',false,'token',started.details->>'token'); END IF;
      INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
        VALUES(p_asset,asset.owner_user_id,'retention_original_removal_started',
          jsonb_build_object('generation',p_generation,'preparationId',p_preparation,'copyId',copied.id,'token',p_token));
      RETURN jsonb_build_object('ok',true,'execute',true,'token',p_token);
    END IF;
    IF started.id IS NULL OR started.details->>'token' IS DISTINCT FROM p_token::text
       OR started.details->>'preparationId' IS DISTINCT FROM p_preparation::text
       OR started.details->>'copyId' IS DISTINCT FROM copied.id::text THEN
      RETURN jsonb_build_object('ok',false,'error','removal_authority_changed');
    END IF;
    -- This service-only receipt is written after provider NoSuchKey and a
    -- second integrity check. It records observed absence, not future revocation.
    identity:=jsonb_build_object('generation',p_generation,'preparationId',p_preparation,'copyId',copied.id,'token',p_token,
      'sourceAbsent',true,'objectId',p_object_id,'objectVersion',p_object_version,'sha256',p_sha256,'size',p_size);
    SELECT * INTO removed FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='retention_original_removed' AND details->>'generation'=p_generation::text;
    IF FOUND THEN
      IF removed.details IS DISTINCT FROM identity THEN RETURN jsonb_build_object('ok',false,'error','removal_identity_changed'); END IF;
    ELSE
      INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
        VALUES(p_asset,asset.owner_user_id,'retention_original_removed',identity) RETURNING * INTO removed;
    END IF;
    RETURN jsonb_build_object('ok',true,'receipt',removed.details||jsonb_build_object('id',removed.id));
  END IF;
  SELECT * INTO started FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='retention_original_copy_started' AND details->>'generation'=p_generation::text;
  IF p_phase='copy_started' THEN
    IF FOUND THEN RETURN jsonb_build_object('ok',true,'execute',false,'token',started.details->>'token'); END IF;
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,asset.owner_user_id,'retention_original_copy_started',jsonb_build_object('generation',p_generation,'preparationId',p_preparation,'token',p_token));
    RETURN jsonb_build_object('ok',true,'execute',true,'token',p_token);
  END IF;
  IF started.id IS NULL OR started.details->>'token' IS DISTINCT FROM p_token::text
     OR started.details->>'preparationId' IS DISTINCT FROM p_preparation::text THEN
    RETURN jsonb_build_object('ok',false,'error','copy_authority_changed');
  END IF;
  IF p_object_id IS NULL OR p_object_id::text=prepared.details->>'objectId' OR p_object_version IS NULL
     OR length(btrim(p_object_version)) NOT BETWEEN 1 AND 200 OR p_sha256 IS DISTINCT FROM prepared.details->>'sha256'
     OR p_size IS DISTINCT FROM (prepared.details->>'size')::bigint THEN
    RETURN jsonb_build_object('ok',false,'error','copy_identity_changed');
  END IF;
  identity:=jsonb_build_object('generation',p_generation,'preparationId',p_preparation,'token',p_token,
    'objectId',p_object_id,'objectVersion',p_object_version,'sha256',p_sha256,'size',p_size);
  SELECT * INTO copied FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='retention_original_copied' AND details->>'generation'=p_generation::text;
  IF FOUND THEN
    IF copied.details IS DISTINCT FROM identity THEN RETURN jsonb_build_object('ok',false,'error','copy_identity_changed'); END IF;
  ELSE
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,asset.owner_user_id,'retention_original_copied',identity) RETURNING * INTO copied;
  END IF;
  RETURN jsonb_build_object('ok',true,'receipt',copied.details||jsonb_build_object('id',copied.id));
END;$fn$;
REVOKE ALL ON FUNCTION public.advance_media_original_retention(uuid,uuid,uuid,text,uuid,uuid,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.advance_media_original_retention(uuid,uuid,uuid,text,uuid,uuid,text,text,bigint) TO service_role;



-- One item INSERT owner for ADD_MEDIA and the legacy command transport. The
-- service parses origins; SQL resolves the exact coordinates under a source
-- lock so retirement cannot race a newly attached canonical reference.
CREATE FUNCTION public.insert_memory_media_item(p_actor uuid,p_memory uuid,p_write jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE parent public.memories%ROWTYPE; asset public.media_assets%ROWTYPE; item public.memory_items%ROWTYPE;
  source jsonb; item_id uuid; url text; source_post uuid;
BEGIN
  IF jsonb_typeof(p_write) IS DISTINCT FROM 'object' OR jsonb_typeof(p_write->'media_url') IS DISTINCT FROM 'string'
    OR NULLIF(p_write->>'media_url','') IS NULL THEN RAISE EXCEPTION 'memory_media_write_invalid'; END IF;
  SELECT * INTO parent FROM public.memories WHERE id=p_memory FOR UPDATE;
  IF NOT FOUND OR parent.owner_id IS DISTINCT FROM p_actor OR parent.state NOT IN ('draft','published','archived')
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND account_status='active') THEN
    RAISE EXCEPTION 'memory_media_parent_unavailable';
  END IF;
  url:=p_write->>'media_url'; source_post:=(p_write->>'source_post_id')::uuid;
  item_id:=COALESCE((p_write->>'id')::uuid,gen_random_uuid());
  SELECT * INTO item FROM public.memory_items WHERE id=item_id FOR UPDATE;
  IF FOUND THEN
    IF item.memory_id IS DISTINCT FROM p_memory OR item.media_url IS DISTINCT FROM url OR item.source_post_id IS DISTINCT FROM source_post
      OR (p_write->>'expected_asset_id' IS NOT NULL AND item.media_asset_id IS DISTINCT FROM (p_write->>'expected_asset_id')::uuid) THEN
      RAISE EXCEPTION 'memory_media_item_identity_conflict';
    END IF;
    RETURN jsonb_build_object('item',to_jsonb(item),'duplicate',true);
  END IF;
  source:=NULLIF(p_write->'source_ref','null'::jsonb);
  IF source IS NOT NULL THEN
    IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR COALESCE(source->>'bucket','') NOT IN ('post-media','profile-media')
      OR NULLIF(source->>'path','') IS NULL OR source->>'path' LIKE '%..%' THEN RAISE EXCEPTION 'memory_media_source_invalid'; END IF;
    SELECT * INTO asset FROM public.media_assets WHERE storage_bucket=source->>'bucket' AND storage_path=source->>'path' FOR SHARE;
    IF asset.id IS NULL THEN
      IF p_write->>'expected_asset_id' IS NOT NULL OR COALESCE((SELECT enabled FROM public.feature_flags WHERE flag='media_canonical_enabled'),false) THEN RAISE EXCEPTION 'memory_media_source_unavailable'; END IF;
    ELSIF asset.owner_user_id IS DISTINCT FROM p_actor OR asset.deleted_at IS NOT NULL OR asset.purge_status<>'not_requested'
      OR asset.moderation_status IN ('removed','owner_deleted') THEN
      RAISE EXCEPTION 'memory_media_source_unavailable';
    END IF;
  ELSIF url LIKE 'post-media/%' OR url LIKE 'profile-media/%' THEN
    RAISE EXCEPTION 'memory_media_source_proof_required';
  END IF;
  IF p_write->>'expected_asset_id' IS NOT NULL AND asset.id IS DISTINCT FROM (p_write->>'expected_asset_id')::uuid THEN
    RAISE EXCEPTION 'memory_media_source_changed';
  END IF;
  INSERT INTO public.memory_items(id,memory_id,media_url,media_type,caption,position,source_post_id,media_asset_id)
    VALUES(item_id,p_memory,url,COALESCE(p_write->>'media_type','image/jpeg'),p_write->>'caption',COALESCE((p_write->>'position')::integer,0),source_post,asset.id)
    RETURNING * INTO item;
  RETURN jsonb_build_object('item',to_jsonb(item),'duplicate',false);
END;$fn$;
REVOKE ALL ON FUNCTION public.insert_memory_media_item(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.insert_memory_media_item(uuid,uuid,jsonb) TO service_role;

-- Preserve the kernel's receipt/event/audit transaction and replace only its
-- item INSERT. Its duplicate-receipt branch still runs before source lookup.
DO $memory_item_writer$
DECLARE definition text; original text;
BEGIN
  definition:=pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure);
  original:=substring(definition FROM 'INSERT INTO public.memory_items \(memory_id, media_url, media_type, caption, position, source_post_id\)[\s\S]*?RETURNING \* INTO v_item;');
  IF original IS NULL OR position('insert_memory_media_item' IN definition)>0 THEN RAISE EXCEPTION '4041 Memory item writer anchor changed'; END IF;
  EXECUTE replace(definition,original,'SELECT * INTO v_item FROM jsonb_populate_record(NULL::public.memory_items,public.insert_memory_media_item(v_actor,v_memory_id,v_write)->''item'');');
END;$memory_item_writer$;

-- Origin parsing belongs to the application. This service-only command compares
-- the exact parsed source identity and the unchanged stored URL under locks.
-- It never changes the URL, Memory audience, source state or read permission.
CREATE FUNCTION public.reconcile_memory_media_binding(p_actor uuid,p_item uuid,p_asset uuid,p_url text,p_bucket text,p_path text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $fn$
DECLARE initial public.memory_items%ROWTYPE; item public.memory_items%ROWTYPE; parent public.memories%ROWTYPE; asset public.media_assets%ROWTYPE; owner_id uuid;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE EXCEPTION 'media_recovery_requires_read_committed'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR length(p_reason)>1000 OR NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended','deactivated')
      AND (expires_at IS NULL OR expires_at>clock_timestamp())) THEN RETURN jsonb_build_object('ok',false,'error','admin_required'); END IF;
  SELECT * INTO initial FROM public.memory_items WHERE id=p_item;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','memory_item_unavailable'); END IF;
  SELECT * INTO parent FROM public.memories WHERE id=initial.memory_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','memory_item_unavailable'); END IF;
  owner_id:=parent.owner_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||owner_id::text,0));
  SELECT * INTO parent FROM public.memories WHERE id=initial.memory_id FOR SHARE;
  SELECT * INTO item FROM public.memory_items WHERE id=p_item FOR UPDATE;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR SHARE;
  IF item.id IS NULL OR parent.id IS NULL OR asset.id IS NULL OR item.memory_id IS DISTINCT FROM parent.id
    OR parent.owner_id IS DISTINCT FROM owner_id OR parent.owner_id IS DISTINCT FROM asset.owner_user_id OR parent.state NOT IN ('draft','published','archived')
    OR item.media_url IS DISTINCT FROM p_url OR NULLIF(p_url,'') IS NULL
    OR (asset.storage_bucket,asset.storage_path) IS DISTINCT FROM (p_bucket,p_path)
    OR asset.purge_status NOT IN ('not_requested','retained')
    OR EXISTS(SELECT 1 FROM public.user_deletion_requests WHERE user_id=parent.owner_id AND execution_started_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'error','memory_media_source_changed');
  END IF;
  IF item.media_asset_id=p_asset THEN RETURN jsonb_build_object('ok',true,'alreadyBound',true,'itemId',item.id,'assetId',asset.id); END IF;
  IF item.media_asset_id IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','memory_media_binding_changed'); END IF;
  INSERT INTO public.moderation_actions(target_user_id,performed_by,action_type,reason,metadata)
    VALUES(parent.owner_id,p_actor,'memory_media_source_bound',btrim(p_reason),jsonb_build_object('memory_id',parent.id,'item_id',item.id,'asset_id',asset.id,
      'transaction_id',pg_current_xact_id()::text,'before',encode(sha256(convert_to(to_jsonb(item)::text,'UTF8')),'hex')));
  UPDATE public.memory_items SET media_asset_id=asset.id WHERE id=item.id;
  RETURN jsonb_build_object('ok',true,'alreadyBound',false,'itemId',item.id,'assetId',asset.id);
END;$fn$;
REVOKE ALL ON FUNCTION public.reconcile_memory_media_binding(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_memory_media_binding(uuid,uuid,uuid,text,text,text,text) TO service_role;

-- The Memory domain keeps its private tables private. Review uses its existing
-- memory -> item -> source lock order and returns bindings, never live access.
CREATE FUNCTION memory_video_segments_private.review_retained(p_actor uuid,p_asset uuid,p_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $fn$
DECLARE asset public.media_assets%ROWTYPE; operation public.memory_video_segment_operations%ROWTYPE;
  segment public.memory_video_segments%ROWTYPE; memory public.memories%ROWTYPE; item public.memory_items%ROWTYPE;
  bindings jsonb:='[]'::jsonb; item_bindings jsonb:='[]'::jsonb; memory_ids uuid[]; item_ids uuid[]; target uuid;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE EXCEPTION 'media_recovery_requires_read_committed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended','deactivated')
      AND (expires_at IS NULL OR expires_at>clock_timestamp())) THEN RETURN jsonb_build_object('ok',false,'error','admin_required'); END IF;
  SELECT array_agg(DISTINCT refs.memory_id ORDER BY refs.memory_id),array_agg(DISTINCT refs.item_id ORDER BY refs.item_id)
    INTO memory_ids,item_ids FROM (
      SELECT o.memory_id,o.item_id FROM public.memory_video_segment_operations o WHERE o.asset_id=p_asset
        OR EXISTS(SELECT 1 FROM public.memory_video_segments s WHERE s.id=o.id AND s.asset_id=p_asset)
      UNION SELECT i.memory_id,i.id FROM public.memory_items i WHERE i.media_asset_id=p_asset
    ) refs;
  FOR target IN SELECT unnest(memory_ids) LOOP PERFORM 1 FROM public.memories WHERE id=target FOR SHARE; END LOOP;
  FOR target IN SELECT unnest(item_ids) LOOP PERFORM 1 FROM public.memory_items WHERE id=target FOR UPDATE; END LOOP;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR asset.recovery_generation IS DISTINCT FROM p_generation OR p_generation IS NULL
    OR asset.purge_status<>'retained' OR asset.deleted_at IS NULL OR asset.recovery_snapshot IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','retention_changed');
  END IF;
  -- The canonical lock fences new bindings. A binding committed while we
  -- waited must be reviewed on a new pass, not locked in reverse order.
  FOR item IN SELECT * FROM public.memory_items WHERE media_asset_id=p_asset ORDER BY id LOOP
    IF NOT item.id=ANY(COALESCE(item_ids,ARRAY[]::uuid[])) OR NOT item.memory_id=ANY(COALESCE(memory_ids,ARRAY[]::uuid[])) THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_memory_binding_changed');
    END IF;
    SELECT * INTO memory FROM public.memories WHERE id=item.memory_id;
    IF memory.id IS NULL OR memory.owner_id IS DISTINCT FROM asset.owner_user_id OR memory.state NOT IN ('draft','published','archived') THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_memory_binding_changed');
    END IF;
    item_bindings:=item_bindings||jsonb_build_array(jsonb_build_object('itemId',item.id,'memoryId',memory.id,'ownerId',memory.owner_id,
      'assetId',asset.id,'itemMediaUrl',item.media_url,'sourcePostId',item.source_post_id,
      'memoryFingerprint',encode(sha256(convert_to(to_jsonb(memory)::text,'UTF8')),'hex'),
      'itemFingerprint',encode(sha256(convert_to(to_jsonb(item)::text,'UTF8')),'hex')));
  END LOOP;
  FOR operation IN SELECT * FROM public.memory_video_segment_operations o WHERE o.asset_id=p_asset
      OR EXISTS(SELECT 1 FROM public.memory_video_segments s WHERE s.id=o.id AND s.asset_id=p_asset) ORDER BY o.id FOR SHARE LOOP
    SELECT * INTO memory FROM public.memories WHERE id=operation.memory_id;
    SELECT * INTO item FROM public.memory_items WHERE id=operation.item_id;
    SELECT * INTO segment FROM public.memory_video_segments WHERE id=operation.id FOR SHARE;
    IF operation.asset_id IS DISTINCT FROM asset.id OR operation.owner_id IS DISTINCT FROM asset.owner_user_id
      OR NOT operation.memory_id=ANY(COALESCE(memory_ids,ARRAY[]::uuid[])) OR NOT operation.item_id=ANY(COALESCE(item_ids,ARRAY[]::uuid[]))
      OR memory.id IS NULL OR item.id IS NULL OR memory.owner_id IS DISTINCT FROM operation.owner_id
      OR item.memory_id IS DISTINCT FROM memory.id OR memory.state IS NULL OR memory.state NOT IN ('draft','published','archived') THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_memory_binding_changed');
    END IF;
    IF segment.id IS NOT NULL AND ((segment.memory_id,segment.item_id,segment.owner_id,segment.asset_id) IS DISTINCT FROM
        (operation.memory_id,operation.item_id,operation.owner_id,operation.asset_id)
      OR segment.asset_version IS DISTINCT FROM (asset.recovery_snapshot->>'version')::integer
      OR segment.duration_ms IS DISTINCT FROM asset.duration_ms OR asset.media_type<>'video') THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_memory_binding_changed');
    END IF;
    bindings:=bindings||jsonb_build_array(jsonb_build_object('id',operation.id,'memoryId',memory.id,'itemId',item.id,
      'ownerId',operation.owner_id,'assetId',asset.id,'itemMediaUrl',item.media_url,'sourcePostId',item.source_post_id,
      'operationFingerprint',encode(sha256(convert_to(to_jsonb(operation)::text,'UTF8')),'hex'),
      'memoryFingerprint',encode(sha256(convert_to(to_jsonb(memory)::text,'UTF8')),'hex'),
      'itemFingerprint',encode(sha256(convert_to(to_jsonb(item)::text,'UTF8')),'hex'),
      'segmentFingerprint',CASE WHEN segment.id IS NULL THEN NULL ELSE encode(sha256(convert_to(to_jsonb(segment)::text,'UTF8')),'hex') END,
      'segment',CASE WHEN segment.id IS NULL THEN NULL ELSE memory_video_segments_private.as_json(segment) END));
  END LOOP;
  RETURN jsonb_build_object('ok',true,'bindings',bindings,'itemBindings',item_bindings);
END;$fn$;
REVOKE ALL ON FUNCTION memory_video_segments_private.review_retained(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION memory_video_segments_private.review_retained(uuid,uuid,uuid) TO service_role;

-- Reserve restoration authority without exposing bytes or reactivating rows.
-- The existing journal owns the pending command. Its fresh service-managed
-- destination never reuses a key to which an owner had upload authority.
-- Timestamp serialization in review fingerprints must not depend on the
-- worker connection's timezone. Keep this local to the function invocation.
-- Service-only snapshot for the application's existing origin-safe URL parser.
-- No reference is written here; preparation validates the digest under a table
-- write fence, and keeps only that proof in the existing restoration receipt.
CREATE FUNCTION memory_video_segments_private.unbound_reference_snapshot(p_actor uuid,p_asset uuid,p_after uuid,p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $refs$
  WITH owner AS (SELECT owner_user_id FROM public.media_assets WHERE id=p_asset
    AND EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active')
    AND NOT EXISTS(SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended','deactivated')
      AND (expires_at IS NULL OR expires_at>statement_timestamp()))),
  refs AS MATERIALIZED (SELECT i.id,i.memory_id,i.media_url FROM public.memory_items i
    JOIN public.memories m ON m.id=i.memory_id JOIN owner o ON o.owner_user_id=m.owner_id
    WHERE i.media_asset_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.memory_video_segment_operations b
      WHERE b.item_id=i.id AND b.asset_id=p_asset)),
  summary AS (SELECT count(*) AS total,encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM refs r),
  page AS (SELECT * FROM refs WHERE p_after IS NULL OR id>p_after ORDER BY id LIMIT greatest(1,least(p_limit,100)))
  SELECT jsonb_build_object('ownerId',o.owner_user_id,'fingerprint',s.fingerprint,'total',s.total,
    'items',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM page p),'[]'::jsonb)) FROM owner o CROSS JOIN summary s;
$refs$;
REVOKE ALL ON FUNCTION memory_video_segments_private.unbound_reference_snapshot(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION memory_video_segments_private.unbound_reference_snapshot(uuid,uuid,uuid,integer) TO service_role;
-- Preserve the private segment owner's access boundary; expose only its
-- admin-authorized review projection, never table grants or write authority.
CREATE FUNCTION public.memory_unbound_reference_snapshot(p_actor uuid,p_asset uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $refs$
  SELECT memory_video_segments_private.unbound_reference_snapshot(p_actor,p_asset,p_after,p_limit);
$refs$;
REVOKE ALL ON FUNCTION public.memory_unbound_reference_snapshot(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.memory_unbound_reference_snapshot(uuid,uuid,uuid,integer) TO service_role;

CREATE FUNCTION public.prepare_media_restoration(p_actor uuid,p_asset uuid,p_generation uuid,p_reason text,p_reservation uuid DEFAULT NULL,p_memory_review jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $fn$
DECLARE initial public.media_assets%ROWTYPE; asset public.media_assets%ROWTYPE;
  source public.post_media%ROWTYPE; prepared public.media_asset_lifecycle_events%ROWTYPE;
  copied public.media_asset_lifecycle_events%ROWTYPE; receipt public.media_asset_lifecycle_events%ROWTYPE;
  account_id uuid; post_id uuid; parent_ids uuid[]; source_ids uuid[]:=ARRAY[]::uuid[];
  sources jsonb:='[]'::jsonb; parents jsonb:='[]'::jsonb; reservation uuid:=gen_random_uuid();
  extension text; identity jsonb; dependencies jsonb; memory_review jsonb; caption jsonb; consents jsonb; attachments jsonb;
  passport_ids uuid[]; passport_id uuid; passport public.passport_memories%ROWTYPE; passport_bindings jsonb:='[]'::jsonb;
  reference_snapshot jsonb; reference_review jsonb;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE EXCEPTION 'media_recovery_requires_read_committed'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR length(p_reason)>1000 OR NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended','deactivated')
      AND (expires_at IS NULL OR expires_at>clock_timestamp())) THEN RETURN jsonb_build_object('ok',false,'error','admin_required'); END IF;
  SELECT * INTO initial FROM public.media_assets WHERE id=p_asset;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','retention_changed'); END IF;
  FOR account_id IN SELECT DISTINCT value FROM unnest(ARRAY[initial.owner_user_id,initial.uploader_user_id]) value WHERE value IS NOT NULL ORDER BY value LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||account_id::text,0));
  END LOOP;
  -- NOWAIT avoids lock-order deadlocks with a writer already holding a Memory
  -- row. Refusal asks for a fresh review; it never retries a write implicitly.
  BEGIN
    LOCK TABLE public.memory_items IN SHARE ROW EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.memories IN EXCLUSIVE MODE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_memory_review_busy');
  END;
  SELECT array_agg(DISTINCT s.post_id ORDER BY s.post_id) INTO parent_ids FROM public.post_media s
    WHERE s.storage_bucket=initial.storage_bucket AND s.storage_path=initial.storage_path;
  IF parent_ids IS NULL THEN RETURN jsonb_build_object('ok',false,'error','restoration_source_unavailable'); END IF;
  -- Same parent -> source -> canonical order used by Postcard withdrawal.
  FOR post_id IN SELECT unnest(parent_ids) LOOP
    PERFORM 1 FROM public.posts WHERE id=post_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','restoration_parent_unavailable'); END IF;
    SELECT parents||jsonb_build_array(jsonb_build_object('id',p.id,'fingerprint',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))) INTO parents FROM public.posts p WHERE p.id=post_id;
  END LOOP;
  FOR source IN SELECT * FROM public.post_media WHERE storage_bucket=initial.storage_bucket AND storage_path=initial.storage_path ORDER BY id FOR UPDATE LOOP
    IF source.user_id IS DISTINCT FROM initial.owner_user_id OR NOT source.post_id=ANY(parent_ids)
      OR source.deleted_at IS NULL OR source.recovery_snapshot IS NULL THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_source_unavailable');
    END IF;
    IF (NULLIF(source.recovery_snapshot->>'thumbnail_url','') IS NOT NULL AND NULLIF(source.thumbnail_storage_path,'') IS NULL)
      OR (NULLIF(source.recovery_snapshot->>'feed_url','') IS NOT NULL AND NULLIF(source.feed_storage_path,'') IS NULL) THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_dependency_unresolved');
    END IF;
    source_ids:=array_append(source_ids,source.id);
    sources:=sources||jsonb_build_array(jsonb_build_object('id',source.id,'postId',source.post_id,'fingerprint',encode(sha256(convert_to(to_jsonb(source)::text,'UTF8')),'hex')));
  END LOOP;
  IF cardinality(source_ids)=0 THEN RETURN jsonb_build_object('ok',false,'error','restoration_source_unavailable'); END IF;
  -- entity_type=memory belongs to Passport, not kernel Memories. Lock parents
  -- before canonical/attachment rows, matching the existing Passport writer.
  SELECT COALESCE(array_agg(DISTINCT entity_id ORDER BY entity_id),ARRAY[]::uuid[]) INTO passport_ids
    FROM public.media_attachments WHERE media_asset_id=p_asset AND entity_type='memory';
  FOREACH passport_id IN ARRAY passport_ids LOOP
    SELECT * INTO passport FROM public.passport_memories WHERE id=passport_id FOR UPDATE;
    IF NOT FOUND OR passport.user_id IS DISTINCT FROM initial.owner_user_id
      OR passport.status NOT IN ('active','suggested','dismissed') OR NULLIF(passport.photo_url,'') IS NULL THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_passport_binding_unavailable');
    END IF;
    passport_bindings:=passport_bindings||jsonb_build_array(jsonb_build_object('id',passport.id,'ownerId',passport.user_id,
      'photoUrl',passport.photo_url,'fingerprint',encode(sha256(convert_to(to_jsonb(passport)::text,'UTF8')),'hex')));
  END LOOP;
  memory_review:=memory_video_segments_private.review_retained(p_actor,p_asset,p_generation);
  IF memory_review->>'ok' IS DISTINCT FROM 'true' THEN RETURN memory_review; END IF;

  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR (asset.owner_user_id,asset.uploader_user_id,asset.storage_bucket,asset.storage_path) IS DISTINCT FROM
      (initial.owner_user_id,initial.uploader_user_id,initial.storage_bucket,initial.storage_path)
    OR p_generation IS NULL OR asset.recovery_generation IS DISTINCT FROM p_generation OR asset.purge_status<>'retained'
    OR asset.deleted_at IS NULL OR asset.recovery_snapshot IS NULL THEN RETURN jsonb_build_object('ok',false,'error','retention_changed'); END IF;
  IF EXISTS(SELECT 1 FROM public.user_deletion_requests WHERE user_id IN (asset.owner_user_id,asset.uploader_user_id)
      AND (execution_started_at IS NOT NULL OR status IN ('executing','failed','completed','executed'))) THEN
    RETURN jsonb_build_object('ok',false,'error','permanent_deletion_started');
  END IF;
  -- The asset UPDATE lock fences new attachment FKs; lock existing rows too so
  -- relinking, visibility changes and detach cannot escape the reviewed set.
  -- These bindings are provenance, never a grant to read their parent entities.
  PERFORM 1 FROM public.media_attachments WHERE media_asset_id=p_asset ORDER BY id FOR SHARE;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'assetId',a.media_asset_id,
    'entityType',a.entity_type,'entityId',a.entity_id,
    'fingerprint',encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')) ORDER BY a.id),'[]'::jsonb)
    INTO attachments FROM public.media_attachments a WHERE a.media_asset_id=p_asset;
  -- A concurrent new attachment may have arrived before the asset lock. Do not
  -- lock a newly discovered parent in reverse order; require a fresh review.
  IF EXISTS(SELECT 1 FROM public.media_attachments WHERE media_asset_id=p_asset AND entity_type='memory' AND NOT entity_id=ANY(passport_ids))
    OR EXISTS(SELECT 1 FROM unnest(passport_ids) AS p(id) WHERE NOT EXISTS(SELECT 1 FROM public.media_attachments
      WHERE media_asset_id=p_asset AND entity_type='memory' AND entity_id=p.id)) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_passport_binding_changed');
  END IF;
  SELECT * INTO prepared FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='retention_original_prepared' AND details->>'generation'=p_generation::text;
  SELECT * INTO copied FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='retention_original_copied' AND details->>'generation'=p_generation::text AND details->>'preparationId'=prepared.id::text;
  IF copied.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='retention_original_removed' AND details->>'copyId'=copied.id::text
      AND details->>'preparationId'=prepared.id::text AND details->>'generation'=p_generation::text AND details->'sourceAbsent'='true'::jsonb) THEN
    RETURN jsonb_build_object('ok',false,'error','retained_original_unverified');
  END IF;
  IF NULLIF(asset.thumbnail_url,'') IS NOT NULL AND NULLIF(asset.thumbnail_path,'') IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_dependency_unresolved');
  END IF;
  -- The locked canonical/source rows are the only locator authority. Group by
  -- object, retaining every reference so shared attachments never duplicate work.
  WITH dependency_references AS (
    SELECT asset.thumbnail_path AS path,'canonical_thumbnail'::text AS kind,asset.id AS ref_id
    UNION ALL SELECT s.thumbnail_storage_path,'source_thumbnail',s.id FROM public.post_media s WHERE s.id=ANY(source_ids)
    UNION ALL SELECT s.feed_storage_path,'source_feed',s.id FROM public.post_media s WHERE s.id=ANY(source_ids)
  ), objects AS (
    SELECT path,jsonb_agg(jsonb_build_object('kind',kind,'id',ref_id) ORDER BY kind,ref_id) AS refs
      FROM dependency_references WHERE NULLIF(path,'') IS NOT NULL GROUP BY path
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket',asset.storage_bucket,'sourcePath',path,'references',refs) ORDER BY path COLLATE "C"),'[]'::jsonb)
    INTO dependencies FROM objects;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(dependencies) d
    WHERE length(d->>'sourcePath')>2048 OR (lower(split_part(d->>'sourcePath','/',1))<>asset.owner_user_id::text
      AND NOT public.restored_media_object_owned(asset.id,asset.storage_bucket,d->>'sourcePath'))
      OR d->>'sourcePath' ~ '(^|/)[.][.]?(/|$)' OR d->>'sourcePath' LIKE '%\\%') THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_dependency_unresolved');
  END IF;
  SELECT to_jsonb(m)||jsonb_build_object('fingerprint',encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex'),
    'source',jsonb_build_object('id',asset.id,'owner_user_id',asset.owner_user_id,'storage_bucket',asset.storage_bucket,
      'storage_path',asset.storage_path,'media_type',asset.media_type,'duration_ms',asset.duration_ms,
      'version',(asset.recovery_snapshot->>'version')::integer,'deleted_at',NULL,'purge_status','not_requested',
      'processing_status',asset.recovery_snapshot->>'processing_status','moderation_status',asset.recovery_snapshot->>'moderation_status'))
    INTO caption FROM public.media_caption_manifests m WHERE m.asset_id=p_asset FOR SHARE;
  IF caption->>'object_path' IS NOT NULL AND ((caption->>'source_version')::integer IS DISTINCT FROM (asset.recovery_snapshot->>'version')::integer
    OR asset.media_type<>'video' OR asset.storage_bucket<>'post-media' OR asset.duration_ms IS NULL OR asset.duration_ms<=0) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_caption_unresolved');
  END IF;
  IF EXISTS(SELECT 1 FROM public.media_caption_asr_consents WHERE asset_id=p_asset AND owner_user_id<>asset.owner_user_id)
    OR EXISTS(SELECT 1 FROM public.media_caption_translation_consents WHERE asset_id=p_asset AND owner_user_id<>asset.owner_user_id)
    OR EXISTS(SELECT 1 FROM public.media_dubbing_consents WHERE asset_id=p_asset AND owner_user_id<>asset.owner_user_id) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_consent_binding_changed');
  END IF;
  -- Bind revoked as well as live consent rows and their epochs. Review never
  -- grants consent; a changed/revoked record requires a new review, not replay.
  SELECT jsonb_build_object(
    'asr',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.media_caption_asr_consents c WHERE c.asset_id=p_asset),'[]'::jsonb),
    'asrEpoch',(SELECT to_jsonb(e) FROM public.media_caption_asr_epochs e WHERE e.asset_id=p_asset),
    'translation',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.media_caption_translation_consents c WHERE c.asset_id=p_asset),'[]'::jsonb),
    'translationEpoch',(SELECT to_jsonb(e) FROM public.media_caption_translation_epochs e WHERE e.asset_id=p_asset),
    'dubbing',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.target_language) FROM public.media_dubbing_consents c WHERE c.asset_id=p_asset),'[]'::jsonb),
    'dubbingEpoch',(SELECT to_jsonb(e) FROM public.media_dubbing_epochs e WHERE e.asset_id=p_asset)) INTO consents;
  SELECT * INTO receipt FROM public.media_asset_lifecycle_events r WHERE r.media_asset_id=p_asset
    AND r.event_type='restoration_prepared' AND r.details->>'generation'=p_generation::text
    AND NOT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events c WHERE c.media_asset_id=p_asset
      AND c.event_type='restoration_cancelled' AND c.details->>'reservationId'=r.id::text);
  -- A worker may validate one reviewed reservation, but must never allocate a
  -- different one if cancellation won the race before its dispatch.
  IF p_reservation IS NOT NULL AND (receipt.id IS NULL OR receipt.id IS DISTINCT FROM p_reservation) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_review_changed');
  END IF;
  reference_snapshot:=public.memory_unbound_reference_snapshot(p_actor,p_asset,NULL,1);
  reference_review:=COALESCE(p_memory_review,receipt.details->'unboundMemoryReview');
  IF reference_review IS NULL AND (reference_snapshot->>'total')::bigint=0 THEN
    reference_review:=jsonb_build_object('ownerId',reference_snapshot->'ownerId','fingerprint',reference_snapshot->'fingerprint','total',0,'storageOrigin',NULL,'reviewed',true);
  END IF;
  IF reference_review IS NULL OR reference_review->>'reviewed' IS DISTINCT FROM 'true'
    OR reference_review->'ownerId' IS DISTINCT FROM reference_snapshot->'ownerId'
    OR reference_review->'fingerprint' IS DISTINCT FROM reference_snapshot->'fingerprint'
    OR reference_review->'total' IS DISTINCT FROM reference_snapshot->'total' THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_memory_reference_review_changed');
  END IF;
  identity:=jsonb_build_object('unboundMemoryReview',reference_review,'generation',p_generation,'ownerId',asset.owner_user_id,'retiredVersion',(asset.recovery_snapshot->>'version')::integer,'assetVersion',asset.version,'assetFingerprint',encode(sha256(convert_to(to_jsonb(asset)::text,'UTF8')),'hex'),
    'bucket',asset.storage_bucket,'sourcePath',asset.storage_path,'retainedPath',prepared.details->>'retainedPath',
    'preparationId',prepared.id,'copyId',copied.id,'objectId',copied.details->>'objectId','objectVersion',copied.details->>'objectVersion',
    'sha256',copied.details->>'sha256','size',(copied.details->>'size')::bigint,'sources',sources,'parents',parents,'dependencies',dependencies,
    'authored',jsonb_build_object('caption',caption,'memoryBindings',memory_review->'bindings','memoryItems',memory_review->'itemBindings','passportBindings',passport_bindings,'attachments',attachments,'consents',consents));
  identity:=identity||jsonb_build_object('authoredFingerprint',encode(sha256(convert_to((identity->'authored')::text,'UTF8')),'hex'));
  IF receipt.id IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='restoration_abort_requested' AND details->>'reservationId'=receipt.id::text) THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_aborting');
    END IF;
    IF receipt.actor_user_id IS DISTINCT FROM p_actor OR receipt.details->>'reason' IS DISTINCT FROM btrim(p_reason)
      OR receipt.details-ARRAY['reason','destinationPath'] IS DISTINCT FROM identity THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_review_changed');
    END IF;
    RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
  END IF;
  extension:=CASE asset.mime_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp'
    WHEN 'image/heic' THEN 'heic' WHEN 'image/heif' THEN 'heif' WHEN 'video/mp4' THEN 'mp4' WHEN 'video/quicktime' THEN 'mov' WHEN 'video/webm' THEN 'webm' END;
  IF extension IS NULL THEN RETURN jsonb_build_object('ok',false,'error','restoration_media_type_unavailable'); END IF;
  INSERT INTO public.media_asset_lifecycle_events(id,media_asset_id,actor_user_id,event_type,details)
    VALUES(reservation,p_asset,p_actor,'restoration_prepared',identity||jsonb_build_object('reason',btrim(p_reason),
      'destinationPath','_recovered/'||p_asset::text||'/'||reservation::text||'/original.'||extension)) RETURNING * INTO receipt;
  RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
END;$fn$;
REVOKE ALL ON FUNCTION public.prepare_media_restoration(uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_media_restoration(uuid,uuid,uuid,text,uuid,jsonb) TO service_role;


-- Persist measured dependency identities through the same reviewed reservation.
-- This is verification only: no provider dispatch, cancellation barrier or publication.
CREATE FUNCTION public.verify_media_restoration_dependencies(p_actor uuid,p_asset uuid,p_generation uuid,p_reservation uuid,p_objects jsonb,p_caption jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE reservation public.media_asset_lifecycle_events%ROWTYPE; receipt public.media_asset_lifecycle_events%ROWTYPE;
  reviewed jsonb; identity jsonb; object jsonb; manifest jsonb; track jsonb;
BEGIN
  -- RPC JSON null and an omitted optional argument both mean no caption proof.
  p_caption:=NULLIF(p_caption,'null'::jsonb);
  SELECT * INTO reservation FROM public.media_asset_lifecycle_events WHERE id=p_reservation AND media_asset_id=p_asset
    AND event_type='restoration_prepared' AND details->>'generation'=p_generation::text;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','restoration_review_changed'); END IF;
  reviewed:=public.prepare_media_restoration(p_actor,p_asset,p_generation,reservation.details->>'reason',p_reservation);
  IF reviewed->>'ok' IS DISTINCT FROM 'true' THEN RETURN reviewed; END IF;
  IF jsonb_typeof(p_objects) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok',false,'error','restoration_dependencies_invalid'); END IF;
  IF jsonb_array_length(p_objects)<>jsonb_array_length(reservation.details->'dependencies') OR
    (SELECT count(DISTINCT o->>'sourcePath') FROM jsonb_array_elements(p_objects) o)<>jsonb_array_length(p_objects) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_dependencies_invalid');
  END IF;
  manifest:=reservation.details#>'{authored,caption}';
  IF manifest->>'object_path' IS NULL THEN
    IF p_caption IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','restoration_caption_invalid'); END IF;
  ELSE
    IF jsonb_typeof(p_caption) IS DISTINCT FROM 'object' OR NOT p_caption ?& ARRAY['bucket','sourcePath','objectId','objectVersion','sha256','size','manifestFingerprint','revisionKey','sourceVersion','tracks']
      OR p_caption-ARRAY['bucket','sourcePath','objectId','objectVersion','sha256','size','manifestFingerprint','revisionKey','sourceVersion','tracks']<>'{}'::jsonb
      OR p_caption->>'bucket' IS DISTINCT FROM 'post-media' OR p_caption->>'sourcePath' IS DISTINCT FROM manifest->>'object_path'
      OR p_caption->>'manifestFingerprint' IS DISTINCT FROM manifest->>'fingerprint'
      OR p_caption->>'revisionKey' IS DISTINCT FROM manifest->>'revision_key' OR p_caption->'sourceVersion' IS DISTINCT FROM manifest->'source_version'
      OR jsonb_typeof(p_caption->'tracks') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok',false,'error','restoration_caption_invalid'); END IF;
    IF jsonb_array_length(p_caption->'tracks')>8 OR (SELECT count(DISTINCT t->>'language') FROM jsonb_array_elements(p_caption->'tracks') t)<>jsonb_array_length(p_caption->'tracks') THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_caption_invalid');
    END IF;
    FOR track IN SELECT value FROM jsonb_array_elements(p_caption->'tracks') LOOP
      IF jsonb_typeof(track) IS DISTINCT FROM 'object' OR NOT track ?& ARRAY['language','sourceKind','revision','vttSha256']
        OR track-ARRAY['language','sourceKind','revision','vttSha256']<>'{}'::jsonb
        OR (track->>'language' ~ '^(und|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$') IS NOT TRUE OR length(track->>'language')>35
        OR (track->>'sourceKind' IN ('manual','asr','translation')) IS NOT TRUE
        OR jsonb_typeof(track->'revision') IS DISTINCT FROM 'number' OR (track->>'revision' ~ '^[1-9][0-9]{0,15}$') IS NOT TRUE
        OR (track->>'vttSha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RETURN jsonb_build_object('ok',false,'error','restoration_caption_invalid'); END IF;
      IF (track->>'revision')::bigint>9007199254740991 THEN RETURN jsonb_build_object('ok',false,'error','restoration_caption_invalid'); END IF;
    END LOOP;
  END IF;
  FOR object IN SELECT value FROM jsonb_array_elements(p_objects||CASE WHEN p_caption IS NULL THEN '[]'::jsonb
    ELSE jsonb_build_array(p_caption-ARRAY['manifestFingerprint','revisionKey','sourceVersion','tracks']) END) LOOP
    IF jsonb_typeof(object)<>'object' OR NOT object ?& ARRAY['bucket','sourcePath','objectId','objectVersion','sha256','size']
      OR object-ARRAY['bucket','sourcePath','objectId','objectVersion','sha256','size']<>'{}'::jsonb
      OR NOT (EXISTS(SELECT 1 FROM jsonb_array_elements(reservation.details->'dependencies') d WHERE d->>'bucket'=object->>'bucket' AND d->>'sourcePath'=object->>'sourcePath')
        OR COALESCE(object->>'bucket'='post-media' AND object->>'sourcePath'=manifest->>'object_path',false))
      OR (object->>'objectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS NOT TRUE
      OR jsonb_typeof(object->'objectVersion') IS DISTINCT FROM 'string' OR length(btrim(object->>'objectVersion')) NOT BETWEEN 1 AND 200
      OR (object->>'sha256' ~ '^[0-9a-f]{64}$') IS NOT TRUE OR jsonb_typeof(object->'size') IS DISTINCT FROM 'number'
      OR (object->>'size' ~ '^[1-9][0-9]{0,9}$') IS NOT TRUE THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_dependencies_invalid');
    END IF;
    IF (object->>'size')::bigint>5368709120 THEN RETURN jsonb_build_object('ok',false,'error','restoration_dependencies_invalid'); END IF;
    IF object->>'sourcePath'=reservation.details->>'sourcePath' AND
      (object->>'objectId',object->>'objectVersion',object->>'sha256',object->'size') IS DISTINCT FROM
      (reservation.details->>'objectId',reservation.details->>'objectVersion',reservation.details->>'sha256',reservation.details->'size') THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_dependencies_invalid');
    END IF;
  END LOOP;
  -- Match AuthoredCaptionsService.MAX_CAPTION_ARTIFACT_BYTES (6 * 256KiB + 4096).
  IF p_caption IS NOT NULL AND (p_caption->>'size')::bigint>1576960 THEN RETURN jsonb_build_object('ok',false,'error','restoration_caption_invalid'); END IF;
  SELECT jsonb_build_object('generation',p_generation,'reservationId',p_reservation,
    'authoredFingerprint',reservation.details->>'authoredFingerprint','caption',p_caption,
    'objects',COALESCE(jsonb_agg(value ORDER BY (value->>'sourcePath') COLLATE "C"),'[]'::jsonb))
    INTO identity FROM jsonb_array_elements(p_objects);
  SELECT * INTO receipt FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='restoration_dependencies_verified' AND details->>'reservationId'=p_reservation::text;
  IF FOUND THEN
    IF receipt.details IS DISTINCT FROM identity THEN RETURN jsonb_build_object('ok',false,'error','restoration_dependency_changed'); END IF;
  ELSE
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,p_actor,'restoration_dependencies_verified',identity) RETURNING * INTO receipt;
  END IF;
  RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
END;$fn$;
REVOKE ALL ON FUNCTION public.verify_media_restoration_dependencies(uuid,uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.verify_media_restoration_dependencies(uuid,uuid,uuid,uuid,jsonb,jsonb) TO service_role;

-- The first copy dispatch requires the exact current admin review. Recording
-- the resulting physical copy is reconciliation, not activation: it remains
-- possible after review/role changes and cannot publish any content.
CREATE FUNCTION public.advance_media_restoration_copy(p_actor uuid,p_asset uuid,p_generation uuid,p_reservation uuid,
  p_phase text,p_token uuid,p_object_id uuid DEFAULT NULL,p_object_version text DEFAULT NULL,p_sha256 text DEFAULT NULL,p_size bigint DEFAULT NULL,p_source_path text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE asset public.media_assets%ROWTYPE; reservation public.media_asset_lifecycle_events%ROWTYPE;
  started public.media_asset_lifecycle_events%ROWTYPE; copied public.media_asset_lifecycle_events%ROWTYPE;
  reviewed jsonb; identity jsonb; expected jsonb; binding jsonb:='{}'::jsonb;
  verified public.media_asset_lifecycle_events%ROWTYPE; caption_plan public.media_asset_lifecycle_events%ROWTYPE;
  caption_mode boolean; target_source jsonb; revision text;
  start_event text:='restoration_copy_started'; copied_event text:='restoration_copied';
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE EXCEPTION 'media_recovery_requires_read_committed'; END IF;
  IF p_phase IS NULL OR p_phase NOT IN ('copy_started','copied','caption_prepared','caption_started','caption_written') OR p_token IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_restore_phase'); END IF;
  SELECT * INTO reservation FROM public.media_asset_lifecycle_events WHERE id=p_reservation AND media_asset_id=p_asset
    AND event_type='restoration_prepared' AND details->>'generation'=p_generation::text;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','restoration_review_changed'); END IF;
  caption_mode:=p_phase IN ('caption_prepared','caption_started','caption_written');
  IF caption_mode THEN
    SELECT * INTO verified FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='restoration_dependencies_verified' AND details->>'reservationId'=p_reservation::text
      AND details->>'generation'=p_generation::text AND details->>'authoredFingerprint'=reservation.details->>'authoredFingerprint';
    IF verified.id IS NULL OR verified.details#>>'{caption,sourcePath}' IS NULL
      OR p_source_path IS DISTINCT FROM verified.details#>>'{caption,sourcePath}'
      OR (reservation.details->>'assetVersion')::bigint>=2147483647 THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_caption_unverified');
    END IF;
    target_source:=(reservation.details#>'{authored,caption,source}')||jsonb_build_object(
      'storage_path',reservation.details->>'destinationPath','version',(reservation.details->>'assetVersion')::integer+1);
    revision:=encode(sha256(convert_to('restoration-caption:'||p_reservation::text,'UTF8')),'hex');
    binding:=jsonb_build_object('sourcePath',p_source_path,'verificationId',verified.id,
      'authoredFingerprint',reservation.details->>'authoredFingerprint','targetSource',target_source,'revisionKey',revision,
      'destinationPath','manual-captions/'||p_asset::text||'/v'||(target_source->>'version')||'-'||revision||'.json');
    IF p_phase='caption_prepared' THEN
      IF (p_sha256 ~ '^[a-f0-9]{64}$') IS NOT TRUE OR p_size IS NULL OR p_size NOT BETWEEN 1 AND 1576960 THEN
        RETURN jsonb_build_object('ok',false,'error','restoration_caption_invalid');
      END IF;
      reviewed:=public.prepare_media_restoration(p_actor,p_asset,p_generation,reservation.details->>'reason',p_reservation);
      IF reviewed->>'ok' IS DISTINCT FROM 'true' THEN RETURN reviewed; END IF;
      identity:=binding||jsonb_build_object('generation',p_generation,'reservationId',p_reservation,'sha256',p_sha256,'size',p_size);
      SELECT * INTO caption_plan FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
        AND event_type='restoration_caption_prepared' AND details->>'reservationId'=p_reservation::text;
      IF FOUND THEN
        IF caption_plan.details IS DISTINCT FROM identity THEN RETURN jsonb_build_object('ok',false,'error','restoration_caption_changed'); END IF;
      ELSE
        INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
          VALUES(p_asset,p_actor,'restoration_caption_prepared',identity) RETURNING * INTO caption_plan;
      END IF;
      RETURN jsonb_build_object('ok',true,'receipt',caption_plan.details||jsonb_build_object('id',caption_plan.id));
    END IF;
    SELECT * INTO caption_plan FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='restoration_caption_prepared' AND details->>'reservationId'=p_reservation::text
      AND details->>'generation'=p_generation::text;
    IF caption_plan.id IS NULL OR caption_plan.details-ARRAY['generation','reservationId','sha256','size'] IS DISTINCT FROM binding THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_caption_unprepared');
    END IF;
    expected:=caption_plan.details||jsonb_build_object('objectId',verified.details#>>'{caption,objectId}');
    binding:=binding||jsonb_build_object('rebaseId',caption_plan.id);
    start_event:='restoration_caption_started';copied_event:='restoration_caption_written';
    p_phase:=CASE p_phase WHEN 'caption_started' THEN 'copy_started' ELSE 'copied' END;
  ELSE
    expected:=reservation.details;
  END IF;
  IF p_source_path IS NOT NULL AND NOT caption_mode THEN
    IF p_source_path=reservation.details->>'sourcePath' THEN RETURN jsonb_build_object('ok',false,'error','restoration_original_alias'); END IF;
    SELECT * INTO verified FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='restoration_dependencies_verified' AND details->>'reservationId'=p_reservation::text
      AND details->>'generation'=p_generation::text;
    SELECT value INTO expected FROM jsonb_array_elements(verified.details->'objects') WHERE value->>'sourcePath'=p_source_path;
    IF expected IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reservation.details->'dependencies') d
        WHERE d->>'sourcePath'=p_source_path AND d->>'bucket'=expected->>'bucket') THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_dependency_unverified');
    END IF;
    start_event:='restoration_dependency_copy_started';copied_event:='restoration_dependency_copied';
    binding:=jsonb_build_object('sourcePath',p_source_path,'verificationId',verified.id,
      'destinationPath','_recovered/'||p_asset::text||'/'||p_reservation::text||'/objects/'||encode(sha256(convert_to(p_source_path,'UTF8')),'hex'));
  END IF;
  SELECT * INTO started FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type=start_event AND details->>'reservationId'=p_reservation::text
      AND (p_source_path IS NULL OR details->>'sourcePath'=p_source_path);
  IF p_phase='copy_started' AND started.id IS NULL THEN
    -- Reuse the review owner and its account -> parent -> source -> asset lock
    -- order. Passing the reservation ID makes this validation-only.
    reviewed:=public.prepare_media_restoration(p_actor,p_asset,p_generation,reservation.details->>'reason',p_reservation);
    IF reviewed->>'ok' IS DISTINCT FROM 'true' THEN RETURN reviewed; END IF;
    IF (jsonb_array_length(reservation.details->'dependencies')>0 OR reservation.details#>>'{authored,caption,object_path}' IS NOT NULL) AND NOT EXISTS(
      SELECT 1 FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
        AND event_type='restoration_dependencies_verified' AND details->>'reservationId'=p_reservation::text
        AND details->>'authoredFingerprint'=reservation.details->>'authoredFingerprint') THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_dependencies_unverified');
    END IF;
  END IF;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR asset.recovery_generation IS DISTINCT FROM p_generation OR asset.purge_status<>'retained' OR asset.deleted_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','retention_changed');
  END IF;
  IF EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='restoration_cancelled' AND details->>'reservationId'=p_reservation::text) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_cancelled');
  END IF;
  SELECT * INTO started FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type=start_event AND details->>'reservationId'=p_reservation::text
      AND (p_source_path IS NULL OR details->>'sourcePath'=p_source_path);
  IF p_phase='copy_started' THEN
    IF FOUND THEN RETURN jsonb_build_object('ok',true,'execute',false,'token',started.details->>'token')||binding; END IF;
    IF EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='restoration_abort_requested' AND details->>'reservationId'=p_reservation::text) THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_aborting');
    END IF;
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,p_actor,start_event,jsonb_build_object('generation',p_generation,'reservationId',p_reservation,'token',p_token)||binding);
    RETURN jsonb_build_object('ok',true,'execute',true,'token',p_token)||binding;
  END IF;
  IF started.id IS NULL OR started.details->>'token' IS DISTINCT FROM p_token::text
      OR started.details->>'generation' IS DISTINCT FROM p_generation::text THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_copy_authority_changed');
  END IF;
  IF p_object_id IS NULL OR p_object_id::text=expected->>'objectId' OR p_object_version IS NULL
      OR length(btrim(p_object_version)) NOT BETWEEN 1 AND 200 OR p_sha256 IS DISTINCT FROM expected->>'sha256'
      OR p_size IS DISTINCT FROM (expected->>'size')::bigint THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_copy_identity_changed');
  END IF;
  identity:=jsonb_build_object('generation',p_generation,'reservationId',p_reservation,'token',p_token,
    'objectId',p_object_id,'objectVersion',p_object_version,'sha256',p_sha256,'size',p_size)||binding;
  SELECT * INTO copied FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type=copied_event AND details->>'reservationId'=p_reservation::text
      AND (p_source_path IS NULL OR details->>'sourcePath'=p_source_path);
  IF FOUND THEN
    IF copied.details IS DISTINCT FROM identity THEN RETURN jsonb_build_object('ok',false,'error','restoration_copy_identity_changed'); END IF;
  ELSE
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,started.actor_user_id,copied_event,identity) RETURNING * INTO copied;
  END IF;
  RETURN jsonb_build_object('ok',true,'receipt',copied.details||jsonb_build_object('id',copied.id));
END;$fn$;
REVOKE ALL ON FUNCTION public.advance_media_restoration_copy(uuid,uuid,uuid,uuid,text,uuid,uuid,text,text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.advance_media_restoration_copy(uuid,uuid,uuid,uuid,text,uuid,uuid,text,text,bigint,text) TO service_role;

-- Extend the cancellation owner with a durable abort fence and cleanup phases.
-- A request stops new dispatches but does not release retention. Previously
-- dispatched copies may still reconcile; every one must settle before cleanup.
CREATE FUNCTION public.cancel_media_restoration(p_actor uuid,p_asset uuid,p_generation uuid,p_reservation uuid,p_reason text,
  p_phase text DEFAULT 'cancel',p_path text DEFAULT NULL,p_token uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE asset public.media_assets%ROWTYPE; reservation public.media_asset_lifecycle_events%ROWTYPE;
  receipt public.media_asset_lifecycle_events%ROWTYPE; authority public.media_asset_lifecycle_events%ROWTYPE;
  started public.media_asset_lifecycle_events%ROWTYPE; cancelled public.media_asset_lifecycle_events%ROWTYPE;
  paths text[]; copies jsonb; pending boolean; identity jsonb;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE EXCEPTION 'media_recovery_requires_read_committed'; END IF;
  IF p_phase IS NULL OR p_phase NOT IN ('cancel','request_abort','removal_started','absent') THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_abort_phase');
  END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR length(p_reason)>1000 OR p_actor IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','admin_required');
  END IF;
  -- Recording already-dispatched physical absence may outlive the admin role.
  -- Starting cleanup and final cancellation still require current admin authority.
  IF p_phase<>'absent' AND (NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended','deactivated')
      AND (expires_at IS NULL OR expires_at>clock_timestamp()))) THEN RETURN jsonb_build_object('ok',false,'error','admin_required'); END IF;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR p_generation IS NULL OR asset.recovery_generation IS DISTINCT FROM p_generation OR asset.purge_status<>'retained' THEN
    RETURN jsonb_build_object('ok',false,'error','retention_changed');
  END IF;
  SELECT * INTO reservation FROM public.media_asset_lifecycle_events WHERE id=p_reservation AND media_asset_id=p_asset
    AND event_type='restoration_prepared' AND details->>'generation'=p_generation::text;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','restoration_review_changed'); END IF;
  SELECT * INTO authority FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='restoration_abort_requested' AND details->>'reservationId'=p_reservation::text;
  IF authority.id IS NOT NULL AND (authority.actor_user_id IS DISTINCT FROM p_actor
    OR authority.details->>'reason' IS DISTINCT FROM btrim(p_reason)) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_review_changed');
  END IF;
  SELECT * INTO cancelled FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='restoration_cancelled' AND details->>'reservationId'=p_reservation::text;
  IF cancelled.id IS NOT NULL AND (cancelled.actor_user_id IS DISTINCT FROM p_actor OR cancelled.details->>'reason' IS DISTINCT FROM btrim(p_reason)) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_review_changed');
  END IF;
  SELECT array_agg(path ORDER BY path COLLATE "C") INTO paths FROM public.media_permanent_purge_paths(p_asset) path
    WHERE starts_with(path,'_recovered/'||p_asset::text||'/'||p_reservation::text||'/')
      OR EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events e WHERE e.media_asset_id=p_asset
        AND e.event_type='restoration_caption_prepared' AND e.details->>'reservationId'=p_reservation::text
        AND e.details->>'destinationPath'=path);
  IF paths IS NULL OR NOT reservation.details->>'destinationPath'=ANY(paths) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_manifest_invalid');
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('sourcePath',s.details->>'sourcePath',
    'destinationPath',COALESCE(s.details->>'destinationPath',reservation.details->>'destinationPath'),
    'token',s.details->>'token','copy',CASE WHEN c.id IS NULL THEN NULL ELSE c.details||jsonb_build_object('id',c.id) END)
    ORDER BY s.id),'[]'::jsonb) INTO copies
    FROM public.media_asset_lifecycle_events s LEFT JOIN public.media_asset_lifecycle_events c
      ON c.media_asset_id=s.media_asset_id AND c.details->>'reservationId'=p_reservation::text
        AND c.details->>'generation'=p_generation::text AND c.details->>'token'=s.details->>'token'
        AND c.event_type=CASE s.event_type WHEN 'restoration_copy_started' THEN 'restoration_copied' WHEN 'restoration_caption_started' THEN 'restoration_caption_written' ELSE 'restoration_dependency_copied' END
        AND c.details->>'sourcePath' IS NOT DISTINCT FROM s.details->>'sourcePath'
    WHERE s.media_asset_id=p_asset AND s.event_type IN ('restoration_copy_started','restoration_dependency_copy_started','restoration_caption_started')
      AND s.details->>'reservationId'=p_reservation::text;
  pending:=EXISTS(SELECT 1 FROM jsonb_array_elements(copies) c WHERE c->'copy'='null'::jsonb);
  IF p_phase='request_abort' THEN
    IF cancelled.id IS NOT NULL AND authority.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','restoration_cancelled'); END IF;
    IF authority.id IS NULL THEN
      INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
        VALUES(p_asset,p_actor,'restoration_abort_requested',jsonb_build_object('generation',p_generation,'reservationId',p_reservation,'reason',btrim(p_reason))) RETURNING * INTO authority;
    END IF;
    RETURN jsonb_build_object('ok',true,'receipt',authority.details||jsonb_build_object('id',authority.id),
      'bucket',asset.storage_bucket,'paths',paths,'copies',copies,'pending',pending,
      'cancelled',CASE WHEN cancelled.id IS NULL THEN NULL ELSE cancelled.details||jsonb_build_object('id',cancelled.id) END);
  END IF;
  IF p_phase='cancel' THEN
    IF cancelled.id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'receipt',cancelled.details||jsonb_build_object('id',cancelled.id)); END IF;
    IF pending OR (authority.id IS NULL AND jsonb_array_length(copies)>0) THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_transfer_pending');
    END IF;
    IF authority.id IS NOT NULL AND EXISTS(SELECT 1 FROM unnest(paths) path WHERE NOT EXISTS(
      SELECT 1 FROM public.media_asset_lifecycle_events e WHERE e.media_asset_id=p_asset AND e.event_type='restoration_cleanup_absent'
        AND e.details->>'abortId'=authority.id::text AND e.details->>'path'=path AND e.details->>'bucket'=asset.storage_bucket
        AND e.details->'absent'='true'::jsonb)) THEN RETURN jsonb_build_object('ok',false,'error','restoration_cleanup_pending'); END IF;
    identity:=jsonb_build_object('generation',p_generation,'reservationId',p_reservation,'reason',btrim(p_reason));
    IF authority.id IS NOT NULL THEN identity:=identity||jsonb_build_object('abortId',authority.id,'paths',paths); END IF;
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,p_actor,'restoration_cancelled',identity) RETURNING * INTO receipt;
    RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
  END IF;
  IF cancelled.id IS NOT NULL OR authority.id IS NULL OR pending THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_cleanup_unavailable');
  END IF;
  IF p_path IS NULL OR NOT p_path=ANY(paths) OR p_token IS NULL THEN RETURN jsonb_build_object('ok',false,'error','restoration_cleanup_path_forbidden'); END IF;
  SELECT * INTO started FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='restoration_cleanup_started' AND details->>'reservationId'=p_reservation::text AND details->>'path'=p_path;
  IF p_phase='removal_started' THEN
    IF FOUND THEN RETURN jsonb_build_object('ok',true,'execute',false,'token',started.details->>'token','abortId',authority.id); END IF;
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,p_actor,'restoration_cleanup_started',jsonb_build_object('generation',p_generation,'reservationId',p_reservation,
        'abortId',authority.id,'bucket',asset.storage_bucket,'path',p_path,'token',p_token));
    RETURN jsonb_build_object('ok',true,'execute',true,'token',p_token,'abortId',authority.id);
  END IF;
  IF started.id IS NULL OR started.details->>'token' IS DISTINCT FROM p_token::text
    OR started.details->>'abortId' IS DISTINCT FROM authority.id::text THEN RETURN jsonb_build_object('ok',false,'error','restoration_cleanup_authority_changed'); END IF;
  identity:=started.details||jsonb_build_object('absent',true);
  SELECT * INTO receipt FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
    AND event_type='restoration_cleanup_absent' AND details->>'reservationId'=p_reservation::text AND details->>'path'=p_path;
  IF FOUND THEN
    IF receipt.details IS DISTINCT FROM identity THEN RETURN jsonb_build_object('ok',false,'error','restoration_cleanup_identity_changed'); END IF;
  ELSE
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,p_actor,'restoration_cleanup_absent',identity) RETURNING * INTO receipt;
  END IF;
  RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
END;$fn$;
REVOKE ALL ON FUNCTION public.cancel_media_restoration(uuid,uuid,uuid,uuid,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_media_restoration(uuid,uuid,uuid,uuid,text,text,text,uuid) TO service_role;

-- One service command owns the manifest, per-object claims, observed-absence
-- receipts and final completion/audit. A timeout never grants another dispatch.
CREATE FUNCTION public.advance_media_object_purge(p_asset uuid,p_version bigint,p_phase text,p_path text DEFAULT NULL,p_token uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE asset public.media_assets%ROWTYPE; started public.media_asset_lifecycle_events%ROWTYPE;
  receipt public.media_asset_lifecycle_events%ROWTYPE; paths text[]; identity jsonb;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE EXCEPTION 'media_recovery_requires_read_committed'; END IF;
  IF p_phase IS NULL OR p_phase NOT IN ('manifest','started','absent','completed') THEN RETURN jsonb_build_object('ok',false,'error','invalid_purge_phase'); END IF;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND OR asset.deleted_at IS NULL OR asset.moderation_status NOT IN ('owner_deleted','removed') THEN
    RETURN jsonb_build_object('ok',false,'error','purge_source_changed');
  END IF;
  IF NOT (EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='permanent_deletion_authorized' AND details->>'generation'=asset.recovery_generation::text)
    OR EXISTS(SELECT 1 FROM public.user_deletion_requests WHERE user_id IN (asset.owner_user_id,asset.uploader_user_id)
      AND status='executing' AND execution_token IS NOT NULL AND execution_started_at IS NOT NULL)) THEN
    RETURN jsonb_build_object('ok',false,'error','permanent_deletion_required');
  END IF;
  IF NOT public.media_retention_transfer_settled(p_asset,asset.recovery_generation) THEN
    RETURN jsonb_build_object('ok',false,'error','retention_transfer_pending');
  END IF;
  IF p_phase='completed' AND asset.purge_status='completed' THEN
    SELECT * INTO receipt FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='purge_succeeded' AND details->>'purgeProtocol'='verified-objects-v1';
    IF FOUND AND receipt.details->>'claimVersion'=p_version::text THEN
      RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
    END IF;
  END IF;
  IF p_phase='manifest' AND asset.purge_status='completed' AND asset.version=p_version THEN
    SELECT * INTO receipt FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset
      AND event_type='purge_succeeded' AND details->>'purgeProtocol'='verified-objects-v1'
      AND details->>'generation' IS NOT DISTINCT FROM asset.recovery_generation::text;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','purge_completion_unverified'); END IF;
    SELECT array_agg(path ORDER BY path) INTO paths FROM public.media_permanent_purge_paths(p_asset) path;
    IF paths IS NULL OR array_position(paths,NULL) IS NOT NULL OR array_position(paths,'') IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'error','purge_manifest_invalid');
    END IF;
    RETURN jsonb_build_object('ok',true,'bucket',asset.storage_bucket,'generation',asset.recovery_generation,'paths',paths,
      'completion',receipt.details||jsonb_build_object('id',receipt.id));
  END IF;
  IF asset.version IS DISTINCT FROM p_version OR asset.purge_status NOT IN ('pending','failed') THEN
    RETURN jsonb_build_object('ok',false,'error','purge_source_changed');
  END IF;
  SELECT array_agg(path ORDER BY path) INTO paths FROM public.media_permanent_purge_paths(p_asset) path;
  IF paths IS NULL OR array_position(paths,NULL) IS NOT NULL OR array_position(paths,'') IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','purge_manifest_invalid');
  END IF;
  IF p_phase='manifest' THEN RETURN jsonb_build_object('ok',true,'bucket',asset.storage_bucket,'generation',asset.recovery_generation,'paths',paths); END IF;
  IF p_phase='completed' THEN
    IF EXISTS(SELECT 1 FROM unnest(paths) path WHERE NOT EXISTS(
      SELECT 1 FROM public.media_asset_lifecycle_events e WHERE e.media_asset_id=p_asset AND e.event_type='purge_object_absent'
        AND e.details->>'path'=path AND e.details->>'bucket'=asset.storage_bucket
        AND e.details->>'generation' IS NOT DISTINCT FROM asset.recovery_generation::text)) THEN
      RETURN jsonb_build_object('ok',false,'error','purge_objects_unverified');
    END IF;
    UPDATE public.media_assets SET purge_status='completed',purged_at=clock_timestamp(),purge_error=NULL,updated_at=clock_timestamp() WHERE id=p_asset;
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,asset.owner_user_id,'purge_succeeded',jsonb_build_object('purgeProtocol','verified-objects-v1',
        'generation',asset.recovery_generation,'claimVersion',p_version,'objectCount',cardinality(paths),'bucket',asset.storage_bucket,'paths',paths)) RETURNING * INTO receipt;
    RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
  END IF;
  IF p_path IS NULL OR NOT p_path=ANY(paths) OR p_token IS NULL THEN RETURN jsonb_build_object('ok',false,'error','purge_path_forbidden'); END IF;
  SELECT * INTO started FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset AND event_type='purge_object_started' AND details->>'path'=p_path;
  IF p_phase='started' THEN
    IF FOUND THEN RETURN jsonb_build_object('ok',true,'execute',false,'token',started.details->>'token'); END IF;
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,asset.owner_user_id,'purge_object_started',jsonb_build_object('generation',asset.recovery_generation,'bucket',asset.storage_bucket,'path',p_path,'token',p_token));
    RETURN jsonb_build_object('ok',true,'execute',true,'token',p_token);
  END IF;
  IF started.id IS NULL OR started.details->>'token' IS DISTINCT FROM p_token::text
      OR started.details->>'bucket' IS DISTINCT FROM asset.storage_bucket
      OR started.details->>'generation' IS DISTINCT FROM asset.recovery_generation::text THEN
    RETURN jsonb_build_object('ok',false,'error','purge_authority_changed');
  END IF;
  identity:=started.details||jsonb_build_object('absent',true);
  SELECT * INTO receipt FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset AND event_type='purge_object_absent' AND details->>'path'=p_path;
  IF FOUND THEN
    IF receipt.details IS DISTINCT FROM identity THEN RETURN jsonb_build_object('ok',false,'error','purge_identity_changed'); END IF;
  ELSE
    INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES(p_asset,asset.owner_user_id,'purge_object_absent',identity) RETURNING * INTO receipt;
  END IF;
  RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
END;$fn$;
REVOKE ALL ON FUNCTION public.advance_media_object_purge(uuid,bigint,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.advance_media_object_purge(uuid,bigint,text,text,uuid) TO service_role;

DO $account_transfer_barrier$
DECLARE definition text; anchor text:='  IF request.status NOT IN (''pending'',''failed'') THEN RETURN jsonb_build_object(''ok'',false,''error'',''deletion_not_claimable''); END IF;';
BEGIN
  definition:=pg_get_functiondef('public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text)'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4041 account transfer barrier anchor changed'; END IF;
  EXECUTE replace(definition,anchor,anchor||$guard$
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'media_recovery_requires_read_committed';
  END IF;
  IF EXISTS(SELECT 1 FROM public.media_assets a WHERE p_user IN (a.owner_user_id,a.uploader_user_id)
    AND NOT public.media_retention_transfer_settled(a.id,a.recovery_generation)) THEN
    RETURN jsonb_build_object('ok',false,'error','retention_transfer_pending');
  END IF;
$guard$);
END;$account_transfer_barrier$;

-- The translation reaper independently treats source withdrawal as erasure
-- authority. Keep settled outputs while their canonical source is retained.
DO $translation_retention$
DECLARE definition text; anchor text:='  source_present := FOUND;';
BEGIN
  definition:=pg_get_functiondef('public.media_caption_translation_artifact_retire(jsonb)'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4041 translation retirement anchor changed'; END IF;
  EXECUTE replace(definition,anchor,anchor||E'\n  IF source_present AND source_row.purge_status=''retained'' THEN RETURN NULL; END IF;');
END;$translation_retention$;

-- Authored captions are retained content too. The existing manifest CAS owns
-- both edit and erasure; its source lock serializes this check with withdrawal.
DO $caption_retention$
DECLARE definition text; anchor text:='  IF NOT FOUND THEN RETURN false; END IF;';
BEGIN
  definition:=pg_get_functiondef('public.cas_media_caption_manifest(uuid,uuid,jsonb,text,text,text,uuid)'::regprocedure);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4041 caption retention anchor changed'; END IF;
  EXECUTE replace(definition,anchor,anchor||E'\n  IF source_row.purge_status=''retained'' THEN RETURN false; END IF;');
END;$caption_retention$;

-- Dubbing cleanup also runs independently of the canonical purge worker.
-- Lock source -> artifact, matching source invalidation, and recheck the source
-- identity on the write. Neither an owner request nor a stale worker token is
-- permanent-deletion authority for a retained source. Source-less orphan cleanup
-- and explicit consent revocation on a live source retain their existing flow.
CREATE OR REPLACE FUNCTION public.media_dubbing_retire(p_id uuid,p_owner uuid,p_job uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE artifact public.media_dubbing_artifacts%ROWTYPE; source_id uuid; source_purge text;
BEGIN
  SELECT asset_id INTO source_id FROM public.media_dubbing_artifacts WHERE id=p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT purge_status INTO source_purge FROM public.media_assets WHERE id=source_id FOR UPDATE;
  IF source_purge='retained' THEN RETURN NULL; END IF;
  UPDATE public.media_dubbing_artifacts SET cleanup_requested=true
    WHERE id=p_id AND asset_id=source_id AND
      ((p_owner IS NOT NULL AND owner_user_id=p_owner AND p_job IS NULL AND p_token IS NULL)
       OR (p_owner IS NULL AND job_id=p_job AND lease_token=p_token))
    RETURNING * INTO artifact;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(artifact);
END;$fn$;

CREATE OR REPLACE FUNCTION public.media_dubbing_forget(p_id uuid,p_owner uuid,p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE source_id uuid; source_purge text;
BEGIN
  SELECT asset_id INTO source_id FROM public.media_dubbing_artifacts WHERE id=p_id;
  IF NOT FOUND THEN RETURN true; END IF;
  SELECT purge_status INTO source_purge FROM public.media_assets WHERE id=source_id FOR UPDATE;
  IF source_purge='retained' THEN RETURN false; END IF;
  DELETE FROM public.media_dubbing_artifacts WHERE id=p_id AND asset_id=source_id
    AND cleanup_requested AND write_state<>'pending' AND
      ((p_owner IS NOT NULL AND owner_user_id=p_owner AND p_job IS NULL AND p_token IS NULL)
       OR (p_owner IS NULL AND job_id=p_job AND lease_token=p_token));
  RETURN FOUND OR NOT EXISTS(SELECT 1 FROM public.media_dubbing_artifacts WHERE id=p_id);
END;$fn$;
REVOKE ALL ON FUNCTION public.media_dubbing_retire(uuid,uuid,uuid,uuid),public.media_dubbing_forget(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.media_dubbing_retire(uuid,uuid,uuid,uuid),public.media_dubbing_forget(uuid,uuid,uuid,uuid) TO service_role;
-- Exact, transaction-local restoration transitions. The existing journal is
-- both authorization receipt and audit; no session setting can grant a bypass.
CREATE SCHEMA media_recovery_private;
REVOKE ALL ON SCHEMA media_recovery_private FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA media_recovery_private TO service_role;
CREATE FUNCTION media_recovery_private.transition_allowed(p_table text,p_old jsonb,p_new jsonb)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $fn$
  SELECT EXISTS(SELECT 1 FROM public.media_asset_lifecycle_events e
    CROSS JOIN LATERAL jsonb_array_elements(e.details->'changes') c
    WHERE e.event_type='restoration_activated' AND e.details->>'transactionId'=pg_current_xact_id_if_assigned()::text
      AND c->>'table'=p_table AND c->>'id'=p_old->>'id' AND p_old->>'id'=p_new->>'id'
      AND c->>'before'=encode(sha256(convert_to(p_old::text,'UTF8')),'hex')
      AND c->>'after'=encode(sha256(convert_to((p_new-'updated_at')::text,'UTF8')),'hex'));
$fn$;
REVOKE ALL ON FUNCTION media_recovery_private.transition_allowed(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION media_recovery_private.transition_allowed(text,jsonb,jsonb) TO service_role;

-- Replacing a URL invalidates its source link. The exact reviewed restoration
-- transition is the only URL change that preserves an existing binding.
CREATE FUNCTION memory_video_segments_private.guard_item_media_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE owner_id uuid; asset public.media_assets%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND NEW.media_url IS DISTINCT FROM OLD.media_url THEN
    IF media_recovery_private.transition_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
    NEW.media_asset_id:=NULL;
  END IF;
  IF NEW.media_asset_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    SELECT m.owner_id INTO owner_id FROM public.memories m WHERE m.id=NEW.memory_id FOR SHARE;
    SELECT * INTO asset FROM public.media_assets WHERE id=NEW.media_asset_id FOR SHARE;
    IF owner_id IS NULL OR owner_id IS DISTINCT FROM asset.owner_user_id OR asset.deleted_at IS NOT NULL
      OR asset.purge_status<>'not_requested' OR asset.moderation_status IN ('removed','owner_deleted') THEN
      RAISE EXCEPTION 'memory_media_binding_owner_changed';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.media_asset_id IS DISTINCT FROM OLD.media_asset_id AND NOT EXISTS(
    SELECT 1 FROM public.moderation_actions a WHERE a.action_type='memory_media_source_bound'
      AND a.metadata->>'item_id'=NEW.id::text AND a.metadata->>'asset_id'=NEW.media_asset_id::text
      AND a.metadata->>'transaction_id'=pg_current_xact_id_if_assigned()::text
      AND a.metadata->>'before'=encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex')) THEN
    RAISE EXCEPTION 'memory_media_binding_requires_review';
  END IF;
  SELECT m.owner_id INTO owner_id FROM public.memories m WHERE m.id=NEW.memory_id FOR SHARE;
  SELECT * INTO asset FROM public.media_assets WHERE id=NEW.media_asset_id FOR SHARE;
  IF asset.id IS NULL OR owner_id IS NULL OR owner_id IS DISTINCT FROM asset.owner_user_id THEN
    RAISE EXCEPTION 'memory_media_binding_owner_changed';
  END IF;
  RETURN NEW;
END;$fn$;
REVOKE ALL ON FUNCTION memory_video_segments_private.guard_item_media_binding() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER memory_items_media_binding_guard BEFORE INSERT OR UPDATE OF media_asset_id,media_url,memory_id ON public.memory_items
  FOR EACH ROW EXECUTE FUNCTION memory_video_segments_private.guard_item_media_binding();

-- Rebind only the exact reviewed rows, through the Memory table owner. Deleted
-- operations stay tombstones; a missing reviewed segment aborts the transaction.
CREATE FUNCTION memory_video_segments_private.rebind_restored(p_asset uuid,p_reservation uuid,p_version integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $fn$
DECLARE authority public.media_asset_lifecycle_events%ROWTYPE; binding jsonb; stored public.memory_video_segments%ROWTYPE;
  item public.memory_items%ROWTYPE; target text;
BEGIN
  SELECT * INTO authority FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset AND event_type='restoration_activated'
    AND details->>'reservationId'=p_reservation::text AND details->>'transactionId'=pg_current_xact_id()::text
    AND (details->>'version')::integer=p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'restoration_transaction_required'; END IF;
  target:=authority.details->>'destinationPath';
  FOR binding IN SELECT value FROM jsonb_array_elements(authority.details->'memoryBindings') LOOP
    SELECT * INTO stored FROM public.memory_video_segments WHERE id=(binding->>'id')::uuid FOR UPDATE;
    IF binding->'segment'='null'::jsonb THEN
      IF stored.id IS NOT NULL THEN RAISE EXCEPTION 'restoration_segment_tombstone_changed'; END IF;
    ELSE
      IF stored.id IS NULL OR encode(sha256(convert_to(to_jsonb(stored)::text,'UTF8')),'hex') IS DISTINCT FROM binding->>'segmentFingerprint' THEN
        RAISE EXCEPTION 'restoration_segment_changed';
      END IF;
      UPDATE public.memory_video_segments SET asset_version=p_version WHERE id=stored.id;
    END IF;
  END LOOP;
  FOR item IN SELECT i.* FROM public.memory_items i WHERE EXISTS(
    SELECT 1 FROM jsonb_array_elements(authority.details->'memoryBindings') b WHERE b->>'itemId'=i.id::text AND b->'segment'<>'null'::jsonb) OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(authority.details->'memoryItems') b WHERE b->>'itemId'=i.id::text)
    ORDER BY i.id FOR UPDATE LOOP
    UPDATE public.memory_items SET media_url='post-media/'||target WHERE id=item.id;
  END LOOP;
END;$fn$;
REVOKE ALL ON FUNCTION memory_video_segments_private.rebind_restored(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION memory_video_segments_private.rebind_restored(uuid,uuid,integer) TO service_role;

DO $restore_guard_transitions$
DECLARE signature text; definition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.guard_postcard_canonical_asset()','public.guard_withdrawn_postcard_upload()',
    'public.guard_postcard_retention_source()','public.retain_postcard_media_snapshot()','public.guard_retained_media_purge()',
    'public.guard_removed_media_legacy_publication()','public.retire_postcard_media_source()',
    'memory_video_segments_private.erase_with_source()'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    IF position('BEGIN' IN definition)=0 OR position('media_recovery_private.transition_allowed' IN definition)>0 THEN
      RAISE EXCEPTION '4041 restoration guard anchor changed: %',signature;
    END IF;
    IF signature='public.guard_postcard_canonical_asset()' THEN
      definition:=regexp_replace(definition,'BEGIN',$key$BEGIN
  IF (TG_OP='INSERT' AND split_part(NEW.storage_path,'/',1)='_recovered') OR
    (TG_OP='UPDATE' AND ('_recovered' IN (split_part(OLD.storage_path,'/',1),split_part(NEW.storage_path,'/',1)))
      AND (NEW.storage_bucket,NEW.storage_path,NEW.owner_user_id) IS DISTINCT FROM (OLD.storage_bucket,OLD.storage_path,OLD.owner_user_id)) THEN
    RAISE EXCEPTION 'restored_media_identity_requires_activation';
  END IF;
$key$);
    END IF;
    EXECUTE regexp_replace(definition,'BEGIN',$body$BEGIN
  IF TG_OP='UPDATE' AND current_user IN ('postgres','service_role') THEN
    IF media_recovery_private.transition_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  END IF;
$body$);
  END LOOP;
END;$restore_guard_transitions$;

CREATE FUNCTION memory_video_segments_private.restoration_item_changes(p_asset uuid,p_reservation uuid,p_path text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $fn$
DECLARE reservation public.media_asset_lifecycle_events%ROWTYPE; item public.memory_items%ROWTYPE;
  changes jsonb:='[]'::jsonb; target jsonb;
BEGIN
  SELECT e.* INTO reservation FROM public.media_asset_lifecycle_events e JOIN public.media_assets a ON a.id=e.media_asset_id
    WHERE e.id=p_reservation AND e.media_asset_id=p_asset AND e.event_type='restoration_prepared'
      AND a.purge_status='retained' AND e.details->>'generation'=a.recovery_generation::text
      AND e.details->>'destinationPath'=p_path;
  IF NOT FOUND THEN RAISE EXCEPTION 'restoration_memory_review_required'; END IF;
  IF EXISTS(SELECT 1 FROM public.memory_items i JOIN public.media_assets a ON a.id=p_asset
    WHERE i.media_url IN(a.storage_bucket||'/'||a.storage_path,a.public_url,a.recovery_snapshot->>'public_url')
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reservation.details#>'{authored,memoryBindings}') b WHERE b->>'itemId'=i.id::text)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reservation.details#>'{authored,memoryItems}') b WHERE b->>'itemId'=i.id::text)) THEN
    RAISE EXCEPTION 'restoration_memory_reference_unreviewed';
  END IF;
  FOR item IN SELECT i.* FROM public.memory_items i WHERE EXISTS(
    SELECT 1 FROM jsonb_array_elements(reservation.details#>'{authored,memoryBindings}') b
      WHERE b->>'itemId'=i.id::text AND b->'segment'<>'null'::jsonb) OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(reservation.details#>'{authored,memoryItems}') b WHERE b->>'itemId'=i.id::text) ORDER BY i.id FOR UPDATE LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reservation.details#>'{authored,memoryBindings}') b
      WHERE b->>'itemId'=item.id::text AND b->>'itemFingerprint'=encode(sha256(convert_to(to_jsonb(item)::text,'UTF8')),'hex'))
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reservation.details#>'{authored,memoryItems}') b
        WHERE b->>'itemId'=item.id::text AND b->>'itemFingerprint'=encode(sha256(convert_to(to_jsonb(item)::text,'UTF8')),'hex')) THEN
      RAISE EXCEPTION 'restoration_memory_item_changed';
    END IF;
    target:=to_jsonb(item)||jsonb_build_object('media_url','post-media/'||p_path);
    changes:=changes||jsonb_build_array(jsonb_build_object('table','memory_items','id',item.id,
      'before',encode(sha256(convert_to(to_jsonb(item)::text,'UTF8')),'hex'),
      'after',encode(sha256(convert_to((target-'updated_at')::text,'UTF8')),'hex')));
  END LOOP;
  RETURN changes;
END;$fn$;
REVOKE ALL ON FUNCTION memory_video_segments_private.restoration_item_changes(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION memory_video_segments_private.restoration_item_changes(uuid,uuid,text) TO service_role;

-- The existing Passport row remains the owner of its photo and audience. This
-- helper only consumes the activation transaction's reviewed bindings; it
-- neither creates Passport memories nor changes their lifecycle or visibility.
CREATE FUNCTION media_recovery_private.rebind_passport(p_asset uuid,p_reservation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $fn$
DECLARE authority public.media_asset_lifecycle_events%ROWTYPE; binding jsonb;
  parent public.passport_memories%ROWTYPE; expected jsonb;
BEGIN
  SELECT * INTO authority FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset AND event_type='restoration_activated'
    AND details->>'reservationId'=p_reservation::text AND details->>'transactionId'=pg_current_xact_id_if_assigned()::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'restoration_passport_activation_required'; END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(authority.details->'passportBindings') LOOP
    SELECT * INTO parent FROM public.passport_memories WHERE id=(binding->>'id')::uuid FOR UPDATE;
    IF NOT FOUND OR binding->>'fingerprint' IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(parent)::text,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'restoration_passport_binding_changed';
    END IF;
    expected:=to_jsonb(parent)||jsonb_build_object('photo_url',authority.details->>'bucket'||'/'||(authority.details->>'destinationPath'));
    UPDATE public.passport_memories SET photo_url=expected->>'photo_url',updated_at=clock_timestamp()
      WHERE id=parent.id RETURNING * INTO parent;
    IF to_jsonb(parent)-'updated_at' IS DISTINCT FROM expected-'updated_at' THEN
      RAISE EXCEPTION 'restoration_passport_target_changed';
    END IF;
  END LOOP;
END;$fn$;
REVOKE ALL ON FUNCTION media_recovery_private.rebind_passport(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION media_recovery_private.rebind_passport(uuid,uuid) TO service_role;

-- Local activation owner. Ordinary _recovered signing requires verified
-- activation and current domain access; this command never issues URLs.
CREATE FUNCTION public.activate_media_restoration(p_actor uuid,p_asset uuid,p_generation uuid,p_reservation uuid,p_objects jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $fn$
DECLARE reservation public.media_asset_lifecycle_events%ROWTYPE; original public.media_asset_lifecycle_events%ROWTYPE;
  dependency public.media_asset_lifecycle_events%ROWTYPE; caption public.media_asset_lifecycle_events%ROWTYPE;
  receipt public.media_asset_lifecycle_events%ROWTYPE; asset public.media_assets%ROWTYPE; target_asset public.media_assets%ROWTYPE;
  source public.post_media%ROWTYPE; target_source public.post_media%ROWTYPE; item public.memory_items%ROWTYPE;
  reviewed jsonb; expected jsonb:='[]'::jsonb; paths jsonb; entry jsonb; target jsonb; change jsonb;
  changes jsonb:='[]'::jsonb; source_targets jsonb:='[]'::jsonb; source_aliases text[]; account_id uuid;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE EXCEPTION 'media_recovery_requires_read_committed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended','deactivated')
      AND (expires_at IS NULL OR expires_at>clock_timestamp())) THEN RETURN jsonb_build_object('ok',false,'error','admin_required'); END IF;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','retention_changed'); END IF;
  FOR account_id IN SELECT DISTINCT value FROM unnest(ARRAY[asset.owner_user_id,asset.uploader_user_id]) value WHERE value IS NOT NULL ORDER BY value LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||account_id::text,0));
  END LOOP;
  SELECT * INTO receipt FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset AND event_type='restoration_activated'
    AND details->>'generation'=p_generation::text;
  IF FOUND THEN
    IF receipt.actor_user_id IS DISTINCT FROM p_actor OR receipt.details->>'reservationId' IS DISTINCT FROM p_reservation::text THEN
      RETURN jsonb_build_object('ok',false,'error','restoration_identity_changed');
    END IF;
    RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
  END IF;
  SELECT * INTO reservation FROM public.media_asset_lifecycle_events WHERE id=p_reservation AND media_asset_id=p_asset
    AND event_type='restoration_prepared' AND details->>'generation'=p_generation::text;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','restoration_review_changed'); END IF;
  reviewed:=public.prepare_media_restoration(p_actor,p_asset,p_generation,reservation.details->>'reason',p_reservation);
  IF reviewed->>'ok' IS DISTINCT FROM 'true' THEN RETURN reviewed; END IF;
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset FOR UPDATE;
  IF asset.version>=2147483647 OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=asset.owner_user_id AND account_status='active') THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_owner_unavailable');
  END IF;
  IF EXISTS(SELECT 1 FROM public.posts p WHERE p.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(reservation.details->'parents'))
      AND (p.author_id IS DISTINCT FROM asset.owner_user_id OR p.status IS DISTINCT FROM 'active' OR p.deleted_at IS NOT NULL OR p.postcard_draft_state='cancelled')) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_parent_unavailable');
  END IF;
  -- Other entity parents need their own domain rebind/privacy gate. Never
  -- infer that Passport memory IDs identify kernel Memories.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(reservation.details#>'{authored,attachments}') a
    WHERE CASE WHEN a->>'entityType'='memory' THEN NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(reservation.details#>'{authored,passportBindings}') p WHERE p->>'id'=a->>'entityId')
    ELSE a->>'entityType' NOT IN ('post','postcard') OR NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(reservation.details->'parents') p WHERE p->>'id'=a->>'entityId') END) THEN
    RETURN jsonb_build_object('ok',false,'error','restoration_parent_binding_unresolved');
  END IF;
  SELECT * INTO original FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset AND event_type='restoration_copied'
    AND details->>'reservationId'=p_reservation::text AND details->>'generation'=p_generation::text;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','restoration_original_uncopied'); END IF;
  paths:=jsonb_build_object(asset.storage_path,reservation.details->>'destinationPath');
  expected:=expected||jsonb_build_array(jsonb_build_object('receiptId',original.id,'path',reservation.details->>'destinationPath',
    'objectId',original.details->>'objectId','objectVersion',original.details->>'objectVersion','sha256',original.details->>'sha256','size',original.details->'size'));
  FOR entry IN SELECT value FROM jsonb_array_elements(reservation.details->'dependencies') LOOP
    IF entry->>'sourcePath'=asset.storage_path THEN CONTINUE; END IF;
    SELECT * INTO dependency FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset AND event_type='restoration_dependency_copied'
      AND details->>'reservationId'=p_reservation::text AND details->>'sourcePath'=entry->>'sourcePath' AND details->>'generation'=p_generation::text;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','restoration_dependency_uncopied'); END IF;
    paths:=paths||jsonb_build_object(entry->>'sourcePath',dependency.details->>'destinationPath');
    expected:=expected||jsonb_build_array(jsonb_build_object('receiptId',dependency.id,'path',dependency.details->>'destinationPath',
      'objectId',dependency.details->>'objectId','objectVersion',dependency.details->>'objectVersion','sha256',dependency.details->>'sha256','size',dependency.details->'size'));
  END LOOP;
  IF reservation.details#>>'{authored,caption,object_path}' IS NOT NULL THEN
    SELECT * INTO caption FROM public.media_asset_lifecycle_events WHERE media_asset_id=p_asset AND event_type='restoration_caption_written'
      AND details->>'reservationId'=p_reservation::text AND details->>'generation'=p_generation::text;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','restoration_caption_unwritten'); END IF;
    expected:=expected||jsonb_build_array(jsonb_build_object('receiptId',caption.id,'path',caption.details->>'destinationPath',
      'objectId',caption.details->>'objectId','objectVersion',caption.details->>'objectVersion','sha256',caption.details->>'sha256','size',caption.details->'size'));
  END IF;
  SELECT jsonb_agg(value ORDER BY (value->>'path') COLLATE "C") INTO expected FROM jsonb_array_elements(expected);
  IF p_objects IS DISTINCT FROM expected THEN RETURN jsonb_build_object('ok',false,'error','restoration_objects_unverified'); END IF;
  SELECT array_agg(DISTINCT ref) INTO source_aliases FROM (SELECT asset.public_url AS ref UNION ALL SELECT asset.recovery_snapshot->>'public_url' UNION ALL SELECT s.recovery_snapshot->>'public_url' FROM public.post_media s WHERE s.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(reservation.details->'sources'))) aliases WHERE ref IS NOT NULL;
  target:=to_jsonb(asset)||jsonb_build_object('storage_path',reservation.details->>'destinationPath',
    'public_url',asset.storage_bucket||'/'||(reservation.details->>'destinationPath'),
    'thumbnail_path',paths->>asset.thumbnail_path,'thumbnail_url',CASE WHEN asset.thumbnail_path IS NULL THEN NULL ELSE asset.storage_bucket||'/'||(paths->>asset.thumbnail_path) END,
    'version',asset.version+1,'processing_status',asset.recovery_snapshot->>'processing_status','moderation_status',asset.recovery_snapshot->>'moderation_status',
    'deleted_at',NULL,'purge_status','not_requested','purge_requested_at',NULL,'purged_at',NULL,'purge_error',NULL,'recovery_generation',NULL,'recovery_snapshot',NULL);
  target_asset:=jsonb_populate_record(NULL::public.media_assets,target);
  changes:=changes||jsonb_build_array(jsonb_build_object('table','media_assets','id',asset.id,
    'before',encode(sha256(convert_to(to_jsonb(asset)::text,'UTF8')),'hex'),'after',encode(sha256(convert_to((target-'updated_at')::text,'UTF8')),'hex')));
  FOR source IN SELECT * FROM public.post_media WHERE id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(reservation.details->'sources')) ORDER BY id LOOP
    target:=to_jsonb(source)||jsonb_build_object('storage_path',target_asset.storage_path,'public_url',target_asset.public_url,
      'thumbnail_storage_path',paths->>source.thumbnail_storage_path,'feed_storage_path',paths->>source.feed_storage_path,
      'thumbnail_url',CASE WHEN source.thumbnail_storage_path IS NULL THEN NULL ELSE asset.storage_bucket||'/'||(paths->>source.thumbnail_storage_path) END,
      'feed_url',CASE WHEN source.feed_storage_path IS NULL THEN NULL ELSE asset.storage_bucket||'/'||(paths->>source.feed_storage_path) END,
      'processing_status',source.recovery_snapshot->>'processing_status','moderation_status',source.recovery_snapshot->>'moderation_status',
      'deleted_at',NULL,'recovery_snapshot',NULL);
    source_targets:=source_targets||jsonb_build_array(target);
    changes:=changes||jsonb_build_array(jsonb_build_object('table','post_media','id',source.id,
      'before',encode(sha256(convert_to(to_jsonb(source)::text,'UTF8')),'hex'),'after',encode(sha256(convert_to((target-'updated_at')::text,'UTF8')),'hex')));
  END LOOP;
  -- Memory item transition hashes are supplied by the private domain helper
  -- from the exact rows locked during review (never caller-provided metadata).
  changes:=changes||memory_video_segments_private.restoration_item_changes(p_asset,p_reservation,target_asset.storage_path);
  INSERT INTO public.media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
    VALUES(p_asset,p_actor,'restoration_activated',jsonb_build_object('generation',p_generation,'reservationId',p_reservation,
      'transactionId',pg_current_xact_id()::text,'reason',reservation.details->>'reason','version',target_asset.version,
      'destinationPath',target_asset.storage_path,'bucket',asset.storage_bucket,'objects',expected,'changes',changes,
      'memoryBindings',reservation.details#>'{authored,memoryBindings}','memoryItems',reservation.details#>'{authored,memoryItems}',
      'passportBindings',reservation.details#>'{authored,passportBindings}')) RETURNING * INTO receipt;
  UPDATE public.media_assets SET storage_path=target_asset.storage_path,public_url=target_asset.public_url,
    thumbnail_path=target_asset.thumbnail_path,thumbnail_url=target_asset.thumbnail_url,processing_status=target_asset.processing_status,
    moderation_status=target_asset.moderation_status,deleted_at=NULL,purge_status='not_requested',purge_requested_at=NULL,purged_at=NULL,purge_error=NULL,
    recovery_generation=NULL,recovery_snapshot=NULL,updated_at=clock_timestamp() WHERE id=p_asset RETURNING * INTO asset;
  IF to_jsonb(asset)-'updated_at' IS DISTINCT FROM to_jsonb(target_asset)-'updated_at' THEN RAISE EXCEPTION 'restoration_target_changed'; END IF;
  FOR target IN SELECT value FROM jsonb_array_elements(source_targets) LOOP
    target_source:=jsonb_populate_record(NULL::public.post_media,target);
    UPDATE public.post_media SET storage_path=target_source.storage_path,public_url=target_source.public_url,
      thumbnail_storage_path=target_source.thumbnail_storage_path,thumbnail_url=target_source.thumbnail_url,
      feed_storage_path=target_source.feed_storage_path,feed_url=target_source.feed_url,processing_status=target_source.processing_status,
      moderation_status=target_source.moderation_status,deleted_at=NULL,recovery_snapshot=NULL,updated_at=clock_timestamp()
      WHERE id=target_source.id RETURNING * INTO source;
    IF to_jsonb(source)-'updated_at' IS DISTINCT FROM target-'updated_at' THEN RAISE EXCEPTION 'restoration_source_target_changed'; END IF;
  END LOOP;
  IF caption.id IS NOT NULL THEN
    target:=jsonb_build_object('id',asset.id,'owner_user_id',asset.owner_user_id,'storage_bucket',asset.storage_bucket,'storage_path',asset.storage_path,
      'media_type',asset.media_type,'duration_ms',asset.duration_ms,'version',asset.version,'deleted_at',asset.deleted_at,'purge_status',asset.purge_status,
      'processing_status',asset.processing_status,'moderation_status',asset.moderation_status);
    IF target IS DISTINCT FROM caption.details->'targetSource' OR NOT public.cas_media_caption_manifest(asset.id,asset.owner_user_id,target,
      reservation.details#>>'{authored,caption,revision_key}',caption.details->>'revisionKey',caption.details->>'destinationPath',NULL) THEN
      RAISE EXCEPTION 'restoration_caption_target_changed';
    END IF;
  END IF;
  SELECT array_agg(DISTINCT ref) INTO source_aliases FROM (
    SELECT reservation.details->>'bucket'||'/'||(reservation.details->>'sourcePath') AS ref
    UNION ALL SELECT reservation.details#>>'{authored,caption,source,storage_bucket}'||'/'||(reservation.details->>'sourcePath')
    UNION ALL SELECT value->>'itemMediaUrl' FROM jsonb_array_elements(reservation.details#>'{authored,memoryBindings}') WHERE value->'segment'<>'null'::jsonb
    UNION ALL SELECT value->>'itemMediaUrl' FROM jsonb_array_elements(reservation.details#>'{authored,memoryItems}')
    UNION ALL SELECT unnest(source_aliases)
  ) aliases WHERE ref IS NOT NULL;
  UPDATE public.posts p SET media_urls=ARRAY(SELECT CASE WHEN url=ANY(source_aliases) THEN asset.public_url ELSE url END
      FROM unnest(p.media_urls) WITH ORDINALITY media(url,ord) ORDER BY ord),updated_at=clock_timestamp()
    WHERE p.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(reservation.details->'parents')) AND p.media_urls&&source_aliases;
  PERFORM memory_video_segments_private.rebind_restored(p_asset,p_reservation,asset.version);
  PERFORM media_recovery_private.rebind_passport(p_asset,p_reservation);
  SELECT * INTO asset FROM public.media_assets WHERE id=p_asset;
  IF to_jsonb(asset)-'updated_at' IS DISTINCT FROM to_jsonb(target_asset)-'updated_at' THEN RAISE EXCEPTION 'restoration_target_changed'; END IF;
  RETURN jsonb_build_object('ok',true,'receipt',receipt.details||jsonb_build_object('id',receipt.id));
END;$fn$;
REVOKE ALL ON FUNCTION public.activate_media_restoration(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.activate_media_restoration(uuid,uuid,uuid,uuid,jsonb) TO service_role;

DO $memory_item_ready$
DECLARE functions text; guard text;
BEGIN
  PERFORM set_config('search_path','pg_catalog,pg_temp',true);
  SELECT string_agg(format('(%L,%L)',name,md5(pg_get_functiondef(name::regprocedure))),',') INTO functions
    FROM (VALUES('public.insert_memory_media_item(uuid,uuid,jsonb)'),('public.memory_kernel_execute(jsonb)'),('memory_video_segments_private.guard_item_media_binding()')) f(name);
  SELECT md5(pg_get_triggerdef(oid)) INTO guard FROM pg_trigger WHERE tgrelid='public.memory_items'::regclass AND tgname='memory_items_media_binding_guard';
  EXECUTE format($def$CREATE FUNCTION public.memory_item_source_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $body$
    SELECT NOT EXISTS(SELECT 1 FROM (VALUES %s) expected(name,fingerprint) WHERE to_regprocedure(name) IS NULL OR md5(pg_get_functiondef(to_regprocedure(name))) IS DISTINCT FROM fingerprint)
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.memory_items'::regclass AND tgname='memory_items_media_binding_guard' AND tgenabled IN ('O','A') AND md5(pg_get_triggerdef(oid))=%L)
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.memory_items'::regclass AND confrelid='public.media_assets'::regclass
        AND contype='f' AND confdeltype='c' AND convalidated AND conkey=ARRAY[(SELECT attnum FROM pg_attribute
          WHERE attrelid='public.memory_items'::regclass AND attname='media_asset_id' AND atttypid='uuid'::regtype AND NOT attisdropped)]);
  $body$;$def$,functions,guard);
END;$memory_item_ready$;
REVOKE ALL ON FUNCTION public.memory_item_source_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.memory_item_source_ready() TO service_role;

-- Candidate confirmation must not claim an episode before its media insertion
-- owner is available. Preserve the origin marker check and add the same source
-- proof used by ordinary ADD_MEDIA, without creating another probe or writer.
CREATE OR REPLACE FUNCTION public.memory_candidate_origin_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp
AS $fn$
  SELECT position('4036 candidate origin' IN pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure))>0
    AND public.memory_item_source_ready();
$fn$;
REVOKE ALL ON FUNCTION public.memory_candidate_origin_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.memory_candidate_origin_ready() TO service_role;

-- Refresh the existing readiness owner after extending its lifecycle.
DO $readiness$
DECLARE definitions text; trigger_definitions text; retention_policy text;
BEGIN
  PERFORM set_config('search_path','pg_catalog,pg_temp',true);
  SELECT md5(concat_ws(';',pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid))) INTO retention_policy
    FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='media_retention_namespace';
  SELECT string_agg(format('(%L,%L)',name,md5(pg_get_functiondef(to_regprocedure(name)))),',') INTO definitions
    FROM (VALUES('public.memory_unbound_reference_snapshot(uuid,uuid,uuid,integer)'),('memory_video_segments_private.unbound_reference_snapshot(uuid,uuid,uuid,integer)'),('public.memory_item_source_ready()'),('public.insert_memory_media_item(uuid,uuid,jsonb)'),('public.reconcile_memory_media_binding(uuid,uuid,uuid,text,text,text,text)'),('memory_video_segments_private.guard_item_media_binding()'),('media_recovery_private.rebind_passport(uuid,uuid)'),('public.activate_media_restoration(uuid,uuid,uuid,uuid,jsonb)'),('media_recovery_private.transition_allowed(text,jsonb,jsonb)'),('memory_video_segments_private.restoration_item_changes(uuid,uuid,text)'),('memory_video_segments_private.rebind_restored(uuid,uuid,integer)'),('memory_video_segments_private.review_retained(uuid,uuid,uuid)'),('memory_video_segments_private.erase_with_source()'),('public.guard_postcard_canonical_asset()'),('public.retire_postcard_media_source()'),
      ('public.restored_media_object_owned(uuid,text,text,uuid)'),('public.retire_withdrawn_postcard_assets()'),('public.retire_media_asset(uuid,uuid)'),
      ('public.cancel_postcard_draft(uuid,uuid)'),('public.guard_withdrawn_postcard_upload()'),
      ('public.guard_removed_media_legacy_publication()'),('public.withdraw_postcard_media(uuid,uuid,uuid,text,timestamp with time zone,text,uuid)'),
      ('public.renew_postcard_upload(uuid)'),('public.retain_postcard_media_snapshot()'),('public.guard_postcard_retention_source()'),('public.guard_retained_media_purge()'),('public.authorize_media_permanent_deletion(uuid,uuid,uuid,text)'),('public.media_caption_translation_artifact_retire(jsonb)'),
      ('public.cas_media_caption_manifest(uuid,uuid,jsonb,text,text,text,uuid)'),('public.media_dubbing_retire(uuid,uuid,uuid,uuid)'),('public.media_dubbing_forget(uuid,uuid,uuid,uuid)'),
      ('public.verify_media_restoration_dependencies(uuid,uuid,uuid,uuid,jsonb,jsonb)'),('public.advance_media_restoration_copy(uuid,uuid,uuid,uuid,text,uuid,uuid,text,text,bigint,text)'),('public.prepare_media_restoration(uuid,uuid,uuid,text,uuid,jsonb)'),('public.cancel_media_restoration(uuid,uuid,uuid,uuid,text,text,text,uuid)'),('public.media_retention_transfer_settled(uuid,uuid)'),('public.media_permanent_purge_paths(uuid)'),('public.advance_media_object_purge(uuid,bigint,text,text,uuid)'),('public.prepare_media_original_retention(uuid,uuid,uuid,text,text,bigint)'),('public.advance_media_original_retention(uuid,uuid,uuid,text,uuid,uuid,text,text,bigint)'),('public.claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text)')) functions(name);
  SELECT string_agg(format('(%L::regclass,%L,%L)',t.tgrelid::regclass::text,t.tgname,md5(pg_get_triggerdef(t.oid))),',') INTO trigger_definitions
    FROM pg_trigger t JOIN (VALUES ('public.media_assets'::regclass,'memory_video_segments_asset_invalidation'),('public.media_assets'::regclass,'postcard_canonical_asset_guard'),
      ('public.post_media'::regclass,'postcard_media_source_retired'),('public.posts'::regclass,'postcard_assets_withdrawn'),
      ('public.post_media'::regclass,'postcard_upload_withdrawn_guard'),('public.post_media'::regclass,'reported_media_legacy_guard'),('public.post_media'::regclass,'zz_postcard_retention_snapshot'),('public.media_assets'::regclass,'retained_media_purge_guard'),('public.post_media'::regclass,'postcard_retention_source_guard'),('public.memory_items'::regclass,'memory_items_media_binding_guard')) expected(relation,name)
      ON t.tgrelid=expected.relation AND t.tgname=expected.name;
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION public.postcard_canonical_lifecycle_ready()
    RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $probe$
      SELECT NOT EXISTS(SELECT 1 FROM (VALUES %s) expected(name,fingerprint)
        WHERE to_regprocedure(name) IS NULL OR md5(pg_get_functiondef(to_regprocedure(name))) IS DISTINCT FROM fingerprint)
      AND (SELECT count(*)=10 FROM pg_trigger t JOIN (VALUES %s) expected(relation,name,fingerprint)
        ON t.tgrelid=expected.relation AND t.tgname=expected.name
        WHERE t.tgenabled IN ('O','A') AND md5(pg_get_triggerdef(t.oid))=expected.fingerprint)
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.memory_items'::regclass AND confrelid='public.media_assets'::regclass
        AND contype='f' AND confdeltype='c' AND convalidated AND conkey=ARRAY[(SELECT attnum FROM pg_attribute
          WHERE attrelid='public.memory_items'::regclass AND attname='media_asset_id' AND atttypid='uuid'::regtype AND NOT attisdropped)])
      AND EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
        WHERE p.polrelid='storage.objects'::regclass AND p.polname='media_retention_namespace' AND c.relrowsecurity
          AND NOT p.polpermissive AND p.polcmd='*' AND cardinality(p.polroles)=2
          AND p.polroles @> ARRAY[to_regrole('anon')::oid,to_regrole('authenticated')::oid]
          AND md5(concat_ws(';',pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)))=%L);
    $probe$;
  $definition$,definitions,trigger_definitions,retention_policy);
END;$readiness$;
REVOKE ALL ON FUNCTION public.postcard_canonical_lifecycle_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.postcard_canonical_lifecycle_ready() TO service_role;
COMMIT;
