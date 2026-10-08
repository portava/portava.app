-- 3821_payment_ledger.sql
-- The double-entry payment ledger: parties, accounts, transactions, entries.
-- docs/architecture/09_Payment_Architecture.md §4, §5 (invariants I1-I5, I7), §7.2, §10.
-- Requirement rows PAY-021, PAY-022, PAY-026, PAY-028, PAY-031, PAY-033, PAY-037,
-- PAY-038 and the index half of PAY-047 (task PAY-T05).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; payments owns
-- 3820-3859). APPLIED TO NO SHARED DATABASE. Rehearsed on a private throwaway
-- PostgreSQL 16 only (apply, re-apply, rollback, re-apply).
--   NOT applied to portava-ci (hwokxgbmezheskbzskfr).
--   NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--   public.payment_parties         who an account belongs to. The ONLY row that
--                                  links money to a profile, and the link is one
--                                  nullable column (see ERASURE below).
--   public.payment_accounts        one row per (owner_kind, owner_id,
--                                  account_type, currency) — `09` §4. owner_id is
--                                  a payment_parties id, never a profile id.
--   public.payment_transactions    the envelope (`09` §5.4): kind, idempotency,
--                                  the attribution tuple, currency and conversion
--                                  details, external_ref, occurred_at.
--   public.payment_ledger_entries  account, signed amount_minor, currency,
--                                  entry_reason — and nothing else (PAY-038).
--   public.payment_account_ensure(jsonb)  idempotent account creation (PAY-022).
--
-- EVERY FUNCTION OF 3821-3823 PINS `search_path TO pg_catalog, pg_temp` — pg_temp
-- LAST, and named. An empty search_path does NOT exclude pg_temp: PostgreSQL
-- then searches it FIRST for relation and TYPE names, so a caller's
-- `CREATE DOMAIN pg_temp.uuid … CHECK (pg_temp.f())` ran f() as the owner of a
-- SECURITY DEFINER function that declared a `uuid` variable. Every type inside
-- a function body is also written pg_catalog.<type>, and every table public.<t>.
--
-- SIGN CONVENTION, fixed here because every reader depends on it: a CREDIT is a
-- positive amount_minor and a DEBIT is negative, as 2901/2921 already write
-- them (payable and revenue positive, receivable negative). An account's
-- balance is SUM(amount_minor) over its entries; a party with no entries has a
-- zero balance by construction, not by a seeded row (`09` §4).
--
-- ── THE INVARIANTS, AND WHAT ENFORCES EACH (`09` §5.3) ──────────────────────
--   I1  every entry belongs to one transaction, and a transaction's entries sum
--       to zero: CONSTRAINT TRIGGERs ple_transaction_balances (on entries) and
--       ptx_has_balanced_entries (on the envelope, so an envelope with NO
--       entries is refused too), both DEFERRABLE INITIALLY DEFERRED — checked at
--       COMMIT, because the two sides are separate INSERTs. A transaction names
--       at least two DIFFERENT accounts (a +500/-500 pair on one account moves
--       nothing), and when it is booked in the currency it was presented in,
--       its credits total original_amount_minor.
--       SEALED: an entry may only be inserted in the database transaction that
--       inserted its envelope (ple_transaction_is_open). Two things must both
--       hold: the envelope's id was announced by an AFTER INSERT row trigger —
--       which fires only for a row actually inserted, so `INSERT … ON CONFLICT
--       DO NOTHING` over a committed id announces nothing — and the envelope's
--       created_at, which a BEFORE INSERT trigger forces to now(), equals THIS
--       transaction's now(), so a hand-written announcement cannot open an
--       envelope another transaction committed. WHAT THIS DOES NOT CONSTRAIN,
--       and it is all about the table owner (service_role, authenticated and
--       anon hold no write privilege at all): (a) a role that can disable
--       triggers — the owner by ALTER TABLE … DISABLE TRIGGER, a superuser by
--       session_replication_role — is bound by no trigger; (b) inside the ONE
--       database transaction that created an envelope, the owner writing
--       directly can still add a balanced pair to it after the posting function
--       has returned, by re-announcing it by hand; (c) two transactions that
--       began in the same microsecond share a now(). In each case the owner
--       must act deliberately, the pair must still balance, and the result is a
--       projection that no longer equals its entries — which the reconciliation
--       job (`09` §4, unbuilt) is what would notice.
--   I2  immutable: no INSERT, UPDATE or DELETE grant to service_role at all (the
--       only writers are the SECURITY DEFINER functions of this file and 3822),
--       plus a BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger that raises.
--   I3  NO statement-level UPDATE/DELETE trigger (2292: it refuses an erasure
--       cascade whether or not there is anything to protect). Row-level, plus
--       TRUNCATE-level, only. A postcondition asserts it.
--   I4  a transaction is single-currency: entries reference
--       payment_transactions (id, currency, livemode) by a composite foreign
--       key, so an entry in another currency than its envelope is refused.
--   I5  amount_minor <> 0 (CHECK), and an entry's currency is its account's:
--       composite foreign key to payment_accounts (id, currency, livemode).
--   I7  attribution and idempotency are NOT NULL and non-empty on the envelope.
--       (I6 — the balance floor — is the posting function's, in 3822; the
--       attribution VOCABULARY is 3823's.)
--
-- ── OWNER RULINGS OF 2026-10-04 THIS SCHEMA IS BUILT TO ─────────────────────
-- CURRENCIES ("store the original transaction currency and amount, plus any
--   conversion details; don't assume one currency"): no column defaults a
--   currency. The envelope carries `currency` (what its entries are booked in),
--   `original_currency` + `original_amount_minor` (what the customer was
--   presented), and, whenever the two currencies differ, the rate actually
--   applied, its source and its timestamp (`09` §8) — CHECK-required then, and
--   CHECK-forbidden otherwise, so a conversion can be neither omitted nor
--   invented.
-- ERASURE ("pseudonymize accounting entries, removing direct identifiers and
--   the identity link … keep only the records needed"): the link is
--   payment_parties.profile_id, ON DELETE SET NULL, and removing it is the ONE
--   change payment_parties permits. No entry or account row has a column that
--   could hold a person. The ENVELOPE has seven text columns that could
--   (scope, idempotency_key, cause_id, subject_id, attribution_version,
--   external_ref, fx_rate_source), so they are guarded twice:
--   AT THE DOOR, for every writer — trigger ptx_admit refuses a row whose text
--   contains the id of any profile (so of any party's profile), spelled with or
--   without dashes in either case; CHECK ptx_no_contact_details refuses an
--   '@', a +<digits> phone number, and a cause/subject/key that is nothing but
--   digits; external_ref must have a provider object id's shape; scope,
--   attribution_version and fx_rate_source are slugs. A cause or subject that
--   really is a person is written as their PARTY id, never their profile id.
--   AT ERASURE — when a party's link is removed (by 3823's door or by profiles'
--   ON DELETE SET NULL) trigger pp_identity_scrub rewrites any envelope text
--   that still carries that profile id to the party id, and tombstones an
--   idempotency key that carried it. That rewrite is the one UPDATE
--   payment_transactions permits, and it can change nothing else.
--   WHAT CANNOT BE DETECTED: a name, a username, an id in an encoding other
--   than hex, or the id of a profile whose row no longer exists (nothing is
--   left to recognise it by — keeping a list of erased ids would be keeping
--   the identifiers). The seven columns are for ids of things, and say so.
--   The scrub leaves content_hash as it was: it is the hash of what was first
--   posted, so a replay of that content is still recognised as a replay (or
--   is refused at the door, while the profile row exists).
--   The rows stay LINKABLE to each other through the party id: this is
--   pseudonymisation, not anonymisation. The door, the open-balance rule, the
--   retention setting and their tests are 3823's.
-- FEES AND TIPS ("10% … no platform commission on tips … configurable by
--   product and market"): no rate lives here. entry_reason separates
--   'principal', 'tip' and 'platform_fee' so a fee is never folded into what it
--   was charged on (`09` §5.2: reasons, not account types).
-- TEST MODE ONLY: `livemode` is on every account, envelope and entry, is part
--   of both composite keys (a live entry could only ever name a live account
--   and a live envelope), and is CHECK-constrained FALSE on accounts and
--   envelopes. Recording live money needs a migration that says so — the
--   intel_reward_ledger `CHECK (cash_amount = 0)` posture (`09` §1.5).
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
-- * No provider is named, imported or called. external_ref is a provider OBJECT
--   id — `<prefix>_<token>` — and nothing else; an adapter whose provider issues
--   bare numbers stores them under its own prefix.
-- * No account type is defined for an `external` party. `09` §5.2 pairs none of
--   the nine with it (the cash memo of §9.2 is unbuilt), so the owner-kind
--   vocabulary admits `external` and the pairing CHECK admits no account for it
--   yet. Adding one is a migration, with its reason.
-- * No client grant and no policy: RLS is enabled with zero policies, so every
--   role but the table owner and service_role is denied, and service_role may
--   only SELECT.
--
-- RUNTIME EFFECT ON EXISTING SURFACES: none. Nothing in the tree reads or
-- writes these tables until 3822/3823 and services/payments/PaymentLedger.ts.
--
-- Rollback: db/rollback/2026-10-04-3821-payment-ledger-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3821): public.profiles does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3821): the anon / authenticated / service_role roles are not all present.';
  END IF;
  -- Refuse to adopt a same-named table that is not the one this file creates.
  IF to_regclass('public.payment_accounts') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payment_accounts' AND column_name = 'livemode') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3821): public.payment_accounts exists and is not the table this file creates.';
  END IF;
  IF to_regclass('public.payment_transactions') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payment_transactions' AND column_name = 'content_hash') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3821): public.payment_transactions exists and is not the table this file creates.';
  END IF;
END
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Parties: the one place identity touches money.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.payment_parties (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text        NOT NULL,
  -- THE IDENTITY LINK. SET NULL, not CASCADE and not RESTRICT: a profile's
  -- deletion must neither delete accounting records nor be blocked by them.
  profile_id           uuid        NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- What a non-user party is: 'portava', a processor's name, …
  label                text        NULL,
  identity_removed_at  timestamptz NULL,
  identity_removed_via text        NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pp_kind_known CHECK (kind IN ('user', 'platform', 'processor', 'external')),
  -- A user party has a profile OR has had its identity removed, never both and
  -- never neither. A non-user party never carries a profile.
  CONSTRAINT pp_identity_shape CHECK (
    (kind = 'user' AND label IS NULL
       AND (profile_id IS NOT NULL) <> (identity_removed_at IS NOT NULL)
       AND (identity_removed_at IS NULL) = (identity_removed_via IS NULL))
    OR
    (kind <> 'user' AND profile_id IS NULL AND identity_removed_at IS NULL
       AND identity_removed_via IS NULL
       AND label IS NOT NULL AND label ~ '^[a-z][a-z0-9_]{0,62}$')),
  CONSTRAINT pp_identity_removed_via_known CHECK (
    identity_removed_via IS NULL OR identity_removed_via IN ('erasure_request', 'profile_deleted')),
  -- TOTAL indexes (NULLs are distinct), so ON CONFLICT inference matches them.
  CONSTRAINT pp_one_party_per_profile UNIQUE (profile_id),
  CONSTRAINT pp_one_party_per_label UNIQUE (kind, label),
  CONSTRAINT pp_id_kind_key UNIQUE (id, kind)
);
COMMENT ON TABLE public.payment_parties IS
  '3821 (09 §4 "party"): who a payment account belongs to. The ONLY row that links money to a profile. profile_id is ON DELETE SET NULL and its removal is the one UPDATE this table permits (payment_party_identity_guard): the party id stays, so every account, entry and transaction of the person is retained and still linkable to the others — pseudonymised, not anonymous (owner ruling 2026-10-04, creator-ledger erasure). No client grant; service_role may only SELECT.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Accounts: (owner_kind, owner_id, account_type, currency) — `09` §4, §5.2.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.payment_accounts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind    text        NOT NULL,
  owner_id      uuid        NOT NULL,
  account_type  text        NOT NULL,
  currency      char(3)     NOT NULL,
  livemode      boolean     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pa_owner_fk FOREIGN KEY (owner_id, owner_kind)
    REFERENCES public.payment_parties (id, kind),
  CONSTRAINT pa_owner_kind_known CHECK (owner_kind IN ('user', 'platform', 'processor', 'external')),
  -- `09` §5.2's nine. buddy_payable / creator_payable (2901, 2921) are
  -- user_payable here; traveler_receivable is user_receivable.
  CONSTRAINT pa_account_type_known CHECK (account_type IN (
    'user_payable', 'user_receivable', 'platform_revenue', 'platform_fee_expense',
    'processor_clearing', 'payout_in_transit', 'hold_reserve', 'refund_liability',
    'tax_withheld')),
  -- … each with ITS owner kind, per the same table.
  CONSTRAINT pa_account_type_owner_kind CHECK (
    (owner_kind = 'user' AND account_type IN ('user_payable', 'user_receivable'))
    OR (owner_kind = 'platform' AND account_type IN (
          'platform_revenue', 'platform_fee_expense', 'payout_in_transit',
          'hold_reserve', 'refund_liability', 'tax_withheld'))
    OR (owner_kind = 'processor' AND account_type = 'processor_clearing')),
  CONSTRAINT pa_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT pa_test_mode_only CHECK (livemode = false),
  CONSTRAINT pa_one_account_per_owner_type_currency
    UNIQUE (owner_kind, owner_id, account_type, currency, livemode),
  -- The target of I5's composite key.
  CONSTRAINT pa_id_currency_mode_key UNIQUE (id, currency, livemode)
);
COMMENT ON TABLE public.payment_accounts IS
  '3821 (09 §4, §5.2; PAY-021, PAY-026): the addressable unit — a party x one of the nine account types x a currency. owner_id is a payment_parties id, never a profile id, so nothing here changes when a person is erased. A balance is SUM(payment_ledger_entries.amount_minor), credits positive; an account with no entries has balance zero by construction. livemode is CHECK-constrained FALSE: this ledger records test-mode money only. Append-only.';

CREATE INDEX IF NOT EXISTS pa_owner_idx ON public.payment_accounts (owner_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Transactions: the envelope — `09` §5.4, §6, §7, §8.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    text        NOT NULL,

  -- `09` §7: the key is derived from the EVENT, and uniqueness is an index.
  scope                   text        NOT NULL,
  idempotency_key         text        NOT NULL,
  -- sha256 of the posted content (3822), so a replay under the same key can be
  -- told from a DIFFERENT request under the same key.
  content_hash            text        NOT NULL,

  -- What the entries are booked in, and what the customer was presented.
  currency                char(3)     NOT NULL,
  livemode                boolean     NOT NULL,
  original_currency       char(3)     NOT NULL,
  original_amount_minor   bigint      NOT NULL,
  -- `09` §8: the rate ACTUALLY APPLIED, its source and its timestamp. DIRECTION:
  -- units of `currency` (booked) per ONE unit of `original_currency`, both in
  -- MAJOR units — 75 000 JPY booked as 502.50 USD is 0.0067. `09` §2's fx_rates
  -- reads the same way round (units of currency per 1 base).
  fx_rate                 numeric     NULL,
  fx_rate_source          text        NULL,
  fx_rate_at              timestamptz NULL,
  fx_transaction_id       uuid        NULL REFERENCES public.payment_transactions(id),

  -- `09` §9.2: a reversal is a NEW transaction naming the one it negates.
  reverses_transaction_id uuid        NULL REFERENCES public.payment_transactions(id),

  -- `09` §6: the attribution tuple, frozen at write time (I7: NOT NULL here;
  -- the vocabularies are 3823's).
  cause_kind              text        NOT NULL,
  cause_id                text        NOT NULL,
  subject_kind            text        NOT NULL,
  subject_id              text        NOT NULL,
  beneficiary_account_id  uuid        NOT NULL,
  attribution_version     text        NOT NULL,

  -- The processor's object id: `<prefix>_<token>`. Nothing here knows a provider.
  external_ref            text        NULL,
  occurred_at             timestamptz NOT NULL,
  -- Forced to now() by ptx_admit, whatever a writer supplies: it is half of the
  -- seal (an entry needs an envelope created in ITS OWN database transaction).
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ptx_kind_known CHECK (kind IN (
    'charge', 'capture', 'fee', 'payout', 'refund', 'chargeback', 'reversal', 'fx')),
  -- The scope NAMES the event's source and, for a client-chosen key, WHOSE key
  -- it is: `http:<operation>:<the caller's payment PARTY id>` (lib/http.ts
  -- requireIdempotencyKey), so two callers who pick the same key never meet.
  -- A lower-case slug. A party id is welcome; a PROFILE id is refused by
  -- ptx_admit, here as in every other text column.
  CONSTRAINT ptx_scope_shape CHECK (scope ~ '^[a-z0-9][a-z0-9:._/-]{0,119}$'),
  CONSTRAINT ptx_idempotency_key_shape CHECK (
    length(idempotency_key) BETWEEN 1 AND 255 AND idempotency_key = btrim(idempotency_key)),
  -- `09` §7.2. TOTAL, so a replay is found by the index, never by a read.
  CONSTRAINT ptx_idempotency_once UNIQUE (scope, idempotency_key),
  CONSTRAINT ptx_content_hash_shape CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ptx_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ptx_original_currency_shape CHECK (original_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ptx_original_amount_positive CHECK (original_amount_minor > 0),
  CONSTRAINT ptx_test_mode_only CHECK (livemode = false),
  -- A conversion is stated in full or not at all (`09` §8 "never fabricate").
  CONSTRAINT ptx_conversion_details CHECK (
    (original_currency = currency
       AND fx_rate IS NULL AND fx_rate_source IS NULL AND fx_rate_at IS NULL)
    OR
    (original_currency <> currency
       AND fx_rate IS NOT NULL AND fx_rate > 0
       AND fx_rate_source IS NOT NULL AND length(btrim(fx_rate_source)) BETWEEN 1 AND 120
       AND fx_rate_at IS NOT NULL)),
  CONSTRAINT ptx_fx_link_is_fx CHECK (fx_transaction_id IS NULL OR kind = 'fx'),
  CONSTRAINT ptx_no_self_link CHECK (
    fx_transaction_id IS DISTINCT FROM id AND reverses_transaction_id IS DISTINCT FROM id),
  CONSTRAINT ptx_reversal_is_linked CHECK ((kind = 'reversal') = (reverses_transaction_id IS NOT NULL)),
  -- I7: present AND non-empty. Absence is not permitted to be silent.
  CONSTRAINT ptx_attribution_present CHECK (
    length(btrim(cause_kind)) BETWEEN 1 AND 60
    AND length(btrim(cause_id)) BETWEEN 1 AND 200
    AND length(btrim(subject_kind)) BETWEEN 1 AND 60
    AND length(btrim(subject_id)) BETWEEN 1 AND 200
    AND length(btrim(attribution_version)) BETWEEN 1 AND 120),
  -- A provider object id (pi_…, ch_…, re_…, po_…, evt_…): a short lower-case
  -- prefix, an underscore, a token. Not an email, not a note, not free text.
  CONSTRAINT ptx_external_ref_shape CHECK (
    external_ref IS NULL OR external_ref ~ '^[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{4,200}$'),
  CONSTRAINT ptx_fx_rate_source_shape CHECK (
    fx_rate_source IS NULL OR fx_rate_source ~ '^[a-z0-9][a-z0-9:._/-]{0,119}$'),
  -- Named to sort AFTER ptx_attribution_present (CHECKs are tested in name
  -- order), so a blank id is still reported as absent. No text column may hold
  -- an '@' or a +<digits> phone number, and a key, cause or subject may not be
  -- digits and separators alone: a bare number cannot be told from a phone
  -- number, so a numeric id is written with what it is an id OF — `booking:42`.
  CONSTRAINT ptx_no_contact_details CHECK (
    (scope || '|' || idempotency_key || '|' || cause_id || '|' || subject_id || '|' || attribution_version
       || '|' || coalesce(external_ref, '') || '|' || coalesce(fx_rate_source, ''))
      !~ '@|\+[0-9][0-9 ().-]{5,}[0-9]'
    AND idempotency_key !~ '^[0-9 ().+-]{1,20}$'
    AND cause_id !~ '^[0-9 ().+-]{1,20}$'
    AND subject_id !~ '^[0-9 ().+-]{1,20}$'),
  -- The beneficiary is an account in this transaction's currency and mode.
  CONSTRAINT ptx_beneficiary_fk FOREIGN KEY (beneficiary_account_id, currency, livemode)
    REFERENCES public.payment_accounts (id, currency, livemode),
  -- The target of I4's composite key.
  CONSTRAINT ptx_id_currency_mode_key UNIQUE (id, currency, livemode)
);
COMMENT ON TABLE public.payment_transactions IS
  '3821 (09 §5.4; PAY-037, PAY-047): one row per money movement, carrying kind, (scope, idempotency_key) UNIQUE, the frozen attribution tuple (09 §6), the booked currency with the ORIGINAL currency and amount and any conversion details (owner ruling 2026-10-04), external_ref and occurred_at. Its entries are payment_ledger_entries. Append-only; livemode CHECK-constrained FALSE. Its text columns are ids of THINGS: a row whose text contains a profile id, an @ or a +phone number is refused at INSERT for every writer (ptx_admit, ptx_no_contact_details), a person is referred to by payment PARTY id, and the one UPDATE the table permits is the erasure scrub that replaces a removed profile id with its party id (pp_identity_scrub). A name or an id in another encoding cannot be detected.';
COMMENT ON COLUMN public.payment_transactions.fx_rate IS
  '09 §8: the rate actually applied — units of currency (booked) per ONE unit of original_currency, both in MAJOR units. Stored as handed in; the ledger knows no currency''s minor-unit exponent and converts nothing.';
COMMENT ON COLUMN public.payment_transactions.original_amount_minor IS
  'What the customer was presented, in minor units of original_currency. When original_currency = currency it equals the sum of the transaction''s credit entries (checked at COMMIT, SQLSTATE PL007). When they differ it is not comparable to the entries without each currency''s exponent, so it is stored beside fx_rate and not checked against them.';
COMMENT ON COLUMN public.payment_transactions.external_ref IS
  'The provider object id, <prefix>_<token>. Constrained to that shape: this column is not for notes or contact details.';

-- At most one reversal per transaction: reversing twice re-credits money once owed.
CREATE UNIQUE INDEX IF NOT EXISTS ptx_one_reversal_per_transaction
  ON public.payment_transactions (reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ptx_cause_idx ON public.payment_transactions (cause_kind, cause_id);
CREATE INDEX IF NOT EXISTS ptx_beneficiary_idx ON public.payment_transactions (beneficiary_account_id);
CREATE INDEX IF NOT EXISTS ptx_external_ref_idx
  ON public.payment_transactions (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS ptx_fx_link_idx
  ON public.payment_transactions (fx_transaction_id) WHERE fx_transaction_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Entries: account, signed amount, currency, reason — `09` §5.4 (PAY-038).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.payment_ledger_entries (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid    NOT NULL,
  account_id      uuid    NOT NULL,
  -- Integer minor units, signed: credit positive, debit negative. Never zero.
  amount_minor    bigint  NOT NULL,
  currency        char(3) NOT NULL,
  livemode        boolean NOT NULL,
  entry_reason    text    NOT NULL,

  CONSTRAINT ple_amount_non_zero CHECK (amount_minor <> 0),
  -- 'principal', 'tip' and 'platform_fee' are separate reasons so that a fee is
  -- never folded into what it was charged on, and a tip never into a price.
  CONSTRAINT ple_entry_reason_known CHECK (entry_reason IN (
    'principal', 'tip', 'platform_fee', 'customer_service_fee', 'processor_fee', 'tax',
    'hold', 'hold_release', 'payout', 'payout_return', 'refund', 'chargeback',
    'chargeback_fee', 'reversal', 'fx_conversion', 'fx_spread', 'rounding', 'adjustment')),
  -- I4: the entry's currency (and mode) is its transaction's.
  CONSTRAINT ple_transaction_fk FOREIGN KEY (transaction_id, currency, livemode)
    REFERENCES public.payment_transactions (id, currency, livemode),
  -- I5: … and its account's.
  CONSTRAINT ple_account_fk FOREIGN KEY (account_id, currency, livemode)
    REFERENCES public.payment_accounts (id, currency, livemode)
);
COMMENT ON TABLE public.payment_ledger_entries IS
  '3821 (09 §5.3 I1-I5, §5.4; PAY-028, PAY-031, PAY-033, PAY-038): the only truth. One signed integer amount in minor units (credit positive, debit negative, never zero) against one account, under one transaction, with a reason. Currency and mode are constrained to the transaction''s AND the account''s by composite foreign keys. A transaction''s entries sum to zero, checked at COMMIT. Append-only: no UPDATE or DELETE grant, and a row-level trigger refuses both.';

CREATE INDEX IF NOT EXISTS ple_transaction_idx ON public.payment_ledger_entries (transaction_id);
CREATE INDEX IF NOT EXISTS ple_account_idx ON public.payment_ledger_entries (account_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- What an erased profile id looks like in text, and what replaces it.
-- ═══════════════════════════════════════════════════════════════════════════
-- Pure functions of their arguments. They are shared by the scrub (which
-- performs the rewrite) and by the append-only guard (which permits an UPDATE of
-- payment_transactions only when it IS that rewrite), so the two cannot disagree.
CREATE OR REPLACE FUNCTION public.payment_identifier_pattern(p_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $fn$
  -- The id's 32 hex digits with an optional dash between any two: it matches the
  -- canonical spelling, the dashless one, and anything between. Used with ~*.
  SELECT pg_catalog.array_to_string(
           pg_catalog.regexp_split_to_array(pg_catalog.replace(p_id::pg_catalog.text, '-', ''), ''), '-?');
$fn$;
REVOKE ALL ON FUNCTION public.payment_identifier_pattern(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_identifier_pattern(uuid) FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payment_identifier_scrubbed(p_value text, p_profile uuid, p_replacement uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $fn$
  -- The canonical spelling becomes the replacement's canonical spelling; any
  -- other spelling becomes its dashless one. NULL stays NULL.
  SELECT pg_catalog.regexp_replace(
           pg_catalog.regexp_replace(p_value, p_profile::pg_catalog.text, p_replacement::pg_catalog.text, 'gi'),
           public.payment_identifier_pattern(p_profile),
           pg_catalog.replace(p_replacement::pg_catalog.text, '-', ''), 'gi');
$fn$;
REVOKE ALL ON FUNCTION public.payment_identifier_scrubbed(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_identifier_scrubbed(text, uuid, uuid) FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payment_transaction_scrubbed(
  p_row public.payment_transactions, p_profile uuid, p_replacement uuid)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  -- The seven text columns of an envelope as they stand once p_profile is gone.
  -- A key that carried the id (or sits under a scope that did) is tombstoned
  -- whole: `scrubbed:<transaction id>` is unique by construction, so an erasure
  -- can never fail on ptx_idempotency_once.
  RETURN jsonb_build_object(
    'scope', public.payment_identifier_scrubbed(p_row.scope, p_profile, p_replacement),
    'idempotency_key', CASE
      WHEN (p_row.scope || '|' || p_row.idempotency_key) ~* public.payment_identifier_pattern(p_profile)
        THEN 'scrubbed:' || p_row.id::pg_catalog.text
      ELSE p_row.idempotency_key END,
    'cause_id', public.payment_identifier_scrubbed(p_row.cause_id, p_profile, p_replacement),
    'subject_id', public.payment_identifier_scrubbed(p_row.subject_id, p_profile, p_replacement),
    'attribution_version', public.payment_identifier_scrubbed(p_row.attribution_version, p_profile, p_replacement),
    'external_ref', public.payment_identifier_scrubbed(p_row.external_ref, p_profile, p_replacement),
    'fx_rate_source', public.payment_identifier_scrubbed(p_row.fx_rate_source, p_profile, p_replacement));
END;
$fn$;
REVOKE ALL ON FUNCTION public.payment_transaction_scrubbed(public.payment_transactions, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_transaction_scrubbed(public.payment_transactions, uuid, uuid) FROM anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- I2 / I3: append-only. Row-level and TRUNCATE-level; never statement-level.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payment_ledger_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_token pg_catalog.text;
BEGIN
  -- THE ONE EXCEPTION, on the envelope only: the erasure scrub. It is admitted
  -- when a scrub is in progress in this transaction (the token names the
  -- removed profile id and its replacement) AND the row that would result is
  -- exactly the old row with that id replaced in its text columns — computed
  -- here, from OLD, by the same function the scrub uses. Any other change under
  -- the same token is refused like every other UPDATE. Amounts, accounts,
  -- currency, kind, the beneficiary and every timestamp cannot change by it.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'payment_transactions' THEN
    v_token := coalesce(current_setting('portava.payment_identity_scrub', true), '');
    IF v_token ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
      IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
         AND to_jsonb(NEW) = to_jsonb(OLD) || public.payment_transaction_scrubbed(
               OLD, left(v_token, 36)::pg_catalog.uuid, right(v_token, 36)::pg_catalog.uuid) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION
    'payment_ledger_append_only — % on % is refused: ledger rows are never changed or removed; a correction is a new, opposite transaction (09 §5.3 I2)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'PL001';
END;
$fn$;
COMMENT ON FUNCTION public.payment_ledger_append_only() IS
  '3821 (09 §5.3 I2/I3): refuses UPDATE, DELETE and TRUNCATE of a payment ledger table with SQLSTATE PL001. Attached FOR EACH ROW (UPDATE, DELETE) and FOR EACH STATEMENT (TRUNCATE only — TRUNCATE fires no row trigger). Never attached as a statement-level UPDATE/DELETE trigger. ONE exception, on payment_transactions: the erasure scrub of public.payment_scrub_profile_identifier — an UPDATE whose result is exactly the old row with a removed profile id replaced by its party id in the seven text columns, and nothing else.';
REVOKE ALL ON FUNCTION public.payment_ledger_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_ledger_append_only() FROM anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ple_append_only ON public.payment_ledger_entries;
CREATE TRIGGER ple_append_only
  BEFORE UPDATE OR DELETE ON public.payment_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.payment_ledger_append_only();
DROP TRIGGER IF EXISTS ple_no_truncate ON public.payment_ledger_entries;
CREATE TRIGGER ple_no_truncate
  BEFORE TRUNCATE ON public.payment_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_ledger_append_only();

DROP TRIGGER IF EXISTS ptx_append_only ON public.payment_transactions;
CREATE TRIGGER ptx_append_only
  BEFORE UPDATE OR DELETE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.payment_ledger_append_only();
DROP TRIGGER IF EXISTS ptx_no_truncate ON public.payment_transactions;
CREATE TRIGGER ptx_no_truncate
  BEFORE TRUNCATE ON public.payment_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_ledger_append_only();

DROP TRIGGER IF EXISTS pa_append_only ON public.payment_accounts;
CREATE TRIGGER pa_append_only
  BEFORE UPDATE OR DELETE ON public.payment_accounts
  FOR EACH ROW EXECUTE FUNCTION public.payment_ledger_append_only();
DROP TRIGGER IF EXISTS pa_no_truncate ON public.payment_accounts;
CREATE TRIGGER pa_no_truncate
  BEFORE TRUNCATE ON public.payment_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_ledger_append_only();

-- A party is never deleted or truncated either; its one permitted UPDATE is below.
DROP TRIGGER IF EXISTS pp_no_delete ON public.payment_parties;
CREATE TRIGGER pp_no_delete
  BEFORE DELETE ON public.payment_parties
  FOR EACH ROW EXECUTE FUNCTION public.payment_ledger_append_only();
DROP TRIGGER IF EXISTS pp_no_truncate ON public.payment_parties;
CREATE TRIGGER pp_no_truncate
  BEFORE TRUNCATE ON public.payment_parties
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_ledger_append_only();

-- ═══════════════════════════════════════════════════════════════════════════
-- The one UPDATE a party permits: its identity link is removed.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payment_party_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.label IS DISTINCT FROM OLD.label OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'payment_party_frozen — party % may not be re-identified: id, kind, label and created_at never change', OLD.id
      USING ERRCODE = 'PL005';
  END IF;
  IF OLD.profile_id IS NOT NULL AND NEW.profile_id IS NULL THEN
    -- Reached by the erasure door (3823) AND by profiles' ON DELETE SET NULL,
    -- which PostgreSQL executes as exactly this UPDATE. Either way the row ends
    -- in the same state, stamped here rather than by the caller.
    NEW.identity_removed_at := now();
    NEW.identity_removed_via := coalesce(NEW.identity_removed_via, 'profile_deleted');
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'payment_party_frozen — the only change party % permits is the removal of its profile link; a removed link is never restored or repointed', OLD.id
    USING ERRCODE = 'PL005';
END;
$fn$;
COMMENT ON FUNCTION public.payment_party_identity_guard() IS
  '3821: BEFORE UPDATE FOR EACH ROW on payment_parties. Permits exactly one change — profile_id going from a profile to NULL — and stamps identity_removed_at / identity_removed_via itself, so the erasure door and the profiles foreign key (ON DELETE SET NULL) leave identical rows. Every other UPDATE raises SQLSTATE PL005.';
REVOKE ALL ON FUNCTION public.payment_party_identity_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_party_identity_guard() FROM anon, authenticated, service_role;

DROP TRIGGER IF EXISTS pp_identity_guard ON public.payment_parties;
CREATE TRIGGER pp_identity_guard
  BEFORE UPDATE ON public.payment_parties
  FOR EACH ROW EXECUTE FUNCTION public.payment_party_identity_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- Erasure, second half: nothing else still says who it was.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payment_scrub_profile_identifier(p_profile uuid, p_replacement uuid)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_pattern pg_catalog.text;
  v_rows    pg_catalog.int8 := 0;
BEGIN
  IF p_profile IS NULL OR p_replacement IS NULL THEN
    RETURN 0;
  END IF;
  v_pattern := public.payment_identifier_pattern(p_profile);
  -- Transaction-local, and cleared below: the guard admits the rewrite only
  -- while it is set, and only when the rewrite is the one it computes itself.
  PERFORM set_config('portava.payment_identity_scrub', p_profile::pg_catalog.text || ':' || p_replacement::pg_catalog.text, true);
  UPDATE public.payment_transactions t
     SET scope               = s.j->>'scope',
         idempotency_key     = s.j->>'idempotency_key',
         cause_id            = s.j->>'cause_id',
         subject_id          = s.j->>'subject_id',
         attribution_version = s.j->>'attribution_version',
         external_ref        = s.j->>'external_ref',
         fx_rate_source      = s.j->>'fx_rate_source'
    FROM (SELECT x.id, public.payment_transaction_scrubbed(x, p_profile, p_replacement) AS j
            FROM public.payment_transactions x
           WHERE (x.scope || '|' || x.idempotency_key || '|' || x.cause_id || '|' || x.subject_id || '|'
                  || x.attribution_version || '|' || coalesce(x.external_ref, '') || '|'
                  || coalesce(x.fx_rate_source, '')) ~* v_pattern) s
   WHERE t.id = s.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('portava.payment_identity_scrub', '', true);
  RETURN v_rows;
END;
$fn$;
COMMENT ON FUNCTION public.payment_scrub_profile_identifier(uuid, uuid) IS
  '3821 (owner ruling 2026-10-04, erasure): rewrites every payment_transactions row whose text columns still carry p_profile — in any hex spelling, either case — replacing it with p_replacement (the party id) and tombstoning an idempotency key that carried it; returns the rows rewritten. Amounts, accounts and entries are untouched. One sequential pass over payment_transactions per erasure. ptx_admit keeps profile ids out at INSERT, so this normally finds nothing; it exists so that an identifier written around the door does not outlive the person''s erasure. SECURITY INVOKER and executable by no role but the owner: its callers are the party trigger pp_identity_scrub and 3823''s erasure door.';
REVOKE ALL ON FUNCTION public.payment_scrub_profile_identifier(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_scrub_profile_identifier(uuid, uuid) FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payment_party_scrub_identifiers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  -- The count is left in a transaction-local setting for the erasure door to report.
  PERFORM set_config(
    'portava.payment_identity_scrubbed_rows',
    public.payment_scrub_profile_identifier(OLD.profile_id, NEW.id)::pg_catalog.text,
    true);
  RETURN NULL;
END;
$fn$;
COMMENT ON FUNCTION public.payment_party_scrub_identifiers() IS
  '3821: AFTER UPDATE FOR EACH ROW on payment_parties, WHEN the profile link has just been removed. Runs the scrub with the party id as the replacement, so the erasure door and profiles'' ON DELETE SET NULL leave the same ledger. SECURITY DEFINER (a trigger function: not callable directly) so the rewrite does not depend on which role caused the link to go.';
REVOKE ALL ON FUNCTION public.payment_party_scrub_identifiers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_party_scrub_identifiers() FROM anon, authenticated, service_role;

DROP TRIGGER IF EXISTS pp_identity_scrub ON public.payment_parties;
CREATE TRIGGER pp_identity_scrub
  AFTER UPDATE ON public.payment_parties
  FOR EACH ROW
  WHEN (OLD.profile_id IS NOT NULL AND NEW.profile_id IS NULL)
  EXECUTE FUNCTION public.payment_party_scrub_identifiers();

-- ═══════════════════════════════════════════════════════════════════════════
-- The door, for every writer: no envelope names a person.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payment_transaction_admit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_field pg_catalog.text;
BEGIN
  -- Half of the seal: an envelope's created_at is its own transaction's now().
  NEW.created_at := now();

  -- Every 32-hex-digit window of every text column (dashes removed, lower-cased)
  -- is looked up as a profile id: in payment_parties (the profile of any party,
  -- so of every party this transaction could touch) and in profiles. One index
  -- probe per window; a column with no long hex run costs nothing.
  SELECT f.name INTO v_field
    FROM (VALUES ('scope', NEW.scope), ('idempotency_key', NEW.idempotency_key), ('cause_id', NEW.cause_id),
                 ('subject_id', NEW.subject_id), ('attribution_version', NEW.attribution_version),
                 ('external_ref', NEW.external_ref), ('fx_rate_source', NEW.fx_rate_source)) AS f(name, val)
   CROSS JOIN LATERAL (SELECT lower(replace(f.val, '-', '')) AS s) n
   CROSS JOIN LATERAL generate_series(1, length(n.s) - 31) AS g(i)
   CROSS JOIN LATERAL (SELECT CASE WHEN substr(n.s, g.i, 32) ~ '^[0-9a-f]{32}$'
                                   THEN substr(n.s, g.i, 32)::pg_catalog.uuid END AS candidate) w
   WHERE w.candidate IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.payment_parties pt WHERE pt.profile_id = w.candidate)
       OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = w.candidate))
   LIMIT 1;
  IF v_field IS NOT NULL THEN
    RAISE EXCEPTION
      'payment_invalid_request: person_identifier — % contains a profile id. A ledger row outlives the person''s erasure: refer to a person by payment party id, and derive keys from the event', v_field
      USING ERRCODE = 'PL422';
  END IF;
  RETURN NEW;
END;
$fn$;
COMMENT ON FUNCTION public.payment_transaction_admit() IS
  '3821: BEFORE INSERT FOR EACH ROW on payment_transactions, so it binds every writer. Forces created_at to now() (the seal reads it) and refuses, with SQLSTATE PL422 person_identifier, a row any of whose seven text columns contains the id of a profile — dashed or not, either case. Emails and phone numbers are refused by CHECK ptx_no_contact_details.';
REVOKE ALL ON FUNCTION public.payment_transaction_admit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_transaction_admit() FROM anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ptx_admit ON public.payment_transactions;
CREATE TRIGGER ptx_admit
  BEFORE INSERT ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.payment_transaction_admit();

-- ═══════════════════════════════════════════════════════════════════════════
-- I1, first half: an entry is written with its envelope, in one transaction.
-- ═══════════════════════════════════════════════════════════════════════════
-- The envelope's AFTER INSERT announces its id in a transaction-local setting.
-- AFTER, not BEFORE: a BEFORE INSERT row trigger fires even when ON CONFLICT DO
-- NOTHING then inserts nothing, which let `INSERT … (id = <a committed
-- transaction>) ON CONFLICT (id) DO NOTHING` re-announce a committed envelope.
-- An AFTER row trigger fires only for a row that was inserted.
-- An entry is accepted only when its envelope was announced AND was created in
-- this same database transaction (created_at = now(); ptx_admit forces the
-- former and nothing can set the latter). set_config(…, true) cannot outlive
-- the transaction, and a committed envelope's created_at is another
-- transaction's, so a committed envelope is closed to further entries for good.
-- Without this, a later pair of entries that itself sums to zero would pass the
-- balance check while moving money under an attribution frozen for something
-- else, and around the balance projection.
CREATE OR REPLACE FUNCTION public.payment_transaction_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM set_config(
    'portava.payment_open_transactions',
    coalesce(current_setting('portava.payment_open_transactions', true), '') || NEW.id::pg_catalog.text || ',',
    true);
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.payment_transaction_open() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_transaction_open() FROM anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ptx_open_for_entries ON public.payment_transactions;
CREATE TRIGGER ptx_open_for_entries
  AFTER INSERT ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.payment_transaction_open();

CREATE OR REPLACE FUNCTION public.payment_entry_transaction_is_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  IF position(NEW.transaction_id::pg_catalog.text || ',' IN
              coalesce(current_setting('portava.payment_open_transactions', true), '')) = 0
     OR NOT EXISTS (SELECT 1 FROM public.payment_transactions t
                     WHERE t.id = NEW.transaction_id AND t.created_at = now()) THEN
    RAISE EXCEPTION
      'payment_transaction_sealed — an entry may only be written in the database transaction that wrote its envelope (%); a committed transaction takes no further entries (09 §5.3 I1)',
      NEW.transaction_id
      USING ERRCODE = 'PL003';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.payment_entry_transaction_is_open() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_entry_transaction_is_open() FROM anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ple_transaction_is_open ON public.payment_ledger_entries;
CREATE TRIGGER ple_transaction_is_open
  BEFORE INSERT ON public.payment_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.payment_entry_transaction_is_open();

-- ═══════════════════════════════════════════════════════════════════════════
-- I1, second half: every transaction balances, checked at COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payment_assert_transaction_balanced(p_transaction_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  n_accounts   pg_catalog.int8;
  n_currencies pg_catalog.int8;
  residual     pg_catalog.numeric;
  credited     pg_catalog.numeric;
  v_tx         record;
BEGIN
  SELECT count(DISTINCT e.account_id), count(DISTINCT e.currency), coalesce(sum(e.amount_minor), 0),
         coalesce(sum(e.amount_minor) FILTER (WHERE e.amount_minor > 0), 0)
    INTO n_accounts, n_currencies, residual, credited
    FROM public.payment_ledger_entries e
   WHERE e.transaction_id = p_transaction_id;
  -- DISTINCT accounts, not entries: +500 and -500 on one account is two entries
  -- that sum to zero and move nothing.
  IF n_accounts < 2 THEN
    RAISE EXCEPTION
      'payment_transaction_unbalanced — transaction % names % account(s); a money movement names at least two different accounts (09 §5.2, §5.4)',
      p_transaction_id, n_accounts
      USING ERRCODE = 'PL002';
  END IF;
  -- Unreachable while ple_transaction_fk stands (I4); kept so the invariant is
  -- stated where it is checked, per currency, as `09` §5.3 words it.
  IF n_currencies <> 1 THEN
    RAISE EXCEPTION
      'payment_transaction_unbalanced — transaction % mixes % currencies (09 §5.3 I4)', p_transaction_id, n_currencies
      USING ERRCODE = 'PL002';
  END IF;
  IF residual <> 0 THEN
    RAISE EXCEPTION
      'payment_transaction_unbalanced — transaction % sums to %, not 0 (09 §5.3 I1)', p_transaction_id, residual
      USING ERRCODE = 'PL002';
  END IF;

  SELECT t.reverses_transaction_id AS original, t.currency, t.original_currency, t.original_amount_minor
    INTO v_tx
    FROM public.payment_transactions t WHERE t.id = p_transaction_id;

  -- The amount the customer was presented is the amount the entries move: in
  -- one currency, the credits total original_amount_minor. (Across currencies
  -- the two figures are not comparable without each currency's exponent, which
  -- the ledger does not hold; the rate applied is stored beside them instead.)
  IF v_tx.original_currency = v_tx.currency AND credited <> v_tx.original_amount_minor THEN
    RAISE EXCEPTION
      'payment_original_amount_mismatch — transaction % records original_amount_minor % but its credit entries total %',
      p_transaction_id, v_tx.original_amount_minor, credited
      USING ERRCODE = 'PL007';
  END IF;

  -- `09` §9.2: a reversal's entries are the negation of the original's.
  IF v_tx.original IS NOT NULL AND EXISTS (
    SELECT 1
      FROM (SELECT e.account_id, sum(e.amount_minor) AS net
              FROM public.payment_ledger_entries e
             WHERE e.transaction_id = p_transaction_id GROUP BY e.account_id) r
      FULL JOIN
           (SELECT e.account_id, sum(e.amount_minor) AS net
              FROM public.payment_ledger_entries e
             WHERE e.transaction_id = v_tx.original GROUP BY e.account_id) o
        USING (account_id)
     WHERE coalesce(r.net, 0) <> -coalesce(o.net, 0)
  ) THEN
    RAISE EXCEPTION
      'payment_reversal_not_negation — transaction % must negate transaction % exactly, account by account (09 §9.2)',
      p_transaction_id, v_tx.original
      USING ERRCODE = 'PL004';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.payment_assert_transaction_balanced(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_assert_transaction_balanced(uuid) FROM anon, authenticated, service_role;

-- The two deferred checks run at COMMIT, AFTER a SECURITY DEFINER posting
-- function has returned — so as the SESSION's role, service_role, which holds
-- no EXECUTE on payment_assert_transaction_balanced. They are therefore
-- SECURITY DEFINER themselves (trigger functions: not callable directly). On a
-- database with Supabase's default privileges this was masked, because
-- service_role is granted EXECUTE on every new function there; on a plain one
-- every post failed at COMMIT with 42501. The explicit REVOKE … FROM
-- service_role above makes both kinds of database behave the same.
CREATE OR REPLACE FUNCTION public.payment_entry_transaction_balances()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM public.payment_assert_transaction_balanced(NEW.transaction_id);
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.payment_entry_transaction_balances() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_entry_transaction_balances() FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payment_transaction_has_balanced_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM public.payment_assert_transaction_balanced(NEW.id);
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.payment_transaction_has_balanced_entries() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_transaction_has_balanced_entries() FROM anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ple_transaction_balances ON public.payment_ledger_entries;
CREATE CONSTRAINT TRIGGER ple_transaction_balances
  AFTER INSERT ON public.payment_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.payment_entry_transaction_balances();

-- The envelope's own check: an envelope with no entries fires no entry trigger.
DROP TRIGGER IF EXISTS ptx_has_balanced_entries ON public.payment_transactions;
CREATE CONSTRAINT TRIGGER ptx_has_balanced_entries
  AFTER INSERT ON public.payment_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.payment_transaction_has_balanced_entries();

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS + grants: deny-default. The revoke is unconditional and comes first
-- (2093: Supabase's default privileges grant ALL at CREATE TABLE).
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.payment_parties        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_ledger_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_parties        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.payment_accounts       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.payment_transactions   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.payment_ledger_entries FROM PUBLIC, anon, authenticated, service_role;

-- SELECT and nothing else. Every write goes through a SECURITY DEFINER function,
-- so the API's own key cannot append an entry around the balance projection.
GRANT SELECT ON public.payment_parties        TO service_role;
GRANT SELECT ON public.payment_accounts       TO service_role;
GRANT SELECT ON public.payment_transactions   TO service_role;
GRANT SELECT ON public.payment_ledger_entries TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PAY-022: creating an account is cheap and idempotent.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payment_account_ensure(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  k          pg_catalog.text;
  v_kind     pg_catalog.text;
  v_profile  pg_catalog.uuid;
  v_label    pg_catalog.text;
  v_type     pg_catalog.text;
  v_currency pg_catalog.text;
  v_party    pg_catalog.uuid;
  v_account  pg_catalog.uuid;
  v_created  pg_catalog.bool := false;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'payment_invalid_request: payload_not_an_object' USING ERRCODE = 'PL422';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('owner_kind', 'profile_id', 'owner_label', 'account_type', 'currency', 'livemode') THEN
      RAISE EXCEPTION 'payment_invalid_request: unknown_field — %', k USING ERRCODE = 'PL422';
    END IF;
  END LOOP;
  IF p ? 'livemode' AND p->'livemode' IS DISTINCT FROM 'false'::pg_catalog.jsonb THEN
    RAISE EXCEPTION 'payment_live_mode_refused — this ledger records test-mode money only' USING ERRCODE = 'PL451';
  END IF;

  v_kind     := p->>'owner_kind';
  v_label    := p->>'owner_label';
  v_type     := p->>'account_type';
  v_currency := p->>'currency';
  IF v_kind IS NULL OR v_type IS NULL OR v_currency IS NULL THEN
    RAISE EXCEPTION 'payment_invalid_request: owner_kind_account_type_and_currency_are_required' USING ERRCODE = 'PL422';
  END IF;
  IF v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'payment_invalid_request: currency_shape — % is not a three-letter upper-case code', v_currency USING ERRCODE = 'PL422';
  END IF;

  BEGIN
    IF v_kind = 'user' THEN
      IF v_label IS NOT NULL OR coalesce(p->>'profile_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RAISE EXCEPTION 'payment_invalid_request: user_owner_needs_profile_id_and_no_label' USING ERRCODE = 'PL422';
      END IF;
      v_profile := (p->>'profile_id')::pg_catalog.uuid;
      INSERT INTO public.payment_parties (kind, profile_id) VALUES ('user', v_profile)
      ON CONFLICT (profile_id) DO NOTHING;
      SELECT pt.id INTO v_party FROM public.payment_parties pt WHERE pt.profile_id = v_profile;
    ELSE
      IF p ? 'profile_id' OR v_label IS NULL THEN
        RAISE EXCEPTION 'payment_invalid_request: non_user_owner_needs_label_and_no_profile_id' USING ERRCODE = 'PL422';
      END IF;
      INSERT INTO public.payment_parties (kind, label) VALUES (v_kind, v_label)
      ON CONFLICT (kind, label) DO NOTHING;
      SELECT pt.id INTO v_party FROM public.payment_parties pt WHERE pt.kind = v_kind AND pt.label = v_label;
    END IF;

    INSERT INTO public.payment_accounts (owner_kind, owner_id, account_type, currency, livemode)
    VALUES (v_kind, v_party, v_type, v_currency, false)
    ON CONFLICT (owner_kind, owner_id, account_type, currency, livemode) DO NOTHING
    RETURNING id INTO v_account;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'payment_invalid_request: profile_not_found — %', SQLERRM USING ERRCODE = 'PL422';
    WHEN check_violation THEN
      RAISE EXCEPTION 'payment_invalid_request: account_shape — %', SQLERRM USING ERRCODE = 'PL422';
  END;

  IF v_account IS NOT NULL THEN
    v_created := true;
  ELSE
    SELECT a.id INTO v_account FROM public.payment_accounts a
     WHERE a.owner_kind = v_kind AND a.owner_id = v_party AND a.account_type = v_type
       AND a.currency = v_currency AND a.livemode = false;
  END IF;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'payment_account_ensure: the account could not be resolved after its insert (%/%/%)', v_kind, v_type, v_currency
      USING ERRCODE = 'PL500';
  END IF;

  RETURN jsonb_build_object('account_id', v_account, 'party_id', v_party, 'created', v_created);
END;
$fn$;
COMMENT ON FUNCTION public.payment_account_ensure(jsonb) IS
  '3821 (09 §4; PAY-022): idempotent account creation — INSERT … ON CONFLICT DO NOTHING on the party and on the (owner_kind, owner_id, account_type, currency, livemode) tuple, then the row''s id. A second call returns the same account with created = false. Payload: owner_kind, account_type, currency, and profile_id (user) or owner_label (platform, processor). Unknown fields, a bad shape, a missing profile and livemode other than false are refused by name (PL422 / PL451). Returns account_id, party_id (the pseudonym a person is referred to by everywhere else in the ledger) and created. SECURITY DEFINER because service_role holds no INSERT on the ledger, search_path pinned to pg_catalog, pg_temp; EXECUTE for service_role only.';
REVOKE ALL ON FUNCTION public.payment_account_ensure(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_account_ensure(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_account_ensure(jsonb) TO service_role;

-- ── Postconditions (assertion only) ─────────────────────────────────────────
DO $post$
DECLARE
  n int;
  t text;
  pr text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_parties', 'payment_accounts', 'payment_transactions', 'payment_ledger_entries'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '3821: POSTCONDITION FAILED: public.% is absent', t;
    END IF;
    SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relname = t AND c.relrowsecurity;
    IF n <> 1 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: row level security is off on %', t; END IF;
    SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF n <> 0 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % carries % polic(y/ies); it is deny-all by design', t, n; END IF;
    -- EXACT privileges, not claimed ones (2093): SELECT for service_role and
    -- nothing else, and nothing at all for a client role.
    FOREACH pr IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('anon', 'public.' || t, pr) OR has_table_privilege('authenticated', 'public.' || t, pr) THEN
        RAISE EXCEPTION '3821: POSTCONDITION FAILED: a client role holds % on %', pr, t;
      END IF;
      IF has_table_privilege('service_role', 'public.' || t, pr) <> (pr = 'SELECT') THEN
        RAISE EXCEPTION '3821: POSTCONDITION FAILED: service_role must hold SELECT and only SELECT on %; % is wrong', t, pr;
      END IF;
    END LOOP;
    -- I3: no statement-level trigger except the TRUNCATE guard.
    SELECT count(*) INTO n FROM pg_trigger g
     WHERE g.tgrelid = ('public.' || t)::regclass AND NOT g.tgisinternal
       AND (g.tgtype & 1) = 0 AND (g.tgtype & 32) = 0;
    IF n <> 0 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % statement-level non-TRUNCATE trigger(s) on % (09 §5.3 I3)', n, t; END IF;
    SELECT count(*) INTO n FROM pg_trigger g
     WHERE g.tgrelid = ('public.' || t)::regclass AND NOT g.tgisinternal AND g.tgenabled = 'O'
       AND (g.tgtype & 1) = 0 AND (g.tgtype & 32) = 32;
    IF n <> 1 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: the TRUNCATE guard is absent from %', t; END IF;
    -- No key on a ledger table may SET NULL / SET DEFAULT except the identity link.
    SELECT count(*) INTO n FROM pg_constraint k
     WHERE k.conrelid = ('public.' || t)::regclass AND k.contype = 'f' AND k.confdeltype IN ('n', 'd')
       AND NOT (t = 'payment_parties' AND k.confrelid = 'public.profiles'::regclass);
    IF n <> 0 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % SET NULL / SET DEFAULT key(s) on %', n, t; END IF;
  END LOOP;

  -- I2: the row-level UPDATE-and-DELETE guard on the three append-only tables.
  SELECT count(*) INTO n FROM pg_trigger g
   WHERE NOT g.tgisinternal AND g.tgenabled = 'O'
     AND g.tgfoid = 'public.payment_ledger_append_only()'::regprocedure
     AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 8) = 8 AND (g.tgtype & 16) = 16
     AND g.tgrelid IN ('public.payment_accounts'::regclass, 'public.payment_transactions'::regclass,
                       'public.payment_ledger_entries'::regclass);
  IF n <> 3 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: the append-only row guard is on % of 3 tables', n; END IF;

  -- I1: both balance checks are constraint triggers, deferrable, initially deferred.
  SELECT count(*) INTO n FROM pg_trigger g
   WHERE g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred AND g.tgenabled = 'O'
     AND ((g.tgrelid = 'public.payment_ledger_entries'::regclass AND g.tgname = 'ple_transaction_balances')
       OR (g.tgrelid = 'public.payment_transactions'::regclass AND g.tgname = 'ptx_has_balanced_entries'));
  IF n <> 2 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % of 2 deferred balance constraint triggers present', n; END IF;

  -- I4 / I5: the two composite keys carry currency AND livemode.
  SELECT count(*) INTO n FROM pg_constraint k
   WHERE k.conrelid = 'public.payment_ledger_entries'::regclass AND k.contype = 'f'
     AND k.conname IN ('ple_transaction_fk', 'ple_account_fk') AND array_length(k.conkey, 1) = 3;
  IF n <> 2 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % of 2 composite (id, currency, livemode) keys on the entries', n; END IF;

  -- I7 and the currency ruling: none of these may be nullable, and no currency has a default.
  SELECT count(*) INTO n FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'payment_transactions' AND c.is_nullable = 'NO'
     AND c.column_name IN ('scope', 'idempotency_key', 'content_hash', 'currency', 'original_currency',
                           'original_amount_minor', 'cause_kind', 'cause_id', 'subject_kind', 'subject_id',
                           'beneficiary_account_id', 'attribution_version', 'occurred_at', 'livemode');
  IF n <> 14 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % of 14 envelope columns are NOT NULL', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND left(c.table_name, 8) = 'payment_'
     AND c.column_name IN ('currency', 'original_currency') AND c.column_default IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % currency column(s) carry a default; no currency is assumed', n; END IF;

  IF has_function_privilege('anon', 'public.payment_account_ensure(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.payment_account_ensure(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '3821: POSTCONDITION FAILED: a client role can execute payment_account_ensure';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.payment_account_ensure(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '3821: POSTCONDITION FAILED: service_role cannot execute payment_account_ensure';
  END IF;
  SELECT count(*) INTO n FROM pg_proc f
   WHERE f.oid = 'public.payment_account_ensure(jsonb)'::regprocedure AND f.prosecdef;
  IF n <> 1 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: payment_account_ensure is not SECURITY DEFINER'; END IF;

  -- EVERY function of this file pins search_path to pg_catalog, pg_temp — never
  -- empty, which leaves pg_temp searched FIRST for type names.
  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace ns ON ns.oid = f.pronamespace
   WHERE ns.nspname = 'public' AND f.proname IN (
     'payment_identifier_pattern', 'payment_identifier_scrubbed', 'payment_transaction_scrubbed',
     'payment_ledger_append_only', 'payment_party_identity_guard', 'payment_scrub_profile_identifier',
     'payment_party_scrub_identifiers', 'payment_transaction_admit', 'payment_transaction_open',
     'payment_entry_transaction_is_open', 'payment_assert_transaction_balanced',
     'payment_entry_transaction_balances', 'payment_transaction_has_balanced_entries', 'payment_account_ensure')
     AND f.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'];
  IF n <> 14 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % of 14 functions pin search_path to pg_catalog, pg_temp', n; END IF;

  -- SECURITY DEFINER is held by the account door and by the three trigger
  -- functions that run outside it (two at COMMIT, one under a foreign-key
  -- action) — and by nothing else in this file.
  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace ns ON ns.oid = f.pronamespace
   WHERE ns.nspname = 'public' AND f.prosecdef AND f.proname IN (
     'payment_identifier_pattern', 'payment_identifier_scrubbed', 'payment_transaction_scrubbed',
     'payment_ledger_append_only', 'payment_party_identity_guard', 'payment_scrub_profile_identifier',
     'payment_transaction_admit', 'payment_transaction_open', 'payment_entry_transaction_is_open',
     'payment_assert_transaction_balanced');
  IF n <> 0 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % internal function(s) are SECURITY DEFINER', n; END IF;
  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace ns ON ns.oid = f.pronamespace
   WHERE ns.nspname = 'public' AND f.prosecdef AND f.prorettype = 'pg_catalog.trigger'::regtype AND f.proname IN (
     'payment_entry_transaction_balances', 'payment_transaction_has_balanced_entries', 'payment_party_scrub_identifiers');
  IF n <> 3 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % of 3 deferred / cascade trigger functions are SECURITY DEFINER', n; END IF;

  -- No role but the owner may execute an internal function — on a database with
  -- Supabase's default privileges as on one without.
  FOREACH t IN ARRAY ARRAY[
    'public.payment_identifier_pattern(uuid)', 'public.payment_identifier_scrubbed(text, uuid, uuid)',
    'public.payment_transaction_scrubbed(public.payment_transactions, uuid, uuid)',
    'public.payment_scrub_profile_identifier(uuid, uuid)', 'public.payment_assert_transaction_balanced(uuid)',
    'public.payment_ledger_append_only()', 'public.payment_party_identity_guard()',
    'public.payment_party_scrub_identifiers()', 'public.payment_transaction_admit()',
    'public.payment_transaction_open()', 'public.payment_entry_transaction_is_open()',
    'public.payment_entry_transaction_balances()', 'public.payment_transaction_has_balanced_entries()'] LOOP
    FOREACH pr IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(pr, t, 'EXECUTE') THEN
        RAISE EXCEPTION '3821: POSTCONDITION FAILED: % can execute %', pr, t;
      END IF;
    END LOOP;
  END LOOP;

  -- The seal's and the door's triggers, and the constraints an older shape of
  -- this table would lack (CREATE TABLE IF NOT EXISTS adopts what it finds).
  SELECT count(*) INTO n FROM pg_trigger g
   WHERE NOT g.tgisinternal AND g.tgenabled = 'O' AND (g.tgtype & 1) = 1 AND (g.tgtype & 4) = 4
     AND ((g.tgrelid = 'public.payment_transactions'::regclass AND g.tgname = 'ptx_admit' AND (g.tgtype & 2) = 2)
       OR (g.tgrelid = 'public.payment_transactions'::regclass AND g.tgname = 'ptx_open_for_entries' AND (g.tgtype & 2) = 0)
       OR (g.tgrelid = 'public.payment_ledger_entries'::regclass AND g.tgname = 'ple_transaction_is_open' AND (g.tgtype & 2) = 2));
  IF n <> 3 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % of 3 admission / seal triggers present (ptx_admit BEFORE, ptx_open_for_entries AFTER, ple_transaction_is_open BEFORE)', n; END IF;
  SELECT count(*) INTO n FROM pg_trigger g
   WHERE NOT g.tgisinternal AND g.tgenabled = 'O' AND g.tgrelid = 'public.payment_parties'::regclass
     AND g.tgname = 'pp_identity_scrub' AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 0 AND (g.tgtype & 16) = 16;
  IF n <> 1 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: the erasure scrub trigger is absent from payment_parties'; END IF;
  SELECT count(*) INTO n FROM pg_constraint k
   WHERE k.conrelid = 'public.payment_transactions'::regclass AND k.contype = 'c' AND k.convalidated
     AND ((k.conname = 'ptx_no_contact_details')
       OR (k.conname = 'ptx_fx_rate_source_shape')
       OR (k.conname = 'ptx_external_ref_shape' AND pg_get_constraintdef(k.oid) LIKE '%[a-z][a-z0-9]{1,15}\_%')
       OR (k.conname = 'ptx_scope_shape' AND pg_get_constraintdef(k.oid) NOT LIKE '%AND%'));
  IF n <> 4 THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: % of 4 envelope text constraints are the ones this file declares (an older payment_transactions is in place: roll it back first)', n; END IF;
END
$post$;

-- ── Probe: PROVE the refusals rather than assert that triggers exist ────────
-- Everything below runs inside a block that is always rolled back (sentinel
-- PL999), against rows that exist only inside it.
DO $probe$
DECLARE
  v_party    uuid;
  v_a        uuid;
  v_b        uuid;
  v_tx       uuid := gen_random_uuid();
  v_same     uuid := gen_random_uuid();
  v_forged   uuid := gen_random_uuid();
  one_account_refused boolean := false;
  forged_refused      boolean := false;
  contact_refused     boolean := false;
  mismatch_refused    boolean := false;
  unbalanced_refused boolean := false;
  update_refused     boolean := false;
  delete_refused     boolean := false;
  zero_refused       boolean := false;
  sealed_refused     boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.payment_parties (kind, label) VALUES ('platform', 'probe_3821') RETURNING id INTO v_party;
    INSERT INTO public.payment_accounts (owner_kind, owner_id, account_type, currency, livemode)
    VALUES ('platform', v_party, 'platform_revenue', 'USD', false) RETURNING id INTO v_a;
    INSERT INTO public.payment_accounts (owner_kind, owner_id, account_type, currency, livemode)
    VALUES ('platform', v_party, 'refund_liability', 'USD', false) RETURNING id INTO v_b;

    -- A sealed envelope: no announcement in this transaction for a random id.
    BEGIN
      INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason)
      VALUES (gen_random_uuid(), v_a, 1, 'USD', false, 'adjustment');
    EXCEPTION WHEN SQLSTATE 'PL003' THEN sealed_refused := true;
    END;

    -- … and a HAND-WRITTEN announcement opens nothing: there is no envelope of
    -- this transaction behind it.
    PERFORM set_config('portava.payment_open_transactions', v_forged::text || ',', true);
    BEGIN
      INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason)
      VALUES (v_forged, v_a, 1, 'USD', false, 'adjustment');
    EXCEPTION WHEN SQLSTATE 'PL003' THEN forged_refused := true;
    END;
    PERFORM set_config('portava.payment_open_transactions', '', true);

    -- An email is not a processor reference.
    BEGIN
      INSERT INTO public.payment_transactions
        (kind, scope, idempotency_key, content_hash, currency, livemode, original_currency,
         original_amount_minor, cause_kind, cause_id, subject_kind, subject_id,
         beneficiary_account_id, attribution_version, external_ref, occurred_at)
      VALUES
        ('fee', 'probe:3821', 'probe-contact', repeat('0', 64), 'USD', false, 'USD', 100,
         'adjustment', 'probe', 'booking', 'probe', v_a, 'probe/v1', 'someone@example.test', now());
    EXCEPTION WHEN check_violation THEN contact_refused := true;
    END;

    -- Two entries on ONE account sum to zero and move nothing. (Its own block:
    -- the refusal rolls these rows back, with the checks they queued.)
    BEGIN
      INSERT INTO public.payment_transactions
        (id, kind, scope, idempotency_key, content_hash, currency, livemode, original_currency,
         original_amount_minor, cause_kind, cause_id, subject_kind, subject_id,
         beneficiary_account_id, attribution_version, occurred_at)
      VALUES
        (v_same, 'fee', 'probe:3821', 'probe-same', repeat('0', 64), 'USD', false, 'USD', 100,
         'adjustment', 'probe', 'booking', 'probe', v_a, 'probe/v1', now());
      INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason)
      VALUES (v_same, v_a, 100, 'USD', false, 'adjustment'), (v_same, v_a, -100, 'USD', false, 'adjustment');
      PERFORM public.payment_assert_transaction_balanced(v_same);
    EXCEPTION WHEN SQLSTATE 'PL002' THEN one_account_refused := (SQLERRM LIKE '%names 1 account(s)%');
    END;

    INSERT INTO public.payment_transactions
      (id, kind, scope, idempotency_key, content_hash, currency, livemode, original_currency,
       original_amount_minor, cause_kind, cause_id, subject_kind, subject_id,
       beneficiary_account_id, attribution_version, occurred_at)
    VALUES
      (v_tx, 'fee', 'probe:3821', 'probe', repeat('0', 64), 'USD', false, 'USD', 100,
       'adjustment', 'probe', 'booking', 'probe', v_a, 'probe/v1', now());

    BEGIN
      INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason)
      VALUES (v_tx, v_a, 0, 'USD', false, 'adjustment');
    EXCEPTION WHEN check_violation THEN zero_refused := true;
    END;

    INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason)
    VALUES (v_tx, v_a, 100, 'USD', false, 'adjustment'), (v_tx, v_b, -90, 'USD', false, 'adjustment');
    BEGIN
      SET CONSTRAINTS public.ple_transaction_balances IMMEDIATE;
    EXCEPTION WHEN SQLSTATE 'PL002' THEN unbalanced_refused := true;
    END;
    SET CONSTRAINTS public.ple_transaction_balances DEFERRED;

    -- Made to balance, but 100 was presented and the credits now total 105: the
    -- original amount is tied to the entries.
    BEGIN
      INSERT INTO public.payment_ledger_entries (transaction_id, account_id, amount_minor, currency, livemode, entry_reason)
      VALUES (v_tx, v_a, 5, 'USD', false, 'adjustment'), (v_tx, v_b, -15, 'USD', false, 'adjustment');
      PERFORM public.payment_assert_transaction_balanced(v_tx);
    EXCEPTION WHEN SQLSTATE 'PL007' THEN mismatch_refused := true;
    END;

    BEGIN
      UPDATE public.payment_ledger_entries SET amount_minor = 90 WHERE transaction_id = v_tx AND account_id = v_a;
    EXCEPTION WHEN SQLSTATE 'PL001' THEN update_refused := true;
    END;
    BEGIN
      DELETE FROM public.payment_ledger_entries WHERE transaction_id = v_tx;
    EXCEPTION WHEN SQLSTATE 'PL001' THEN delete_refused := true;
    END;

    RAISE EXCEPTION USING ERRCODE = 'PL999', MESSAGE = '3821 probe rollback';
  EXCEPTION WHEN SQLSTATE 'PL999' THEN
    NULL;
  END;

  IF NOT sealed_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: an entry was accepted for an envelope not written in this transaction'; END IF;
  IF NOT forged_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: a hand-written announcement opened a transaction to entries'; END IF;
  IF NOT contact_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: an email address was accepted as a processor reference'; END IF;
  IF NOT one_account_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: a transaction naming one account passed the balance check'; END IF;
  IF NOT mismatch_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: an original amount its entries do not total was accepted'; END IF;
  IF NOT zero_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: a zero-amount entry was accepted'; END IF;
  IF NOT unbalanced_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: an unbalanced transaction passed the balance check'; END IF;
  IF NOT update_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: an entry was updated'; END IF;
  IF NOT delete_refused THEN RAISE EXCEPTION '3821: POSTCONDITION FAILED: an entry was deleted'; END IF;
  IF EXISTS (SELECT 1 FROM public.payment_parties WHERE label = 'probe_3821') THEN
    RAISE EXCEPTION '3821: POSTCONDITION FAILED: the probe left a row behind';
  END IF;
END
$probe$;

COMMIT;
