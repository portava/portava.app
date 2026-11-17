-- Generated with Supabase CLI; sole canonical chain. Retain the existing slot
-- as the cleanup receipt until previously issued upload authority has expired.
BEGIN;
ALTER TABLE public.post_media ADD COLUMN deleted_at timestamptz;

CREATE FUNCTION public.guard_withdrawn_postcard_upload()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'postcard_upload_withdrawn';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    IF TG_OP='INSERT' OR current_user NOT IN ('postgres','service_role') THEN
      RAISE EXCEPTION 'postcard_withdrawal_service_only' USING ERRCODE='42501';
    END IF;
    IF NEW.processing_status<>'pending' OR NEW.public_url<>'' OR NEW.thumbnail_url IS NOT NULL OR NEW.feed_url IS NOT NULL OR
       (to_jsonb(NEW)-ARRAY['deleted_at','updated_at','processing_status','public_url','thumbnail_url','feed_url']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['deleted_at','updated_at','processing_status','public_url','thumbnail_url','feed_url']) THEN
      RAISE EXCEPTION 'postcard_withdrawal_must_preserve_cleanup_identity';
    END IF;
  END IF;
  RETURN NEW;
END;$fn$;
CREATE TRIGGER postcard_upload_withdrawn_guard BEFORE INSERT OR UPDATE ON public.post_media
  FOR EACH ROW EXECUTE FUNCTION public.guard_withdrawn_postcard_upload();
REVOKE ALL ON FUNCTION public.guard_withdrawn_postcard_upload() FROM PUBLIC,anon,authenticated;

-- Narrow the existing visibility owner instead of adding a competing policy.
ALTER POLICY post_media_select_post_readable_or_owner ON public.post_media
  USING (deleted_at IS NULL AND ((SELECT auth.uid())=user_id OR
    EXISTS(SELECT 1 FROM public.posts p WHERE p.id=post_media.post_id)));

-- Keep existing source retirement and terminal-publication owners. Anchors
-- must match exactly: an unexpected installed definition requires review.
DO $upgrade$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition:=pg_get_functiondef('public.guard_postcard_canonical_asset()'::regprocedure);
  anchor:='IF source.id IS NULL OR'; replacement:='IF source.id IS NULL OR source.deleted_at IS NOT NULL OR';
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4039 canonical anchor changed'; END IF;
  EXECUTE replace(definition,anchor,replacement);
  definition:=pg_get_functiondef('public.retire_postcard_media_source()'::regprocedure);
  anchor:='IF TG_OP=''UPDATE'' AND'; replacement:='IF TG_OP=''UPDATE'' AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at AND';
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4039 source anchor changed'; END IF;
  EXECUTE replace(definition,anchor,replacement);
  definition:=pg_get_functiondef('public.guard_removed_media_legacy_publication()'::regprocedure);
  anchor:='IF NEW.moderation_status IS DISTINCT FROM ''rejected'' AND EXISTS(';
  replacement:='IF NEW.deleted_at IS NULL AND NEW.moderation_status IS DISTINCT FROM ''rejected'' AND EXISTS(';
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4039 terminal guard anchor changed'; END IF;
  EXECUTE replace(definition,anchor,replacement);
  definition:=pg_get_functiondef('public.cancel_postcard_draft(uuid,uuid)'::regprocedure);
  anchor:='UPDATE public.post_media SET processing_status=''pending'', updated_at=clock_timestamp() WHERE post_id=p.id AND user_id=p_actor;';
  replacement:=replace(anchor,'WHERE post_id=p.id','WHERE deleted_at IS NULL AND post_id=p.id');
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION '4039 cancel anchor changed'; END IF;
  EXECUTE replace(definition,anchor,replacement);
END;$upgrade$;
DROP TRIGGER postcard_media_source_retired ON public.post_media;
CREATE TRIGGER postcard_media_source_retired AFTER DELETE OR UPDATE OF storage_bucket,storage_path,user_id,post_id,deleted_at
  ON public.post_media FOR EACH ROW EXECUTE FUNCTION public.retire_postcard_media_source();

