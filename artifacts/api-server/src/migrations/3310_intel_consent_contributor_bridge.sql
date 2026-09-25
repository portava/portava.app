-- 3310_intel_consent_contributor_bridge.sql
-- Sensing / World Intelligence — the consent bridge for the rotating contributor
-- token, and the actor's own token set.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Numbered well above
-- 3002 and 3110 so it can never be applied before the migration it depends on
-- and never collide with a branch holding 300x/311x.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════
-- 3002 replaced the ACCOUNT ID stored in intel_observations / intel_evidence /
-- intel_confirmations.actor_id with a rotating contributor token, assigned by a
-- BEFORE INSERT trigger, derived as sha256(pepper_for_epoch || actor_id). The
-- pepper lives in public.intel_contributor_pepper, which has RLS on, zero
-- policies and ZERO GRANTS — service_role included. That is deliberate and is
-- the whole privacy property: nothing outside the database can map a stored
-- contributor token back to an account.
--
-- Four readers were left joining that column to an account:
--
--   lib/intelProjectionAggregator.ts   .in("user_id", actorIds) on
--                                      intel_contribution_consent
--   lib/crowdFlowProducer.ts           the same join, for next_stop_contribution
--   lib/intelEvidenceCapture.ts        obs.actor_id !== actorId ownership check
--   services/media/MediaContributorReputationService.ts
--                                      .eq("actor_id", scope.contributorId)
--
-- Post-3002 every one of those matches NOTHING, and the FIRST one is not a
-- degradation — it is a fabrication. Its consent read returns ZERO ROWS rather
-- than an error, and `evidenceComplete = false` is set only on an ERROR, so the
-- aggregator would conclude "nobody in this cohort consented" and publish the
-- resulting suppression AS A FACT. An empty world that was never observed is
-- exactly the failure the Sensing rulings forbid ("Preserve null / unknown when
-- canonical fact is unavailable", §1).
--
-- The bridge can only live INSIDE the database, because the pepper is
-- unreadable outside it. So this migration adds two SECURITY DEFINER functions
-- and nothing else: no table, no column, no policy, no grant on any table.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. WHAT THE CONSENT BRIDGE MAY AND MAY NOT SAY
-- ═══════════════════════════════════════════════════════════════════════════
-- `intel_consented_contributor_tokens(uuid[]) RETURNS uuid[]` answers exactly
-- one question: OF THE CONTRIBUTOR IDS YOU ALREADY HOLD, WHICH ARE CURRENTLY
-- CONSENTED. It returns a SUBSET OF ITS OWN INPUT and nothing else:
--
--   * it never returns an account id the caller did not already supply;
--   * its return type is uuid[], not a row type, so there is no column an
--     account id could ride out on (the postcondition asserts the type);
--   * it never logs, and it RAISEs no message containing a token or a user id;
--   * a caller holding a token learns "consented / not consented", which is a
--     property of the CONTRIBUTION it already has, never WHOSE it is.
--
-- The privacy direction that matters is token -> account, and this function
-- computes account -> token internally and discards the account. There is no
-- argument shape, and no return shape, that inverts it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. A TOKEN IS EPOCH-SCOPED, SO ONE ACCOUNT HAS SEVERAL LIVE TOKENS
-- ═══════════════════════════════════════════════════════════════════════════
-- 3002 mints one pepper per 7-DAY EPOCH and the digest carries the epoch, so a
-- contributor who has been active for a month holds four distinct tokens, all
-- of them live in the store at once, and a claim's cohort routinely mixes
-- tokens from more than one epoch (observation TTLs are hours, but the 180-day
-- retention sweep is what bounds the table).
--
-- So the bridge cannot ask "what is this contributor's token"; it must consider
-- EVERY epoch the pepper table still holds. It does, by CROSS JOINing the
-- consented population against intel_contributor_pepper. There is no index that
-- could help — a token is a one-way digest — so the cost is
-- (consented accounts x live epochs) sha256 calls per call, which is why the
-- input is CAPPED and why the callers de-duplicate before calling. Epochs are
-- bounded by retention: 180 days is ~26 peppers, and 3002's header records that
-- a spent pepper may be deleted once the sweep has passed over the rows it
-- keys, which bounds this loop as well as the residual link.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. IT ANSWERS FOR BOTH SCHEMAS, ON PURPOSE
-- ═══════════════════════════════════════════════════════════════════════════
-- Arm (a) of the UNION matches the supplied value against
-- intel_contribution_consent.user_id DIRECTLY. Before 3002 is applied the stored
-- actor_id IS the account id, and that arm is the whole answer; after 3002 no
-- stored actor_id resolves to a profiles row (3002's postcondition (d) asserts
-- precisely that), so the arm is dead for contribution rows and costs one index
-- probe.
--
-- Arm (a) DISCLOSES NOTHING NEW. service_role already holds SELECT on
-- intel_contribution_consent (2333), so "is this account id consented" is a
-- question it can already ask directly, with the same answer, in one statement.
-- The bridge is not the weakest link for that question and does not become one.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. THE SECOND FUNCTION, AND WHY IT IS NOT AN INVERSION
-- ═══════════════════════════════════════════════════════════════════════════
-- Two of the four call sites do not ask about consent at all. They ask "which
-- stored actor_id values are MINE" — the evidence-ownership gate (the caller
-- has just authenticated as that account) and the contributor's own reputation
-- read (the caller was handed the contributor id by the route).
--
-- `intel_contributor_tokens_for_actor(uuid) RETURNS uuid[]` answers that, and
-- it runs in the SAFE DIRECTION: account -> tokens. You must already hold the
-- account id to learn anything, and holding it is what the call site's
-- authorization already established. 3002 already granted service_role EXECUTE
-- on intel_contributor_token(uuid, timestamptz), which is the same derivation
-- for the CURRENT epoch; this is that function's read-only, all-epochs sibling.
--
-- It is STABLE and it MINTS NOTHING. intel_contributor_token is VOLATILE
-- because it creates the epoch's pepper on first use; a READ path must never
-- do that, because minting a pepper from a read would create an epoch row for
-- an epoch in which nobody contributed, and 3002's erasure and retention
-- reasoning is written against peppers that key real rows.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DOES NOT DO
-- ═══════════════════════════════════════════════════════════════════════════
-- It does not touch intel_contributor_pepper's grants (still none), does not
-- add a token -> account index or table, does not relax any RLS policy, and
-- does not make any application role able to read a pepper. It adds two
-- functions and two grants to service_role. Nothing else changes.
--
-- RUNTIME EFFECT: none until 3002 is applied. Until then the TypeScript callers
-- probe for these functions, find them absent, ALSO find 3002's marker function
-- absent, and take the pre-3002 branch (the direct account-column read, which
-- is correct there). A database that has 3002 but NOT this migration is the one
-- state in which the callers WITHHOLD — see lib/intelConsent.ts.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_contribution_consent') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_contribution_consent does not exist. Apply 2172 first.';
  END IF;
  -- 3002 is the whole reason this file exists. Applying this one first would
  -- create a bridge over a store that has no tokens in it, and — worse — the
  -- callers read the presence of these functions as "the store is tokenised and
  -- the bridge is available", so a premature apply would make them trust an
  -- answer computed from an empty pepper table.
  IF to_regclass('public.intel_contributor_pepper') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_contributor_pepper does not exist. Apply 3002_intel_contribution_identity.sql first — this migration is its consent bridge and is meaningless without it.';
  END IF;
  IF to_regprocedure('public.intel_contributor_token_for_pepper(uuid, integer, text)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_contributor_token_for_pepper(uuid, integer, text) is missing (3002). The bridge cannot derive a token.';
  END IF;
  IF to_regprocedure('public.intel_contributor_token(uuid, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_contributor_token(uuid, timestamptz) is missing (3002). It is the marker the TypeScript callers probe to tell a pre-3002 store from a tokenised one; without it they cannot distinguish the two and would read an empty consent answer as a fact.';
  END IF;
  IF to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: role service_role does not exist — the grants below would not apply and the bridge would be unreachable.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The consent bridge
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.intel_consented_contributor_tokens(p_tokens uuid[])
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_in  uuid[];
  v_n   integer;
  v_out uuid[];
BEGIN
  IF p_tokens IS NULL THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  -- De-duplicate and drop nulls FIRST: the cross join below is quadratic in the
  -- input, and a cohort read hands this function one entry per observation.
  SELECT coalesce(array_agg(DISTINCT t), ARRAY[]::uuid[])
    INTO v_in
    FROM unnest(p_tokens) AS t
   WHERE t IS NOT NULL;

  v_n := coalesce(array_length(v_in, 1), 0);
  IF v_n = 0 THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  -- A CAP, NOT A TRUNCATION. Silently answering about the first N would hand the
  -- caller a partial consent set it could not tell from a complete one, which is
  -- the same fabrication this migration exists to remove. Raising makes the
  -- caller's read fail, and every caller treats a failed consent read as
  -- "withhold", never as "nobody consented".
  IF v_n > 5000 THEN
    RAISE EXCEPTION 'intel_consented_contributor_tokens: % distinct contributor ids in one call exceeds the cap of 5000; split the cohort', v_n;
  END IF;

  SELECT coalesce(array_agg(DISTINCT x.tok), ARRAY[]::uuid[])
    INTO v_out
    FROM (
      -- (a) PRE-3002 / out-of-scope shape: the supplied value IS an account id.
      --     Returns only values the caller supplied, and asks nothing
      --     service_role cannot already ask of this table directly (2333).
      SELECT c.user_id AS tok
        FROM public.intel_contribution_consent c
       WHERE c.enabled = true
         AND c.withdrawn_at IS NULL
         AND c.user_id = ANY (v_in)

      UNION

      -- (b) POST-3002 shape: the supplied value is an epoch-scoped contributor
      --     token. Every live epoch is considered, because one account holds one
      --     token PER EPOCH and a cohort mixes epochs. The account id exists only
      --     inside this scan; what leaves is the token the caller already had.
      SELECT d.tok
        FROM public.intel_contribution_consent c
        CROSS JOIN public.intel_contributor_pepper p
        CROSS JOIN LATERAL (
          SELECT public.intel_contributor_token_for_pepper(c.user_id, p.epoch, p.pepper) AS tok
        ) d
       WHERE c.enabled = true
         AND c.withdrawn_at IS NULL
         AND d.tok = ANY (v_in)
    ) x;

  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.intel_consented_contributor_tokens(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_consented_contributor_tokens(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.intel_consented_contributor_tokens(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_consented_contributor_tokens(uuid[]) TO service_role;

COMMENT ON FUNCTION public.intel_consented_contributor_tokens(uuid[]) IS
  'Consent bridge for the rotating contributor token (3310, over 3002). Given contributor ids the caller already holds — post-3002 tokens, or pre-3002 account ids — returns the SUBSET that currently has enabled, un-withdrawn intel_contribution_consent. Considers every live pepper epoch, because one account holds one token per epoch. Returns a subset of its own input and never an account id the caller did not supply; the account id exists only inside the scan. service_role only.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The actor's own contributor identities
-- ═══════════════════════════════════════════════════════════════════════════
-- The all-epochs, read-only sibling of 3002's intel_contributor_token. Safe
-- direction only: you must already hold the account id.
CREATE OR REPLACE FUNCTION public.intel_contributor_tokens_for_actor(p_actor_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_tokens uuid[];
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN ARRAY[]::uuid[];
  END IF;
  -- No mint. A read path that created an epoch pepper would key an epoch in
  -- which nobody contributed; see the header.
  SELECT coalesce(
           array_agg(public.intel_contributor_token_for_pepper(p_actor_id, p.epoch, p.pepper)),
           ARRAY[]::uuid[])
    INTO v_tokens
    FROM public.intel_contributor_pepper p;
  RETURN v_tokens;
END;
$fn$;

REVOKE ALL ON FUNCTION public.intel_contributor_tokens_for_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_contributor_tokens_for_actor(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.intel_contributor_tokens_for_actor(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_contributor_tokens_for_actor(uuid) TO service_role;

COMMENT ON FUNCTION public.intel_contributor_tokens_for_actor(uuid) IS
  'Every live-epoch contributor token for an account the caller ALREADY HOLDS (3310, over 3002). The read-only, all-epochs sibling of intel_contributor_token: STABLE, mints no pepper. Runs account -> token only; it cannot be used to resolve a token to an account. Used by the evidence-ownership gate and the contributor reputation read so they can recognise their own rows post-3002. service_role only.';

-- ── Postcondition ───────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_rettype     text;
  v_secdef      boolean;
  v_volatility  "char";
  v_probe       uuid;
  v_answer      uuid[];
  v_user        uuid;
  v_epoch       integer;
  v_pepper      text;
  v_token       uuid;
  v_peppers     bigint;
BEGIN
  -- (a) Both functions exist, with the exact signatures the callers name.
  IF to_regprocedure('public.intel_consented_contributor_tokens(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.intel_consented_contributor_tokens(uuid[]) was not created — the consent join has no bridge and the aggregator would read an empty answer as a fact.';
  END IF;
  IF to_regprocedure('public.intel_contributor_tokens_for_actor(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: public.intel_contributor_tokens_for_actor(uuid) was not created — the evidence-ownership gate and the reputation read cannot recognise their own rows.';
  END IF;

  -- (b) THE PRIVACY SHAPE. A row type could carry a user_id column out; uuid[]
  --     cannot. Assert the return type rather than trusting the body above.
  SELECT pg_catalog.format_type(pr.prorettype, NULL), pr.prosecdef, pr.provolatile
    INTO v_rettype, v_secdef, v_volatility
    FROM pg_proc pr WHERE pr.oid = 'public.intel_consented_contributor_tokens(uuid[])'::regprocedure;
  IF v_rettype <> 'uuid[]' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_consented_contributor_tokens returns % — it must return uuid[], a bare subset of its input, so no account id can ride out in a column.', v_rettype;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_consented_contributor_tokens is not SECURITY DEFINER — it cannot read the pepper, so it would answer "nobody consented" to every caller.';
  END IF;
  IF v_volatility = 'v' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_consented_contributor_tokens is VOLATILE — a read path must not be able to mint an epoch pepper.';
  END IF;

  SELECT pg_catalog.format_type(pr.prorettype, NULL), pr.prosecdef, pr.provolatile
    INTO v_rettype, v_secdef, v_volatility
    FROM pg_proc pr WHERE pr.oid = 'public.intel_contributor_tokens_for_actor(uuid)'::regprocedure;
  IF v_rettype <> 'uuid[]' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_contributor_tokens_for_actor returns % — expected uuid[].', v_rettype;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_contributor_tokens_for_actor is not SECURITY DEFINER — it cannot read the pepper.';
  END IF;
  IF v_volatility = 'v' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_contributor_tokens_for_actor is VOLATILE — it must not mint an epoch pepper from a read path.';
  END IF;

  -- (c) THE GRANT BOUNDARY. anon/authenticated must not be able to ask either
  --     question over PostgREST; service_role must, or the bridge is unreachable
  --     and every caller withholds forever.
  IF has_function_privilege('anon', 'public.intel_consented_contributor_tokens(uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.intel_consented_contributor_tokens(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.intel_contributor_tokens_for_actor(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.intel_contributor_tokens_for_actor(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon or authenticated holds EXECUTE on a contributor bridge function — either would be an internet-reachable oracle over contribution identity.';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.intel_consented_contributor_tokens(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.intel_contributor_tokens_for_actor(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lacks EXECUTE on a contributor bridge function — the four call sites would withhold permanently.';
  END IF;

  -- (d) THE PEPPER IS STILL UNREADABLE. This migration must not have widened it.
  IF has_table_privilege('service_role', 'public.intel_contributor_pepper', 'SELECT')
     OR has_table_privilege('authenticated', 'public.intel_contributor_pepper', 'SELECT')
     OR has_table_privilege('anon', 'public.intel_contributor_pepper', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: an application role can SELECT intel_contributor_pepper. The bridge exists BECAUSE nothing outside the database may read it; a grant here would make every stored token reversible.';
  END IF;

  -- (e) IT DOES NOT ECHO ITS INPUT. A value that is neither a consented account
  --     nor a derivable token must come back absent — otherwise the function
  --     would answer "consented" for everything and the filter would be a no-op.
  v_probe := pg_catalog.gen_random_uuid();
  v_answer := public.intel_consented_contributor_tokens(ARRAY[v_probe]);
  IF coalesce(array_length(v_answer, 1), 0) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_consented_contributor_tokens echoed an unknown id back as consented — the consent filter would admit every contributor.';
  END IF;
  IF coalesce(array_length(public.intel_consented_contributor_tokens(ARRAY[]::uuid[]), 1), 0) <> 0
     OR coalesce(array_length(public.intel_consented_contributor_tokens(NULL::uuid[]), 1), 0) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_consented_contributor_tokens answered non-empty for an empty/NULL input.';
  END IF;

  -- (f) IT ACTUALLY BRIDGES. Both arms are exercised against real rows whenever
  --     the database has any; a store with no consent rows (production today)
  --     cannot exercise them and says so rather than pretending it did.
  SELECT c.user_id INTO v_user
    FROM public.intel_contribution_consent c
   WHERE c.enabled = true AND c.withdrawn_at IS NULL
   LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE '3310: no enabled, un-withdrawn consent row exists, so arms (a) and (b) could not be exercised against data. The shape assertions above still hold.';
  ELSE
    -- arm (a), the pre-3002 / account-id shape
    IF NOT (v_user = ANY (public.intel_consented_contributor_tokens(ARRAY[v_user]))) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: a consented account id was not returned by the bridge — the pre-3002 arm is broken and every pre-3002 cohort would be suppressed.';
    END IF;

    -- arm (b), the post-3002 / token shape
    SELECT p.epoch, p.pepper INTO v_epoch, v_pepper
      FROM public.intel_contributor_pepper p ORDER BY p.epoch DESC LIMIT 1;
    IF v_epoch IS NULL THEN
      RAISE NOTICE '3310: intel_contributor_pepper holds no epoch yet, so arm (b) could not be exercised against data.';
    ELSE
      v_token := public.intel_contributor_token_for_pepper(v_user, v_epoch, v_pepper);
      IF NOT (v_token = ANY (public.intel_consented_contributor_tokens(ARRAY[v_token]))) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: a token derived from a CONSENTED account was not returned by the bridge — the post-3002 arm is broken, and the aggregator would publish "nobody consented" over a consenting cohort.';
      END IF;
      -- and the account it came from must NOT appear in that answer
      IF v_user = ANY (public.intel_consented_contributor_tokens(ARRAY[v_token])) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: the bridge returned the ACCOUNT ID behind a token. It must return a subset of its input and nothing else.';
      END IF;
    END IF;
  END IF;

  -- (g) The actor-token function returns one token per live epoch, and none at
  --     all for a NULL actor.
  SELECT count(*) INTO v_peppers FROM public.intel_contributor_pepper;
  v_probe := pg_catalog.gen_random_uuid();
  IF coalesce(array_length(public.intel_contributor_tokens_for_actor(v_probe), 1), 0) <> v_peppers THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_contributor_tokens_for_actor returned a number of tokens that does not match the % live epoch(s) — a missed epoch silently drops that week''s contributions from an ownership or reputation read.', v_peppers;
  END IF;
  IF coalesce(array_length(public.intel_contributor_tokens_for_actor(NULL::uuid), 1), 0) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_contributor_tokens_for_actor(NULL) returned tokens.';
  END IF;
END $post$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- db/rollback/2026-09-25-3310-intel-consent-contributor-bridge-rollback.sql.
-- It is COMPLETE — this migration creates no table, writes no row and changes
-- no existing object — but reversing it on a database that HAS 3002 makes the
-- four call sites withhold, which is the designed degradation, not an outage to
-- be worked around by re-pointing them at the account column.
