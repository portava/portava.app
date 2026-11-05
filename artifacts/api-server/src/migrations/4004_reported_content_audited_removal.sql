-- Generated with `supabase migration new reported_content_audited_removal`, then
-- normalized to this repository's ordered numeric migration convention.
-- Extends the 3994 report-linked command to posts, comments, messages, Buddy
-- listings, canonical media and event archives. No report closure, Trust penalty, booking cancellation,
-- account sanction, deletion of evidence, or new retention policy.
BEGIN;

CREATE UNIQUE INDEX moderation_actions_reported_content_operation_uq
  ON public.moderation_actions(performed_by, (metadata->>'operation_id'))
  WHERE metadata->>'command'='REMOVE_REPORTED_CONTENT_V1';

CREATE FUNCTION public.read_reported_content_target(p_type text,p_id uuid,p_lock boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' SET lock_timeout='1000ms'
AS $fn$
DECLARE target_table text; target jsonb;
BEGIN
  IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
  target_table := CASE p_type WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'posts_comments'
    WHEN 'message' THEN 'messages' WHEN 'buddy_listing' THEN 'rent_buddy_profiles'
    WHEN 'media' THEN 'media_assets' WHEN 'event' THEN 'events' END;
  IF target_table IS NULL OR p_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='unsupported_target'; END IF;
  -- The table is from the fixed allowlist above; never a caller-controlled identifier.
  EXECUTE pg_catalog.format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1%s',target_table,
    CASE WHEN p_lock THEN ' FOR UPDATE' ELSE '' END) INTO target USING p_id;
  IF target IS NULL AND p_type='buddy_listing' THEN
    SELECT pg_catalog.to_jsonb(t) INTO target FROM public.rent_buddy_profiles t WHERE user_id=p_id;
    IF target IS NOT NULL AND p_lock THEN
      SELECT pg_catalog.to_jsonb(t) INTO target FROM public.rent_buddy_profiles t WHERE id=(target->>'id')::uuid FOR UPDATE;
    END IF;
  END IF;
  RETURN target;
END $fn$;

CREATE FUNCTION public.get_reported_content_removal_context(p_admin_id uuid,p_type text,p_id uuid,p_report_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' SET timezone='UTC' SET lock_timeout='1000ms'
AS $fn$
DECLARE target jsonb; report_row public.moderation_reports%ROWTYPE; owner_id uuid; preview text;
BEGIN
  IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_admin_id AND role='admin') THEN
    RAISE EXCEPTION USING ERRCODE='PT403',MESSAGE='admin_role_required'; END IF;
  SELECT * INTO report_row FROM public.moderation_reports WHERE id=p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='report_not_found'; END IF;
  target := public.read_reported_content_target(p_type,p_id);
  IF target IS NULL THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='content_not_found'; END IF;
  owner_id := (target->>CASE p_type WHEN 'post' THEN 'author_id' WHEN 'message' THEN 'sender_id'
    WHEN 'media' THEN 'owner_user_id' WHEN 'event' THEN 'host_id' ELSE 'user_id' END)::uuid;
  IF owner_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=owner_id) THEN
    RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='content_owner_not_found'; END IF;
  IF report_row.subject_type IS DISTINCT FROM p_type OR pg_catalog.lower(report_row.subject_id) IS DISTINCT FROM p_id::text
    OR report_row.status IS NULL OR report_row.status NOT IN ('open','reviewing')
    OR (report_row.subject_user_id IS NOT NULL AND report_row.subject_user_id<>owner_id)
    OR (p_type<>'buddy_listing' AND target->>'deleted_at' IS NOT NULL)
    OR (p_type='media' AND (target->>'moderation_status' IS NULL OR target->>'moderation_status' NOT IN ('processing','active','limited','rejected','pending','approved','flagged')))
    OR (p_type='event' AND (target->>'state' IS NULL OR target->>'state' NOT IN ('draft','open','full','waitlist','started','completed','cancelled')))
    OR (p_type='buddy_listing' AND (target->>'status' IS NULL OR target->>'status'='suspended' OR target->>'admin_status'='disabled')) THEN
    RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='removal_context_changed'; END IF;
  preview := CASE p_type WHEN 'post' THEN target->>'content' WHEN 'event' THEN target->>'title' WHEN 'media' THEN target->>'caption' WHEN 'buddy_listing'
    THEN pg_catalog.concat_ws(' — ',target->>'display_name',target->>'tagline') ELSE target->>'body' END;
  RETURN pg_catalog.jsonb_build_object('contractVersion',1,'subjectType',p_type,'subjectId',p_id,'reportId',p_report_id,
    'eventState',CASE WHEN p_type='event' THEN target->>'state' END,
    'reportStatus',report_row.status,'preview',pg_catalog.left(preview,2000),
    'effect',CASE WHEN p_type='buddy_listing' THEN 'suspend_listing' ELSE 'remove_content' END,
    'contentToken',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(target::text,'UTF8')),'hex'),
    'reportToken',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(report_row)::text,'UTF8')),'hex'));
