BEGIN;
SET LOCAL lock_timeout = '1000ms';

DO $pre$
DECLARE
  requirement record;
  attribute_number smallint;
  table_name text;
BEGIN
  FOR requirement IN SELECT * FROM (VALUES
    ('profiles','id','uuid'), ('profiles','role','text'),
    ('reviews','id','uuid'), ('reviews','reviewer_id','uuid'), ('reviews','entity_id','uuid'),
    ('reviews','entity_type','review_entity_type'), ('reviews','state','review_state'),
    ('reviews','rating','integer'), ('reviews','body','text'), ('reviews','updated_at','timestamp with time zone'),
    ('moderation_reports','id','uuid'), ('moderation_reports','subject_type','text'),
    ('moderation_reports','subject_id','text'), ('moderation_reports','subject_user_id','uuid'), ('moderation_reports','status','text'),
    ('moderation_actions','id','uuid'), ('moderation_actions','performed_by','uuid'),
    ('moderation_actions','target_user_id','uuid'), ('moderation_actions','report_id','uuid'),
    ('moderation_actions','action_type','text'), ('moderation_actions','reason','text'),
    ('moderation_actions','metadata','jsonb'), ('moderation_actions','created_at','timestamp with time zone')
  ) AS required(table_name,column_name,type_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid=pg_catalog.to_regclass('public.' || requirement.table_name)
      AND attname=requirement.column_name AND NOT attisdropped
      AND pg_catalog.format_type(atttypid,atttypmod)=requirement.type_name) THEN
      RAISE EXCEPTION '3994 prerequisite missing or incompatible: %.%', requirement.table_name, requirement.column_name;
    END IF;
  END LOOP;
  FOR requirement IN SELECT * FROM (VALUES
    ('moderation_reports','subject_type'), ('moderation_reports','subject_id'), ('moderation_reports','status'),
    ('reviews','reviewer_id'), ('reviews','entity_type'), ('reviews','entity_id'), ('reviews','rating'), ('reviews','state')
  ) AS required(table_name,column_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid=pg_catalog.to_regclass('public.' || requirement.table_name)
        AND attname=requirement.column_name AND NOT attisdropped AND attnotnull) THEN
      RAISE EXCEPTION '3994 requires NOT NULL for %.%', requirement.table_name, requirement.column_name;
    END IF;
  END LOOP;
  FOR requirement IN SELECT * FROM (VALUES
    ('target_user_id','public.profiles','c',false),
    ('performed_by','public.profiles','n',true),
    ('report_id','public.moderation_reports','n',true)
  ) AS required(column_name,parent_name,delete_action,nullable) LOOP
    SELECT attnum INTO STRICT attribute_number FROM pg_catalog.pg_attribute
      WHERE attrelid='public.moderation_actions'::regclass AND attname=requirement.column_name AND NOT attisdropped
      AND attnotnull=NOT requirement.nullable;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_attribute AS parent_column ON parent_column.attrelid=constraint_row.confrelid
        AND parent_column.attname='id' AND constraint_row.confkey=ARRAY[parent_column.attnum]
      WHERE constraint_row.conrelid='public.moderation_actions'::regclass AND constraint_row.contype='f'
        AND constraint_row.conkey=ARRAY[attribute_number]
        AND constraint_row.confrelid=pg_catalog.to_regclass(requirement.parent_name)
        AND constraint_row.confdeltype::text=requirement.delete_action AND constraint_row.convalidated) THEN
      RAISE EXCEPTION '3994 requires the existing 2138/3705 FK contract for %', requirement.column_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_attribute AS attribute_row ON attribute_row.attrelid=constraint_row.conrelid AND attribute_row.attname='id'
    WHERE constraint_row.conrelid='public.moderation_actions'::regclass AND constraint_row.contype='p'
      AND constraint_row.conkey=ARRAY[attribute_row.attnum]) THEN
    RAISE EXCEPTION '3994 requires the existing audit primary key';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.moderation_actions'::regclass)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public.moderation_actions'::regclass
      AND polroles<>ARRAY['service_role'::regrole::oid]) THEN
    RAISE EXCEPTION '3994 requires service-only moderation_actions policies';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['profiles','reviews','moderation_reports','moderation_actions'] LOOP
    IF NOT pg_catalog.has_table_privilege('service_role','public.' || table_name,'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role','public.' || table_name,'UPDATE') THEN
      RAISE EXCEPTION '3994 service role lacks existing privileges for %', table_name;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_table_privilege('service_role','public.moderation_actions','INSERT') THEN
    RAISE EXCEPTION '3994 service role cannot insert audit receipts';
  END IF;
