-- 3822_payment_posting_and_balances.sql
-- The one door that writes money, the balance projection it maintains, and the
-- balance floor it enforces.
-- docs/architecture/09_Payment_Architecture.md §3.2, §4, §5.3 (I6), §7.
-- Requirement rows PAY-023, PAY-034, PAY-046 (the stored half), PAY-047
-- (task PAY-T06). Depends on 3821.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; payments owns
-- 3820-3859). APPLIED TO NO SHARED DATABASE. Rehearsed on a private throwaway
-- PostgreSQL 16 only (apply, re-apply, rollback, re-apply).
--   NOT applied to portava-ci (hwokxgbmezheskbzskfr).
--   NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--   public.payment_account_balances  the projection: one row per account that
--                                    has entries, balance_minor = the fold.
--   public.payment_balance_rules     per account type: its normal side, whether
--                                    the floor is enforced, and the transaction
--                                    kinds allowed to cross it (I6, as data).
--   public.payment_post_transaction(jsonb)
--                                    ONE call = ONE database transaction that
--                                    writes the envelope, its entries and the
--                                    balance delta, or writes nothing.
--
-- ── THE POSTING FUNCTION ────────────────────────────────────────────────────
-- SECURITY DEFINER, search_path pinned empty, EXECUTE for service_role only.
-- It is SECURITY DEFINER for one reason: service_role holds no INSERT on the
-- ledger (3821), so the API's own key cannot append an entry around the
-- projection or around I6. This function is the only writer.
--
--   EXACTLY ONCE (`09` §7). The envelope is inserted ON CONFLICT (scope,
--     idempotency_key) DO NOTHING — the index decides, not a read. When the key
--     exists the stored content_hash is compared with this request's: equal is
--     a REPLAY and returns the original transaction id with replayed = true;
--     different raises payment_idempotency_conflict (SQLSTATE PL409) — the same
--     key over different money is never reported as success. The hash covers
--     everything that decides where money goes (kind, currencies, original
--     amount, conversion, links, attribution, external_ref, the entries); it
--     does not cover occurred_at, so a retry that restamps its clock is still
--     a replay of the first.
--   THE PROJECTION (`09` §4). After the entries, ONE statement:
--     INSERT … ON CONFLICT (account_id) DO UPDATE SET balance_minor =
--     balance_minor + EXCLUDED.balance_minor. Never a read followed by a write.
--   I6 (`09` §5.3). The same statement RETURNs the new balances; an account
--     whose type has its floor enforced may not be moved further onto its
--     abnormal side unless the transaction's kind is listed for it. A violation
--     raises payment_insufficient_balance (PL402) and the whole call rolls back.
--   CONCURRENCY. Before any entry is written the accounts it names are locked
--     FOR NO KEY UPDATE in id order: two posts on one account are serialised
--     (so the floor is checked against the true balance and both land), the
--     order is the same for every caller (no deadlock), and NO KEY UPDATE does
--     not block the foreign-key checks of unrelated rows.
--
-- ── I6 AS DATA, AND THE DEFAULT SEEDED HERE ─────────────────────────────────
-- Which accounts may go negative follows from who carries a chargeback or a
-- refund the payee has already been paid for — the merchant-of-record question
-- the owner's 2026-10-04 answers leave to per-market setup. So the rule is a
-- table, and the seed is the narrowest reading of `09`:
--   user_payable  credit-normal, floor ENFORCED, crossable by 'chargeback' only
--                 (`09` §9.2: "debits user_payable (which may drive it negative
--                 — I6 permits this for exactly this account type)"). A payout,
--                 a refund or a reversal larger than the balance is REFUSED;
--                 widening that is one row, by migration, when it is decided.
--   every other type: normal side recorded, floor NOT enforced. user_receivable
--                 is debit-normal, and `09` §7 requires a capture that arrives
--                 before its authorisation to reconcile rather than fail, which
--                 a floor on it would refuse. The platform and processor
--                 accounts are not user accounts (I6's subject).
--
-- NOTHING HERE NAMES OR CALLS A PROVIDER, computes a fee, a split or a rate, or
-- converts a currency. Every figure is handed in.
--
-- RUNTIME EFFECT ON EXISTING SURFACES: none. The only caller is
-- services/payments/PaymentLedger.ts, which no existing route reaches.
--
-- Rollback: db/rollback/2026-10-04-3822-payment-posting-and-balances-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.payment_accounts') IS NULL
     OR to_regclass('public.payment_transactions') IS NULL
     OR to_regclass('public.payment_ledger_entries') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3822): 3821 is not applied.';
  END IF;
  IF to_regprocedure('public.payment_assert_transaction_balanced(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3822): public.payment_assert_transaction_balanced(uuid) is absent (3821).';
  END IF;
  IF has_table_privilege('service_role', 'public.payment_ledger_entries', 'INSERT') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3822): service_role can INSERT ledger entries directly; the projection would not be the only path.';
  END IF;
