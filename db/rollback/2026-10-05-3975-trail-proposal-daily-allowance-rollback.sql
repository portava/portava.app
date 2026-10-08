-- Rollback for 3975_trail_proposal_daily_allowance.sql (census-discovery §84, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Restores 3415's trail_propose verbatim (no migration between 3415 and 3975
-- touched it). After this, starting a Trail is bounded only by the API's
-- pre-check count (TrailService.proposeTrail), which a race between instances
-- can overshoot; say so to whoever runs it.

BEGIN;

CREATE OR REPLACE FUNCTION public.trail_propose(
  p_title text, p_destination text, p_description text, p_parent_trail_id uuid, p_created_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_key bigint;
  v_parent_state text;
  v_peers jsonb;
  v_verdict jsonb;
  v_refusals jsonb;
  v_row public.trails%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'trail_propose requires READ COMMITTED (this transaction is %): under a transaction snapshot the per-token lock cannot show it a racing proposal', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  -- 1. Serialise against every proposal this one could collide with.
  FOR v_key IN
    SELECT DISTINCT hashtextextended('trail_propose:token:' || t, 0) AS k
      FROM unnest(public.trail_title_tokens(p_title)) AS t
     ORDER BY k
  LOOP
    PERFORM pg_advisory_xact_lock(v_key);
  END LOOP;

  -- 2. The declared parent, read by id and held against a concurrent archive.
  IF p_parent_trail_id IS NOT NULL THEN
    SELECT tr.lifecycle_status INTO v_parent_state
      FROM public.trails AS tr WHERE tr.id = p_parent_trail_id FOR SHARE;
    IF NOT FOUND OR v_parent_state = 'archived' THEN
      RETURN jsonb_build_object('outcome', 'invalid_parent');
    END IF;
  END IF;

  -- 3. The four checks, over the catalogue as it stands under the lock.
  v_peers := public.trail_proposal_peers(p_title, p_destination);
  v_verdict := public.trail_canonicalisation_verdict(p_title, p_destination, v_peers);

  -- 4. A declared parent waives the overlap refusals THAT PARENT raised, and
  --    nothing else (proposeTrail's WAIVED_BY_PARENT).
  SELECT coalesce(jsonb_agg(x.r ORDER BY x.ord), '[]'::jsonb) INTO v_refusals
    FROM jsonb_array_elements(v_verdict -> 'refusals') WITH ORDINALITY AS x(r, ord)
   WHERE NOT (p_parent_trail_id IS NOT NULL
              AND x.r ->> 'check' IN ('existing_parent_child', 'destination_overlap', 'semantic_overlap')
              AND x.r ->> 'conflictsWith' = p_parent_trail_id::text);
  IF jsonb_array_length(v_refusals) > 0 OR (v_verdict ->> 'slug') IS NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'refused', 'refusals', v_refusals,
      'suggestedParentTrailId', v_verdict -> 'suggestedParentTrailId');
  END IF;

  INSERT INTO public.trails (slug, title, description, destination, parent_trail_id, created_by, canonicalization, lifecycle_status)
  VALUES (
    v_verdict ->> 'slug', p_title, p_description, p_destination, p_parent_trail_id, p_created_by,
    jsonb_build_object(
      'checks', jsonb_build_array('duplicate_title_similarity', 'destination_overlap', 'semantic_overlap', 'existing_parent_child'),
      'comparedAgainst', jsonb_array_length(v_peers),
      'origin', CASE WHEN p_created_by IS NULL THEN 'system' ELSE 'user' END,
      'waivedByDeclaredParent', p_parent_trail_id,
      'decidedBy', 'trail_propose (3415), under the per-token lock'),
    'proposed')
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('outcome', 'created', 'trail', jsonb_build_object(
    'id', v_row.id, 'slug', v_row.slug, 'title', v_row.title, 'description', v_row.description,
    'destination', v_row.destination, 'place_scope', v_row.place_scope,
    'parent_trail_id', v_row.parent_trail_id, 'lifecycle_status', v_row.lifecycle_status,
    'created_by', v_row.created_by, 'created_at', v_row.created_at, 'updated_at', v_row.updated_at));
END;
$fn$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3975_trail_proposal_daily_allowance.sql';

COMMIT;

DO $post$
BEGIN
  IF position('trail_propose:proposer:' IN pg_get_functiondef('public.trail_propose(text,text,text,uuid,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3975 rollback): the proposer allowance is still present';
  END IF;
END $post$;