END
$pre$;

CREATE UNIQUE INDEX moderation_actions_reported_review_operation_uq
  ON public.moderation_actions (performed_by, (metadata->>'operation_id'))
  WHERE metadata->>'command' = 'REMOVE_REPORTED_REVIEW_V1';

CREATE FUNCTION public.remove_reported_review(
  p_admin_id uuid,
  p_review_id uuid,
  p_report_id uuid,
  p_operation_id uuid,
  p_reason text,
  p_expected_review_token text,
  p_expected_report_token text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = '' SET timezone = 'UTC' SET lock_timeout = '1000ms'
AS $function$
DECLARE
  normalized_reason text;
  trim_characters constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  target_owner uuid;
  locked_profile record;
  actor_allowed boolean := false;
  owner_present boolean := false;
  report_row public.moderation_reports%ROWTYPE;
  review_row public.reviews%ROWTYPE;
  receipt public.moderation_actions%ROWTYPE;
  receipt_metadata jsonb;
  metadata_key text;
  expected_review jsonb;
  committed_at timestamptz;
  affected bigint;
  replayed boolean := false;
  began_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='service_role required';
  END IF;
  normalized_reason := pg_catalog.btrim(p_reason,trim_characters);
  IF p_admin_id IS NULL OR p_review_id IS NULL OR p_report_id IS NULL OR p_operation_id IS NULL
    OR normalized_reason IS NULL OR pg_catalog.char_length(normalized_reason) NOT BETWEEN 1 AND 1000
    OR p_expected_review_token IS NULL OR p_expected_review_token !~ '^[0-9a-f]{64}$'
    OR p_expected_report_token IS NULL OR p_expected_report_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='PT400', MESSAGE='invalid_removal_intent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass('public.moderation_actions_reported_review_operation_uq')
    AND indrelid='public.moderation_actions'::regclass AND indisvalid AND indisunique
    AND indnkeyatts=2 AND indkey[0]=(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=indrelid AND attname='performed_by') AND indkey[1]=0
    AND pg_catalog.pg_get_expr(indexprs,indrelid)='(metadata ->> ''operation_id''::text)'
    AND pg_catalog.pg_get_expr(indpred,indrelid)='((metadata ->> ''command''::text) = ''REMOVE_REPORTED_REVIEW_V1''::text)') THEN
    RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_schema_unavailable';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'REMOVE_REPORTED_REVIEW_V1:' || p_admin_id::text || ':' || p_operation_id::text,0));
  SELECT target_user_id INTO target_owner FROM public.moderation_actions
    WHERE performed_by=p_admin_id AND metadata->>'command'='REMOVE_REPORTED_REVIEW_V1'
      AND metadata->>'operation_id'=p_operation_id::text;
  IF NOT FOUND THEN
    SELECT reviewer_id INTO target_owner FROM public.reviews WHERE id=p_review_id;
  END IF;
  FOR locked_profile IN SELECT id,role FROM public.profiles
    WHERE id=ANY(ARRAY[p_admin_id,target_owner]) ORDER BY id FOR SHARE LOOP
    IF locked_profile.id=p_admin_id THEN actor_allowed := locked_profile.role='admin'; END IF;
    IF locked_profile.id=target_owner THEN owner_present := true; END IF;
  END LOOP;
  IF actor_allowed IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='PT403', MESSAGE='admin_role_required';
  END IF;
  SELECT * INTO receipt FROM public.moderation_actions
    WHERE performed_by=p_admin_id AND metadata->>'command'='REMOVE_REPORTED_REVIEW_V1'
      AND metadata->>'operation_id'=p_operation_id::text FOR SHARE;
  IF FOUND THEN
    receipt_metadata := receipt.metadata;
    IF pg_catalog.jsonb_typeof(receipt_metadata) IS DISTINCT FROM 'object'
      OR receipt_metadata->'receipt_version' IS DISTINCT FROM '1'::jsonb
      OR receipt.action_type IS DISTINCT FROM 'content_removed' OR receipt.id IS NULL OR receipt.target_user_id IS NULL
      OR receipt.created_at IS NULL OR NOT pg_catalog.isfinite(receipt.created_at)
      OR receipt.reason IS NULL OR receipt.reason IS DISTINCT FROM pg_catalog.btrim(receipt.reason,trim_characters)
      OR pg_catalog.char_length(receipt.reason) NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_receipt_unreadable';
    END IF;
    FOREACH metadata_key IN ARRAY ARRAY['command','operation_id','report_table','report_id','target_type','target_id',
      'expected_review_token','expected_report_token','from_state','to_state','reviewed_entity_type','reviewed_entity_id'] LOOP
      IF pg_catalog.jsonb_typeof(receipt_metadata->metadata_key) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_receipt_unreadable';
      END IF;
    END LOOP;
    IF receipt_metadata->>'report_table' <> 'moderation_reports' OR receipt_metadata->>'target_type' <> 'review'
      OR receipt_metadata->>'from_state' NOT IN ('published','hidden') OR receipt_metadata->>'to_state' <> 'removed'
      OR receipt_metadata->>'reviewed_entity_type' NOT IN ('trip','rent_buddy_booking','place')
      OR receipt_metadata->>'report_id' !~ uuid_pattern OR receipt_metadata->>'target_id' !~ uuid_pattern
      OR receipt_metadata->>'reviewed_entity_id' !~ uuid_pattern
      OR receipt_metadata->>'expected_review_token' !~ '^[0-9a-f]{64}$'
      OR receipt_metadata->>'expected_report_token' !~ '^[0-9a-f]{64}$'
      OR (receipt.report_id IS NOT NULL AND receipt.report_id::text <> receipt_metadata->>'report_id')
      OR receipt_metadata - ARRAY['command','receipt_version','operation_id','report_table','report_id','target_type','target_id',
        'expected_review_token','expected_report_token','from_state','to_state','reviewed_entity_type','reviewed_entity_id'] <> '{}'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_receipt_unreadable';
    END IF;
    IF receipt_metadata->>'target_id' <> p_review_id::text OR receipt_metadata->>'report_id' <> p_report_id::text
      OR receipt.reason <> normalized_reason OR receipt_metadata->>'expected_review_token' <> p_expected_review_token
      OR receipt_metadata->>'expected_report_token' <> p_expected_report_token THEN
      RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='removal_intent_conflict';
    END IF;
    replayed := true;
  ELSE
    IF NOT owner_present THEN
      RAISE EXCEPTION USING ERRCODE='PT404', MESSAGE='review_owner_not_found';
    END IF;
    SELECT * INTO report_row FROM public.moderation_reports WHERE id=p_report_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404', MESSAGE='report_not_found'; END IF;
    SELECT * INTO review_row FROM public.reviews WHERE id=p_review_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404', MESSAGE='review_not_found'; END IF;
    IF report_row.subject_type IS DISTINCT FROM 'review' OR pg_catalog.lower(report_row.subject_id) IS DISTINCT FROM p_review_id::text
      OR report_row.status IS NULL OR report_row.status NOT IN ('open','reviewing') OR review_row.state IS NULL OR review_row.state NOT IN ('published','hidden')
      OR review_row.entity_type IS NULL OR review_row.entity_id IS NULL OR review_row.rating IS NULL OR review_row.rating NOT BETWEEN 1 AND 5
      OR review_row.reviewer_id IS DISTINCT FROM target_owner
      OR (report_row.subject_user_id IS NOT NULL AND report_row.subject_user_id <> review_row.reviewer_id)
      OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(review_row)::text,'UTF8')),'hex') <> p_expected_review_token
      OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(report_row)::text,'UTF8')),'hex') <> p_expected_report_token THEN
      RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='removal_context_changed';
    END IF;
    IF pg_catalog.clock_timestamp()-began_at > interval '5 seconds' THEN
      RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_budget_exhausted';
    END IF;
    committed_at := pg_catalog.clock_timestamp();
    expected_review := pg_catalog.to_jsonb(review_row) || pg_catalog.jsonb_build_object('state','removed','updated_at',committed_at);
    receipt_metadata := pg_catalog.jsonb_build_object(
      'command','REMOVE_REPORTED_REVIEW_V1','receipt_version',1,'operation_id',p_operation_id::text,
      'report_table','moderation_reports','report_id',p_report_id::text,'target_type','review','target_id',p_review_id::text,
      'expected_review_token',p_expected_review_token,'expected_report_token',p_expected_report_token,
      'from_state',review_row.state::text,'to_state','removed','reviewed_entity_type',review_row.entity_type::text,
      'reviewed_entity_id',review_row.entity_id::text);
    UPDATE public.reviews SET state='removed',updated_at=committed_at WHERE id=p_review_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_write_incomplete'; END IF;
    INSERT INTO public.moderation_actions(target_user_id,performed_by,report_id,action_type,reason,created_at,metadata)
      VALUES(target_owner,p_admin_id,p_report_id,'content_removed',normalized_reason,committed_at,receipt_metadata)
      RETURNING * INTO receipt;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 OR receipt.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_audit_incomplete';
    END IF;
    SELECT * INTO receipt FROM public.moderation_actions WHERE id=receipt.id;
    IF NOT FOUND OR receipt.performed_by IS DISTINCT FROM p_admin_id OR receipt.target_user_id IS DISTINCT FROM target_owner
      OR receipt.report_id IS DISTINCT FROM p_report_id OR receipt.action_type IS DISTINCT FROM 'content_removed'
      OR receipt.reason IS DISTINCT FROM normalized_reason OR receipt.created_at IS DISTINCT FROM committed_at
      OR receipt.metadata IS DISTINCT FROM receipt_metadata THEN
      RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_audit_incomplete';
    END IF;
    SELECT * INTO review_row FROM public.reviews WHERE id=p_review_id;
    IF NOT FOUND OR pg_catalog.to_jsonb(review_row) IS DISTINCT FROM expected_review THEN
      RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_write_incomplete';
    END IF;
    SELECT * INTO report_row FROM public.moderation_reports WHERE id=p_report_id;
    IF NOT FOUND OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(report_row)::text,'UTF8')),'hex') <> p_expected_report_token THEN
      RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_report_changed';
    END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('ok',true,'contractVersion',1,'operationId',p_operation_id::text,
    'reviewId',p_review_id::text,'reportId',p_report_id::text,'auditId',receipt.id::text,
    'stateAtCommit','removed','committedAt',receipt.created_at,'replayed',replayed,
    'reviewedEntityType',receipt.metadata->>'reviewed_entity_type','reviewedEntityId',receipt.metadata->>'reviewed_entity_id');
