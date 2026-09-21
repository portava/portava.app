-- 2774_trip_proposal_governance.sql
--
-- Implements the resolution recorded in docs/architecture/blocker-ledger.md
-- under PROPOSAL_DECISION_RULE, and supersedes 2768's interim host gating.
--
-- THE INCONSISTENCY THIS RESOLVES
-- ===============================
-- The spec describes TripProposal twice and the two do not agree.
--   §5.1 (storage): id, trip_id, proposal_type, payload_json, status,
--                   expires_at, affected_version
--   §9.3 (domain):  type, proposedBy, affectedObjects[], rationale,
--                   impactSummary, decisionRule: HOST | MAJORITY | UNANIMOUS |
--                   ANYONE, status, expiresAt
-- 2763 implemented §5.1 exactly, so the table is right about §5.1 and missing
-- five of §9.3's fields — decisionRule among them, and decisionRule is the one
-- that is not descriptive. It decides who may accept.
--
-- The split is by whether a field must be ENFORCEABLE or merely READABLE:
--   decision_rule  COLUMN. A governance rule inside payload_json cannot be
--                  relied on by the code enforcing it: an unconstrained jsonb
--                  key can hold any string, including one no branch handles,
--                  and the safest behaviour for an unknown rule is not
--                  something a ->> can express. CHECK'd to §9.3's four.
--   proposed_by    COLUMN. MAJORITY and UNANIMOUS are computed over the crew,
--                  and a proposal whose author is unknown cannot be excluded
--                  from, or counted in, its own vote. Also §9.3's attribution.
--   affectedObjects / rationale / impactSummary
--                  payload_json, under documented keys. Nothing enforces them,
--                  they vary by proposal type, and a column each would freeze a
--                  shape §9.3 does not fix.
--
-- §9.3 also implies a VOTE — MAJORITY and UNANIMOUS are not computable without
-- one — and §1's capability list already names "proposals, votes". Hence
-- trip_proposal_votes.
--
-- WHAT COUNTS AS THE ELECTORATE
-- =============================
-- The accepted crew, by exactly the rule authz.accepted_trip_ids applies:
-- role IN (owner, co_host, member, viewer) with an accepted status, plus the
-- owner where no membership row exists. NOT "everyone with a row" — an invited
-- person has not joined and cannot be counted as abstaining from a decision
-- they have not been told about.
--
-- The PROPOSER'S OWN VOTE IS NOT ASSUMED. Creating a proposal is not voting for
-- it; §9.3 gives proposing and deciding different verbs, and a UNANIMOUS rule
-- that silently counted the author would pass on one real vote out of two.
--
-- DEFAULT decision_rule IS 'host', NOT 'anyone'
-- =============================================
-- Existing rows get 'host' and new rows default to it. That preserves 2768's
-- behaviour exactly for every proposal already written and for every caller
-- that does not name a rule — a migration that widened who may decide, silently
-- and retroactively, would be legitimising decisions the narrower rule refused.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2774 (Trips).

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  IF to_regclass('public.trip_proposals') IS NULL THEN
    RAISE EXCEPTION '2774: requires 2763 (trip_proposals)';
  END IF;
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid='public.trip_proposals'::regclass
     AND attname IN ('decision_rule','proposed_by') AND NOT attisdropped;
  IF n <> 0 THEN RAISE EXCEPTION '2774: % of the 2 columns already exist; this migration has run', n; END IF;
  IF to_regclass('public.trip_proposal_votes') IS NOT NULL THEN
    RAISE EXCEPTION '2774: trip_proposal_votes already exists';
  END IF;
END
$pre$;

ALTER TABLE public.trip_proposals
  ADD COLUMN decision_rule text NOT NULL DEFAULT 'host',
  ADD COLUMN proposed_by   uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.trip_proposals
  ADD CONSTRAINT trip_proposals_decision_rule_known
    CHECK (decision_rule IN ('host','majority','unanimous','anyone'));

COMMENT ON COLUMN public.trip_proposals.decision_rule IS
  'Trips spec §9.3 decisionRule, lowercased: host | majority | unanimous | anyone. A COLUMN and not a payload_json key because the code that enforces a governance rule cannot rely on an unconstrained jsonb value — see migration 2774. Defaults to ''host'', the narrowest of the four, so no existing proposal has its decision widened retroactively.';
