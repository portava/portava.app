-- Rollback for 3977_trail_review_before_visible.sql (census-discovery §122, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- THIS ROLLBACK PUBLISHES EVERY PENDING AND REJECTED TRAIL to every signed-in
-- client (the restrictive policies go, and with them the review column), and a
-- person's new Trail is again public the moment it is started. It refuses while
-- trail_creation_enabled is TRUE, so new pending Trails cannot appear during it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trail_creation_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3977): trail_creation_enabled is TRUE. Turn it off deliberately first.';
  END IF;
END $$;

DROP POLICY IF EXISTS trails_review_visible ON public.trails;
DROP POLICY IF EXISTS content_trails_review_visible ON public.content_trails;
DROP POLICY IF EXISTS trail_edges_review_visible ON public.trail_edges;
DROP FUNCTION IF EXISTS authz.trail_review_visible(uuid);
DROP FUNCTION IF EXISTS public.trail_review_decide(uuid, uuid, text, text);

-- rebuild_place_cooccurrence: drop the approved-only clause again.
DO $cooc$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.rebuild_place_cooccurrence(timestamptz)'::regprocedure);
  d := replace(d, ' AND t.review_state = ''approved''', '');
  EXECUTE d;
END
$cooc$;

-- 3975's trail_propose, verbatim.
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

  -- 0. census-discovery §84: the PROPOSER's daily allowance — three Trails
  --    started per rolling 24 hours (TrailService.TRAIL_PROPOSALS_PER_DAY,
  --    pinned equal by test). Decided here, under a per-proposer lock taken
  --    BEFORE the token locks: a second proposal by the same person waits here
  --    holding nothing, and two different proposers never wait on each other's
  --    proposer lock, so the lock order cannot cycle. Under READ COMMITTED the
  --    count below sees every proposal of this person that committed before
  --    this one got the lock. A system proposal (no proposer) is not counted.
  IF p_created_by IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('trail_propose:proposer:' || p_created_by::text, 0));
    IF (SELECT count(*) FROM public.trails AS tr
         WHERE tr.created_by = p_created_by AND tr.created_at > now() - interval '24 hours') >= 3 THEN
      RETURN jsonb_build_object('outcome', 'rate_limited', 'limit', 3, 'window_hours', 24);
    END IF;
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

DROP INDEX IF EXISTS public.idx_trails_review_pending;
DROP INDEX IF EXISTS public.idx_trails_created_by_review;
ALTER TABLE public.trails
  DROP CONSTRAINT IF EXISTS trails_rejection_has_reason,
  DROP CONSTRAINT IF EXISTS trails_review_state_known,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS review_reason,
  DROP COLUMN IF EXISTS review_state;


COMMIT;
