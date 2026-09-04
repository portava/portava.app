-- 2224_route_hop_signal.sql
-- The SECOND §10 Crowd Flow signal family: accepted route plans.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
-- ═════════════════════════════════════════════════════════════════════════════
-- Map spec §10 requires signals from at least MIN_SIGNAL_FAMILIES (2) independent
-- families before a crowd flow may publish. lib/crowdFlowProducer's audit found
-- exactly one fed family (`next_stop_contribution`) and recorded, per family, why
-- the others could not be fed. For `accepted_plan` it recorded FOUR blockers:
--
--   1. NOTHING IS EVER ACCEPTED. route_plans.status was written exactly once, as
--      'draft' (routes/routePlan.ts). No code path set 'active' or 'completed',
--      so the enum's accepted states were unreachable and a "leg" was only ever
--      OPTIMIZER OUTPUT — a machine-proposed ordering, not a traveller's
--      declaration.
--   2. NO LAWFUL BASIS. route_plans / route_stops / route_legs were claimed by no
--      purpose in lib/locationPurposes even though route_stops.structured_location
--      holds {label, lat, lng}.
--   3. NO CONSENT COVERING PUBLICATION. Trip route data is owner + trip-member
--      visible. Nothing authorised publishing any part of it into a PUBLIC
--      aggregate.
--   4. COORDINATES, NOT ZONES. structured_location is a point.
--
-- This migration closes (1) and (3) in the schema. (2) is closed in
-- lib/locationPurposes.ts (purpose `route_plan_itinerary`); (4) is closed in
-- lib/routeHopSignal.ts, which resolves every stop to a zone id and DROPS the
-- point before a signal exists — a hop whose endpoints cannot be resolved to
-- zones is discarded, never completed from the coordinate.
--
-- OWNER AUTHORISATION (2026-08-31). The owner explicitly granted the two
-- decisions a prior audit correctly refused to make alone: creating a consent
-- scope covering publication into a public aggregate, and declaring a
-- lawful-basis purpose entry. That grant does NOT weaken MIN_SIGNAL_FAMILIES,
-- PRIVACY_THRESHOLD_V1, maxGroupShare or the freshness gate — all four are
-- untouched here and in the producer.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT "ACCEPTED" MEANS, AND WHY THE COLUMNS ARE SHAPED THIS WAY
-- ═════════════════════════════════════════════════════════════════════════════
-- A generated plan and an accepted plan must be DISTINGUISHABLE IN THE DATA, not
-- by convention. Two columns record the acceptance act itself:
--
--   accepted_at          the instant the traveller accepted. This — not
--                        created_at — is the observation time of every hop the
--                        plan contributes, because it is when the declaration
--                        was made.
--   accepted_by_user_id  who performed that act.
--
-- ...and a CHECK makes "accepted state with no recorded acceptance"
-- UNREPRESENTABLE, the same move migration 2172 makes for consent evidence
-- (intel_consent_enabled_requires_evidence). A row cannot sit in 'active' or
-- 'completed' while claiming no accepter, so a producer reading status='active'
-- is reading a fact the database enforces rather than a convention the
-- application maintains.
--
-- ON DELETE CASCADE on accepted_by_user_id rather than SET NULL: SET NULL would
-- produce exactly the row the CHECK forbids. It is also moot in practice —
-- route_plans.owner_user_id already CASCADEs from auth.users and only the owner
-- may accept — but the constraint must be correct on its own terms.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE CONSENT SCOPE
-- ═════════════════════════════════════════════════════════════════════════════
-- route_flow_contribution_consent is modelled on intel_contribution_consent
-- (migration 2172, D4 ruling) deliberately and not merely for convenience: a
-- SEPARATE table is what keeps this a separate signal family. Reusing the intel
-- consent record would have meant one consent decision governing both families,
-- and MIN_SIGNAL_FAMILIES would then be counting prompts rather than independent
-- sources — the exact failure the prior audit named.
--
-- Default OFF. Explicit opt-in. Server-authoritative: owner may READ their own
-- row, only service_role writes, so a client cannot forge a consent version or
-- timestamp. lib/routeHopSignal.readAcceptedPlanHops refuses to emit a hop for
-- any actor without enabled = true AND withdrawn_at IS NULL, and a consent-read
-- FAILURE leaves the consented set empty — a failure can shrink a cohort, never
-- inflate one.
--
-- WORDING IS PROVISIONAL AND NEEDS PRIVACY-POLICY REVIEW. The COMMENT and the
-- description below state plainly what is collected, why, for how long and what
-- publication means. They are written as factual descriptions of the code's
-- behaviour, NOT as a legal conclusion; whoever owns privacy policy must review
-- the user-facing wording before this consent is offered to anyone.

