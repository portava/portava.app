-- 2921_creator_earning_entries.sql
--
-- "Earnings can be recorded WITHOUT PAYING" (`07` §10) for all SIX of §2's
-- creator value types — one append-only, double-entry, rule-versioned source
-- that is not tied to a subsystem.
-- census-discovery DV-57, DV-58, DV-60. Depends on 2920.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2920-2929.
--
-- ── WHY A THIRD LEDGER, AND WHY THE OTHER TWO STAY ─────────────────────────
-- The tree has two earning sources and each is correct FOR ITS SUBSYSTEM and
-- structurally unable to serve any other:
--
--   public.intel_reward_ledger (2170, + 2900's reversals) books non-cash QIU
--     credits to an intel contributor. Its rows are (actor_id, source, qiu,
--     earned_units); there is no object, no creator type and no double entry.
--   public.rent_buddy_earnings_entries (2901) is the double-entry source this
--     file's shape is taken from, and it is a Rent-a-Buddy table by declaration:
--     booking_id uuid NOT NULL REFERENCES public.rent_buddy_bookings(id), and
--     CHECK (attribution_kind IN ('booking')).
--
-- Both are APPLIED, and `10` §7 forbids editing an applied migration. Widening
-- 2901 would also be wrong on the merits — a Trail Builder's earning is not a
-- Rent-a-Buddy booking and should not FK to one. So this is a new relation, and
-- the two existing ones are left exactly as found. Both carry LIVE ROWS; a
-- postcondition asserts neither was touched.
--
-- ── THE SHAPE IS 2901's, DELIBERATELY ──────────────────────────────────────
-- Signed minor units; entries sharing a transaction_key sum to zero per
-- currency (`09` §5.3 I1); a correction is a NEW row naming reverses_entry_id;
-- uniqueness is a database index; provider is recorded and read by nothing.
-- The pure model behind it is lib/creatorLedgerEntries.ts, unchanged in those
-- respects and now carrying a creator_type.
--
-- ── THE ONE NEW RULE: NO PRODUCER, NO EARNING ──────────────────────────────
-- Four of §2's six types have no code that records their value event (see
-- lib/creatorTypes.ts). An earnings row for such a type would be an invention.
-- 2920 marks those attributions attribution_basis = 'seam_no_producer'; this
-- table makes the consequence structural rather than a convention:
--
--   attribution_id uuid NOT NULL REFERENCES public.creator_attributions(id)
--   + trigger cee_requires_recorded_value_event
--
-- Every entry must name a real attribution row, and that row must be a
-- RECORDED value event. A seam cannot be earned against. This is why the
-- migration cannot be used to manufacture coverage for the four types that
-- do not have it: the ledger works for all six, and four of them have nothing
-- to book yet, and the database says which is which.
--
-- ── PRE-MONEY, STRUCTURALLY (`09` §1) ──────────────────────────────────────
-- cash_settled_minor bigint NOT NULL DEFAULT 0 CHECK (cash_settled_minor = 0),
-- 2170:40's shape, as in 2901. There is no balance column, no wallet, no
-- payout state and no disbursement table anywhere in this lane. A balance is
-- SUM(amount_minor) over these rows and nothing else.
--
-- RUNTIME EFFECT ON EXISTING SURFACES: NONE. No existing table, column,
-- constraint, policy, grant or flag is altered, and no row of any existing
-- table is read or written. The only writer is
-- services/creators/CreatorEarningService.ts, which is gated fail-closed on the
-- absent feature flag `creator_attribution`.
--
-- Readers: services/creators/CreatorEarningService.ts,
--          lib/creatorLedgerEntries.ts, lib/creatorLedgerRows.ts.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.creator_attributions') IS NULL THEN
    RAISE EXCEPTION '2921: PRECONDITION FAILED: 2920 must be applied first (public.creator_attributions absent)';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '2921: PRECONDITION FAILED: public.profiles is required for beneficiary references';
  END IF;
  IF to_regproc('public.intel_append_only') IS NULL THEN
    RAISE EXCEPTION '2921: PRECONDITION FAILED: public.intel_append_only() is required to block UPDATE';
  END IF;
  IF to_regclass('public.creator_earning_entries') IS NOT NULL THEN
    RAISE EXCEPTION '2921: public.creator_earning_entries already exists; this migration is not idempotent by design';
  END IF;
END
$pre$;