END
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════
-- The projection (`09` §4, PAY-023).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.payment_account_balances (
  account_id     uuid        PRIMARY KEY,
  currency       char(3)     NOT NULL,
  livemode       boolean     NOT NULL,
  -- SUM(payment_ledger_entries.amount_minor) for the account. Credit positive.
  balance_minor  bigint      NOT NULL,
  entry_count    bigint      NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pab_account_fk FOREIGN KEY (account_id, currency, livemode)
    REFERENCES public.payment_accounts (id, currency, livemode),
  CONSTRAINT pab_entry_count_positive CHECK (entry_count > 0)
);
COMMENT ON TABLE public.payment_account_balances IS
  '3822 (09 §4; PAY-023): a PROJECTION of payment_ledger_entries, never a source. One row per account that has at least one entry; an account with no row has balance zero. Written only by public.payment_post_transaction, by one INSERT … ON CONFLICT DO UPDATE in the same transaction as the entries. The reconciliation job (unbuilt) recomputes SUM(entries) and is the only thing that may correct it. service_role may only SELECT.';

ALTER TABLE public.payment_account_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_account_balances FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.payment_account_balances TO service_role;

DROP TRIGGER IF EXISTS pab_no_truncate ON public.payment_account_balances;
CREATE TRIGGER pab_no_truncate
  BEFORE TRUNCATE ON public.payment_account_balances
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_ledger_append_only();

-- ═══════════════════════════════════════════════════════════════════════════
-- I6 as data.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.payment_balance_rules (
  account_type     text        PRIMARY KEY,
  normal_side      text        NOT NULL,
  floor_enforced   boolean     NOT NULL,
  overdraft_kinds  text[]      NOT NULL DEFAULT '{}'::text[],
  note             text        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pbr_account_type_known CHECK (account_type IN (
    'user_payable', 'user_receivable', 'platform_revenue', 'platform_fee_expense',
    'processor_clearing', 'payout_in_transit', 'hold_reserve', 'refund_liability',
    'tax_withheld')),
  CONSTRAINT pbr_normal_side_known CHECK (normal_side IN ('credit', 'debit', 'either')),
  -- A floor needs a side to be the floor of.
  CONSTRAINT pbr_floor_needs_a_side CHECK (NOT floor_enforced OR normal_side <> 'either'),
  CONSTRAINT pbr_overdraft_kinds_known CHECK (overdraft_kinds <@ ARRAY[
    'charge', 'capture', 'fee', 'payout', 'refund', 'chargeback', 'reversal', 'fx']::text[]),
  CONSTRAINT pbr_note_given CHECK (length(btrim(note)) BETWEEN 1 AND 1000)
);
COMMENT ON TABLE public.payment_balance_rules IS
  '3822 (09 §5.3 I6; PAY-034): per account type, its normal side (credit = positive balance, debit = negative), whether the balance floor is enforced, and the transaction kinds allowed to move the balance further onto the abnormal side. Read by public.payment_post_transaction under the account lock; a type with no row here is REFUSED, not assumed unconstrained. Changing a row is an owner decision (who carries a chargeback or an over-refund) and is made by migration: service_role may only SELECT.';