BEGIN;

-- ── 1. The acceptance transition's evidence columns ──────────────────────────

ALTER TABLE public.route_plans
  ADD COLUMN IF NOT EXISTS accepted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_by_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.route_plans.accepted_at IS
  'When the traveller explicitly ACCEPTED this plan (POST /api/route-plans/:id/accept). NULL for a plan that was only generated. This is the observation instant for any §10 crowd-flow hop the plan contributes — the moment the declaration was made, not when the optimizer produced the ordering.';
COMMENT ON COLUMN public.route_plans.accepted_by_user_id IS
  'Who performed the acceptance. Only the plan owner may accept, so this equals owner_user_id today; it is stored explicitly because the acceptance is evidence of a traveller act, not an inference from ownership.';

-- A plan may not sit in an ACCEPTED state without the evidence of acceptance.
-- Preflight first: ADD CONSTRAINT would fail on a pre-existing violating row and
-- the operator deserves to know which shape of row blocked it.
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad
    FROM public.route_plans
   WHERE status IN ('active', 'completed')
     AND (accepted_at IS NULL OR accepted_by_user_id IS NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % route_plans row(s) are active/completed with no recorded acceptance. Backfill accepted_at/accepted_by_user_id, or move them back to draft, before adding the constraint.', bad;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE public.route_plans
    ADD CONSTRAINT route_plans_accepted_requires_evidence
      CHECK (
        status NOT IN ('active', 'completed')
        OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON CONSTRAINT route_plans_accepted_requires_evidence ON public.route_plans IS
  'An accepted state must carry the acceptance act that produced it. Makes "active with no accepter" unrepresentable, so a §10 producer reading status=''active'' reads a database-enforced fact rather than an application convention. Mirrors intel_consent_enabled_requires_evidence (2172).';

-- The producer reads accepted plans inside a freshness window; without this the
-- read is a sequential scan over every plan ever created.
CREATE INDEX IF NOT EXISTS route_plans_accepted_at_idx
  ON public.route_plans (accepted_at DESC)
  WHERE status = 'active' AND accepted_at IS NOT NULL;

-- ── 2. The consent scope ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.route_flow_contribution_consent (
  user_id         uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Current effective state. Default FALSE: OFF until an explicit opt-in.
  enabled         boolean NOT NULL DEFAULT false,
  -- The disclosure version the user agreed to (server-stamped). NULL until a
  -- first grant.
  consent_version text,
  consented_at    timestamptz,
  -- Recorded distinctly from consented_at so a withdrawal instant is audit
  -- evidence in its own right.
  withdrawn_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_flow_consent_enabled_requires_evidence
    CHECK (enabled = false OR (consent_version IS NOT NULL AND consented_at IS NOT NULL))
);

ALTER TABLE public.route_flow_contribution_consent ENABLE ROW LEVEL SECURITY;

-- DROP-then-CREATE so a replay cannot fail on "policy already exists".
DROP POLICY IF EXISTS route_flow_consent_select_own ON public.route_flow_contribution_consent;
CREATE POLICY route_flow_consent_select_own ON public.route_flow_contribution_consent
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS route_flow_consent_service_all ON public.route_flow_contribution_consent;
CREATE POLICY route_flow_consent_service_all ON public.route_flow_contribution_consent
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- REVOKE ALL from authenticated FIRST: ALTER DEFAULT PRIVILEGES in this database
-- grants new tables INSERT/UPDATE to authenticated, which would let a client
-- write its own consent row and forge the version/timestamps. Grant back ONLY
-- SELECT. (RLS also denies; the grant must not exist either.)
REVOKE ALL ON public.route_flow_contribution_consent FROM PUBLIC;
REVOKE ALL ON public.route_flow_contribution_consent FROM anon;
REVOKE ALL ON public.route_flow_contribution_consent FROM authenticated;
GRANT SELECT ON public.route_flow_contribution_consent TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.route_flow_contribution_consent TO service_role;

COMMENT ON TABLE public.route_flow_contribution_consent IS
  'Server-authoritative consent for contributing ACCEPTED route plans to the public §10 Crowd Flow aggregate. One row per user (profiles.id).
WHAT IS COLLECTED: nothing new. The consent covers a further use of route plans the traveller already created — specifically, for a plan they explicitly ACCEPTED, each leg is reduced to a pair of ZONE identifiers (neighbourhood/district level) plus the acceptance timestamp. No coordinate, no stop name, no plan id, no user id and no ordered sequence of stops leaves the producer.
WHY: to show aggregate movement between areas ("people are moving from A to B right now") so travellers can see where a city is heading. Portava cannot show that from one signal family alone; §10 requires two independent families before any flow publishes.
FOR HOW LONG: contribution is bounded by the crowd-flow freshness window (lib/crowdFlowProducer.SIGNAL_MAX_AGE_MINUTES, anchored to the experience.next_move TTL), so a plan stops contributing shortly after it is accepted. Nothing is stored: the aggregate is derived at read time and never written to a table. The route plan itself is retained under the route_plan_itinerary purpose, unchanged by this consent.
WHAT PUBLICATION MEANS: a zone-to-zone edge becomes publicly visible ONLY if it also clears the shared privacy gate (PRIVACY_THRESHOLD_V1: at least 15 distinct people, at least 5 independent parties, no single party over 20% of them, plus a publication delay). Below any of those it is discarded. One person''s accepted route can never be published, and no sequence of a person''s hops is ever assembled.
CONTROL: default false; explicit opt-in; withdrawal takes effect on the next read (there is no stored copy to purge). Owner reads own row; only service_role writes, so a client cannot forge a consent version or instant. Deleted with the profile.
WORDING PROVISIONAL: this text describes the code''s behaviour and is NOT a legal conclusion. The user-facing disclosure needs privacy-policy owner review before this consent is offered.';

COMMIT;

-- ── Postconditions (separate transaction: an assertion inside the transaction
--    it is verifying proves nothing about what persisted — see 2195). ─────────

DO $$
BEGIN
  IF to_regclass('public.route_flow_contribution_consent') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: route_flow_contribution_consent table missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'route_flow_contribution_consent' AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on route_flow_contribution_consent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'route_plans' AND column_name = 'accepted_at'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: route_plans.accepted_at missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'route_plans' AND column_name = 'accepted_by_user_id'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: route_plans.accepted_by_user_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'route_plans_accepted_requires_evidence'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: route_plans_accepted_requires_evidence constraint missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND table_name = 'route_flow_contribution_consent'
       AND grantee IN ('anon', 'authenticated')
       AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role can write route_flow_contribution_consent';
  END IF;
END $$;

-- REVERSAL:
--   DROP TABLE IF EXISTS public.route_flow_contribution_consent;
--   ALTER TABLE public.route_plans DROP CONSTRAINT IF EXISTS route_plans_accepted_requires_evidence;
--   DROP INDEX IF EXISTS public.route_plans_accepted_at_idx;
--   ALTER TABLE public.route_plans DROP COLUMN IF EXISTS accepted_by_user_id;
--   ALTER TABLE public.route_plans DROP COLUMN IF EXISTS accepted_at;
-- Dropping the consent table while lib/routeHopSignal still reads it makes every
-- consent lookup fail — which fails CLOSED (empty consented set, zero hops), so
-- the reversal is safe in that order. Reverse the producer in the same change.
