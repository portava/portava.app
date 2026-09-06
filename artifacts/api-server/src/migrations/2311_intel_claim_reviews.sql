-- 2311_intel_claim_reviews.sql
-- The review record: who moved a claim's lifecycle, when, and why.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2311.
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS + CREATE POLICY guarded by
-- DROP POLICY IF EXISTS. No existing table is altered, no row is written, no
-- flag is flipped, no reader changes shape. Re-running the file is a no-op.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THIS TABLE EXISTS
-- ══════════════════════════════════════════════════════════════════════════════
-- `intel_claims` already owns the lifecycle — candidate | active | conflicting |
-- superseded | expired | retracted | rejected — and that vocabulary is reused
-- verbatim; this migration adds NO second status enum. What the claim row cannot
-- say is WHO moved it and WHY.
--
-- The nearest existing provenance is `intel_claims.promotion_source` (migration
-- 2174), and it is deliberately coarse: it records 'system' vs 'admin', not
-- WHICH admin. For an ordinary claim about how busy a bar is, that is proportionate.
-- For a claim asserting that people are in physical danger it is not: a safety
-- assertion has to be explainable after the fact from evidence plus the identity
-- and reasoning of the principal who approved it. "An admin did it" is not an
-- audit trail.
--
-- RAW EVIDENCE STAYS APPEND-ONLY. This is a separate record, not a mutation of
-- the observation. intel_observations remains what somebody reported;
-- intel_claims remains the current belief; this table is the history of
-- authorized decisions taken over that belief. Collapsing the three would make
-- it impossible to distinguish what was seen from what was decided.
--
-- NOT admin_access_log. That table (2035) records ACCESS — view, export, expand
-- — over profile/event/trip/gps_event/check_in. A lifecycle transition is a
-- different act with different columns, and widening two of its CHECK
-- constraints to carry it would blur an access log into a decision log.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PRIVACY POSTURE
-- ══════════════════════════════════════════════════════════════════════════════
-- This is RESTRICTED moderation data. It carries a reviewer identity and free
-- text, neither of which may ever reach a Map consumer — the public projection
-- gets the minimum approved derivative and nothing else. So the table is
-- service_role only, with no anon or authenticated policy at all, matching the
-- posture protected_zones (2217) uses for the same reason. RLS is enabled with
-- no permissive policy, which denies by default rather than by omission.

CREATE TABLE IF NOT EXISTS public.intel_claim_reviews (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id      uuid        NOT NULL REFERENCES public.intel_claims(id) ON DELETE CASCADE,
  reviewer_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The decision taken. Deliberately NOT the claim's status vocabulary: an
  -- action is what a person did, a status is where the claim ended up, and the
  -- mapping between them is policy that belongs in code, not in a CHECK.
  action        text        NOT NULL,

  -- Where the claim was and where it went, captured at decision time so the
  -- trail survives later transitions.
  prior_status  text        NOT NULL,
  new_status    text        NOT NULL,

  -- Why. Free text, restricted, never projected.
  reason        text,

  -- Which policy authorized it, so an activation can be re-explained later even
  -- if the policy changes. Written by the service from its own contract.
  policy_ref    text,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_claim_reviews_action_check
    CHECK (action IN ('approve','reject','retract','reconfirm','supersede')),

  -- Both ends of the transition must be real lifecycle values. This is the same
  -- vocabulary as intel_claims_status_check, restated because a review row can
  -- outlive the claim's current status and must remain independently readable.
  CONSTRAINT intel_claim_reviews_prior_status_check
    CHECK (prior_status IN ('candidate','active','conflicting','superseded','expired','retracted','rejected')),
  CONSTRAINT intel_claim_reviews_new_status_check
    CHECK (new_status IN ('candidate','active','conflicting','superseded','expired','retracted','rejected')),

  -- A review that changes nothing is not a review. Reconfirm is the one honest
  -- exception: it re-attests a claim already active without moving it.
  CONSTRAINT intel_claim_reviews_transition_check
    CHECK (action = 'reconfirm' OR prior_status <> new_status)
);

CREATE INDEX IF NOT EXISTS intel_claim_reviews_claim_idx
  ON public.intel_claim_reviews (claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intel_claim_reviews_reviewer_idx
  ON public.intel_claim_reviews (reviewer_id, created_at DESC);

COMMENT ON TABLE public.intel_claim_reviews IS
  'Restricted audit of authorized lifecycle decisions over intel_claims: who, when, why, and under which policy. Reviewer identity and reason are moderation data and must NEVER reach a public projection — service_role only, no anon/authenticated policy. Raw evidence stays append-only in intel_observations; current belief stays in intel_claims; this is the decision history over that belief.';

-- ── RLS: restricted moderation data, service_role only ────────────────────────

ALTER TABLE public.intel_claim_reviews ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.intel_claim_reviews FROM PUBLIC;
REVOKE ALL ON public.intel_claim_reviews FROM anon;
REVOKE ALL ON public.intel_claim_reviews FROM authenticated;
GRANT SELECT, INSERT ON public.intel_claim_reviews TO service_role;

DROP POLICY IF EXISTS intel_claim_reviews_service ON public.intel_claim_reviews;
CREATE POLICY intel_claim_reviews_service ON public.intel_claim_reviews
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- No anon or authenticated policy is created, deliberately. RLS is on and the
-- table has no permissive policy for those roles, so they are denied by the
-- default rather than by an omission someone could later "fix" by adding one.

-- ══════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_policies int;
  v_rls      boolean;
BEGIN
  IF to_regclass('public.intel_claim_reviews') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.intel_claim_reviews is absent.';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.intel_claim_reviews'::regclass;
  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on intel_claim_reviews — reviewer identity and moderation reasons would be readable.';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'intel_claim_reviews'
    AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles));
  IF v_policies > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_claim_reviews has % anon/authenticated policy(ies). This table carries reviewer identity and free-text moderation reasons; it is service_role only.', v_policies;
  END IF;
END $$;