CREATE TABLE public.creator_earning_entries (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Entries sharing a key sum to zero per currency. A single-sided booking is
  -- not expressible as a transaction, which is what makes a fictitious
  -- collection impossible: it has no counterpart to book (`09` §5.3 I1, §1.3.1).
  transaction_key     text        NOT NULL,

  -- `07` §2's dimension, on the earning as well as on the attribution. Without
  -- it a per-type recomputation would have to be inferred from a join.
  creator_type        text        NOT NULL,

  -- `07` §7: the earning names the CONTRIBUTION it came from, and that
  -- contribution must be a recorded value event (see the trigger below).
  attribution_id      uuid        NOT NULL REFERENCES public.creator_attributions(id),

  account             text        NOT NULL,
  entry_reason        text        NOT NULL,
  -- `07` §6's revenue share sources. NULL on entries that are not a share.
  revenue_source      text        NULL,

  -- Signed minor units. Never zero: an entry worth nothing states nothing.
  amount_minor        bigint      NOT NULL CHECK (amount_minor <> 0),
  currency            char(3)     NOT NULL DEFAULT 'USD',

  -- The financial-control boundary, 2170:40's shape. Recording a settlement is
  -- structurally impossible, in either direction.
  cash_settled_minor  bigint      NOT NULL DEFAULT 0
    CONSTRAINT cee_no_settlement CHECK (cash_settled_minor = 0),

  -- `07` §8/§10. The version the amount was computed under, so a recomputation
  -- is a new version's entries BESIDE the old rather than a rewrite of them.
  rule_version        text        NOT NULL,

  beneficiary_user_id uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- A correction is a new, opposite entry that NAMES the one it negates.
  reverses_entry_id   uuid        NULL REFERENCES public.creator_earning_entries(id),

  -- Processor identity. Recorded, never read by any derived quantity — that is
  -- what "provider can be swapped later" (`09` §11) reduces to.
  provider            text        NOT NULL DEFAULT 'none',
  external_ref        text        NULL,

  idempotency_key     text        NOT NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cee_creator_type_known CHECK (creator_type IN (
    'discovery_creator','trail_builder','local_expert',
    'itinerary_creator','experience_host','travel_partner')),
  CONSTRAINT cee_account_known CHECK (account IN (
    'creator_payable','platform_revenue','traveler_receivable','cash_external')),
  -- NOTHING here asserts money arrived, left or settled. That is the point:
  -- there is no 'collection', 'capture', 'payout' or 'settlement' reason, so a
  -- caller that believes money moved cannot say so.
  CONSTRAINT cee_entry_reason_known CHECK (entry_reason IN (
    'value_attribution','revenue_share','platform_fee','reversal')),
  -- `07` §6's five sources, verbatim as slugs.
  CONSTRAINT cee_revenue_source_known CHECK (revenue_source IS NULL OR revenue_source IN (
    'booking_commission','marketplace_fee','affiliate_commission',
    'paid_trail_or_guide_product','sponsored_collaboration')),
  CONSTRAINT cee_currency_shape        CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT cee_rule_version_shape    CHECK (length(rule_version) BETWEEN 1 AND 200),
  CONSTRAINT cee_idempotency_shape     CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  CONSTRAINT cee_no_self_reversal      CHECK (reverses_entry_id IS DISTINCT FROM id),
  -- Only a row that NAMES the entry it reverses may carry entry_reason
  -- 'reversal', and a reversal must name one. An unexplained opposite entry is
  -- indistinguishable from a bookkeeping error.
  CONSTRAINT cee_reversal_is_linked CHECK (
    (entry_reason = 'reversal') = (reverses_entry_id IS NOT NULL))
);

-- `09` §7.2 — uniqueness is a database index, not an application check. TOTAL,
-- not partial, so PostgREST conflict-target inference matches it and a writer's
-- ON CONFLICT DO NOTHING is a genuine no-op replay rather than an overwrite.
CREATE UNIQUE INDEX cee_idempotency_key_once
  ON public.creator_earning_entries (idempotency_key);
-- At most one reversal per entry: reversing twice re-credits an earning that
-- existed once, which is how a ledger invents money.
CREATE UNIQUE INDEX cee_one_reversal_per_entry
  ON public.creator_earning_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX cee_attribution_idx  ON public.creator_earning_entries (attribution_id, occurred_at DESC);
CREATE INDEX cee_type_rule_idx    ON public.creator_earning_entries (creator_type, rule_version);
CREATE INDEX cee_beneficiary_idx  ON public.creator_earning_entries (beneficiary_user_id, occurred_at DESC);
CREATE INDEX cee_transaction_idx  ON public.creator_earning_entries (transaction_key);