ALTER TABLE public.payment_balance_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_balance_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.payment_balance_rules TO service_role;

-- DO NOTHING: a row the owner has since changed is not put back by a re-apply.
INSERT INTO public.payment_balance_rules (account_type, normal_side, floor_enforced, overdraft_kinds, note) VALUES
  ('user_payable',         'credit', true,  ARRAY['chargeback']::text[],
   '09 §9.2: only a chargeback may drive what the platform owes a payee below zero. A payout, refund or reversal larger than the balance is refused until the owner decides who carries that loss.'),
  ('user_receivable',      'debit',  false, '{}'::text[],
   'Debit-normal. Floor not enforced: 09 §7 requires a capture that arrives before its authorisation to reconcile, not fail.'),
  ('platform_revenue',     'credit', false, '{}'::text[], 'Platform account; 09 §5.3 I6 constrains user accounts.'),
  ('platform_fee_expense', 'debit',  false, '{}'::text[], 'Platform account; 09 §5.3 I6 constrains user accounts.'),
  ('processor_clearing',   'either', false, '{}'::text[], '09 §5.2: either side; reconciled against the processor''s settlement report.'),
  ('payout_in_transit',    'debit',  false, '{}'::text[], 'Platform account; 09 §5.3 I6 constrains user accounts.'),
  ('hold_reserve',         'credit', false, '{}'::text[], 'Platform account; 09 §5.3 I6 constrains user accounts.'),
  ('refund_liability',     'credit', false, '{}'::text[], 'Platform account; 09 §5.3 I6 constrains user accounts.'),
  ('tax_withheld',         'credit', false, '{}'::text[], 'Reserved (09 §5.2); no writer.')
