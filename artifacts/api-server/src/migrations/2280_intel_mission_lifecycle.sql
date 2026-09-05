-- 2280_intel_mission_lifecycle.sql
-- IG §16/§22 — complete the mission lifecycle on intel_mission_candidates (2167).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Additive,
-- forward-only, idempotent. Enables nothing: intel_missions stays OFF (2167/2181);
-- this only widens the state machine so an ACCEPTED, non-cash mission can be
-- carried to completion.
--
-- WHAT THIS ADDS (spec §16 mission generation, §22 moderation/integrity):
--   • statuses 'completed' and 'declined' (the terminal states 2167 lacked).
--   • NEGATIVE-RESULT ACCEPTANCE (AT-12/AT-13, §16 "Negative results are fully
--     valid"): a completed mission carries a `result` in {positive,negative,
--     inconclusive}; a 'negative' result is a VALID completion, not a failure —
--     the CHECK requires a result on completion but never forbids 'negative'.
--   • DECLINE WITHOUT PENALTY (§16/§22 "Contributors may decline or abort unsafe
--     work without conduct penalty"): a 'declined' terminal state with an optional
--     reason. There is deliberately NO penalty/conduct column — the ABSENCE of any
--     penalty mechanism IS the guarantee; declining touches nothing but status.
--   • EVIDENCE CONTRACT REQUIRED SHAPE (§16 "explicit … acceptance contract"): a
--     mission may not be ACCEPTED or COMPLETED unless its evidence_contract
--     declares `required_evidence` — the contract a contributor is held to.
--
-- NOT ADDED HERE: the presence/mission NONCE (Table 13 P4, §22 mission fraud) —
-- owned by unit I3. This migration and CoverageService only READ it IF EXISTS.
-- Cash stays impossible: 2167's CHECK cash_amount = 0 is untouched.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_mission_candidates') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_mission_candidates does not exist (migration 2167).';
  END IF;
END $$;

-- ── 1. Widen the status CHECK to the terminal states ──────────────────────────
-- 2167's inline column CHECK is named intel_mission_candidates_status_check by
-- Postgres convention. Drop-if-exists then add the widened set — idempotent.
ALTER TABLE public.intel_mission_candidates
  DROP CONSTRAINT IF EXISTS intel_mission_candidates_status_check;
ALTER TABLE public.intel_mission_candidates
  ADD CONSTRAINT intel_mission_candidates_status_check
  CHECK (status IN ('candidate','dispatched','accepted','completed','declined','expired','aborted'));

-- ── 2. Lifecycle columns ──────────────────────────────────────────────────────
ALTER TABLE public.intel_mission_candidates
  ADD COLUMN IF NOT EXISTS completed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at    timestamptz,
  ADD COLUMN IF NOT EXISTS decline_reason text,
  -- Negative-result acceptance: the OUTCOME of a completed mission. 'negative' is
  -- a fully valid completion (AT-13), never a rejected one.
  ADD COLUMN IF NOT EXISTS result         text;

-- result vocabulary (idempotent add).
ALTER TABLE public.intel_mission_candidates
  DROP CONSTRAINT IF EXISTS intel_mission_candidates_result_check;
ALTER TABLE public.intel_mission_candidates
  ADD CONSTRAINT intel_mission_candidates_result_check
  CHECK (result IS NULL OR result IN ('positive','negative','inconclusive'));

-- A completed mission MUST carry a result (so a completion is always adjudicated),
-- and negative is explicitly allowed — that is the negative-result-acceptance rule.
ALTER TABLE public.intel_mission_candidates
  DROP CONSTRAINT IF EXISTS intel_mission_candidates_completion_result;
ALTER TABLE public.intel_mission_candidates
  ADD CONSTRAINT intel_mission_candidates_completion_result
  CHECK (status <> 'completed' OR result IS NOT NULL);

-- ── 3. Evidence contract required shape ───────────────────────────────────────
-- A mission may not be ACCEPTED or COMPLETED unless the evidence_contract declares
-- what evidence satisfies it. Enforced only at/after acceptance so a bare
-- candidate/dispatched row (before the contract is finalised) is unaffected.
ALTER TABLE public.intel_mission_candidates
  DROP CONSTRAINT IF EXISTS intel_mission_candidates_evidence_contract_shape;
ALTER TABLE public.intel_mission_candidates
  ADD CONSTRAINT intel_mission_candidates_evidence_contract_shape
  CHECK (
    status NOT IN ('accepted','completed')
    OR (evidence_contract ? 'required_evidence')
  );

COMMENT ON COLUMN public.intel_mission_candidates.result IS
  'IG §16: outcome of a completed mission — positive | negative | inconclusive. A negative result is a VALID completion (AT-13), never a rejection.';
COMMENT ON COLUMN public.intel_mission_candidates.decline_reason IS
  'IG §22: optional reason a contributor declined. Declining carries NO conduct penalty — there is deliberately no penalty column.';

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='intel_mission_candidates' AND column_name='result'
  ) INTO ok;
  IF NOT ok THEN RAISE EXCEPTION 'POSTCONDITION FAILED: result column missing'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='intel_mission_candidates' AND column_name='declined_at'
  ) INTO ok;
  IF NOT ok THEN RAISE EXCEPTION 'POSTCONDITION FAILED: declined_at column missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_mission_candidates_evidence_contract_shape') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: evidence_contract shape constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'intel_mission_candidates_completion_result') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: completion_result constraint missing';
  END IF;
  -- 'completed' status must be insertable under the new CHECK: verify by definition.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname = 'intel_mission_candidates_status_check') NOT LIKE '%completed%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: status CHECK does not allow completed';
  END IF;
END $$;

COMMIT;

-- REVERSAL (best-effort; the widened enum values become unusable once written):
--   ALTER TABLE public.intel_mission_candidates
--     DROP CONSTRAINT IF EXISTS intel_mission_candidates_evidence_contract_shape,
--     DROP CONSTRAINT IF EXISTS intel_mission_candidates_completion_result,
--     DROP CONSTRAINT IF EXISTS intel_mission_candidates_result_check;
--   ALTER TABLE public.intel_mission_candidates
--     DROP COLUMN IF EXISTS result, DROP COLUMN IF EXISTS decline_reason,
--     DROP COLUMN IF EXISTS declined_at, DROP COLUMN IF EXISTS completed_at;
--   ALTER TABLE public.intel_mission_candidates DROP CONSTRAINT IF EXISTS intel_mission_candidates_status_check;
--   ALTER TABLE public.intel_mission_candidates ADD CONSTRAINT intel_mission_candidates_status_check
--     CHECK (status IN ('candidate','dispatched','accepted','expired','aborted'));