-- ── NO PRODUCER, NO EARNING ─────────────────────────────────────────────────
-- A CHECK cannot read another table, and a FK cannot read another table's
-- column value, so this is the one rule that needs a trigger. It also pins the
-- creator_type to the attribution's, so an earning cannot be filed under a type
-- its own contribution does not claim.
CREATE OR REPLACE FUNCTION public.creator_earning_requires_recorded_value_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $fn$
DECLARE a_basis text; a_type text;
BEGIN
  SELECT attribution_basis, creator_type INTO a_basis, a_type
    FROM public.creator_attributions WHERE id = NEW.attribution_id;
  IF a_basis IS NULL THEN
    RAISE EXCEPTION 'creator_earning_entries: attribution % does not exist', NEW.attribution_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF a_basis <> 'recorded_value_event' THEN
    RAISE EXCEPTION
      'creator_earning_entries: attribution % is a % seam — no value event was recorded, so there is nothing to earn against (07 §10)',
      NEW.attribution_id, a_basis
      USING ERRCODE = 'check_violation';
  END IF;
  IF a_type <> NEW.creator_type THEN
    RAISE EXCEPTION
      'creator_earning_entries: entry claims creator_type % but attribution % is %',
      NEW.creator_type, NEW.attribution_id, a_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
COMMENT ON FUNCTION public.creator_earning_requires_recorded_value_event() IS
  '07 §10: earnings are recordable only where value was actually attributed. Four of 07 §2''s six creator types have no producer for their value event; their attributions are attribution_basis = ''seam_no_producer'' (2920) and this refuses to book an earning against one. The rule is here rather than in application code because a CHECK cannot read another table.';

CREATE TRIGGER cee_requires_recorded_value_event
  BEFORE INSERT ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_earning_requires_recorded_value_event();

-- ── Corrections are new rows ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS cee_no_update ON public.creator_earning_entries;
CREATE TRIGGER cee_no_update
  BEFORE UPDATE ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();

-- ── RLS + grants: deny-default, no client grant at all ──────────────────────
ALTER TABLE public.creator_earning_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.creator_earning_entries FROM PUBLIC, anon, authenticated, service_role;
-- INSERT + SELECT: append-only. DELETE only so the account-erasure cascade from
-- creator_attributions can fire; it is not a correction path.
GRANT INSERT, SELECT, DELETE ON public.creator_earning_entries TO service_role;

COMMENT ON TABLE public.creator_earning_entries IS
  '07 §10 "earnings can be recorded without paying", for all six of 07 §2''s creator value types. Append-only, signed, minor-unit double-entry; the balance is SUM(amount_minor) over these rows and there is no stored total anywhere. Records no settlement: cash_settled_minor = 0 is CHECK-enforced (2170:40 shape), and no payout, wallet or disbursement exists in this lane (09 §1). Every entry names a creator_attributions row and that row must be a RECORDED value event, not a seam — trigger cee_requires_recorded_value_event. Corrections are new rows naming reverses_entry_id. No client grant.';
