-- 2901_rent_buddy_earnings_entries.sql
-- Give the Rent-a-Buddy earnings figure an APPEND-ONLY source, so no balance
-- depends on a mutable total.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── THE PROPERTY THAT IS VIOLATED ───────────────────────────────────────────
-- `09` §11 (specs/discovery-v1/09_Payment_Architecture.md): "Payment
-- architecture is ready BEFORE PAYOUTS when ... no balance depends on mutable
-- totals."
--
-- public.rent_buddy_earnings_ledger is ONE MUTABLE SUMMARY ROW PER BOOKING --
-- UNIQUE (booking_id), written by a single upsert on that conflict target
-- (lib/rentBuddyEarningsLedger.ts). The repository's own account of the
-- consequence is not softened anywhere:
--
--     "It records money as collected that was never collected."
--     (docs/architecture/09_Payment_Architecture.md, section 1.3.1)
--
-- in_app_amount_collected was written as the booking's deposit_usd, while
-- pay-deposit and pay-full return 503 and no money exists; for
-- payment_mode = 'full_in_app' deposit_usd IS the whole total, so a booking
-- recorded its entire value as collected the moment it was made. A summary row
-- also cannot express a correction, cannot express a recomputation under a new
-- fee schedule, and cannot be audited, because the value it held a moment ago
-- is gone.
--
-- ── WHY THIS MIGRATION IS ADDITIVE, AND NOT A RESHAPE ───────────────────────
-- rent_buddy_earnings_ledger HAS LIVE ROWS IN PRODUCTION and
-- GET /rent-a-buddy/me/earnings/ledger reads it
-- (routes/rentABuddyMarketplace.ts). Reshaping it into an entry table would
-- either destroy those rows' meaning or break that read, and a migration that
-- cannot preserve every existing row's meaning is not the right migration.
--
-- So NOTHING about rent_buddy_earnings_ledger changes here: not a column, not a
-- constraint, not a grant, not a policy, not a row. It keeps exactly the meaning
-- it has always had -- an ESTIMATE, is_estimated = true -- and stops being the
-- SOURCE of any balance. This file adds the source beside it. From now on every
-- money figure on that summary row is DERIVED by folding the entries below, so
-- the row is a projection of an append-only truth rather than a total somebody
-- maintains.
--
-- ── SHAPE, AND WHERE EACH DECISION COMES FROM ───────────────────────────────
--   * amount_minor bigint + currency char(3), always as a pair. `09` §3 refusal
--     1: "No amount is ever stored as a float, and no amount is stored without
--     its currency." The existing *_usd numeric columns encode the currency in
--     the column NAME, which cannot be joined, checked or migrated.
--   * DOUBLE ENTRY. Every entry names a transaction_key, and a transaction's
--     entries sum to zero per currency (`09` §5.3 I1). That is what makes
--     section 1.3.1 structurally impossible: a collection recorded with no
--     counterpart fails the invariant, so the fictitious figure has nowhere to
--     go. The zero-sum check is enforced by the writer and by the property test;
--     it is NOT a DEFERRABLE constraint trigger here, because this table has no
--     transactional writer yet (the booking is already committed when
--     createEarningsLedgerEntry runs, and PostgREST gives it no transaction to
--     defer to). Stated rather than implied: I1 is enforced in code today.
--   * cash_settled_minor NOT NULL DEFAULT 0 CHECK (cash_settled_minor = 0).
--     The financial-control boundary, copied deliberately from 2170:40's
--     CHECK (cash_amount = 0). `07` §10's "earnings can be recorded WITHOUT
--     PAYING" is not a promise in a comment: it is impossible to record a
--     settlement in this table. `09` §1: "Portava moves no money."
--   * entry_reason has NO value that asserts money arrived, left or settled.
--   * provider text NOT NULL DEFAULT 'none' + external_ref text NULL, with NO
--     CHECK pinning the value. `09` §11's "provider can be swapped later" means
--     no derived quantity may depend on processor identity -- so the pair is
--     recorded and never read by any balance, and naming a processor later is a
--     value change, not a schema change. 'none' is the honest current value:
--     `09` §1.1, no payment processor is installed.
--   * rule_version NOT NULL. `07` §8 "No payout formula hard-coding" -- store
--     the rule version, not the outcome of a hard-coded percentage.
--   * attribution_kind / attribution_id / beneficiary_user_id NOT nullable where
--     they are meaningful. `09` §5.3 I7: absence is not permitted to be silent.
--     Attribution resolves through the CAUSING ENTITY (booking -> buddy profile
--     -> user_id), never through the ranker's creatorId, which is on an owner
--     HOLD (`09` §6, constraint 3).
--   * reverses_entry_id + a partial unique index: a correction is a NEW,
--     OPPOSITE entry, at most one per entry, never an edit (`09` §9.2).
--   * idempotency_key UNIQUE. `09` §7.2: "Uniqueness is a database index, not an
--     application check." NON-partial, so PostgREST conflict-target inference
--     DOES match it -- the writer can use ON CONFLICT DO NOTHING. (2180:17-19
--     records that inference does not match a PARTIAL index; that is why the
--     reward ledger's key handling differs, and why this one is total.)
--
-- ── APPEND-ONLY ─────────────────────────────────────────────────────────────
-- service_role gets INSERT + SELECT only, the 2170:55-56 shape, plus a
-- BEFORE UPDATE row-level trigger so "corrections are new rows" is enforced and
-- not merely unavailable (`09` §5.3 I2). DELETE is granted and NOT
-- trigger-guarded, for one reason only: booking_id cascades, so a deleted
-- booking must be able to take its entries with it, exactly as
-- rent_buddy_earnings_ledger's own ON DELETE CASCADE does.
--
-- NO FOR EACH STATEMENT TRIGGER, deliberately -- `09` §5.3 I3 and
-- 2292_intel_stmt_trigger_removal_ig_campaign.sql:20-32: a statement-level
-- append-only trigger fires before any row is examined, so it refuses an erasure
-- CASCADE whether or not there is anything to protect, making users undeletable.
--
-- ── PROFILE FKs MIRROR THE SIBLING TABLE EXACTLY ────────────────────────────
-- ON DELETE SET NULL, as rent_buddy_earnings_ledger's buddy_user_id/traveler_id
-- already are. Account deletion keeps an ANONYMISED TOMBSTONE profile rather
-- than deleting the profiles row (services/accountDeletion/AccountDeletionService.ts),
-- and financial records are deliberately retained. Choosing a different action
-- here would quietly change a deletion contract this lane does not own.
--
-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Deny-default, REVOKE-first (Supabase default-grants ALL to service_role). NO
-- CLIENT GRANT AT ALL -- stricter than rent_buddy_earnings_ledger, which carries
-- a buddy-visible SELECT policy. `09` §10: money data is restricted, and the
-- restriction is structural. A buddy's earnings view keeps reading the summary
-- row it already reads; nothing needs the raw entries.
--
-- RUNTIME EFFECT: additive only. No existing reader or writer changes behaviour
-- because of this file. rent_buddy_enabled is seeded FALSE
-- (2210_rent_buddy_default_off.sql) and booking creation is hard-blocked by
-- lib/rentBuddyKycGate.ts, so no row can be written in production today.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.rent_buddy_bookings') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.rent_buddy_bookings does not exist.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.rent_buddy_earnings_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The transaction this entry belongs to. Entries sharing a key sum to zero
  -- per currency; a single-sided booking is not expressible as a transaction.
  transaction_key     text NOT NULL,

  booking_id          uuid NOT NULL REFERENCES public.rent_buddy_bookings(id) ON DELETE CASCADE,

  account             text NOT NULL,
  entry_reason        text NOT NULL,

  -- Signed minor units. Never zero: an entry worth nothing states nothing.
  amount_minor        bigint NOT NULL CHECK (amount_minor <> 0),
  currency            char(3) NOT NULL DEFAULT 'USD',

  -- The financial-control boundary, 2170:40's shape. Recording a settlement is
  -- structurally impossible, in either direction.
  cash_settled_minor  bigint NOT NULL DEFAULT 0 CHECK (cash_settled_minor = 0),

  rule_version        text NOT NULL,

  attribution_kind    text NOT NULL,
  attribution_id      uuid NOT NULL,
  beneficiary_user_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- A correction is a new, opposite entry that NAMES the one it negates.
  reverses_entry_id   uuid NULL REFERENCES public.rent_buddy_earnings_entries(id),

  -- Processor identity. Recorded, never read by any derived quantity.
  provider            text NOT NULL DEFAULT 'none',
  external_ref        text NULL,

  idempotency_key     text NOT NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rbee_account_check CHECK (
    account IN ('buddy_payable', 'platform_revenue', 'traveler_receivable', 'cash_external')),
  -- NOTHING here asserts money arrived, left or settled. That is the point.
  CONSTRAINT rbee_entry_reason_check CHECK (
    entry_reason IN ('booking_gross', 'tip', 'platform_fee', 'traveler_service_fee', 'reversal')),
  CONSTRAINT rbee_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT rbee_attribution_kind_check CHECK (attribution_kind IN ('booking')),
  CONSTRAINT rbee_rule_version_check CHECK (length(rule_version) BETWEEN 1 AND 200),
  CONSTRAINT rbee_idempotency_key_check CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  CONSTRAINT rbee_no_self_reversal CHECK (reverses_entry_id IS DISTINCT FROM id),
  -- Only a row that NAMES the entry it reverses may carry entry_reason
  -- 'reversal', and a reversal must name one. An unexplained opposite entry is
  -- indistinguishable from a bookkeeping error.
  CONSTRAINT rbee_reversal_is_linked CHECK (
    (entry_reason = 'reversal') = (reverses_entry_id IS NOT NULL))
);