END $fn$;

CREATE FUNCTION public.remove_reported_content(p_admin_id uuid,p_type text,p_id uuid,p_report_id uuid,p_operation_id uuid,
  p_reason text,p_expected_content_token text,p_expected_report_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' SET timezone='UTC' SET lock_timeout='1000ms'
AS $fn$
DECLARE target jsonb; target_after jsonb; context jsonb; owner_id uuid; target_id uuid;
  receipt public.moderation_actions%ROWTYPE; report_row public.moderation_reports%ROWTYPE;
  normalized_reason text; committed_at timestamptz; affected bigint; replayed boolean:=false; metadata_value jsonb;
BEGIN
  IF current_user<>'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='service_role required'; END IF;
  normalized_reason := pg_catalog.btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  IF p_admin_id IS NULL OR p_id IS NULL OR p_report_id IS NULL OR p_operation_id IS NULL
    OR p_type IS NULL OR p_type NOT IN ('post','comment','message','buddy_listing','media','event')
    OR normalized_reason IS NULL OR pg_catalog.char_length(normalized_reason) NOT BETWEEN 1 AND 1000
    OR p_expected_content_token IS NULL OR p_expected_content_token !~ '^[0-9a-f]{64}$'
    OR p_expected_report_token IS NULL OR p_expected_report_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='invalid_removal_intent'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('REMOVE_REPORTED_CONTENT_V1:'||p_admin_id::text||':'||p_operation_id::text,0));
  PERFORM 1 FROM public.profiles WHERE id=p_admin_id AND role='admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT403',MESSAGE='admin_role_required'; END IF;
  SELECT * INTO receipt FROM public.moderation_actions WHERE performed_by=p_admin_id
    AND metadata->>'command'='REMOVE_REPORTED_CONTENT_V1' AND metadata->>'operation_id'=p_operation_id::text FOR SHARE;
  IF FOUND THEN
    IF receipt.action_type IS DISTINCT FROM (CASE WHEN p_type='event' THEN 'event_remove' ELSE 'content_removed' END) OR receipt.target_user_id IS NULL OR receipt.created_at IS NULL
      OR receipt.metadata->>'target_type' IS DISTINCT FROM p_type OR receipt.metadata->>'target_id' IS DISTINCT FROM p_id::text
      OR receipt.metadata->>'report_id' IS DISTINCT FROM p_report_id::text OR receipt.reason IS DISTINCT FROM normalized_reason
      OR receipt.metadata->>'expected_content_token' IS DISTINCT FROM p_expected_content_token
      OR receipt.metadata->>'expected_report_token' IS DISTINCT FROM p_expected_report_token THEN
      RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='removal_intent_conflict'; END IF;
    replayed:=true;
  ELSE
    SELECT * INTO report_row FROM public.moderation_reports WHERE id=p_report_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='report_not_found'; END IF;
    target:=public.read_reported_content_target(p_type,p_id,true);
    context:=public.get_reported_content_removal_context(p_admin_id,p_type,p_id,p_report_id);
    IF context->>'contentToken' IS DISTINCT FROM p_expected_content_token OR context->>'reportToken' IS DISTINCT FROM p_expected_report_token THEN
      RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='removal_context_changed'; END IF;
    target_id:=(target->>'id')::uuid;
    owner_id:=(target->>CASE p_type WHEN 'post' THEN 'author_id' WHEN 'message' THEN 'sender_id' WHEN 'media' THEN 'owner_user_id' WHEN 'event' THEN 'host_id' ELSE 'user_id' END)::uuid;
    PERFORM 1 FROM public.profiles WHERE id=owner_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='content_owner_not_found'; END IF;
    committed_at:=pg_catalog.clock_timestamp();
    CASE p_type
      WHEN 'post' THEN UPDATE public.posts SET deleted_at=committed_at,status='deleted',updated_at=committed_at WHERE id=target_id;
      WHEN 'comment' THEN UPDATE public.posts_comments SET deleted_at=committed_at WHERE id=target_id;
      WHEN 'message' THEN UPDATE public.messages SET deleted_at=committed_at WHERE id=target_id;
      WHEN 'buddy_listing' THEN UPDATE public.rent_buddy_profiles SET status='suspended',admin_status='disabled',updated_at=committed_at WHERE id=target_id;
      -- The canonical moderation transition to removed is terminal, except for
      -- later owner deletion. Version advances so an in-flight classifier loses CAS.
      WHEN 'media' THEN UPDATE public.media_assets SET moderation_status='removed',version=version+1,updated_at=committed_at WHERE id=target_id;
      -- Archive is legal from every non-archived event state in the canonical
      -- lifecycle authority. The API checks that authority; this locked command
      -- checks the same finite vocabulary and confirmed version before writing.
      WHEN 'event' THEN UPDATE public.events SET state='archived',visibility='invite_only',updated_at=committed_at WHERE id=target_id;
    END CASE;
    GET DIAGNOSTICS affected=ROW_COUNT;
    IF affected<>1 THEN RAISE EXCEPTION USING ERRCODE='PT503',MESSAGE='removal_write_incomplete'; END IF;
    target_after:=public.read_reported_content_target(p_type,p_id);
    IF target_after IS NULL OR (p_type NOT IN ('buddy_listing','media','event') AND (target_after->>'deleted_at')::timestamptz IS DISTINCT FROM committed_at)
      OR (p_type='media' AND target_after->>'moderation_status' IS DISTINCT FROM 'removed')
      OR (p_type='event' AND (target_after->>'state' IS DISTINCT FROM 'archived' OR target_after->>'visibility' IS DISTINCT FROM 'invite_only'))
      OR (p_type='buddy_listing' AND (target_after->>'status' IS DISTINCT FROM 'suspended' OR target_after->>'admin_status' IS DISTINCT FROM 'disabled')) THEN
      RAISE EXCEPTION USING ERRCODE='PT503',MESSAGE='removal_write_incomplete'; END IF;
    IF p_type='media' THEN
      -- Legacy readers consult post_media, while canonical/Telegraph readers
      -- consult media_assets. Both stores must stop distributing the same file.
      UPDATE public.post_media SET moderation_status='rejected',updated_at=committed_at
        WHERE storage_bucket=target->>'storage_bucket' AND storage_path=target->>'storage_path';
    END IF;
    metadata_value:=pg_catalog.jsonb_build_object('command','REMOVE_REPORTED_CONTENT_V1','receipt_version',1,'operation_id',p_operation_id,
      'report_table','moderation_reports','report_id',p_report_id,'target_type',p_type,'target_id',p_id,'resolved_target_id',target_id,
      'expected_content_token',p_expected_content_token,'expected_report_token',p_expected_report_token,
      'effect',context->>'effect','previous_status',target->>'status','previous_admin_status',target->>'admin_status',
      'previous_post_status',target->>'post_status');
    IF p_type='event' THEN
      metadata_value:=metadata_value||pg_catalog.jsonb_build_object('event_id',target_id,'from_state',target->>'state','to_state','archived',
        'from_visibility',target->>'visibility','to_visibility','invite_only');
      INSERT INTO public.event_activity_log(event_id,actor_id,action,metadata)
        VALUES(target_id,p_admin_id,'admin_remove',metadata_value||pg_catalog.jsonb_build_object('reason',normalized_reason));
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected<>1 THEN RAISE EXCEPTION USING ERRCODE='PT503',MESSAGE='event_activity_incomplete'; END IF;
    END IF;
    INSERT INTO public.moderation_actions(target_user_id,performed_by,report_id,action_type,reason,created_at,metadata)
      VALUES(owner_id,p_admin_id,p_report_id,CASE WHEN p_type='event' THEN 'event_remove' ELSE 'content_removed' END,normalized_reason,committed_at,metadata_value) RETURNING * INTO receipt;
    IF receipt.id IS NULL OR receipt.metadata IS DISTINCT FROM metadata_value OR receipt.reason IS DISTINCT FROM normalized_reason THEN
      RAISE EXCEPTION USING ERRCODE='PT503',MESSAGE='removal_audit_incomplete'; END IF;
    IF p_type='buddy_listing' THEN
      INSERT INTO public.rent_buddy_admin_actions(admin_id,target_type,target_id,action,notes)
        VALUES(p_admin_id,'buddy',target_id,'suspended',normalized_reason);
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected<>1 THEN RAISE EXCEPTION USING ERRCODE='PT503',MESSAGE='listing_audit_incomplete'; END IF;
    END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('ok',true,'contractVersion',1,'operationId',p_operation_id,'subjectType',p_type,'subjectId',p_id,
    'reportId',p_report_id,'auditId',receipt.id,'committedAt',receipt.created_at,'replayed',replayed,
    'effect',receipt.metadata->>'effect','ownerId',receipt.target_user_id);
