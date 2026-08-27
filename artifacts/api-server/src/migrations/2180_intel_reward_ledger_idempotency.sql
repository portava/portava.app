-- 2180_intel_reward_ledger_idempotency.sql
-- Idempotency key for the non-cash reward ledger (fixes double-credit on retry).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- RewardService.recordEarnedReward appended a ledger row per call with no
-- idempotency key, so an at-least-once caller (a retried job, a redelivered
-- message) would book the SAME earning twice — a real over-credit on an
-- append-only ledger (no UPDATE/DELETE grant to reverse it). This adds an
-- optional idempotency_key and a PARTIAL unique index over (actor_id,
-- idempotency_key): a second insert for the same (actor, key) raises 23505, and
-- the service returns the original entry instead of a duplicate.
--
-- The index is PARTIAL (WHERE idempotency_key IS NOT NULL) so keyless callers
-- are entirely unaffected — every keyless insert still appends. The service
-- omits the column when no key is supplied, so a NULL key is never even written.
-- (Because it is partial, the read path detects duplicates via the 23505 error,
-- NOT via PostgREST on_conflict inference — inference does not match a partial
-- index, the same trap that broke intel_state_snapshots in 2176.)

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_reward_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_reward_ledger does not exist.';
  END IF;
END $$;

ALTER TABLE public.intel_reward_ledger
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- One earning per (actor, key). Partial: NULL keys (keyless callers) are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS intel_reward_ledger_actor_idem_key_uidx
  ON public.intel_reward_ledger (actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE has_col int; has_idx int;
BEGIN
  SELECT count(*) INTO has_col FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'intel_reward_ledger'
      AND column_name = 'idempotency_key';
  IF has_col <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: idempotency_key column missing';
  END IF;
  SELECT count(*) INTO has_idx FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'intel_reward_ledger_actor_idem_key_uidx';
  IF has_idx <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: partial unique index missing';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP INDEX IF EXISTS public.intel_reward_ledger_actor_idem_key_uidx;
--   ALTER TABLE public.intel_reward_ledger DROP COLUMN IF EXISTS idempotency_key;
