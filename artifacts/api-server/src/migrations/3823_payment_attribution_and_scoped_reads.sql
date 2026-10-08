-- 3823_payment_attribution_and_scoped_reads.sql
-- The attribution tuple's vocabulary and integrity, the party-scoped read, the
-- erasure door with its retention setting, and the read flag.
-- docs/architecture/09_Payment_Architecture.md §6, §10.
-- Requirement rows PAY-040, PAY-072, PAY-073 (task PAY-T07). Depends on 3821, 3822.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; payments owns
-- 3820-3859). APPLIED TO NO SHARED DATABASE. Rehearsed on a private throwaway
-- PostgreSQL 16 only (apply, re-apply, rollback, re-apply).
--   NOT applied to portava-ci (hwokxgbmezheskbzskfr).
--   NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── (1) THE ATTRIBUTION TUPLE (`09` §6, PAY-040) ────────────────────────────
-- 3821 made the six columns NOT NULL and non-empty (I7) and froze them with
-- the rest of the row (ptx_append_only: no UPDATE, by any role). This file
-- gives them their vocabulary and one integrity rule:
--   cause_kind          IN booking, subscription, tip, reward, adjustment.
--   subject_kind        the kinds canonical_events.subject_kind is written with
--                       for a thing money can be ABOUT: place, event, trip,
--                       experience, booking, itinerary, trail, intel_claim.
--                       Deliberately no person kind — the subject is never a
--                       user, so the tuple holds no identity — and no
--                       'unknown': absence is not permitted to be silent (I7).
--   attribution_version a lower-case version slug (`intel_attributions.
--                       algorithm_version`'s role). A revised split is a NEW
--                       transaction under a new version, never an edit.
--   beneficiary_account_id  must be an account the transaction CREDITS — its
--                       entries on that account net above zero (`09` §6: "the
--                       account credited"; constraint 2: "whoever triggers a
--                       charge is not thereby a payee"). An account no entry
--                       names, or one the transaction debits, is refused at
--                       COMMIT by constraint trigger ptx_has_beneficiary_entry,
--                       for every writer.
--
-- ── (2) EACH PARTY SEES ONLY ITS SIDE (`09` §10, PAY-072, PAY-073) ──────────
-- public.payment_party_ledger(jsonb) returns the accounts a profile's party
-- owns, their balances, and a page of the entries NAMING THOSE ACCOUNTS — the
-- payer reads their side of a booking's money, the payee theirs, and neither
-- reads the other's: an entry on the counterparty's account is not in the
-- result, and no column of the result is a counterparty's (no
-- beneficiary_account_id, no external_ref, no idempotency key, no original
-- amount of the whole transaction).
--
-- The ownership predicate is authz.payment_account_owned_by_profile(account,
-- profile), in schema `authz` with its search_path pinned
-- (pg_catalog, pg_temp — never empty: see 3821's header) because it takes the
-- identity as a PARAMETER (2182: such a predicate must not be reachable as a
-- PostgREST RPC). `authz` is created here if 2182 has not been applied to the
-- target; 2182's own CREATE SCHEMA IF NOT EXISTS then finds it.
--
-- NO POLICY IS ADDED AND NO CLIENT ROLE IS GRANTED ANYTHING. The six payment
-- tables stay RLS-enabled with zero policies and SELECT for service_role only:
-- deny-all is the stricter posture, and with no policy an accidental table
-- grant still exposes nothing. So PAY-072's rule — a predicate a payment policy
-- calls lives in authz — holds with nothing in `public` to move: the one
-- predicate is already there, and the read that uses it is executable by
-- service_role only, called by routes/payments.ts with requireUser's user id.
--
-- ── (3) ERASURE (owner ruling 2026-10-04, creator-ledger erasure) ───────────
-- public.payment_party_remove_identity(jsonb) removes the profile link of a
-- person's payment party, and (3821's pp_identity_scrub) rewrites any envelope
-- text that still carries the profile id to the party id. No amount, account,
-- entry or balance is touched, so every balance and every invariant is exactly
-- what it was, and the records remain linkable to each other through the party
-- id (pseudonymised, not anonymous).
--   OPEN BALANCES. A person who is owed money (a payable above zero), or owes
--   it, must not vanish from it: once the link is gone the same profile gets a
--   NEW, empty party, and nothing would connect them to the old balance. So
--   the door REFUSES — payment_open_balance, SQLSTATE PL428, the balances in
--   DETAIL as JSON — while any account of the party has a non-zero balance.
--   The default is to refuse; the caller settles first (a payout, a refund, or
--   whatever the owner rules for unclaimed money), and nothing has changed.
--   `on_open_balance: "retain"` is the explicit alternative: the identity is
--   removed NOW, the balances stay on the pseudonymous party, and the result
--   carries them AND the party id, so the amount stays addressable — a payout
--   or an escheat is then posted by account id, which needs no identity.
--   Which of the two the deletion service uses, and what becomes of unclaimed
--   money, are the owner's questions; the mechanism serves either answer.
--   WHAT THE FOREIGN KEY CANNOT DO: a profile row deleted outright removes the
--   link through ON DELETE SET NULL, which cannot refuse. Those parties are
--   findable — payment_parties.identity_removed_via = 'profile_deleted' with a
--   non-zero balance — and are the reconciliation job's to report.
-- It returns counts and the retention answer. The party id is returned ONLY in
-- the retain case above; otherwise a caller is not handed the mapping to write
-- back down next to the profile.
-- public.payment_retention_settings holds the retention period as ONE
-- configurable value. It is seeded NULL = undecided: the owner's ruling says "a
-- defined retention period" and gives none. NOTHING DELETES: there is no purge
-- function, no job and no DELETE grant, and the ledger's row triggers refuse a
-- delete from any role. Enabling deletion after the period is a later
-- migration, once the period and its clock are decided.
--
-- ── (4) THE FLAG ────────────────────────────────────────────────────────────
-- `payment_ledger_reads_enabled`, seeded FALSE: gates routes/payments.ts
-- (GET /payments/me/accounts, GET /payments/me/entries). OFF / absent /
-- unreadable answers feature_disabled — never an empty ledger.
--
-- RUNTIME EFFECT ON EXISTING SURFACES: none. The ledger holds zero rows, the
-- flag is FALSE, and no existing route calls any function of this file.
--
-- Rollback: db/rollback/2026-10-04-3823-payment-attribution-and-scoped-reads-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.payment_transactions') IS NULL OR to_regclass('public.payment_parties') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3823): 3821 is not applied.';
  END IF;
  IF to_regclass('public.payment_account_balances') IS NULL
     OR to_regprocedure('public.payment_post_transaction(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3823): 3822 is not applied.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3823): public.feature_flags does not exist.';
  END IF;
  -- The vocabulary CHECKs below are added to a table that may hold rows. Name
  -- the rows that would fail them rather than let ADD CONSTRAINT report one.
  IF EXISTS (
    SELECT 1 FROM public.payment_transactions t
     WHERE t.cause_kind NOT IN ('booking', 'subscription', 'tip', 'reward', 'adjustment')
        OR t.subject_kind NOT IN ('place', 'event', 'trip', 'experience', 'booking', 'itinerary', 'trail', 'intel_claim')
        OR t.attribution_version !~ '^[a-z0-9][a-z0-9._/-]{0,119}$') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3823): payment_transactions holds a row outside the attribution vocabulary this file installs.';
  END IF;
END
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) The attribution tuple.
-- ═══════════════════════════════════════════════════════════════════════════
DO $vocab$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.payment_transactions'::regclass AND conname = 'ptx_cause_kind_known') THEN
    ALTER TABLE public.payment_transactions
      ADD CONSTRAINT ptx_cause_kind_known CHECK (cause_kind IN (
        'booking', 'subscription', 'tip', 'reward', 'adjustment'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.payment_transactions'::regclass AND conname = 'ptx_subject_kind_known') THEN
    ALTER TABLE public.payment_transactions
      ADD CONSTRAINT ptx_subject_kind_known CHECK (subject_kind IN (
        'place', 'event', 'trip', 'experience', 'booking', 'itinerary', 'trail', 'intel_claim'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.payment_transactions'::regclass AND conname = 'ptx_attribution_version_shape') THEN
    ALTER TABLE public.payment_transactions
      ADD CONSTRAINT ptx_attribution_version_shape CHECK (attribution_version ~ '^[a-z0-9][a-z0-9._/-]{0,119}$');
  END IF;
END
$vocab$;

-- SECURITY DEFINER for the reason 3821's two deferred checks are: it runs at
-- COMMIT as the session's role, after the posting function has returned.
CREATE OR REPLACE FUNCTION public.payment_transaction_beneficiary_is_party()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_net pg_catalog.numeric;
BEGIN
  SELECT sum(e.amount_minor) INTO v_net
    FROM public.payment_ledger_entries e
   WHERE e.transaction_id = NEW.id AND e.account_id = NEW.beneficiary_account_id;
  IF v_net IS NULL THEN
    RAISE EXCEPTION
      'payment_beneficiary_not_a_party — transaction % names beneficiary account %, which none of its entries touches (09 §6: the account credited)',
      NEW.id, NEW.beneficiary_account_id
      USING ERRCODE = 'PL006';
  END IF;
  IF v_net <= 0 THEN
    RAISE EXCEPTION
      'payment_beneficiary_not_credited — transaction % names beneficiary account %, which it does not credit (net %). The beneficiary is the account credited (09 §6); whoever is charged is not thereby the payee',
      NEW.id, NEW.beneficiary_account_id, v_net
      USING ERRCODE = 'PL006';
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.payment_transaction_beneficiary_is_party() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_transaction_beneficiary_is_party() FROM anon, authenticated, service_role;

-- Named to sort AFTER ptx_has_balanced_entries: triggers on one row fire in name
-- order, so a transaction with no entries at all is reported as unbalanced (the
-- fundamental defect), not as lacking a beneficiary entry.
DROP TRIGGER IF EXISTS ptx_has_beneficiary_entry ON public.payment_transactions;
CREATE CONSTRAINT TRIGGER ptx_has_beneficiary_entry
  AFTER INSERT ON public.payment_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.payment_transaction_beneficiary_is_party();

-- ═══════════════════════════════════════════════════════════════════════════
-- (2) The party-scoped read.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS authz;
-- service_role only: nothing a client role evaluates calls into authz for money.
GRANT USAGE ON SCHEMA authz TO service_role;

CREATE OR REPLACE FUNCTION authz.payment_account_owned_by_profile(p_account_id uuid, p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
AS $fn$
  SELECT p_profile_id IS NOT NULL AND p_account_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.payment_accounts a
      JOIN public.payment_parties pt ON pt.id = a.owner_id AND pt.kind = a.owner_kind
     WHERE a.id = p_account_id
       AND pt.kind = 'user'
       AND pt.profile_id = p_profile_id
  );
$fn$;
COMMENT ON FUNCTION authz.payment_account_owned_by_profile(uuid, uuid) IS
  '3823 (09 §10; PAY-072): true when the account belongs to the user party currently linked to the profile. The ONE ownership predicate for payment reads. It takes the identity as a parameter, so it lives in authz (not reachable as a PostgREST RPC) and is executable by service_role only. SECURITY INVOKER, search_path pinned to pg_catalog, pg_temp. A party whose identity has been removed owns nothing by this predicate. If a payment table is ever given a client policy, the policy calls a predicate in authz that derives the viewer from auth.uid() — never one in public.';
REVOKE ALL ON FUNCTION authz.payment_account_owned_by_profile(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.payment_account_owned_by_profile(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION authz.payment_account_owned_by_profile(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.payment_party_ledger(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  uuid_re      CONSTANT pg_catalog.text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  k            pg_catalog.text;
  v_profile    pg_catalog.uuid;
  v_party      pg_catalog.uuid;
  v_cause_kind pg_catalog.text;
  v_cause_id   pg_catalog.text;
  v_limit      pg_catalog.int4 := 50;
  v_before_at  pg_catalog.timestamptz;
  v_before_id  pg_catalog.uuid;
  v_accounts   pg_catalog.jsonb;
  v_rows       pg_catalog.jsonb;
  v_cursor     pg_catalog.jsonb := NULL;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'payment_invalid_request: payload_not_an_object' USING ERRCODE = 'PL422';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('profile_id', 'cause_kind', 'cause_id', 'limit', 'before_occurred_at', 'before_entry_id') THEN
      RAISE EXCEPTION 'payment_invalid_request: unknown_field — %', k USING ERRCODE = 'PL422';
    END IF;
  END LOOP;
  IF coalesce(p->>'profile_id', '') !~ uuid_re THEN
    RAISE EXCEPTION 'payment_invalid_request: not_a_uuid — profile_id' USING ERRCODE = 'PL422';
  END IF;
  v_profile := (p->>'profile_id')::pg_catalog.uuid;

  v_cause_kind := p->>'cause_kind';
  v_cause_id   := p->>'cause_id';
  IF (v_cause_kind IS NULL) <> (v_cause_id IS NULL) THEN
    RAISE EXCEPTION 'payment_invalid_request: cause_filter — cause_kind and cause_id are given together or not at all' USING ERRCODE = 'PL422';
  END IF;

  IF p->>'limit' IS NOT NULL THEN
    IF p->>'limit' !~ '^[0-9]{1,3}$' OR (p->>'limit')::pg_catalog.int4 > 200 THEN
      RAISE EXCEPTION 'payment_invalid_request: limit — a whole number from 0 to 200' USING ERRCODE = 'PL422';
    END IF;
    v_limit := (p->>'limit')::pg_catalog.int4;
  END IF;

  IF (p->>'before_occurred_at' IS NULL) <> (p->>'before_entry_id' IS NULL) THEN
    RAISE EXCEPTION 'payment_invalid_request: cursor — before_occurred_at and before_entry_id are given together or not at all' USING ERRCODE = 'PL422';
  END IF;
  IF p->>'before_entry_id' IS NOT NULL THEN
    IF p->>'before_entry_id' !~ uuid_re THEN
      RAISE EXCEPTION 'payment_invalid_request: not_a_uuid — before_entry_id' USING ERRCODE = 'PL422';
    END IF;
    v_before_id := (p->>'before_entry_id')::pg_catalog.uuid;
    BEGIN
      v_before_at := (p->>'before_occurred_at')::pg_catalog.timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'payment_invalid_request: not_a_timestamp — before_occurred_at' USING ERRCODE = 'PL422';
    END;
  END IF;

  SELECT pt.id INTO v_party
    FROM public.payment_parties pt
   WHERE pt.kind = 'user' AND pt.profile_id = v_profile;
  IF v_party IS NULL THEN
    -- An ANSWER, not a failure: this profile has no payment party (it never
    -- had one, or its identity has been removed). A failed read raises.
    RETURN jsonb_build_object('has_party', false, 'accounts', '[]'::pg_catalog.jsonb, 'entries', '[]'::pg_catalog.jsonb, 'next_cursor', NULL);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_id', a.id,
           'account_type', a.account_type,
           'currency', a.currency,
           'balance_minor', coalesce(b.balance_minor, 0)::pg_catalog.text,
           'entry_count', coalesce(b.entry_count, 0)
         ) ORDER BY a.account_type, a.currency), '[]'::pg_catalog.jsonb)
    INTO v_accounts
    FROM public.payment_accounts a
    LEFT JOIN public.payment_account_balances b ON b.account_id = a.id
   WHERE a.owner_id = v_party AND a.owner_kind = 'user'
     AND authz.payment_account_owned_by_profile(a.id, v_profile);

  SELECT coalesce(jsonb_agg(x.entry ORDER BY x.occurred_at DESC, x.entry_id DESC), '[]'::pg_catalog.jsonb)
    INTO v_rows
    FROM (
      SELECT t.occurred_at, e.id AS entry_id,
             jsonb_build_object(
               'entry_id', e.id,
               'transaction_id', e.transaction_id,
               'account_id', e.account_id,
               'account_type', a.account_type,
               'amount_minor', e.amount_minor::pg_catalog.text,
               'currency', e.currency,
               'entry_reason', e.entry_reason,
               'transaction_kind', t.kind,
               'cause_kind', t.cause_kind,
               'cause_id', t.cause_id,
               'subject_kind', t.subject_kind,
               'subject_id', t.subject_id,
               'attribution_version', t.attribution_version,
               'reverses_transaction_id', t.reverses_transaction_id,
               'occurred_at', t.occurred_at
             ) AS entry
        FROM public.payment_accounts a
        JOIN public.payment_ledger_entries e ON e.account_id = a.id
        JOIN public.payment_transactions t ON t.id = e.transaction_id
       WHERE a.owner_id = v_party AND a.owner_kind = 'user'
         AND authz.payment_account_owned_by_profile(e.account_id, v_profile)
         AND (v_cause_kind IS NULL OR (t.cause_kind = v_cause_kind AND t.cause_id = v_cause_id))
         AND (v_before_id IS NULL OR (t.occurred_at, e.id) < (v_before_at, v_before_id))
       ORDER BY t.occurred_at DESC, e.id DESC
       LIMIT v_limit + 1
    ) x;

  IF jsonb_array_length(v_rows) > v_limit THEN
    SELECT coalesce(jsonb_agg(y.entry ORDER BY y.ord), '[]'::pg_catalog.jsonb)
      INTO v_rows
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS y(entry, ord)
     WHERE y.ord <= v_limit;
    IF v_limit > 0 THEN
      v_cursor := jsonb_build_object(
        'before_occurred_at', v_rows->(v_limit - 1)->>'occurred_at',
        'before_entry_id', v_rows->(v_limit - 1)->>'entry_id');
    END IF;
  END IF;

  RETURN jsonb_build_object('has_party', true, 'accounts', v_accounts, 'entries', v_rows, 'next_cursor', v_cursor);
END;
$fn$;
COMMENT ON FUNCTION public.payment_party_ledger(jsonb) IS
  '3823 (09 §10; PAY-073): the party-scoped read. For {profile_id} it returns that profile''s payment accounts with balances, and a page (newest first, keyset cursor) of the ledger entries NAMING THOSE ACCOUNTS, optionally for one cause. Entries on any other account — the counterparty''s, the platform''s, the processor''s — are never in the result, and no returned column belongs to a counterparty. A profile with no payment party gets has_party = false; a failed read raises. Amounts are text. SECURITY INVOKER, search_path pinned to pg_catalog, pg_temp; EXECUTE for service_role only, because it takes the identity as a parameter: the one caller is services/payments/PaymentLedger.ts with requireUser''s user id.';
REVOKE ALL ON FUNCTION public.payment_party_ledger(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_party_ledger(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_party_ledger(jsonb) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- (3) Erasure: the retention setting, and the door.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.payment_retention_settings (
  singleton         boolean     PRIMARY KEY DEFAULT true,
  -- NULL = undecided. The owner ruled "a defined retention period" and gave no
  -- period; until one is recorded here, records are retained and none is due.
  retention_period  interval    NULL,
  -- Where the decision is written down. Required with a period.
  decision_ref      text        NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prs_singleton CHECK (singleton),
  CONSTRAINT prs_period_positive CHECK (retention_period IS NULL OR retention_period > interval '0'),
  CONSTRAINT prs_decision_recorded CHECK ((retention_period IS NULL) = (decision_ref IS NULL))
);
COMMENT ON TABLE public.payment_retention_settings IS
  '3823 (owner ruling 2026-10-04, creator-ledger erasure): how long pseudonymised payment records are kept after a person''s identity is removed — ONE configurable value, in one row. Seeded NULL = undecided. It is read by public.payment_party_remove_identity to report when retention would end; NOTHING deletes on it: there is no purge function, no job, and no DELETE grant on any payment table. Setting the period is an owner decision made by migration (service_role may only SELECT), and it must record where the decision is written (decision_ref).';

ALTER TABLE public.payment_retention_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_retention_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.payment_retention_settings TO service_role;

INSERT INTO public.payment_retention_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION public.payment_party_remove_identity(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  k            pg_catalog.text;
  v_profile    pg_catalog.uuid;
  v_mode       pg_catalog.text;
  v_party      pg_catalog.uuid;
  v_removed_at pg_catalog.timestamptz;
  v_accounts   pg_catalog.int8;
  v_entries    pg_catalog.int8;
  v_period     pg_catalog.interval;
  v_open       pg_catalog.jsonb;
  v_scrubbed   pg_catalog.int8 := 0;
  v_result     pg_catalog.jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'payment_invalid_request: payload_not_an_object' USING ERRCODE = 'PL422';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('profile_id', 'on_open_balance') THEN
      RAISE EXCEPTION 'payment_invalid_request: unknown_field — %', k USING ERRCODE = 'PL422';
    END IF;
  END LOOP;
  IF coalesce(p->>'profile_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'payment_invalid_request: not_a_uuid — profile_id' USING ERRCODE = 'PL422';
  END IF;
  v_profile := (p->>'profile_id')::pg_catalog.uuid;
  v_mode := coalesce(p->>'on_open_balance', 'refuse');
  IF v_mode NOT IN ('refuse', 'retain') THEN
    RAISE EXCEPTION 'payment_invalid_request: on_open_balance — refuse (the default) or retain' USING ERRCODE = 'PL422';
  END IF;

  SELECT pt.id INTO v_party
    FROM public.payment_parties pt
   WHERE pt.kind = 'user' AND pt.profile_id = v_profile;

  IF v_party IS NULL THEN
    -- Nothing is linked: never a payment party, or already removed. Idempotent.
    -- Text that still carries the id is rewritten all the same; there is no
    -- party to rewrite it TO, so the replacement is a fresh id that means nothing.
    v_scrubbed := public.payment_scrub_profile_identifier(v_profile, gen_random_uuid());
    RETURN jsonb_build_object('removed', false, 'accounts', 0, 'entries_retained', 0,
                              'identity_removed_at', NULL, 'retention_period', NULL, 'retain_until', NULL,
                              'identifiers_scrubbed', v_scrubbed, 'open_balances', '[]'::pg_catalog.jsonb);
  END IF;

  -- The posting function's own lock, in its order: a post on one of these
  -- accounts either finished before the balances are read below, or waits.
  PERFORM 1 FROM public.payment_accounts a WHERE a.owner_id = v_party ORDER BY a.id FOR NO KEY UPDATE;

  -- Folded from the entries (the truth), not read off the projection.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_id', o.id, 'account_type', o.account_type, 'currency', o.currency,
           'balance_minor', o.balance::pg_catalog.text) ORDER BY o.account_type, o.currency), '[]'::pg_catalog.jsonb)
    INTO v_open
    FROM (SELECT a.id, a.account_type, a.currency, sum(e.amount_minor) AS balance
            FROM public.payment_accounts a
            JOIN public.payment_ledger_entries e ON e.account_id = a.id
           WHERE a.owner_id = v_party
           GROUP BY a.id, a.account_type, a.currency
          HAVING sum(e.amount_minor) <> 0) o;

  IF jsonb_array_length(v_open) > 0 AND v_mode = 'refuse' THEN
    RAISE EXCEPTION
      'payment_open_balance — this person''s payment party has % account(s) with a non-zero balance; the identity was not removed and nothing was changed', jsonb_array_length(v_open)
      USING ERRCODE = 'PL428',
            DETAIL = v_open::pg_catalog.text,
            HINT = 'Settle each balance to zero first, or pass on_open_balance = retain to remove the identity now and keep the balances on the pseudonymous party, addressed by the party_id that call returns.';
  END IF;

  -- The whole act. payment_party_identity_guard stamps identity_removed_at, and
  -- pp_identity_scrub rewrites any envelope text still carrying the profile id.
  PERFORM set_config('portava.payment_identity_scrubbed_rows', '0', true);
  UPDATE public.payment_parties pt
     SET profile_id = NULL, identity_removed_via = 'erasure_request'
   WHERE pt.id = v_party AND pt.profile_id = v_profile
  RETURNING pt.identity_removed_at INTO v_removed_at;
  IF NOT FOUND THEN
    -- The link went between the read above and here (a concurrent removal).
    RETURN jsonb_build_object('removed', false, 'accounts', 0, 'entries_retained', 0,
                              'identity_removed_at', NULL, 'retention_period', NULL, 'retain_until', NULL,
                              'identifiers_scrubbed', 0, 'open_balances', '[]'::pg_catalog.jsonb);
  END IF;
  v_scrubbed := coalesce(nullif(current_setting('portava.payment_identity_scrubbed_rows', true), ''), '0')::pg_catalog.int8;

  SELECT count(*) INTO v_accounts FROM public.payment_accounts a WHERE a.owner_id = v_party;
  SELECT count(*) INTO v_entries
    FROM public.payment_ledger_entries e
    JOIN public.payment_accounts a ON a.id = e.account_id
   WHERE a.owner_id = v_party;
  SELECT s.retention_period INTO v_period FROM public.payment_retention_settings s WHERE s.singleton;

  v_result := jsonb_build_object(
    'removed', true,
    'accounts', v_accounts,
    'entries_retained', v_entries,
    'identity_removed_at', v_removed_at,
    'retention_period', v_period::pg_catalog.text,
    'retain_until', CASE WHEN v_period IS NULL THEN NULL ELSE v_removed_at + v_period END,
    'identifiers_scrubbed', v_scrubbed,
    'open_balances', v_open);
  -- The party id is returned ONLY with balances left open on it (retain): it is
  -- then the one handle on money still owed. Otherwise it is withheld — the
  -- caller holds the profile id, and the pseudonym beside it is the link again.
  IF jsonb_array_length(v_open) > 0 THEN
    v_result := v_result || jsonb_build_object('party_id', v_party);
  END IF;
  RETURN v_result;
END;
$fn$;
COMMENT ON FUNCTION public.payment_party_remove_identity(jsonb) IS
  '3823 (owner ruling 2026-10-04): pseudonymise a person''s payment records by removing the ONE identity link, payment_parties.profile_id; any envelope text still carrying the profile id is rewritten to the party id (3821 pp_identity_scrub). No amount, account, entry or balance is touched; the records stay linkable through the party id (pseudonymised, not anonymous) and are retained — nothing is deleted. REFUSES with SQLSTATE PL428 payment_open_balance (the balances in DETAIL, as JSON) while any account of the party has a non-zero balance, unless on_open_balance = retain is passed: then the identity is removed, the balances stay on the party, and the result carries open_balances and party_id so the amount stays addressable. Idempotent: a second call reports removed = false. Returns counts, identifiers_scrubbed and the retention answer (retain_until is NULL while public.payment_retention_settings.retention_period is undecided); party_id only in the retain case. SECURITY DEFINER with search_path pinned to pg_catalog, pg_temp; EXECUTE for service_role only.';
REVOKE ALL ON FUNCTION public.payment_party_remove_identity(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_party_remove_identity(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_party_remove_identity(jsonb) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- (4) The read flag, seeded OFF.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'payment_ledger_reads_enabled',
    false,
    'Payment ledger party-scoped reads (09 §10; PAY-073): GET /payments/me/accounts and GET /payments/me/entries return the caller''s OWN payment accounts, balances and ledger entries (test-mode money only). OFF / absent / unreadable (the seed): both routes answer feature_disabled. Turning it ON is the integration lead''s tester flip, after 3821-3823 are applied and verified.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (assertion only) ─────────────────────────────────────────
DO $post$
DECLARE
  n int;
  pr text;
  t text;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.payment_transactions'::regclass AND contype = 'c' AND convalidated
     AND conname IN ('ptx_cause_kind_known', 'ptx_subject_kind_known', 'ptx_attribution_version_shape');
  IF n <> 3 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: % of 3 attribution vocabulary constraints present and validated', n; END IF;

  SELECT count(*) INTO n FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'payment_transactions' AND c.is_nullable = 'NO'
     AND c.column_name IN ('cause_kind', 'cause_id', 'subject_kind', 'subject_id',
                           'beneficiary_account_id', 'attribution_version');
  IF n <> 6 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: % of 6 attribution columns are NOT NULL', n; END IF;

  -- FROZEN: the row guard refuses every UPDATE of the envelope.
  SELECT count(*) INTO n FROM pg_trigger g
   WHERE g.tgrelid = 'public.payment_transactions'::regclass AND NOT g.tgisinternal AND g.tgenabled = 'O'
     AND g.tgname = 'ptx_append_only' AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 16) = 16;
  IF n <> 1 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: the envelope''s row-level update guard is absent; the attribution tuple is not frozen'; END IF;

  SELECT count(*) INTO n FROM pg_trigger g
   WHERE g.tgrelid = 'public.payment_transactions'::regclass AND g.tgname = 'ptx_has_beneficiary_entry'
     AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred AND g.tgenabled = 'O';
  IF n <> 1 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: the deferred beneficiary constraint trigger is absent'; END IF;

  -- PAY-072: the predicate is in authz, pinned, and not a client's to call.
  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace ns ON ns.oid = f.pronamespace
   WHERE ns.nspname = 'authz' AND f.proname = 'payment_account_owned_by_profile'
     AND f.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND NOT f.prosecdef;
  IF n <> 1 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: authz.payment_account_owned_by_profile is absent, not pinned to pg_catalog, pg_temp, or SECURITY DEFINER'; END IF;
  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace ns ON ns.oid = f.pronamespace
   WHERE ns.nspname = 'public' AND f.proname = 'payment_account_owned_by_profile';
  IF n <> 0 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: an ownership predicate that trusts a parameter is in public'; END IF;
  IF has_function_privilege('anon', 'authz.payment_account_owned_by_profile(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'authz.payment_account_owned_by_profile(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '3823: POSTCONDITION FAILED: a client role can execute the ownership predicate';
  END IF;

  FOREACH t IN ARRAY ARRAY['public.payment_party_ledger(jsonb)', 'public.payment_party_remove_identity(jsonb)'] LOOP
    IF has_function_privilege('anon', t, 'EXECUTE') OR has_function_privilege('authenticated', t, 'EXECUTE') THEN
      RAISE EXCEPTION '3823: POSTCONDITION FAILED: a client role can execute %', t;
    END IF;
    IF NOT has_function_privilege('service_role', t, 'EXECUTE') THEN
      RAISE EXCEPTION '3823: POSTCONDITION FAILED: service_role cannot execute %', t;
    END IF;
    SELECT count(*) INTO n FROM pg_proc f
     WHERE f.oid = t::regprocedure AND f.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'];
    IF n <> 1 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: % does not pin search_path to pg_catalog, pg_temp', t; END IF;
  END LOOP;
  -- The deferred beneficiary check runs at COMMIT as the session's role: it is
  -- SECURITY DEFINER, pinned, and no role's to call.
  SELECT count(*) INTO n FROM pg_proc f
   WHERE f.oid = 'public.payment_transaction_beneficiary_is_party()'::regprocedure AND f.prosecdef
     AND f.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'];
  IF n <> 1 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: payment_transaction_beneficiary_is_party is not SECURITY DEFINER with search_path pinned to pg_catalog, pg_temp'; END IF;
  IF has_function_privilege('service_role', 'public.payment_transaction_beneficiary_is_party()', 'EXECUTE') THEN
    RAISE EXCEPTION '3823: POSTCONDITION FAILED: service_role can execute payment_transaction_beneficiary_is_party';
  END IF;
  SELECT count(*) INTO n FROM pg_proc f
   WHERE f.oid = 'public.payment_party_remove_identity(jsonb)'::regprocedure AND f.prosecdef;
  IF n <> 1 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: payment_party_remove_identity is not SECURITY DEFINER'; END IF;
  -- Nothing of 3821-3823 is left on an empty search_path.
  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace ns ON ns.oid = f.pronamespace
   WHERE ns.nspname IN ('public', 'authz') AND left(f.proname, 8) = 'payment_'
     AND NOT coalesce(f.proconfig, '{}'::text[]) @> ARRAY['search_path=pg_catalog, pg_temp'];
  IF n <> 0 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: % payment function(s) do not pin search_path to pg_catalog, pg_temp', n; END IF;
  SELECT count(*) INTO n FROM pg_proc f
   WHERE f.oid = 'public.payment_party_ledger(jsonb)'::regprocedure AND f.prosecdef;
  IF n <> 0 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: payment_party_ledger is SECURITY DEFINER; it must read as its caller'; END IF;

  -- Still deny-all: no policy on any payment table, and no client privilege.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND left(tablename, 8) = 'payment_';
  IF n <> 0 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: % polic(y/ies) on payment tables; they are deny-all by design', n; END IF;
  FOREACH pr IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.payment_retention_settings', pr)
       OR has_table_privilege('authenticated', 'public.payment_retention_settings', pr) THEN
      RAISE EXCEPTION '3823: POSTCONDITION FAILED: a client role holds % on payment_retention_settings', pr;
    END IF;
    IF has_table_privilege('service_role', 'public.payment_retention_settings', pr) <> (pr = 'SELECT') THEN
      RAISE EXCEPTION '3823: POSTCONDITION FAILED: service_role must hold SELECT and only SELECT on payment_retention_settings; % is wrong', pr;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'payment_retention_settings' AND c.relrowsecurity;
  IF n <> 1 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: row level security is off on payment_retention_settings'; END IF;
  SELECT count(*) INTO n FROM public.payment_retention_settings;
  IF n <> 1 THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: payment_retention_settings holds % rows, not 1', n; END IF;

  -- No deletion is enabled: no role but the owner may DELETE a payment row.
  FOREACH t IN ARRAY ARRAY['payment_parties', 'payment_accounts', 'payment_transactions',
                           'payment_ledger_entries', 'payment_account_balances'] LOOP
    IF has_table_privilege('service_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION '3823: POSTCONDITION FAILED: service_role can DELETE from %', t;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'payment_ledger_reads_enabled') THEN
    RAISE EXCEPTION '3823: POSTCONDITION FAILED: payment_ledger_reads_enabled is absent';
  END IF;
END
$post$;

-- ── Probe: PROVE the attribution rules, then roll back ──────────────────────
-- Platform accounts only: no profile is read or touched by this file. The
-- erasure door needs a person and is proved by src/test/db/paymentLedger.db.test.ts.
DO $probe$
DECLARE
  v_revenue  uuid;
  v_refunds  uuid;
  v_stranger uuid;
  v_req      jsonb;
  v_tx       uuid;
  unknown_cause_refused        boolean := false;
  unknown_subject_refused      boolean := false;
  frozen                       boolean := false;
  stranger_beneficiary_refused boolean := false;
  debited_beneficiary_refused  boolean := false;
  one_account_refused          boolean := false;
BEGIN
  BEGIN
    v_revenue := (public.payment_account_ensure(jsonb_build_object(
      'owner_kind', 'platform', 'owner_label', 'probe_3823', 'account_type', 'platform_revenue', 'currency', 'USD'))->>'account_id')::uuid;
    v_refunds := (public.payment_account_ensure(jsonb_build_object(
      'owner_kind', 'platform', 'owner_label', 'probe_3823', 'account_type', 'refund_liability', 'currency', 'USD'))->>'account_id')::uuid;
    v_stranger := (public.payment_account_ensure(jsonb_build_object(
      'owner_kind', 'platform', 'owner_label', 'probe_3823', 'account_type', 'hold_reserve', 'currency', 'USD'))->>'account_id')::uuid;

    v_req := jsonb_build_object(
      'scope', 'probe:3823', 'idempotency_key', 'probe-1', 'kind', 'fee', 'currency', 'USD',
      'original_currency', 'USD', 'original_amount_minor', 700,
      'cause_kind', 'adjustment', 'cause_id', 'probe', 'subject_kind', 'booking', 'subject_id', 'probe',
      'beneficiary_account_id', v_revenue, 'attribution_version', 'probe/v1', 'occurred_at', now(),
      'entries', jsonb_build_array(
        jsonb_build_object('account_id', v_revenue, 'amount_minor', 700, 'entry_reason', 'platform_fee'),
        jsonb_build_object('account_id', v_refunds, 'amount_minor', -700, 'entry_reason', 'platform_fee')));

    -- An attribution outside the vocabulary is refused by name.
    BEGIN
      PERFORM public.payment_post_transaction(v_req || jsonb_build_object('cause_kind', 'gift', 'idempotency_key', 'probe-0'));
    EXCEPTION WHEN SQLSTATE 'PL422' THEN unknown_cause_refused := true;
    END;
    BEGIN
      PERFORM public.payment_post_transaction(v_req || jsonb_build_object('subject_kind', 'user', 'idempotency_key', 'probe-0'));
    EXCEPTION WHEN SQLSTATE 'PL422' THEN unknown_subject_refused := true;
    END;

    -- The account a transaction DEBITS is not its beneficiary; and two entries
    -- on one account are not a movement.
    BEGIN
      PERFORM public.payment_post_transaction(v_req || jsonb_build_object('beneficiary_account_id', v_refunds, 'idempotency_key', 'probe-0'));
    EXCEPTION WHEN SQLSTATE 'PL422' THEN debited_beneficiary_refused := (SQLERRM LIKE '%beneficiary_not_credited%');
    END;
    BEGIN
      PERFORM public.payment_post_transaction(v_req || jsonb_build_object('idempotency_key', 'probe-0', 'entries', jsonb_build_array(
        jsonb_build_object('account_id', v_revenue, 'amount_minor', 700, 'entry_reason', 'platform_fee'),
        jsonb_build_object('account_id', v_revenue, 'amount_minor', -700, 'entry_reason', 'platform_fee'))));
    EXCEPTION WHEN SQLSTATE 'PL422' THEN one_account_refused := (SQLERRM LIKE '%entries_too_few%');
    END;

    v_tx := (public.payment_post_transaction(v_req)->>'transaction_id')::uuid;

    -- The tuple is frozen.
    BEGIN
      UPDATE public.payment_transactions SET cause_id = 'rewritten', attribution_version = 'probe/v2' WHERE id = v_tx;
    EXCEPTION WHEN SQLSTATE 'PL001' THEN frozen := true;
    END;

    -- A beneficiary no entry touches is refused at the table, for any writer.
    BEGIN
      INSERT INTO public.payment_transactions
        (kind, scope, idempotency_key, content_hash, currency, livemode, original_currency,
         original_amount_minor, cause_kind, cause_id, subject_kind, subject_id,
         beneficiary_account_id, attribution_version, occurred_at)
      VALUES ('fee', 'probe:3823', 'probe-2', repeat('0', 64), 'USD', false, 'USD', 5,
              'adjustment', 'probe', 'booking', 'probe', v_stranger, 'probe/v1', now())
      RETURNING id INTO v_tx;
      INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason)
      VALUES (v_tx, v_revenue, 5, 'USD', false, 'adjustment'), (v_tx, v_refunds, -5, 'USD', false, 'adjustment');
      SET CONSTRAINTS public.ptx_has_beneficiary_entry IMMEDIATE;
    EXCEPTION WHEN SQLSTATE 'PL006' THEN stranger_beneficiary_refused := true;
    END;

    RAISE EXCEPTION USING ERRCODE = 'PL999', MESSAGE = '3823 probe rollback';
  EXCEPTION WHEN SQLSTATE 'PL999' THEN
    NULL;
  END;

  IF NOT unknown_cause_refused THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: a cause_kind outside the vocabulary was accepted'; END IF;
  IF NOT unknown_subject_refused THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: a person was accepted as the subject of a payment'; END IF;
  IF NOT frozen THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: an attribution tuple was rewritten'; END IF;
  IF NOT stranger_beneficiary_refused THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: a beneficiary no entry touches was accepted'; END IF;
  IF NOT debited_beneficiary_refused THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: a debited account was accepted as the beneficiary'; END IF;
  IF NOT one_account_refused THEN RAISE EXCEPTION '3823: POSTCONDITION FAILED: a transaction naming one account was accepted'; END IF;
  IF EXISTS (SELECT 1 FROM public.payment_parties WHERE label = 'probe_3823')
     OR EXISTS (SELECT 1 FROM public.payment_transactions WHERE scope = 'probe:3823') THEN
    RAISE EXCEPTION '3823: POSTCONDITION FAILED: the probe left a row behind';
  END IF;
END
$probe$;

COMMIT;

-- The flag ships OFF (assertion only; nothing below changes anything).
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'payment_ledger_reads_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3823): payment_ledger_reads_enabled is ON — it must ship OFF';
  END IF;
END $post$;