COMMENT ON COLUMN public.trip_proposals.proposed_by IS
  'Trips spec §9.3 proposedBy. ON DELETE SET NULL: a deleted account must not take the proposal with it, and a proposal with an unknown author is still a decision that was made. Required for majority and unanimous, which are computed over the crew and must be able to tell the author apart from the electorate — creating a proposal is NOT voting for it.';

CREATE TABLE public.trip_proposal_votes (
  proposal_id uuid        NOT NULL REFERENCES public.trip_proposals(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES public.profiles(id)       ON DELETE CASCADE,
  vote        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, user_id),
  CONSTRAINT trip_proposal_votes_vote_known CHECK (vote IN ('yes','no','abstain'))
);

COMMENT ON TABLE public.trip_proposal_votes IS
  'Trips spec §9.3 / §1 ("proposals, votes"). One vote per crew member per proposal. ON DELETE CASCADE on the proposal because a vote is a statement ABOUT a proposal and means nothing without one — the same reading trip_plan_participants (2771) applies to attendance. Written only by public.trip_kernel_execute; RLS: crew SELECT only, no client grants.';
COMMENT ON COLUMN public.trip_proposal_votes.vote IS
  'yes | no | abstain. ABSTAIN IS NOT ABSENCE: it is a recorded decision not to decide, and it counts toward a unanimous rule being SATISFIED but not toward it being MET — see the kernel''s tally in migration 2775. A crew member who has not voted at all has a different meaning and no row.';

CREATE INDEX idx_trip_proposal_votes_user ON public.trip_proposal_votes (user_id);

ALTER TABLE public.trip_proposal_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY trip_proposal_votes_crew_select ON public.trip_proposal_votes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trip_proposals p
                  WHERE p.id = trip_proposal_votes.proposal_id
                    AND authz.is_trip_crew(p.trip_id)));

REVOKE ALL ON public.trip_proposal_votes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_proposal_votes TO authenticated;