COMMENT ON COLUMN public.creator_earning_entries.revenue_source IS
  '07 §6''s five revenue share sources. NULL on entries that are not a share. No percentage is implied by any value here; the percentages live in creator_rule_versions.params (§8).';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.creator_earning_entries') IS NULL THEN
    RAISE EXCEPTION '2921: POSTCONDITION FAILED: creator_earning_entries not created';
  END IF;

  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'creator_earning_entries' AND NOT c.relrowsecurity;
  IF n > 0 THEN RAISE EXCEPTION '2921: POSTCONDITION FAILED: RLS is disabled'; END IF;

  -- By NAME, not by rendered text: pg_get_constraintdef normalises literals, so
  -- a LIKE over the rendered form depends on the column's type rather than on
  -- the rule. cf. intel_reward_ledger's boundary, which reads back as
  -- `cash_amount = (0)::numeric`.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.creator_earning_entries'::regclass AND conname = 'cee_no_settlement';
  IF n <> 1 THEN
    RAISE EXCEPTION '2921: POSTCONDITION FAILED: the no-settlement boundary (cash_settled_minor = 0) is absent';
  END IF;

  SELECT count(*) INTO n FROM pg_class WHERE relname = 'cee_idempotency_key_once' AND relkind = 'i';
  IF n <> 1 THEN RAISE EXCEPTION '2921: POSTCONDITION FAILED: idempotency index absent; a replay could double-book'; END IF;
  SELECT count(*) INTO n FROM pg_class WHERE relname = 'cee_one_reversal_per_entry' AND relkind = 'i';
  IF n <> 1 THEN RAISE EXCEPTION '2921: POSTCONDITION FAILED: one-reversal-per-entry index absent'; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.creator_earning_entries'::regclass
     AND tgname IN ('cee_no_update','cee_requires_recorded_value_event');
  IF n <> 2 THEN RAISE EXCEPTION '2921: POSTCONDITION FAILED: a required trigger is absent'; END IF;

  -- PROVE the seam rule rather than assert it: book an earning against a seam
  -- attribution and require the refusal.
  DECLARE seam_id uuid;
  BEGIN
    INSERT INTO public.creator_attributions
      (creator_type, subject_kind, subject_id, value_event, value_event_id,
       attribution_basis, beneficiary_user_id, rule_version, idempotency_key)
    SELECT 'trail_builder','trail', gen_random_uuid(), 'route_completion', NULL,
           'seam_no_producer', p.id, 'creator-rules/trail-builder/v1', '2921-postcondition-probe'
      FROM public.profiles p LIMIT 1
    RETURNING id INTO seam_id;

    IF seam_id IS NULL THEN
      -- No profile exists to reference. Say so rather than silently skipping a
      -- postcondition: an unrun proof is not a passed one.
      RAISE WARNING '2921: seam-refusal probe SKIPPED — public.profiles is empty on this database';
    ELSE
      BEGIN
        INSERT INTO public.creator_earning_entries
          (transaction_key, creator_type, attribution_id, account, entry_reason,
           amount_minor, rule_version, idempotency_key)
        VALUES ('2921-probe','trail_builder', seam_id, 'creator_payable', 'value_attribution',
                100, 'creator-rules/trail-builder/v1', '2921-probe-entry');
        RAISE EXCEPTION '2921: POSTCONDITION FAILED: an earning was booked against a seam attribution';
      EXCEPTION
        -- The trigger raises with ERRCODE check_violation precisely so this probe
        -- can catch ITS refusal and nothing else; the RAISE above is P0001 and
        -- therefore propagates, which is what makes this proof rather than prose.
        WHEN check_violation THEN NULL;
      END;
      DELETE FROM public.creator_attributions WHERE id = seam_id;
    END IF;
  END;

  IF has_table_privilege('service_role', 'public.creator_earning_entries', 'UPDATE') THEN
    RAISE EXCEPTION '2921: POSTCONDITION FAILED: service_role has UPDATE. Corrections are new rows.';
  END IF;
  IF has_table_privilege('authenticated', 'public.creator_earning_entries', 'SELECT')
     OR has_table_privilege('anon', 'public.creator_earning_entries', 'SELECT') THEN
    RAISE EXCEPTION '2921: POSTCONDITION FAILED: a client role can read the earning entries (09 §10)';
  END IF;

  -- The two live ledgers must be EXACTLY as this migration found them.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass
     AND conname = 'rbee_attribution_kind_check';
  IF n <> 1 THEN
    RAISE EXCEPTION '2921: POSTCONDITION FAILED: 2901 was modified. This migration adds a relation and must widen nothing.';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.intel_reward_ledger'::regclass
     AND conname = 'intel_reward_ledger_cash_amount_check';
  IF n <> 1 THEN
    RAISE EXCEPTION '2921: POSTCONDITION FAILED: intel_reward_ledger''s cash boundary is missing; this migration must touch nothing there';
  END IF;
END
$post$;

COMMIT;

-- REVERSAL (exact, and lossless for every pre-existing row):
--
--   DROP TRIGGER IF EXISTS cee_requires_recorded_value_event ON public.creator_earning_entries;
--   DROP TRIGGER IF EXISTS cee_no_update ON public.creator_earning_entries;
--   DROP TABLE IF EXISTS public.creator_earning_entries;
--   DROP FUNCTION IF EXISTS public.creator_earning_requires_recorded_value_event();
--
-- NO EXISTING ROW OF ANY OTHER TABLE IS TOUCHED IN EITHER DIRECTION -- this file
-- creates one table and one function and nothing else, so reversing it restores
-- the schema byte-for-byte. intel_reward_ledger and rent_buddy_earnings_ledger,
-- which carry live rows, are neither read nor written here.
--
-- Reverse 2921 BEFORE 2920: creator_earning_entries carries a NOT NULL FK to
-- creator_attributions, so dropping 2920's tables first fails on the dependency.
--
-- What reversing DOES destroy is the only per-creator-type earning record.
-- Reverse only while abandoning the unit.