-- Both explicit deletion and expiry use this one source transition. p_before
-- is only for the worker: it atomically refuses a newly renewed/completed slot.
CREATE FUNCTION public.withdraw_postcard_media(p_actor uuid,p_post uuid,p_media uuid,
  p_expected_moderation text DEFAULT NULL,p_before timestamptz DEFAULT NULL,
  p_admin_reason text DEFAULT NULL,p_report_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE source public.post_media%ROWTYPE; withdrawn_at timestamptz:=clock_timestamp(); admin_action boolean:=p_admin_reason IS NOT NULL;
  report public.moderation_reports%ROWTYPE; report_owner uuid; owner_table text; owner_column text;
BEGIN
  IF admin_action AND (NULLIF(btrim(p_admin_reason),'') IS NULL OR p_before IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=p_actor AND role='admin' AND account_status='active') OR EXISTS(
    SELECT 1 FROM public.user_account_states WHERE user_id=p_actor AND state IN ('banned','suspended','deactivated')
      AND (expires_at IS NULL OR expires_at>clock_timestamp()))) THEN RETURN false; END IF;
  IF p_report_id IS NOT NULL AND NOT admin_action THEN RETURN false; END IF;
  SELECT * INTO source FROM public.post_media WHERE id=p_media AND post_id=p_post FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_actor IS NULL OR (p_actor IS DISTINCT FROM source.user_id AND NOT admin_action) THEN RETURN false; END IF;
  IF p_before IS NOT NULL THEN
    IF source.processing_status<>'pending' OR greatest(source.created_at,source.updated_at)>=p_before THEN RETURN false; END IF;
  ELSE
    IF source.moderation_status IS DISTINCT FROM p_expected_moderation OR
       (NOT admin_action AND source.moderation_status IN ('flagged','rejected','limited')) THEN RETURN false; END IF;
  END IF;
  IF source.deleted_at IS NOT NULL THEN
    IF admin_action AND NOT EXISTS(SELECT 1 FROM public.moderation_actions a
      WHERE a.performed_by=p_actor AND a.action_type='content_removed' AND a.metadata->>'target_id'=source.id::text
        AND a.metadata->>'retained'='true' AND (a.metadata->>'deleted_at')::timestamptz=source.deleted_at
        AND a.report_id IS NOT DISTINCT FROM p_report_id) THEN RETURN false; END IF;
    RETURN true;
  END IF;
  IF admin_action THEN
    IF source.user_id IS NULL THEN RETURN false; END IF;
    IF p_report_id IS NOT NULL THEN
      SELECT * INTO report FROM public.moderation_reports WHERE id=p_report_id FOR SHARE;
      IF NOT FOUND OR report.status IS NULL OR report.status NOT IN ('open','reviewing') THEN RETURN false; END IF;
      report_owner:=report.subject_user_id;
      IF report_owner IS NULL THEN
        -- Match the existing contentOwner.ts legacy fallback under the report
        -- lock. Relation/column names come only from this fixed allowlist.
        IF report.subject_id IS NULL OR report.subject_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
        IF report.subject_type IN ('user','profile') THEN report_owner:=report.subject_id::uuid;
        ELSE
          SELECT relation_name,column_name INTO owner_table,owner_column FROM (VALUES
            ('post','posts','author_id'),('post_media','post_media','user_id'),('comment','posts_comments','user_id'),
            ('message','messages','sender_id'),('thread','message_threads','created_by'),('trip','trips','owner_id'),
            ('event','events','host_id'),('review','reviews','reviewer_id'),('media','media_assets','owner_user_id'),
            ('hidden_gem','hidden_gems','submitted_by'),('buddy_listing','rent_buddy_profiles','user_id')) owners(kind,relation_name,column_name)
            WHERE kind=report.subject_type;
          IF owner_table IS NULL THEN RETURN false; END IF;
          EXECUTE format('SELECT %I FROM public.%I WHERE id=$1',owner_column,owner_table) INTO report_owner USING report.subject_id::uuid;
          IF report_owner IS NULL AND report.subject_type='buddy_listing' THEN
            SELECT user_id INTO report_owner FROM public.rent_buddy_profiles WHERE user_id=report.subject_id::uuid;
          END IF;
        END IF;
      END IF;
      IF report_owner IS DISTINCT FROM source.user_id THEN RETURN false; END IF;
    END IF;
    INSERT INTO public.moderation_actions(target_user_id,performed_by,action_type,reason,report_id,metadata)
      VALUES(source.user_id,p_actor,'content_removed',btrim(p_admin_reason),p_report_id,
        jsonb_build_object('target','post_media','target_type','post_media','target_id',source.id,'media_id',source.id,
          'retained',true,'deleted_at',withdrawn_at,'bucket',source.storage_bucket,'path',source.storage_path)
          ||CASE WHEN p_report_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('report_id',p_report_id,'report_table','moderation_reports') END);
  END IF;
  UPDATE public.post_media SET deleted_at=withdrawn_at,processing_status='pending',
    public_url='',thumbnail_url=NULL,feed_url=NULL,
    updated_at=CASE WHEN p_before IS NULL THEN clock_timestamp() ELSE source.updated_at END WHERE id=source.id;
  RETURN true;
