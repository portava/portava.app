-- 2170_intel_reward_ledger.sql
-- Rewards internal — the non-cash earned-credits ledger + the intel_rewards flag.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- Spec §23 ("Contributor payouts require explicit funding source, ledger version
-- and commercial-use permission") + §30 ("Stamps/credits; no cash"). The reward
-- system is operational INTERNALLY: eligibility (lib/rewardEligibility) and the
-- QIU→credits conversion (lib/rewardEarnings) run, and services/intel/RewardService.ts
-- records earned NON-CASH credits here behind the intel_rewards flag.
--
-- FINANCIAL-CONTROL BOUNDARY (retained regardless of enablement): the CHECK
-- cash_amount = 0 makes it impossible to book platform-funded cash against a
-- contributor through this ledger. A money transfer is a SEPARATE switch behind
-- payments/KYC/tax/fraud infrastructure that does not exist.
--
-- APPEND-ONLY by grant: service_role gets INSERT + SELECT only (no UPDATE/DELETE),
-- so a booked ledger entry is immutable. No client grant — this is not user-facing
-- data. RLS deny-default. The flag intel_rewards is seeded OFF; its reader ships
-- in the same change.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.intel_reward_ledger (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id                  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source                    text NOT NULL,
  qiu                       numeric NOT NULL DEFAULT 0 CHECK (qiu >= 0),
  earned_units              integer NOT NULL DEFAULT 0 CHECK (earned_units >= 0),
  cash_amount               numeric NOT NULL DEFAULT 0 CHECK (cash_amount = 0), -- never platform cash
  ledger_version            text NOT NULL,
  commercial_use_permission boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intel_reward_ledger_actor_created_idx
  ON public.intel_reward_ledger (actor_id, created_at DESC);

-- ── RLS + grants (2130 shape: deny-default; service_role INSERT+SELECT only) ───
ALTER TABLE public.intel_reward_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_reward_ledger FROM PUBLIC;
REVOKE ALL ON public.intel_reward_ledger FROM anon;
REVOKE ALL ON public.intel_reward_ledger FROM authenticated;
REVOKE ALL ON public.intel_reward_ledger FROM service_role;
-- INSERT + SELECT only: a booked entry is append-only (no UPDATE/DELETE grant).
GRANT INSERT, SELECT ON public.intel_reward_ledger TO service_role;

-- ── Flag ──────────────────────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_rewards',
    false,
    'Runs internal reward recording (services/intel/RewardService.ts): books earned NON-CASH credits to intel_reward_ledger for eligible, finalized outcomes. Off = record nothing. Cash transfer is a separate, unbuilt switch; cash_amount = 0 is enforced by the table.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE has_table int; has_flag int;
BEGIN
  SELECT count(*) INTO has_table FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'intel_reward_ledger';
  IF has_table <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_reward_ledger not created';
  END IF;
  SELECT count(*) INTO has_flag FROM public.feature_flags WHERE flag = 'intel_rewards';
  IF has_flag <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_rewards flag not present after seed';
  END IF;
END $$;

COMMIT;

-- REVERSAL: UPDATE public.feature_flags SET enabled = false WHERE flag = 'intel_rewards';
--           (and, only if abandoning the unit, DROP TABLE public.intel_reward_ledger.)