END
$function$;

CREATE FUNCTION public.get_reported_review_removal_context(p_admin_id uuid,p_review_id uuid,p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = '' SET timezone = 'UTC' SET lock_timeout = '1000ms'
AS $function$
DECLARE
  report_row public.moderation_reports%ROWTYPE;
  review_row public.reviews%ROWTYPE;
BEGIN
  IF current_user <> 'service_role' THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='service_role required'; END IF;
  IF p_admin_id IS NULL OR p_review_id IS NULL OR p_report_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PT400', MESSAGE='invalid_removal_context';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_admin_id AND role='admin') THEN
    RAISE EXCEPTION USING ERRCODE='PT403', MESSAGE='admin_role_required';
  END IF;
  IF pg_catalog.to_regprocedure('public.remove_reported_review(uuid,uuid,uuid,uuid,text,text,text)') IS NULL
    OR NOT pg_catalog.has_function_privilege('service_role','public.remove_reported_review(uuid,uuid,uuid,uuid,text,text,text)','EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass('public.moderation_actions_reported_review_operation_uq')
      AND indrelid='public.moderation_actions'::regclass AND indisvalid AND indisunique
      AND indnkeyatts=2 AND indkey[0]=(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=indrelid AND attname='performed_by') AND indkey[1]=0
      AND pg_catalog.pg_get_expr(indexprs,indrelid)='(metadata ->> ''operation_id''::text)'
      AND pg_catalog.pg_get_expr(indpred,indrelid)='((metadata ->> ''command''::text) = ''REMOVE_REPORTED_REVIEW_V1''::text)') THEN
    RAISE EXCEPTION USING ERRCODE='PT503', MESSAGE='removal_schema_unavailable';
  END IF;
  SELECT * INTO report_row FROM public.moderation_reports WHERE id=p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404', MESSAGE='report_not_found'; END IF;
  SELECT * INTO review_row FROM public.reviews WHERE id=p_review_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=review_row.reviewer_id) THEN
    RAISE EXCEPTION USING ERRCODE='PT404', MESSAGE='review_not_found';
  END IF;
  IF report_row.subject_type IS DISTINCT FROM 'review' OR pg_catalog.lower(report_row.subject_id) IS DISTINCT FROM p_review_id::text
    OR report_row.status IS NULL OR report_row.status NOT IN ('open','reviewing') OR review_row.state IS NULL OR review_row.state NOT IN ('published','hidden')
    OR review_row.entity_type IS NULL OR review_row.entity_id IS NULL OR review_row.rating IS NULL OR review_row.rating NOT BETWEEN 1 AND 5
    OR (report_row.subject_user_id IS NOT NULL AND report_row.subject_user_id <> review_row.reviewer_id) THEN
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='removal_context_changed';
  END IF;
  RETURN pg_catalog.jsonb_build_object('contractVersion',1,'reviewId',p_review_id::text,'reportId',p_report_id::text,
    'reportStatus',report_row.status,
    'reviewToken',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(review_row)::text,'UTF8')),'hex'),
    'reportToken',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(report_row)::text,'UTF8')),'hex'),
    'review',pg_catalog.jsonb_build_object('rating',review_row.rating,'body',review_row.body,'state',review_row.state,
      'entityType',review_row.entity_type,'entityId',review_row.entity_id));