-- `09` §7.2 — uniqueness is a database index. TOTAL, not partial, so PostgREST
-- conflict-target inference matches it and the writer's ON CONFLICT DO NOTHING
-- is a genuine no-op replay rather than an overwrite.
CREATE UNIQUE INDEX IF NOT EXISTS rbee_idempotency_key_once
  ON public.rent_buddy_earnings_entries (idempotency_key);

-- At most one reversal per entry: reversing twice re-credits an earning that
-- existed once.
CREATE UNIQUE INDEX IF NOT EXISTS rbee_one_reversal_per_entry
  ON public.rent_buddy_earnings_entries (reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS rbee_booking_idx
  ON public.rent_buddy_earnings_entries (booking_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS rbee_beneficiary_idx
  ON public.rent_buddy_earnings_entries (beneficiary_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS rbee_transaction_idx
  ON public.rent_buddy_earnings_entries (transaction_key);

-- ── Corrections are new rows ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS rbee_no_update ON public.rent_buddy_earnings_entries;
CREATE TRIGGER rbee_no_update
  BEFORE UPDATE ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();

-- ── RLS + grants: deny-default, no client grant at all ──────────────────────
ALTER TABLE public.rent_buddy_earnings_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rent_buddy_earnings_entries FROM PUBLIC;
REVOKE ALL ON public.rent_buddy_earnings_entries FROM anon;
REVOKE ALL ON public.rent_buddy_earnings_entries FROM authenticated;
REVOKE ALL ON public.rent_buddy_earnings_entries FROM service_role;
-- INSERT + SELECT: append-only. DELETE only so the booking cascade can fire.
GRANT INSERT, SELECT, DELETE ON public.rent_buddy_earnings_entries TO service_role;

COMMENT ON TABLE public.rent_buddy_earnings_entries IS
  'Append-only, signed, minor-unit double-entry source for Rent-a-Buddy earnings. The balance is SUM(amount_minor) over these rows; rent_buddy_earnings_ledger is a projection of them and no longer a source. Records no settlement: cash_settled_minor = 0 is CHECK-enforced (2170:40 shape). Corrections are new rows naming reverses_entry_id. No client grant.';

COMMENT ON COLUMN public.rent_buddy_earnings_entries.provider IS
  'Processor identity, ''none'' until one is chosen (09 §1.1). Recorded and never read by any derived quantity — that is what "provider can be swapped later" (09 §11) reduces to.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'rent_buddy_earnings_entries';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: rent_buddy_earnings_entries not created'; END IF;

  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'rent_buddy_earnings_entries' AND NOT c.relrowsecurity;
  IF n > 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is disabled on rent_buddy_earnings_entries'; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass
     AND pg_get_constraintdef(oid) LIKE '%cash_settled_minor = 0%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the no-settlement boundary (cash_settled_minor = 0) is absent';
  END IF;

  SELECT count(*) INTO n FROM pg_class WHERE relname = 'rbee_idempotency_key_once' AND relkind = 'i';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: idempotency index absent; a replay could double-book'; END IF;

  SELECT count(*) INTO n FROM pg_class WHERE relname = 'rbee_one_reversal_per_entry' AND relkind = 'i';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: one-reversal-per-entry index absent'; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.rent_buddy_earnings_entries'::regclass AND tgname = 'rbee_no_update';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: UPDATE is not blocked at the row level'; END IF;

  IF has_table_privilege('service_role', 'public.rent_buddy_earnings_entries', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role has UPDATE. Corrections are new rows.';
  END IF;
  IF has_table_privilege('authenticated', 'public.rent_buddy_earnings_entries', 'SELECT')
     OR has_table_privilege('anon', 'public.rent_buddy_earnings_entries', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role can read the money entries (09 §10)';
  END IF;

  -- The sibling summary table must be EXACTLY as this migration found it.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_ledger'::regclass
     AND conname = 'rent_buddy_earnings_ledger_booking_id_key';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: rent_buddy_earnings_ledger was modified. This migration is additive and must touch nothing there.';
  END IF;
END $$;

COMMIT;

-- REVERSAL (exact, and lossless in the only sense that matters):
--
--   DROP TRIGGER IF EXISTS rbee_no_update ON public.rent_buddy_earnings_entries;
--   DROP TABLE IF EXISTS public.rent_buddy_earnings_entries;
--
-- NO EXISTING ROW OF ANY OTHER TABLE IS TOUCHED IN EITHER DIRECTION -- this file
-- creates one new table and nothing else, so reversing it restores the schema
-- byte-for-byte. What reversing DOES destroy is the entries themselves, and with
-- them the only append-only record of how each summary row's figures were
-- derived; the summary rows survive and keep meaning exactly what they meant
-- before 2901. Reverse only while abandoning the unit.
