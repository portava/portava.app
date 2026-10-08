-- 3975_trail_proposal_daily_allowance.sql
--
-- census-discovery §84 (the verifier, wave 2: starting a Trail published a
-- `proposed` Trail to every user at once, with no rate limit). Replaces
-- `public.trail_propose` (3415) with the same function plus ONE step 0: the
-- proposer's daily allowance — three Trails per rolling 24 hours, LANE C'S
-- NUMBER for the owner to confirm (02_Trails.md names none) — decided where the
-- insert is, under a per-proposer advisory lock, as 3415 decides the four
-- canonicalisation checks. Over the allowance it answers `rate_limited` and
-- writes nothing; services/trails/trailProposal.ts maps that to a 429.
--
-- Everything else in the function is 3415's, byte for byte (the test compares
-- the two bodies with step 0 removed). Signature, SECURITY INVOKER, the pinned
-- search_path and the grants are unchanged.
--
-- APPLIED TO NO DATABASE by the lane that wrote it (lane C, 2026-10-05); not
-- rehearsed on the local harness. Needs 3415.
-- Rollback: db/rollback/2026-10-05-3975-trail-proposal-daily-allowance-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.trail_propose(text,text,text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '3975: requires 3415 (public.trail_propose)';
  END IF;
  IF position('trail_propose:proposer:' IN pg_get_functiondef('public.trail_propose(text,text,text,uuid,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION '3975: the proposer allowance is already present; this migration is not idempotent by design';
  END IF;
END
$pre$;

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

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.trail_propose(text,text,text,uuid,uuid)'::regprocedure);
  IF position('trail_propose:proposer:' IN d) = 0 OR position('rate_limited' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3975): trail_propose does not carry the proposer allowance';
  END IF;
  IF position('trail_propose:token:' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3975): the per-token lock (3415) was lost';
  END IF;
  IF position('trail_propose:proposer:' IN d) > position('trail_propose:token:' IN d) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3975): the proposer lock must be taken BEFORE the token locks';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.trail_propose(text,text,text,uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3975): trail_propose must stay SECURITY INVOKER';
  END IF;
  IF has_function_privilege('authenticated', 'public.trail_propose(text,text,text,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trail_propose(text,text,text,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3975): a client role may execute trail_propose';
  END IF;
END
$post$;