END
$function$;

REVOKE ALL ON FUNCTION public.get_reported_review_removal_context(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.remove_reported_review(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_reported_review_removal_context(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_reported_review(uuid,uuid,uuid,uuid,text,text,text) TO service_role;

DO $post$
DECLARE
  function_row record;
BEGIN
  FOR function_row IN SELECT * FROM pg_catalog.pg_proc WHERE oid=ANY(ARRAY[
    'public.get_reported_review_removal_context(uuid,uuid,uuid)'::regprocedure,
    'public.remove_reported_review(uuid,uuid,uuid,uuid,text,text,text)'::regprocedure]) LOOP
    IF function_row.prosecdef OR NOT ARRAY['search_path=""','TimeZone=UTC','lock_timeout=1000ms'] <@ function_row.proconfig
      OR NOT pg_catalog.has_function_privilege('service_role',function_row.oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('anon',function_row.oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated',function_row.oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(function_row.proacl)
        WHERE grantee NOT IN (function_row.proowner,'service_role'::regrole::oid)) THEN
      RAISE EXCEPTION '3994 RPC privilege/configuration postcondition failed';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_attribute AS attribute_row ON attribute_row.attrelid=index_row.indrelid AND attribute_row.attname='performed_by'
    WHERE index_row.indexrelid='public.moderation_actions_reported_review_operation_uq'::regclass
      AND index_row.indrelid='public.moderation_actions'::regclass AND index_row.indisvalid AND index_row.indisunique
      AND index_row.indnkeyatts=2 AND index_row.indkey[0]=attribute_row.attnum AND index_row.indkey[1]=0
      AND pg_catalog.pg_get_expr(index_row.indexprs,index_row.indrelid)='(metadata ->> ''operation_id''::text)'
      AND pg_catalog.pg_get_expr(index_row.indpred,index_row.indrelid)='((metadata ->> ''command''::text) = ''REMOVE_REPORTED_REVIEW_V1''::text)') THEN
    RAISE EXCEPTION '3994 receipt index postcondition failed';
  END IF;
END
$post$;

COMMIT;
