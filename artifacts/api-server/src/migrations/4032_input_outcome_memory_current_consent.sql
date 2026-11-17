-- Empty scaffold created with Supabase CLI; canonical SQL authored locally.
-- 4029 is already applied in CI and is immutable. Keep the existing ranking
-- reader consistent with its current-disclosure admission boundary.
BEGIN;
CREATE OR REPLACE FUNCTION public.input_outcome_memory(
  p_user_id uuid, p_context text, p_since date
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_context IS NULL OR p_since IS NULL THEN
    RAISE EXCEPTION 'input_outcome_memory: user, context and since are all required';
  END IF;
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag='input_outcome_learning_enabled'),false)
     OR NOT EXISTS(SELECT 1 FROM public.input_outcome_consent c
       WHERE c.user_id=p_user_id AND c.enabled AND c.withdrawn_at IS NULL
         AND c.consent_version='input_outcome_learning_v1' AND c.consented_at IS NOT NULL) THEN
    RETURN jsonb_build_object('active',false);
  END IF;
  RETURN jsonb_build_object('active',true,'counts',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('entity_type',t.entity_type,'entity_id',t.entity_id,'completed',t.total))
    FROM (SELECT k.entity_type,k.entity_id,sum(k.completed_count)::int AS total
      FROM public.input_outcome_counters k
      WHERE k.user_id=p_user_id AND k.context=p_context AND k.bucket_day>=p_since
      GROUP BY k.entity_type,k.entity_id ORDER BY total DESC LIMIT 500) t
  ),'[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.input_outcome_memory(uuid,text,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.input_outcome_memory(uuid,text,date) TO service_role;
COMMENT ON FUNCTION public.input_outcome_memory(uuid,text,date) IS
 'Current-disclosure, enabled, unwithdrawn consent and feature flag are required to read owner-scoped outcome counts. Same statement snapshot, one round trip. Service-only invoker; unavailable reads preserve ordinary assistance fallback. No new collection or activation.';
DO $post$
BEGIN
 IF has_function_privilege('anon','public.input_outcome_memory(uuid,text,date)','EXECUTE')
    OR has_function_privilege('authenticated','public.input_outcome_memory(uuid,text,date)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.input_outcome_memory(uuid,text,date)','EXECUTE') THEN
   RAISE EXCEPTION '4032 outcome memory reader must remain service-only';
 END IF;
END
$post$;
COMMIT;
