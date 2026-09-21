-- 2900_intel_reward_ledger_reversals.sql
-- Make a compensating entry EXPRESSIBLE on the non-cash reward ledger.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHY THIS IS A NEW FILE AND NOT AN EDIT TO 2170 ───────────────────────────
-- `10` §7 forbids editing an applied migration, and 2170 is applied. A
-- constraint change is therefore a NEW migration that SUPERSEDES, and the
-- supersession has to be argued rather than asserted. The argument is below.
--
-- ── THE PROPERTY THAT IS VIOLATED ───────────────────────────────────────────
-- `09` §11 (specs/discovery-v1/09_Payment_Architecture.md): "Payment architecture
-- is ready BEFORE PAYOUTS when ... reversals are possible."
--
-- public.intel_reward_ledger cannot express one. Two facts combine:
--
--   1. 2170:55-56 grants service_role INSERT + SELECT only. There is no UPDATE
--      grant, so a booked row is immutable. (2204 later added DELETE, solely so
--      account deletion can erase a departed contributor's rows; it is not a
--      correction path and must not become one.)
--   2. 2170:38-39 carry CHECK (qiu >= 0) and CHECK (earned_units >= 0).
--
-- Immutable rows plus non-negativity leaves NO REPRESENTATION OF AN OPPOSITE.
-- A credit booked in error stands for ever. 2180:6-12 names exactly this defect
-- -- an at-least-once caller booking the same earning twice on an append-only
-- ledger "with no way to reverse it" -- and closes only the duplicate half.
--
-- It is not hypothetical. lib/intelRewardScheduler.ts books a credit when a
-- contributor's observation reaches the SERVED live state and then never
-- reconsiders it (the alreadyRewarded anti-join). With
-- intel_outcome_attribution_enabled ON, a traveller can afterwards report an
-- outcome that CONTRADICTS that served state -- services/intel/RewardOracle.ts
-- classifyAttribution returns 'contradicted'. The credit cannot be taken back,
-- because the table cannot say so.
--
-- ── WHY THE SUPERSESSION IS CORRECT, NOT A RELAXATION ───────────────────────
-- The replacement constraint is STRICTLY STRONGER than the pair it replaces in
-- every case the original covered, and weaker in none:
--
--     CHECK ( (reverses_entry_id IS NULL     AND qiu >= 0 AND earned_units >= 0)
--          OR (reverses_entry_id IS NOT NULL AND qiu <= 0 AND earned_units <= 0) )
--
--   * An ORIGINAL entry (reverses_entry_id IS NULL) is still non-negative --
--     identical to 2170's rule. Nothing that 2170 refused becomes possible for
--     an ordinary earning.
--   * A negative row is admissible ONLY if it NAMES the entry it reverses. A
--     bare negative credit -- the thing 2170's CHECK was defending against --
--     is still refused, and now for a better reason: an unexplained debit has
--     no cause, and `09` §5.3 I7 requires that absence never be silent.
--   * The FK on reverses_entry_id means the named entry must exist.
--   * The partial UNIQUE index means an entry can be reversed AT MOST ONCE.
--     Reversing twice re-credits an earning that existed once.
--   * A reversal is an INSERT. NOTHING BECOMES MUTABLE. The grants are not
--     touched: service_role still has no UPDATE.
--
-- CHECK (cash_amount = 0) at 2170:40 -- the financial-control boundary, and the
-- reason `07` §10's "earnings can be recorded WITHOUT PAYING" is already
-- satisfied here -- is DELIBERATELY UNTOUCHED, and a postcondition below proves
-- it is still in force after this file runs. Reversing a non-cash credit is
-- non-cash. Nothing in this migration moves money; `09` §1's "Portava moves no
-- money" is unchanged.
--
-- This is the same principle 2277:36-40 already states for derived attribution
-- data -- "a re-computation is a new row under a new algorithm_version, never a
-- rewrite" -- and `09` §9.2's definition of a reversal: "Always a new
-- transaction whose entries are the negation of the original ... Never a DELETE."
--
-- ── EXISTING ROWS ────────────────────────────────────────────────────────────
-- PRESERVED EXACTLY. No row is read, rewritten, backfilled or re-interpreted.
-- Every existing row has reverses_entry_id NULL (the column is added NULL with
-- no default) and already satisfies qiu >= 0 AND earned_units >= 0, because
-- 2170's CHECKs held while they were written. The new constraint is therefore
-- satisfied by the whole existing table by construction -- and it is added
-- WITHOUT NOT VALID so Postgres proves that rather than taking our word for it.
-- A pre-flight count below fails the migration loudly if any row would not pass.
--
-- ── APPEND-ONLY, STRENGTHENED ───────────────────────────────────────────────
-- 2170 made the table append-only BY GRANT ALONE; there is no trigger (2204:23-27
-- says so in as many words). Now that a correction path exists, "corrections are
-- new rows" needs to be enforced and not merely unavailable: a BEFORE UPDATE
-- row-level trigger is attached (`09` §5.3 I2).
--
-- DELETE IS NOT TRIGGER-GUARDED, DELIBERATELY. 2204 grants DELETE precisely so
-- AccountDeletionService's `delete_intel_reward_ledger` step can erase a departed
-- contributor's rows with a plain client DELETE, which declares no erasure
-- transaction. Blocking DELETE here would silently reinstate the GDPR hole 2204
-- was written to close.
--
-- NO STATEMENT-LEVEL TRIGGER, also deliberately -- `09` §5.3 I3 and
-- 2292_intel_stmt_trigger_removal_ig_campaign.sql:20-32: a statement-level
-- append-only trigger fires before any row is examined, so it refuses an erasure
-- CASCADE whether or not there is anything to protect, making users undeletable.
--
-- RUNTIME EFFECT: NONE. No reader or writer changes behaviour because of this
-- file alone. The reversal writer (services/ledger/RewardReversal.ts) is gated on
-- the intel_rewards flag, which 2170 seeded OFF and this file does not touch.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_reward_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_reward_ledger does not exist (2170 not applied).';
  END IF;
