BEGIN;
ALTER TABLE public.post_destination_references
  ADD COLUMN profile_post_id uuid UNIQUE REFERENCES public.posts(id) ON DELETE CASCADE,
  DROP CONSTRAINT post_reference_one_destination,
  ADD CONSTRAINT post_reference_one_destination CHECK (num_nonnulls(memory_item_id,highlight_id,profile_post_id)=1);
-- The wrapper and reference have the same id. A client cannot attach another
-- person's reference to its own post, even if it knows the opaque reference id.
ALTER TABLE public.posts ADD COLUMN post_reference_id uuid
  REFERENCES public.post_destination_references(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT profile_share_reference_identity CHECK (post_reference_id IS NULL OR post_reference_id=id);

CREATE FUNCTION public.share_post_to_profile(p_actor_id uuid,p_post_id uuid,p_operation_id uuid,p_note text,p_visibility text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
  source_post public.posts%ROWTYPE;
  wrapper_id uuid := gen_random_uuid();
  wrapper_visibility public.posts.visibility%TYPE := p_visibility;
  fingerprint text;
  previous public.post_destination_operations%ROWTYPE;
  receipt jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_post_id IS NULL OR p_operation_id IS NULL OR p_visibility IS NULL
     OR p_visibility NOT IN ('private','public') OR char_length(coalesce(p_note,''))>500 THEN
    RAISE EXCEPTION 'invalid_destination';
  END IF;
  fingerprint := encode(sha256(convert_to(jsonb_build_object('post',p_post_id,'destination','profile',
    'note',p_note,'visibility',p_visibility)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('post-destination:'||p_actor_id::text||':'||p_operation_id::text,0));
  SELECT * INTO previous FROM public.post_destination_operations WHERE owner_id=p_actor_id AND operation_id=p_operation_id;
  IF FOUND THEN
    IF previous.intent_hash<>fingerprint THEN RAISE EXCEPTION 'destination_intent_conflict'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.posts p JOIN public.post_destination_references r ON r.profile_post_id=p.id
      WHERE r.id=(previous.result_json->>'referenceId')::uuid AND p.post_reference_id=r.id
        AND p.author_id=p_actor_id AND r.owner_id=p_actor_id AND p.deleted_at IS NULL AND p.status='active') THEN
      RAISE EXCEPTION 'destination_unavailable';
    END IF;
    RETURN previous.result_json||jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO source_post FROM public.posts WHERE id=p_post_id FOR SHARE;
  IF NOT FOUND OR source_post.author_id IS NULL OR source_post.deleted_at IS NOT NULL OR source_post.status IS DISTINCT FROM 'active'
    OR (source_post.author_id<>p_actor_id AND (source_post.visibility IS DISTINCT FROM 'public'
      OR source_post.post_status IS DISTINCT FROM 'published' OR source_post.sharing_disabled OR source_post.reposting_disabled))
    OR EXISTS(SELECT 1 FROM public.blocks WHERE (blocker_id=p_actor_id AND blocked_id=source_post.author_id)
      OR (blocked_id=p_actor_id AND blocker_id=source_post.author_id))
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=source_post.author_id AND coalesce(account_status::text,'active')='active')
    OR (source_post.author_id<>p_actor_id AND EXISTS(SELECT 1 FROM public.profiles WHERE id=source_post.author_id AND is_private)
      AND NOT EXISTS(SELECT 1 FROM public.user_follows WHERE follower_id=p_actor_id AND following_id=source_post.author_id))
    OR EXISTS(SELECT 1 FROM public.user_account_states WHERE user_id IN (p_actor_id,source_post.author_id)
      AND state IN ('suspended','banned') AND (expires_at IS NULL OR expires_at>now())) THEN
    RAISE EXCEPTION 'source_post_unavailable';
  END IF;
  INSERT INTO public.posts (id,author_id,content,status,post_status,visibility,post_reference_id,created_by,updated_by,source)
    VALUES (wrapper_id,p_actor_id,coalesce(btrim(p_note),''),'active','published',wrapper_visibility,wrapper_id,p_actor_id,p_actor_id,'api_server');
  INSERT INTO public.post_destination_references (id,owner_id,post_id,profile_post_id,operation_id,intent_hash)
    VALUES (wrapper_id,p_actor_id,p_post_id,wrapper_id,p_operation_id,fingerprint);
  receipt := jsonb_build_object('referenceId',wrapper_id,'profilePostId',wrapper_id,'memoryId',NULL,'highlightId',NULL,'replayed',false);
  INSERT INTO public.post_destination_operations (owner_id,operation_id,intent_hash,result_json) VALUES (p_actor_id,p_operation_id,fingerprint,receipt);
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.share_post_to_profile(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.share_post_to_profile(uuid,uuid,uuid,text,text) TO service_role;
COMMIT;
