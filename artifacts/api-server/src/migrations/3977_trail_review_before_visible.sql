-- 3977_trail_review_before_visible.sql
--
-- Lead ruling D-66 (2026-10-06): "A newly started Trail is visible only to its
-- creator. Until an admin approves it, it is not ranked, surfaced, linked or
-- shared. A rejected Trail stays private to its creator and shows the reason.
-- The 3-per-person-per-day allowance (migration 3975) stays in force. Trail
-- creation stays behind its feature flag, seeded false." (census-discovery §122)
--
-- APPLIED TO NO DATABASE by the lane that wrote it (lane C, 2026-10-06); not
-- rehearsed (no PostgreSQL on this machine). Needs 2910 (trails), 3390 (the
-- explicit client posture), 3495 (rebuild_place_cooccurrence) and 3975
-- (trail_propose with the proposer allowance). Its application is the owner's.
--
-- WHAT IT ADDS
--   1. trails.review_state  pending | approved | rejected, NOT NULL. Existing rows
--      are 'approved' except a person's still-`proposed` Trail, which becomes
--      'pending' (it was published to everyone at once before this ruling).
--      The column DEFAULT is 'approved' so the server's own writers (probes,
--      admin tooling, the system proposal path) keep their meaning; the one
--      client-reachable creation path, trail_propose, states 'pending' for a
--      person's Trail explicitly (section 4). review_reason / reviewed_by /
--      reviewed_at record the decision; a rejection without a reason is refused
--      by a CHECK.
--   2. trail_review_decide(trail, admin, decision, reason): the one writer of a
--      decision. Row-locked; only a 'pending' Trail can be decided; approve also
--      moves a 'proposed' lifecycle to 'active' (3381 allows it); reject needs a
--      reason. service_role only. The admin check is the route's (requireAdmin).
--   3. The client door. A RESTRICTIVE select policy on trails, content_trails
--      and trail_edges: a client sees a Trail, its members and its edges only
--      when the Trail is approved or the client created it. 3390's permissive
--      policies are untouched (3391 measures them by name and predicate; it
--      flags extra PERMISSIVE policies only). The three apply to EVERY role
--      (no TO clause), not to `authenticated` alone: 3390's postcondition reads
--      any restrictive policy that NAMES a client role on a kept path as a deny,
--      so a role-named narrowing made 3390 impossible to re-apply after its own
--      rollback (CI's local-db job, DV-71 R7). A role-wide filter is also the
--      ruling's own reach: under review, a Trail is its creator's alone, for
--      anyone. service_role bypasses RLS and is unaffected.
--   4. trail_propose: 3975's function, byte for byte, plus review_state in its
--      INSERT and in its answer (the test compares the two bodies).
--   5. rebuild_place_cooccurrence (3495): a pending or rejected Trail's places
--      contribute no co-occurrence (a transform of the installed body; both
--      Trail joins gain `AND t.review_state = 'approved'`).
--   6. trail_creation_enabled, seeded FALSE: POST /v1/discovery/trails refuses
--      while it is off (routes/trails.ts).
--
-- Rollback: db/rollback/2026-10-06-3977-trail-review-before-visible-rollback.sql

BEGIN;

DO $pre$
DECLARE d text;
BEGIN
  IF to_regclass('public.trails') IS NULL OR to_regclass('public.content_trails') IS NULL OR to_regclass('public.trail_edges') IS NULL THEN
    RAISE EXCEPTION '3977: requires 2910 (trails, content_trails, trail_edges)';
  END IF;
  IF to_regprocedure('public.trail_propose(text,text,text,uuid,uuid)') IS NULL
     OR position('trail_propose:proposer:' IN pg_get_functiondef('public.trail_propose(text,text,text,uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '3977: requires 3975 (trail_propose with the proposer allowance)';
  END IF;
  IF to_regprocedure('public.rebuild_place_cooccurrence(timestamptz)') IS NULL THEN
    RAISE EXCEPTION '3977: requires 3495 (rebuild_place_cooccurrence)';
  END IF;
  d := pg_get_functiondef('public.rebuild_place_cooccurrence(timestamptz)'::regprocedure);
  IF (length(d) - length(replace(d, 'AND t.lifecycle_status <> ''archived''', ''))) / length('AND t.lifecycle_status <> ''archived''') <> 2 THEN
    RAISE EXCEPTION '3977: rebuild_place_cooccurrence does not carry exactly the two Trail joins 3495 wrote';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trails' AND column_name = 'review_state') THEN
    RAISE EXCEPTION '3977: trails.review_state already exists; this migration is not idempotent by design';
  END IF;
END
$pre$;

-- ── 1. The review state ────────────────────────────────────────────────────
ALTER TABLE public.trails
  ADD COLUMN review_state  text        NOT NULL DEFAULT 'approved',
  ADD COLUMN review_reason text        NULL,
  ADD COLUMN reviewed_by   uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at   timestamptz NULL;
ALTER TABLE public.trails
  ADD CONSTRAINT trails_review_state_known CHECK (review_state IN ('pending', 'approved', 'rejected')),
  ADD CONSTRAINT trails_rejection_has_reason CHECK (
    review_state <> 'rejected' OR (review_reason IS NOT NULL AND length(btrim(review_reason)) BETWEEN 1 AND 500));
COMMENT ON COLUMN public.trails.review_state IS
  '3977 (lead ruling D-66): pending = visible to its creator only, never ranked, surfaced, linked or shared; approved = public; rejected = private to its creator, with review_reason. Decided only by public.trail_review_decide.';

UPDATE public.trails SET review_state = 'pending'
 WHERE lifecycle_status = 'proposed' AND created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trails_review_pending ON public.trails (created_at) WHERE review_state = 'pending';
CREATE INDEX IF NOT EXISTS idx_trails_created_by_review ON public.trails (created_by, review_state) WHERE created_by IS NOT NULL;

-- ── 2. The one writer of a decision ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trail_review_decide(
  p_trail_id uuid, p_admin_id uuid, p_decision text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_row public.trails%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'detail', 'decision must be approve or reject');
  END IF;
  IF p_admin_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'detail', 'the deciding admin is required');
  END IF;
  IF p_decision = 'reject' AND (v_reason IS NULL OR length(v_reason) > 500) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'detail', 'a rejection needs a reason of 1 to 500 characters');
  END IF;
  SELECT * INTO v_row FROM public.trails AS t WHERE t.id = p_trail_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unknown_trail');
  END IF;
  IF v_row.review_state <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'not_pending', 'review_state', v_row.review_state);
  END IF;
  IF p_decision = 'approve' THEN
    UPDATE public.trails AS t
       SET review_state = 'approved', review_reason = NULL, reviewed_by = p_admin_id, reviewed_at = now(),
           lifecycle_status = CASE WHEN t.lifecycle_status = 'proposed' THEN 'active' ELSE t.lifecycle_status END,
           updated_at = now()
     WHERE t.id = p_trail_id
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.trails AS t
       SET review_state = 'rejected', review_reason = v_reason, reviewed_by = p_admin_id, reviewed_at = now(),
           updated_at = now()
     WHERE t.id = p_trail_id
    RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('outcome', 'decided', 'trail', jsonb_build_object(
    'id', v_row.id, 'slug', v_row.slug, 'title', v_row.title, 'lifecycle_status', v_row.lifecycle_status,
    'created_by', v_row.created_by, 'review_state', v_row.review_state, 'review_reason', v_row.review_reason,
    'reviewed_by', v_row.reviewed_by, 'reviewed_at', v_row.reviewed_at));