END $fn$;

REVOKE ALL ON FUNCTION public.read_reported_content_target(text,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_reported_content_removal_context(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.remove_reported_content(uuid,text,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_reported_content_target(text,uuid,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_reported_content_removal_context(uuid,text,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_reported_content(uuid,text,uuid,uuid,uuid,text,text,text) TO service_role;

-- Existing owner RLS allows direct row writes on posts/comments/Buddy profiles.
-- A client cannot undo a tombstone or administrative suspension by bypassing
-- the HTTP API. Canonical service-role moderation and account erasure remain
-- available. This does not change retention periods or delete any evidence.
CREATE FUNCTION public.guard_reported_content_client_write() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $guard$
BEGIN
  IF current_user NOT IN ('anon','authenticated') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='events' THEN
    IF OLD.state='archived'
      AND (TG_OP='DELETE' OR NEW.state IS DISTINCT FROM OLD.state OR NEW.visibility IS DISTINCT FROM OLD.visibility) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='event_under_moderation';
    END IF;
  ELSIF TG_TABLE_NAME='media_assets' THEN
    IF TG_OP='DELETE' AND OLD.moderation_status IN ('removed','owner_deleted') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='removed_media_cannot_be_recreated';
    ELSIF TG_OP='UPDATE' AND (NEW.moderation_status IS DISTINCT FROM OLD.moderation_status
      OR (OLD.moderation_status IN ('removed','owner_deleted') AND (NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket OR NEW.storage_path IS DISTINCT FROM OLD.storage_path))) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='media_moderation_is_server_owned';
    END IF;
  ELSIF TG_TABLE_NAME='rent_buddy_profiles' THEN
    IF TG_OP='DELETE' AND (OLD.admin_status='disabled' OR OLD.status='suspended') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='listing_under_moderation';
    ELSIF TG_OP='UPDATE' AND (NEW.admin_status IS DISTINCT FROM OLD.admin_status
      OR ((OLD.admin_status='disabled' OR OLD.status='suspended') AND NEW.status IS DISTINCT FROM OLD.status)) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='listing_under_moderation';
    END IF;
  ELSIF OLD.deleted_at IS NOT NULL AND (TG_OP='DELETE' OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='removed_content_cannot_be_restored_by_client';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $guard$;
CREATE TRIGGER reported_content_client_guard BEFORE UPDATE OR DELETE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.guard_reported_content_client_write();
CREATE TRIGGER reported_content_client_guard BEFORE UPDATE OR DELETE ON public.posts_comments
  FOR EACH ROW EXECUTE FUNCTION public.guard_reported_content_client_write();
CREATE TRIGGER reported_content_client_guard BEFORE UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_reported_content_client_write();
CREATE TRIGGER reported_content_client_guard BEFORE UPDATE OR DELETE ON public.rent_buddy_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_reported_content_client_write();
CREATE TRIGGER reported_content_client_guard BEFORE UPDATE OR DELETE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_reported_content_client_write();
CREATE TRIGGER reported_content_client_guard BEFORE UPDATE OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.guard_reported_content_client_write();
REVOKE ALL ON FUNCTION public.guard_reported_content_client_write() FROM PUBLIC,anon,authenticated;

-- A later legacy approval must not resurrect a terminal canonical removal,
-- including service-role writes from older moderation clients.
CREATE FUNCTION public.guard_removed_media_legacy_publication() RETURNS trigger
-- The terminal-state lookup must see the canonical asset even when the
-- caller's asset RLS cannot. No data is returned and no row is mutated here.
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $legacy$
BEGIN
  IF NEW.moderation_status IS DISTINCT FROM 'rejected' AND EXISTS(
    SELECT 1 FROM public.media_assets WHERE storage_bucket=NEW.storage_bucket AND storage_path=NEW.storage_path
      AND moderation_status IN ('removed','owner_deleted')) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='canonical_media_removal_is_terminal';
  END IF;
  RETURN NEW;
END $legacy$;
CREATE TRIGGER reported_media_legacy_guard BEFORE INSERT OR UPDATE ON public.post_media
  FOR EACH ROW EXECUTE FUNCTION public.guard_removed_media_legacy_publication();
REVOKE ALL ON FUNCTION public.guard_removed_media_legacy_publication() FROM PUBLIC,anon,authenticated;
COMMIT;