-- ── The electorate, and the tally. One definition, called by the kernel. ─────
CREATE OR REPLACE FUNCTION public.trip_proposal_electorate(p_trip_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  -- Exactly authz.accepted_trip_ids' rule, in the other direction: who is
  -- accepted crew OF this trip. An invited person is not counted — they have
  -- not joined and cannot be treated as abstaining from a decision nobody has
  -- told them about.
  SELECT m.user_id
    FROM public.trip_members m
   WHERE m.trip_id = p_trip_id
     AND m.role IN ('owner', 'co_host', 'member', 'viewer')
     AND coalesce(m.status, 'accepted') = 'accepted'
  UNION
  SELECT t.owner_id
    FROM public.trips t
   WHERE t.id = p_trip_id
     AND NOT EXISTS (SELECT 1 FROM public.trip_members m2
                      WHERE m2.trip_id = t.id AND m2.user_id = t.owner_id);
$fn$;

COMMENT ON FUNCTION public.trip_proposal_electorate(uuid) IS
  'Trips spec §9.3: who may vote on a proposal. The same rule authz.accepted_trip_ids applies, read the other way round. SECURITY DEFINER so the membership read bypasses RLS and cannot recurse into policies that call it. Deliberately EXCLUDES role ''invited'': someone who has not joined cannot be counted as abstaining from a decision they were never told about.';

CREATE OR REPLACE FUNCTION public.trip_proposal_tally(p_proposal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  p       public.trip_proposals%ROWTYPE;
  n_elect int;
  n_yes   int;
  n_no    int;
  n_abs   int;
BEGIN
  SELECT * INTO p FROM public.trip_proposals WHERE id = p_proposal_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;

  SELECT count(*) INTO n_elect FROM public.trip_proposal_electorate(p.trip_id);

  -- Only votes from CURRENT crew are counted. Someone who voted and then left
  -- has not withdrawn their opinion, but they are no longer part of the group
  -- the rule is about, and counting them would let a departed member decide.
  SELECT
    count(*) FILTER (WHERE v.vote = 'yes'),
    count(*) FILTER (WHERE v.vote = 'no'),
    count(*) FILTER (WHERE v.vote = 'abstain')
    INTO n_yes, n_no, n_abs
    FROM public.trip_proposal_votes v
   WHERE v.proposal_id = p_proposal_id
     AND v.user_id IN (SELECT public.trip_proposal_electorate(p.trip_id));

  RETURN jsonb_build_object(
    'found', true,
    'decision_rule', p.decision_rule,
    'electorate', n_elect,
    'yes', n_yes, 'no', n_no, 'abstain', n_abs,
    'cast', n_yes + n_no + n_abs,
    -- MAJORITY: strictly more than half the ELECTORATE said yes. Not "half of
    -- those who voted" — that lets two people carry a crew of nine.
    'majority_met', n_yes * 2 > n_elect,
    -- UNANIMOUS: everybody voted, and nobody said no. An abstention is a
    -- recorded decision not to block, so it does not defeat unanimity; a
    -- SILENCE does, because nobody knows what it means.
    'unanimous_met', n_elect > 0 AND (n_yes + n_abs) = n_elect AND n_no = 0 AND n_yes > 0);
END
$fn$;

COMMENT ON FUNCTION public.trip_proposal_tally(uuid) IS
  'Trips spec §9.3: the vote counts and whether each rule is met. MAJORITY is strictly more than half the ELECTORATE, not of those who happened to vote — otherwise two people carry a crew of nine. UNANIMOUS requires every elector to have voted with none against and at least one yes; an ABSTENTION does not defeat it (it is a recorded decision not to block) but a SILENCE does, because nobody knows what a silence means. Votes from people who have since left the trip are excluded.';

REVOKE ALL ON FUNCTION public.trip_proposal_electorate(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_proposal_tally(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_proposal_electorate(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.trip_proposal_tally(uuid) TO service_role;

DO $post$
DECLARE n int; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['decision_rule','proposed_by'] LOOP
    SELECT count(*) INTO n FROM pg_attribute
     WHERE attrelid='public.trip_proposals'::regclass AND attname=t AND NOT attisdropped;
    IF n <> 1 THEN RAISE EXCEPTION '2774: column % absent after add', t; END IF;
  END LOOP;

  -- §9.3's four rules, each by name.
  FOREACH t IN ARRAY ARRAY['host','majority','unanimous','anyone'] LOOP
    SELECT count(*) INTO n FROM pg_constraint
     WHERE conrelid='public.trip_proposals'::regclass AND conname='trip_proposals_decision_rule_known'
       AND position('''' || t || '''' in pg_get_constraintdef(oid)) > 0;
    IF n <> 1 THEN RAISE EXCEPTION '2774: §9.3 decision rule % is not accepted', t; END IF;
  END LOOP;

  -- Every existing proposal keeps 2768's behaviour.
  SELECT count(*) INTO n FROM public.trip_proposals WHERE decision_rule <> 'host';
  IF n <> 0 THEN RAISE EXCEPTION '2774: % existing proposal(s) were given a rule other than host', n; END IF;

  IF to_regclass('public.trip_proposal_votes') IS NULL THEN
    RAISE EXCEPTION '2774: trip_proposal_votes absent after create';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='trip_proposal_votes' AND cmd <> 'SELECT';
  IF n <> 0 THEN RAISE EXCEPTION '2774: a non-SELECT policy exists on trip_proposal_votes'; END IF;
  IF has_table_privilege('authenticated','public.trip_proposal_votes','INSERT')
     OR has_table_privilege('authenticated','public.trip_proposal_votes','UPDATE')
     OR has_table_privilege('authenticated','public.trip_proposal_votes','DELETE') THEN
    RAISE EXCEPTION '2774: authenticated holds a write privilege on trip_proposal_votes';
  END IF;

  -- The tally must not be reachable by a client: it is an oracle over who
  -- voted which way.
  IF has_function_privilege('authenticated', 'public.trip_proposal_tally(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trip_proposal_tally(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '2774: a client role can EXECUTE trip_proposal_tally';
  END IF;

  -- And the arithmetic, on a proposal that does not exist.
  IF (public.trip_proposal_tally('00000000-0000-0000-0000-000000000000')->>'found')::boolean THEN
    RAISE EXCEPTION '2774: the tally claims to have found a proposal that does not exist';
  END IF;
END
$post$;

COMMIT;