END;
$fn$;
REVOKE ALL ON FUNCTION public.trail_review_decide(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trail_review_decide(uuid, uuid, text, text) TO service_role;

-- ── 3. The client door ─────────────────────────────────────────────────────
-- A SECURITY DEFINER read of trails (bypassing its RLS, so the policies below
-- cannot recurse), comparing the row to auth.uid() read INSIDE the function.
CREATE OR REPLACE FUNCTION authz.trail_review_visible(p_trail_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.trails AS t
     WHERE t.id = p_trail_id
       AND (t.review_state = 'approved' OR (auth.uid() IS NOT NULL AND t.created_by = auth.uid())));
$fn$;
REVOKE ALL ON FUNCTION authz.trail_review_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.trail_review_visible(uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS trails_review_visible ON public.trails;
CREATE POLICY trails_review_visible ON public.trails AS RESTRICTIVE
  FOR SELECT
  USING (trails.review_state = 'approved' OR (auth.uid() IS NOT NULL AND trails.created_by = auth.uid()));
DROP POLICY IF EXISTS content_trails_review_visible ON public.content_trails;
CREATE POLICY content_trails_review_visible ON public.content_trails AS RESTRICTIVE
  FOR SELECT
  USING (authz.trail_review_visible(content_trails.trail_id));
DROP POLICY IF EXISTS trail_edges_review_visible ON public.trail_edges;
CREATE POLICY trail_edges_review_visible ON public.trail_edges AS RESTRICTIVE
  FOR SELECT
  USING (authz.trail_review_visible(trail_edges.from_trail_id) AND authz.trail_review_visible(trail_edges.to_trail_id));

-- ── 4. trail_propose: 3975's, plus the review state ────────────────────────
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
  v_parent_review text;
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
  --    3977 (lead ruling D-66): and against a Trail under review — a pending or
  --    rejected Trail is not linked, so it cannot be a parent, whoever proposes.
  IF p_parent_trail_id IS NOT NULL THEN
    SELECT tr.lifecycle_status, tr.review_state INTO v_parent_state, v_parent_review
      FROM public.trails AS tr WHERE tr.id = p_parent_trail_id FOR SHARE;
    IF NOT FOUND OR v_parent_state = 'archived' OR v_parent_review IS DISTINCT FROM 'approved' THEN
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

  INSERT INTO public.trails (slug, title, description, destination, parent_trail_id, created_by, canonicalization, lifecycle_status, review_state)
  VALUES (
    v_verdict ->> 'slug', p_title, p_description, p_destination, p_parent_trail_id, p_created_by,
    jsonb_build_object(
      'checks', jsonb_build_array('duplicate_title_similarity', 'destination_overlap', 'semantic_overlap', 'existing_parent_child'),
      'comparedAgainst', jsonb_array_length(v_peers),
      'origin', CASE WHEN p_created_by IS NULL THEN 'system' ELSE 'user' END,
      'waivedByDeclaredParent', p_parent_trail_id,
      'decidedBy', 'trail_propose (3415), under the per-token lock'),
    'proposed',
    -- 3977 (lead ruling D-66): a person's new Trail waits for an admin; a system proposal (no proposer) does not.
    CASE WHEN p_created_by IS NULL THEN 'approved' ELSE 'pending' END)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('outcome', 'created', 'trail', jsonb_build_object(
    'id', v_row.id, 'slug', v_row.slug, 'title', v_row.title, 'description', v_row.description,
    'destination', v_row.destination, 'place_scope', v_row.place_scope,
    'parent_trail_id', v_row.parent_trail_id, 'lifecycle_status', v_row.lifecycle_status,
    'created_by', v_row.created_by, 'created_at', v_row.created_at, 'updated_at', v_row.updated_at,
    'review_state', v_row.review_state, 'review_reason', v_row.review_reason));
END;
$fn$;

-- ── 5. Co-occurrence reads approved Trails only ────────────────────────────
DO $cooc$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.rebuild_place_cooccurrence(timestamptz)'::regprocedure);
  d := replace(d, 'AND t.lifecycle_status <> ''archived''', 'AND t.lifecycle_status <> ''archived'' AND t.review_state = ''approved''');
  EXECUTE d;
END
$cooc$;

-- ── 6. The creation flag, seeded FALSE ─────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('trail_creation_enabled', false,
   '3977 (lead ruling D-66): POST /v1/discovery/trails starts a Trail only while this is TRUE. A new Trail is pending review and visible to its creator only until an admin approves it. FALSE = no person can start a Trail.')
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE d text; n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trails_review_state_known')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trails_rejection_has_reason') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3977): the review constraints are missing';
  END IF;
  SELECT count(*) INTO n FROM pg_policy
   WHERE polname IN ('trails_review_visible', 'content_trails_review_visible', 'trail_edges_review_visible') AND NOT polpermissive;
  IF n <> 3 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3977): expected 3 restrictive review policies, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_policy
   WHERE polname IN ('trails_review_visible', 'content_trails_review_visible', 'trail_edges_review_visible')
     AND NOT polpermissive AND polcmd = 'r' AND polroles = ARRAY[0::oid];
  IF n <> 3 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3977): the review policies must be SELECT-only and apply to every role (PUBLIC); % do', n; END IF;
  d := pg_get_functiondef('public.trail_propose(text,text,text,uuid,uuid)'::regprocedure);
  IF position('review_state' IN d) = 0 OR position('trail_propose:proposer:' IN d) = 0 OR position('trail_propose:token:' IN d) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3977): trail_propose lost the review state, the allowance or the token lock';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.trail_propose(text,text,text,uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3977): trail_propose must stay SECURITY INVOKER';
  END IF;
  d := pg_get_functiondef('public.rebuild_place_cooccurrence(timestamptz)'::regprocedure);
  IF (length(d) - length(replace(d, 'AND t.review_state = ''approved''', ''))) / length('AND t.review_state = ''approved''') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3977): rebuild_place_cooccurrence does not read approved Trails only';
  END IF;
  IF has_function_privilege('authenticated', 'public.trail_review_decide(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trail_review_decide(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3977): a client role may decide a review';
  END IF;
  IF authz.trail_review_visible(gen_random_uuid()) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3977): trail_review_visible answered TRUE for no Trail';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trail_creation_enabled' AND enabled = false) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3977): trail_creation_enabled is not seeded FALSE';
  END IF;
END
$post$;