ON CONFLICT (account_type) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- The door.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payment_post_transaction(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  uuid_re   CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  int_re    CONSTANT text := '^-?[0-9]{1,18}$';
  k              text;
  e              jsonb;
  v_entries      jsonb;
  v_n            int;
  v_scope        text;
  v_key          text;
  v_kind         text;
  v_currency     text;
  v_orig_cur     text;
  v_orig_amount  bigint;
  v_fx           jsonb;
  v_fx_rate      numeric;
  v_fx_source    text;
  v_fx_at        timestamptz;
  v_fx_tx        uuid;
  v_reverses     uuid;
  v_cause_kind   text;
  v_cause_id     text;
  v_subject_kind text;
  v_subject_id   text;
  v_beneficiary  uuid;
  v_version      text;
  v_external_ref text;
  v_occurred_at  timestamptz;
  v_sum          numeric;
  v_hash         text;
  v_id           uuid;
  v_existing     record;
  v_problem      text;
  v_constraint   text;
  v_balances     jsonb;
BEGIN
  -- ── 1. The request's shape. Nothing is defaulted and nothing is ignored. ──
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'payment_invalid_request: payload_not_an_object' USING ERRCODE = 'PL422';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('scope', 'idempotency_key', 'kind', 'currency', 'livemode', 'original_currency',
                 'original_amount_minor', 'fx', 'fx_transaction_id', 'reverses_transaction_id',
                 'cause_kind', 'cause_id', 'subject_kind', 'subject_id', 'beneficiary_account_id',
                 'attribution_version', 'external_ref', 'occurred_at', 'entries') THEN
      RAISE EXCEPTION 'payment_invalid_request: unknown_field — %', k USING ERRCODE = 'PL422';
    END IF;
  END LOOP;
  IF p ? 'livemode' AND p->'livemode' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'payment_live_mode_refused — this ledger records test-mode money only' USING ERRCODE = 'PL451';
  END IF;

  FOREACH k IN ARRAY ARRAY['scope', 'idempotency_key', 'kind', 'currency', 'original_currency',
                           'original_amount_minor', 'cause_kind', 'cause_id', 'subject_kind', 'subject_id',
                           'beneficiary_account_id', 'attribution_version', 'occurred_at'] LOOP
    IF p->>k IS NULL OR btrim(p->>k) = '' THEN
      RAISE EXCEPTION 'payment_invalid_request: missing_field — %', k USING ERRCODE = 'PL422';
    END IF;
  END LOOP;

  v_scope        := p->>'scope';
  v_key          := p->>'idempotency_key';
  v_kind         := p->>'kind';
  v_currency     := p->>'currency';
  v_orig_cur     := p->>'original_currency';
  v_cause_kind   := p->>'cause_kind';
  v_cause_id     := p->>'cause_id';
  v_subject_kind := p->>'subject_kind';
  v_subject_id   := p->>'subject_id';
  v_version      := p->>'attribution_version';
  v_external_ref := p->>'external_ref';

  IF v_currency !~ '^[A-Z]{3}$' OR v_orig_cur !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'payment_invalid_request: currency_shape — currency and original_currency are three upper-case letters' USING ERRCODE = 'PL422';
  END IF;
  IF p->>'original_amount_minor' !~ int_re THEN
    RAISE EXCEPTION 'payment_invalid_request: amount_not_an_integer — original_amount_minor' USING ERRCODE = 'PL422';
  END IF;
  v_orig_amount := (p->>'original_amount_minor')::bigint;
  IF p->>'beneficiary_account_id' !~ uuid_re THEN
    RAISE EXCEPTION 'payment_invalid_request: not_a_uuid — beneficiary_account_id' USING ERRCODE = 'PL422';
  END IF;
  v_beneficiary := (p->>'beneficiary_account_id')::uuid;
  IF p->>'fx_transaction_id' IS NOT NULL THEN
    IF p->>'fx_transaction_id' !~ uuid_re THEN
      RAISE EXCEPTION 'payment_invalid_request: not_a_uuid — fx_transaction_id' USING ERRCODE = 'PL422';
    END IF;
    v_fx_tx := (p->>'fx_transaction_id')::uuid;
  END IF;
  IF p->>'reverses_transaction_id' IS NOT NULL THEN
    IF p->>'reverses_transaction_id' !~ uuid_re THEN
      RAISE EXCEPTION 'payment_invalid_request: not_a_uuid — reverses_transaction_id' USING ERRCODE = 'PL422';
    END IF;
    v_reverses := (p->>'reverses_transaction_id')::uuid;
  END IF;
  BEGIN
    v_occurred_at := (p->>'occurred_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payment_invalid_request: not_a_timestamp — occurred_at' USING ERRCODE = 'PL422';
  END;

  -- Conversion details: all three or none (`09` §8: a missing rate is a
  -- refusal to book, never a guess). The CHECK on the table decides WHEN they
  -- are required; this only reads them.
  v_fx := p->'fx';
  IF v_fx IS NOT NULL AND jsonb_typeof(v_fx) <> 'null' THEN
    IF jsonb_typeof(v_fx) <> 'object'
       OR v_fx->>'rate' IS NULL OR v_fx->>'source' IS NULL OR v_fx->>'at' IS NULL
       OR v_fx->>'rate' !~ '^[0-9]{1,12}(\.[0-9]{1,12})?$' THEN
      RAISE EXCEPTION 'payment_invalid_request: conversion_details — fx needs rate (a positive decimal), source and at' USING ERRCODE = 'PL422';
    END IF;
    v_fx_rate   := (v_fx->>'rate')::numeric;
    v_fx_source := v_fx->>'source';
    BEGIN
      v_fx_at := (v_fx->>'at')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'payment_invalid_request: not_a_timestamp — fx.at' USING ERRCODE = 'PL422';
    END;
  END IF;

  -- ── 2. The entries. ────────────────────────────────────────────────────
  v_entries := p->'entries';
  IF v_entries IS NULL OR jsonb_typeof(v_entries) <> 'array' OR jsonb_array_length(v_entries) < 2 THEN
    RAISE EXCEPTION 'payment_invalid_request: entries_too_few — a money movement names at least two accounts' USING ERRCODE = 'PL422';
  END IF;
  v_n := jsonb_array_length(v_entries);
  IF v_n > 200 THEN
    RAISE EXCEPTION 'payment_invalid_request: entries_too_many — % (limit 200)', v_n USING ERRCODE = 'PL422';
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(v_entries) LOOP
    IF jsonb_typeof(e) <> 'object' THEN
      RAISE EXCEPTION 'payment_invalid_request: entry_not_an_object' USING ERRCODE = 'PL422';
    END IF;
    FOR k IN SELECT jsonb_object_keys(e) LOOP
      IF k NOT IN ('account_id', 'amount_minor', 'entry_reason') THEN
        RAISE EXCEPTION 'payment_invalid_request: unknown_entry_field — % (an entry is account_id, amount_minor and entry_reason; everything else lives on the transaction)', k
          USING ERRCODE = 'PL422';
      END IF;
    END LOOP;
    IF coalesce(e->>'account_id', '') !~ uuid_re THEN
      RAISE EXCEPTION 'payment_invalid_request: not_a_uuid — entries[].account_id' USING ERRCODE = 'PL422';
    END IF;
    IF coalesce(e->>'amount_minor', '') !~ int_re THEN
      RAISE EXCEPTION 'payment_invalid_request: amount_not_an_integer — entries[].amount_minor must be a whole number of minor units' USING ERRCODE = 'PL422';
    END IF;
    IF (e->>'amount_minor')::bigint = 0 THEN
      RAISE EXCEPTION 'payment_invalid_request: zero_amount — an entry of 0 moves nothing (09 §5.3 I5)' USING ERRCODE = 'PL422';
    END IF;
    IF e->>'entry_reason' IS NULL THEN
      RAISE EXCEPTION 'payment_invalid_request: missing_field — entries[].entry_reason' USING ERRCODE = 'PL422';
    END IF;
  END LOOP;

  SELECT sum((x->>'amount_minor')::bigint) INTO v_sum FROM jsonb_array_elements(v_entries) x;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'payment_transaction_unbalanced — the entries sum to %, not 0 (09 §5.3 I1)', v_sum USING ERRCODE = 'PL002';
  END IF;

  -- Named refusals for the two things the composite keys would otherwise
  -- report as a bare foreign-key violation.
  SELECT x.account_id::text INTO v_problem
    FROM (SELECT DISTINCT (y->>'account_id')::uuid AS account_id FROM jsonb_array_elements(v_entries) y) x
    LEFT JOIN public.payment_accounts a ON a.id = x.account_id
   WHERE a.id IS NULL
   LIMIT 1;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'payment_invalid_request: account_not_found — %', v_problem USING ERRCODE = 'PL422';
  END IF;
  SELECT a.id::text || ' is ' || a.currency INTO v_problem
    FROM (SELECT DISTINCT (y->>'account_id')::uuid AS account_id FROM jsonb_array_elements(v_entries) y) x
    JOIN public.payment_accounts a ON a.id = x.account_id
   WHERE a.currency <> v_currency OR a.livemode
   LIMIT 1;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'payment_invalid_request: currency_mismatch — account %, the transaction is % (09 §5.3 I4/I5: a transaction is single-currency)', v_problem, v_currency
      USING ERRCODE = 'PL422';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) y WHERE (y->>'account_id')::uuid = v_beneficiary) THEN
    RAISE EXCEPTION 'payment_invalid_request: beneficiary_not_a_party — beneficiary_account_id % is named by no entry (09 §6: the account credited)', v_beneficiary
      USING ERRCODE = 'PL422';
  END IF;

  -- ── 3. What this request IS, for telling a replay from a different request. ──
  v_hash := encode(sha256(convert_to(jsonb_build_object(
    'kind', v_kind,
    'currency', v_currency,
    'original_currency', v_orig_cur,
    'original_amount_minor', v_orig_amount::text,
    'fx_rate', CASE WHEN v_fx_rate IS NULL THEN NULL ELSE trim_scale(v_fx_rate)::text END,
    'fx_rate_source', v_fx_source,
    'fx_rate_at', CASE WHEN v_fx_at IS NULL THEN NULL
                       ELSE to_char(v_fx_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'fx_transaction_id', v_fx_tx,
    'reverses_transaction_id', v_reverses,
    'cause_kind', v_cause_kind,
    'cause_id', v_cause_id,
    'subject_kind', v_subject_kind,
    'subject_id', v_subject_id,
    'beneficiary_account_id', v_beneficiary,
    'attribution_version', v_version,
    'external_ref', v_external_ref,
    'entries', (
      SELECT jsonb_agg(jsonb_build_array(z.account_id, z.amount_minor::text, z.entry_reason)
                       ORDER BY z.account_id, z.entry_reason, z.amount_minor)
        FROM (SELECT (y->>'account_id')::uuid AS account_id,
                     (y->>'amount_minor')::bigint AS amount_minor,
                     y->>'entry_reason' AS entry_reason
                FROM jsonb_array_elements(v_entries) y) z)
  )::text, 'UTF8')), 'hex');

  -- ── 4. The envelope: the index decides whether this key is new. ─────────
  BEGIN
    INSERT INTO public.payment_transactions
      (kind, scope, idempotency_key, content_hash, currency, livemode, original_currency,
       original_amount_minor, fx_rate, fx_rate_source, fx_rate_at, fx_transaction_id,
       reverses_transaction_id, cause_kind, cause_id, subject_kind, subject_id,
       beneficiary_account_id, attribution_version, external_ref, occurred_at)
    VALUES
      (v_kind, v_scope, v_key, v_hash, v_currency, false, v_orig_cur,
       v_orig_amount, v_fx_rate, v_fx_source, v_fx_at, v_fx_tx,
       v_reverses, v_cause_kind, v_cause_id, v_subject_kind, v_subject_id,
       v_beneficiary, v_version, v_external_ref, v_occurred_at)
    ON CONFLICT (scope, idempotency_key) DO NOTHING
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'ptx_one_reversal_per_transaction' THEN
        RAISE EXCEPTION 'payment_already_reversed — transaction % has already been reversed; reversing it twice would re-credit money owed once', v_reverses
          USING ERRCODE = 'PL412';
      END IF;
      RAISE;
    WHEN check_violation OR foreign_key_violation OR not_null_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      RAISE EXCEPTION 'payment_invalid_request: % — %', coalesce(nullif(v_constraint, ''), 'constraint'), SQLERRM
        USING ERRCODE = 'PL422';
  END;

  IF v_id IS NULL THEN
    SELECT t.id, t.content_hash INTO v_existing
      FROM public.payment_transactions t
     WHERE t.scope = v_scope AND t.idempotency_key = v_key;
    IF NOT FOUND THEN
      -- Only reachable above READ COMMITTED: the conflicting row is committed
      -- but outside this snapshot. Retryable, and said so by its class.
      RAISE EXCEPTION 'payment_idempotency_unresolved — key %/% is held by a transaction this snapshot cannot see; retry', v_scope, v_key
        USING ERRCODE = '40001';
    END IF;
    IF v_existing.content_hash <> v_hash THEN
      RAISE EXCEPTION 'payment_idempotency_conflict — key %/% already recorded transaction % with different content', v_scope, v_key, v_existing.id
        USING ERRCODE = 'PL409';
    END IF;
    RETURN jsonb_build_object('transaction_id', v_existing.id, 'replayed', true);
  END IF;

  -- ── 5. Serialise on the accounts, in one order for every caller. ───────
  PERFORM 1
     FROM public.payment_accounts a
    WHERE a.id IN (SELECT (y->>'account_id')::uuid FROM jsonb_array_elements(v_entries) y)
    ORDER BY a.id
      FOR NO KEY UPDATE;

  -- ── 6. The entries. ────────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.payment_ledger_entries
      (transaction_id, account_id, amount_minor, currency, livemode, entry_reason)
    SELECT v_id, (y->>'account_id')::uuid, (y->>'amount_minor')::bigint, v_currency, false, y->>'entry_reason'
      FROM jsonb_array_elements(v_entries) y;
  EXCEPTION
    WHEN check_violation OR foreign_key_violation OR not_null_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      RAISE EXCEPTION 'payment_invalid_request: % — %', coalesce(nullif(v_constraint, ''), 'constraint'), SQLERRM
        USING ERRCODE = 'PL422';
  END;

  -- This transaction takes no further entries, in this call or after it.
  PERFORM set_config(
    'portava.payment_open_transactions',
    replace(coalesce(current_setting('portava.payment_open_transactions', true), ''), v_id::text || ',', ''),
    true);

  -- ── 7. The projection, in ONE statement, and I6 against what it returns. ──
  WITH delta AS (
    SELECT en.account_id, sum(en.amount_minor)::bigint AS delta_minor, count(*) AS n
      FROM public.payment_ledger_entries en
     WHERE en.transaction_id = v_id
     GROUP BY en.account_id
  ), moved AS (
    INSERT INTO public.payment_account_balances AS b
      (account_id, currency, livemode, balance_minor, entry_count, updated_at)
    SELECT d.account_id, v_currency, false, d.delta_minor, d.n, now()
      FROM delta d
     ORDER BY d.account_id
    ON CONFLICT (account_id) DO UPDATE
      SET balance_minor = b.balance_minor + EXCLUDED.balance_minor,
          entry_count   = b.entry_count + EXCLUDED.entry_count,
          updated_at    = now()
    RETURNING b.account_id, b.balance_minor
  ), judged AS (
    SELECT m.account_id, m.balance_minor, a.account_type,
           CASE
             WHEN r.account_type IS NULL THEN 'no balance rule for account type ' || a.account_type
             WHEN r.floor_enforced AND NOT (v_kind = ANY (r.overdraft_kinds))
                  AND ((r.normal_side = 'credit' AND m.balance_minor < 0 AND d.delta_minor < 0)
                    OR (r.normal_side = 'debit'  AND m.balance_minor > 0 AND d.delta_minor > 0))
               THEN a.account_type || ' account ' || m.account_id::text || ' would stand at '
                    || m.balance_minor::text || ' after a ' || v_kind || ' of ' || d.delta_minor::text
             ELSE NULL
           END AS refusal
      FROM moved m
      JOIN delta d ON d.account_id = m.account_id
      JOIN public.payment_accounts a ON a.id = m.account_id
      LEFT JOIN public.payment_balance_rules r ON r.account_type = a.account_type
  )
  SELECT jsonb_agg(jsonb_build_object('account_id', j.account_id, 'balance_minor', j.balance_minor::text)
                   ORDER BY j.account_id),
         min(j.refusal)
    INTO v_balances, v_problem
    FROM judged j;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'payment_insufficient_balance — % (09 §5.3 I6)', v_problem USING ERRCODE = 'PL402';
  END IF;

  -- The deferred checks will run again at COMMIT for every writer; running the
  -- same assertion here lets THIS caller learn of a refusal from this call.
  PERFORM public.payment_assert_transaction_balanced(v_id);

  RETURN jsonb_build_object(
    'transaction_id', v_id,
    'replayed', false,
    'entry_count', v_n,
    'balances', v_balances);
END;
$fn$;
COMMENT ON FUNCTION public.payment_post_transaction(jsonb) IS
  '3822 (09 §4, §5.3 I6, §7; PAY-023, PAY-034, PAY-046, PAY-047): the only writer of payment_transactions, payment_ledger_entries and payment_account_balances. One call is one transaction: envelope + entries + balance delta, or nothing. Idempotent on (scope, idempotency_key): a replay returns the original transaction (replayed = true); the same key with different content raises PL409 payment_idempotency_conflict. Locks the named accounts in id order, updates the projection in one INSERT … ON CONFLICT DO UPDATE, and refuses (PL402 payment_insufficient_balance) a move that payment_balance_rules does not allow. Amounts are integer minor units, taken as given; balances are returned as text. SECURITY DEFINER with search_path pinned empty; EXECUTE for service_role only.';
REVOKE ALL ON FUNCTION public.payment_post_transaction(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_post_transaction(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_post_transaction(jsonb) TO service_role;

-- ── Postconditions (assertion only) ─────────────────────────────────────────
DO $post$
DECLARE
  n int;
  t text;
  pr text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_account_balances', 'payment_balance_rules'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '3822: POSTCONDITION FAILED: public.% is absent', t;
    END IF;
    SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relname = t AND c.relrowsecurity;
    IF n <> 1 THEN RAISE EXCEPTION '3822: POSTCONDITION FAILED: row level security is off on %', t; END IF;
    SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF n <> 0 THEN RAISE EXCEPTION '3822: POSTCONDITION FAILED: % carries % polic(y/ies); it is deny-all by design', t, n; END IF;
    FOREACH pr IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('anon', 'public.' || t, pr) OR has_table_privilege('authenticated', 'public.' || t, pr) THEN
        RAISE EXCEPTION '3822: POSTCONDITION FAILED: a client role holds % on %', pr, t;
      END IF;
      IF has_table_privilege('service_role', 'public.' || t, pr) <> (pr = 'SELECT') THEN
        RAISE EXCEPTION '3822: POSTCONDITION FAILED: service_role must hold SELECT and only SELECT on %; % is wrong', t, pr;
      END IF;
    END LOOP;
  END LOOP;

  -- Every one of the nine account types has a rule; a missing rule refuses.
  SELECT count(*) INTO n FROM public.payment_balance_rules;
  IF n <> 9 THEN RAISE EXCEPTION '3822: POSTCONDITION FAILED: % of 9 balance rules present', n; END IF;

  IF has_function_privilege('anon', 'public.payment_post_transaction(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.payment_post_transaction(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '3822: POSTCONDITION FAILED: a client role can execute payment_post_transaction';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.payment_post_transaction(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '3822: POSTCONDITION FAILED: service_role cannot execute payment_post_transaction';
  END IF;
  SELECT count(*) INTO n FROM pg_proc f
   WHERE f.oid = 'public.payment_post_transaction(jsonb)'::regprocedure AND f.prosecdef
     AND f.proconfig @> ARRAY['search_path=""'];
  IF n <> 1 THEN RAISE EXCEPTION '3822: POSTCONDITION FAILED: payment_post_transaction is not SECURITY DEFINER with search_path pinned empty'; END IF;

  -- The door is still the only writer: no role but the owner may INSERT.
  FOREACH t IN ARRAY ARRAY['payment_transactions', 'payment_ledger_entries', 'payment_account_balances'] LOOP
    IF has_table_privilege('service_role', 'public.' || t, 'INSERT') THEN
      RAISE EXCEPTION '3822: POSTCONDITION FAILED: service_role can INSERT into % around the posting function', t;
    END IF;
  END LOOP;
END
$post$;

COMMIT;