END $$;

-- ── Pre-flight: prove the existing rows already satisfy the new rule ─────────
DO $$
DECLARE offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM public.intel_reward_ledger
   WHERE qiu < 0 OR earned_units < 0;
  IF offending <> 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: % existing intel_reward_ledger row(s) are already negative; the supersession assumes every existing row is an ORIGINAL entry.', offending;
  END IF;
END $$;

-- ── 1. The link column ──────────────────────────────────────────────────────
ALTER TABLE public.intel_reward_ledger
  ADD COLUMN IF NOT EXISTS reverses_entry_id uuid NULL
    REFERENCES public.intel_reward_ledger(id);

COMMENT ON COLUMN public.intel_reward_ledger.reverses_entry_id IS
  'The entry this row compensates. NULL on an original earning. A row that names an entry is the ONLY row permitted to carry a negative qiu/earned_units, and an entry may be named at most once (intel_reward_ledger_one_reversal_per_entry).';

-- ── 2. Supersede 2170:38-39 ─────────────────────────────────────────────────
ALTER TABLE public.intel_reward_ledger
  DROP CONSTRAINT IF EXISTS intel_reward_ledger_qiu_check;
ALTER TABLE public.intel_reward_ledger
  DROP CONSTRAINT IF EXISTS intel_reward_ledger_earned_units_check;

ALTER TABLE public.intel_reward_ledger
  DROP CONSTRAINT IF EXISTS intel_reward_ledger_sign_by_role;
ALTER TABLE public.intel_reward_ledger
  ADD CONSTRAINT intel_reward_ledger_sign_by_role CHECK (
       (reverses_entry_id IS NULL     AND qiu >= 0 AND earned_units >= 0)
    OR (reverses_entry_id IS NOT NULL AND qiu <= 0 AND earned_units <= 0)
  );

-- A row may not reverse itself: that is a fixed point, not a correction.
ALTER TABLE public.intel_reward_ledger
  DROP CONSTRAINT IF EXISTS intel_reward_ledger_no_self_reversal;
ALTER TABLE public.intel_reward_ledger
  ADD CONSTRAINT intel_reward_ledger_no_self_reversal CHECK (reverses_entry_id IS DISTINCT FROM id);