END;$fn$;
REVOKE ALL ON FUNCTION public.withdraw_postcard_media(uuid,uuid,uuid,text,timestamptz,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_postcard_media(uuid,uuid,uuid,text,timestamptz,text,uuid) TO service_role;

-- Parent -> slot lock order agrees with cancellation. A successful renewal is
-- a real row update, never a zero-row acknowledgement that can mint authority.
CREATE FUNCTION public.renew_postcard_upload(p_media uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE parent uuid; renewed uuid;
BEGIN
  SELECT post_id INTO parent FROM public.post_media WHERE id=p_media;
  PERFORM 1 FROM public.posts p WHERE p.id=parent AND p.status='active' AND p.deleted_at IS NULL
    AND p.postcard_draft_state IS DISTINCT FROM 'cancelled' AND EXISTS(
      SELECT 1 FROM public.profiles WHERE id=p.author_id AND account_status='active') FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.post_media SET updated_at=clock_timestamp()
    WHERE id=p_media AND post_id=parent AND deleted_at IS NULL AND processing_status='pending' RETURNING id INTO renewed;
  RETURN renewed IS NOT NULL;
END;$fn$;
REVOKE ALL ON FUNCTION public.renew_postcard_upload(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.renew_postcard_upload(uuid) TO service_role;

-- Refresh the same capability receipt for the installed lifecycle owners.
DO $readiness$
DECLARE definitions text; trigger_definitions text;
BEGIN
  PERFORM set_config('search_path','pg_catalog,pg_temp',true);
  SELECT string_agg(format('(%L,%L)',name,md5(pg_get_functiondef(to_regprocedure(name)))),',') INTO definitions
    FROM (VALUES('public.guard_postcard_canonical_asset()'),('public.retire_postcard_media_source()'),
      ('public.retire_withdrawn_postcard_assets()'),('public.retire_media_asset(uuid,uuid)'),
      ('public.cancel_postcard_draft(uuid,uuid)'),('public.guard_withdrawn_postcard_upload()'),
      ('public.guard_removed_media_legacy_publication()'),('public.withdraw_postcard_media(uuid,uuid,uuid,text,timestamp with time zone,text,uuid)'),
      ('public.renew_postcard_upload(uuid)')) functions(name);
  SELECT string_agg(format('(%L::regclass,%L,%L)',t.tgrelid::regclass::text,t.tgname,md5(pg_get_triggerdef(t.oid))),',') INTO trigger_definitions
    FROM pg_trigger t JOIN (VALUES ('public.media_assets'::regclass,'postcard_canonical_asset_guard'),
      ('public.post_media'::regclass,'postcard_media_source_retired'),('public.posts'::regclass,'postcard_assets_withdrawn'),
      ('public.post_media'::regclass,'postcard_upload_withdrawn_guard'),('public.post_media'::regclass,'reported_media_legacy_guard')) expected(relation,name)
      ON t.tgrelid=expected.relation AND t.tgname=expected.name;
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION public.postcard_canonical_lifecycle_ready()
    RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $probe$
      SELECT NOT EXISTS(SELECT 1 FROM (VALUES %s) expected(name,fingerprint)
        WHERE to_regprocedure(name) IS NULL OR md5(pg_get_functiondef(to_regprocedure(name))) IS DISTINCT FROM fingerprint)
      AND (SELECT count(*)=5 FROM pg_trigger t JOIN (VALUES %s) expected(relation,name,fingerprint)
        ON t.tgrelid=expected.relation AND t.tgname=expected.name
        WHERE t.tgenabled IN ('O','A') AND md5(pg_get_triggerdef(t.oid))=expected.fingerprint);
    $probe$;
  $definition$,definitions,trigger_definitions);
END;$readiness$;
REVOKE ALL ON FUNCTION public.postcard_canonical_lifecycle_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.postcard_canonical_lifecycle_ready() TO service_role;
COMMIT;