-- ── 3. At most one reversal per entry ───────────────────────────────────────
-- PARTIAL, so the NULL on every original entry is exempt. 2180:17-19 records
-- that PostgREST conflict-target inference does NOT match a partial index --
-- the writer catches the 23505 in code instead (RewardReversal.ts).
CREATE UNIQUE INDEX IF NOT EXISTS intel_reward_ledger_one_reversal_per_entry
  ON public.intel_reward_ledger (reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

-- ── 4. Corrections are new rows: block UPDATE at the row level ──────────────
DROP TRIGGER IF EXISTS intel_reward_ledger_no_update ON public.intel_reward_ledger;
CREATE TRIGGER intel_reward_ledger_no_update
  BEFORE UPDATE ON public.intel_reward_ledger
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();

-- ── 5. Grants unchanged, restated so the diff shows they were considered ────
-- INSERT + SELECT (2170:56) and DELETE (2204, erasure only). NO UPDATE.
REVOKE UPDATE ON public.intel_reward_ledger FROM service_role;
REVOKE ALL ON public.intel_reward_ledger FROM PUBLIC;
REVOKE ALL ON public.intel_reward_ledger FROM anon;
REVOKE ALL ON public.intel_reward_ledger FROM authenticated;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  -- The financial-control boundary survived untouched.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.intel_reward_ledger'::regclass
     AND conname = 'intel_reward_ledger_cash_amount_check';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: CHECK (cash_amount = 0) is gone. This migration must never relax the non-cash boundary.';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.intel_reward_ledger'::regclass
     AND conname = 'intel_reward_ledger_sign_by_role';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sign-by-role constraint not installed';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.intel_reward_ledger'::regclass
     AND conname IN ('intel_reward_ledger_qiu_check', 'intel_reward_ledger_earned_units_check');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the superseded CHECKs are still present; two rules now disagree';
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'intel_reward_ledger'
     AND column_name = 'reverses_entry_id';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: reverses_entry_id column absent';
  END IF;

  SELECT count(*) INTO n FROM pg_class
   WHERE relname = 'intel_reward_ledger_one_reversal_per_entry' AND relkind = 'i';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: one-reversal-per-entry index absent; an entry could be reversed twice';
  END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.intel_reward_ledger'::regclass AND tgname = 'intel_reward_ledger_no_update';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: UPDATE is not blocked at the row level';
  END IF;

  IF has_table_privilege('service_role', 'public.intel_reward_ledger', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role gained UPDATE on the reward ledger. Corrections are new rows.';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.intel_reward_ledger', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lost INSERT; no entry could be booked';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.intel_reward_ledger', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lost DELETE; account deletion could not erase reward rows (2204)';
  END IF;
END $$;

COMMIT;

-- REVERSAL (exact, and safe only under the stated condition):
--
--   -- 1. Only reversible while NO compensating entry has been written. Check:
--   --      SELECT count(*) FROM public.intel_reward_ledger WHERE reverses_entry_id IS NOT NULL;
--   --    A non-zero count means reversing this migration would DESTROY booked
--   --    corrections and restore balances that the product has already
--   --    disowned. Do not proceed; supersede forwards instead.
--   DROP TRIGGER IF EXISTS intel_reward_ledger_no_update ON public.intel_reward_ledger;
--   DROP INDEX IF EXISTS public.intel_reward_ledger_one_reversal_per_entry;
--   ALTER TABLE public.intel_reward_ledger DROP CONSTRAINT IF EXISTS intel_reward_ledger_no_self_reversal;
--   ALTER TABLE public.intel_reward_ledger DROP CONSTRAINT IF EXISTS intel_reward_ledger_sign_by_role;
--   ALTER TABLE public.intel_reward_ledger ADD CONSTRAINT intel_reward_ledger_qiu_check CHECK (qiu >= 0);
--   ALTER TABLE public.intel_reward_ledger ADD CONSTRAINT intel_reward_ledger_earned_units_check CHECK (earned_units >= 0);
--   ALTER TABLE public.intel_reward_ledger DROP COLUMN IF EXISTS reverses_entry_id;
--
-- No existing row is touched by either direction.
