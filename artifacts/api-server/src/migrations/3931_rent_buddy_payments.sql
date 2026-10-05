-- 3931_rent_buddy_payments.sql
-- Lane B (payments / identity / Trust), mission 2026-10-05. Written, NOT applied
-- to any database by the lane that wrote it. Rehearsed on NO database: this
-- machine has no PostgreSQL; CI's local-db harness is the first to run it.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────
-- The records of the Rent-a-Buddy payment slice
-- (artifacts/api-server/src/services/payments/bookingPayments/):
--
--   rent_buddy_payment_recipients   a buddy's account with the payment provider
--                                   (the SELLER's account for a direct charge)
--   rent_buddy_monthly_payouts      one payout per (provider account, month,
--                                   currency), or a carried-forward balance
--   rent_buddy_booking_payments     one row per payment ATTEMPT for a booking
--   rent_buddy_payment_refunds      one row per refund requested
--   payment_webhook_events          provider event ids, recorded on arrival and
--                                   marked processed LAST (retry-safe)
--
-- They hold PROVIDER STATE and its projection. They are NOT the ledger: the
-- double-entry books are PR #598's (payment_post_transaction, 3821-3823), and
-- the API posts to them before it changes any state here. Until #598's ledger
-- is applied the API answers 503 to every webhook that must book money, so
-- these tables cannot get ahead of the books.
--
-- ── OWNER RULINGS ENCODED AS CONSTRAINTS (2026-10-04) ───────────────────────
--   * test mode only: every table that mirrors provider objects carries
--     `livemode boolean NOT NULL DEFAULT false CHECK (livemode = false)` —
--     live money cannot be RECORDED until a reviewed migration lifts it, which
--     is what "keep payments in test mode until payment, identity, and tax
--     readiness are established" needs to be structural rather than a flag;
--   * original amount + currency stored, never rewritten; conversion details
--     kept as the provider reported them (`settlement` jsonb);
--   * commission bounded by the PRE-TAX service component (CHECK), with its
--     basis points and rule version stored; no column can hold a deposit;
--   * the four amount components sum to the amount (CHECK) — no residual cent.
--
-- ── WHO MAY TOUCH THEM ───────────────────────────────────────────────────────
-- RLS on, no policy; no client grant. service_role: SELECT, INSERT, UPDATE.
-- No DELETE for anyone: these are financial records. Their fate on account
-- erasure is the creator-ledger retention question C-11 (answer B, pseudonymise,
-- owner-decided; PERIOD not decided; PR #592 on HOLD). Person ids are plain
-- uuids with NO foreign key to profiles, so an erasure neither cascades through
-- them nor is blocked by them; until C-11's period lands, AccountDeletionService
-- must state their fate (lane report: unresolved dependency).
--
-- ── DEPLOY ORDER ─────────────────────────────────────────────────────────────
-- Additive. Apply before deploying the API that reads/writes these tables; the
-- API without them answers 503 on every payment route (fail-closed), because
-- every read is checked. Nothing here is read by any existing route.
-- Rollback: db/rollback/2026-10-05-3931-rent-buddy-payments-rollback.sql
-- (refuses while any row exists).

-- ── rent_buddy_payment_recipients ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rent_buddy_payment_recipients (
  user_id              uuid        PRIMARY KEY,
  provider             text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  recipient_ref        text        NOT NULL CHECK (length(recipient_ref) BETWEEN 1 AND 255),
  country              text        NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  settlement_currency  text        NOT NULL CHECK (settlement_currency ~ '^[A-Z]{3}$'),
  onboarding           text        NOT NULL CHECK (onboarding IN ('not_started', 'in_progress', 'pending_verification', 'verified', 'restricted', 'rejected')),
  charges_enabled      boolean     NOT NULL DEFAULT false,
  payouts_enabled      boolean     NOT NULL DEFAULT false,
  -- the provider's requirement CODES only; never a document, number or date of birth
  requirements_due     text[]      NOT NULL DEFAULT '{}',
  provider_updated_at  timestamptz,
  livemode             boolean     NOT NULL DEFAULT false CONSTRAINT rbpr_test_mode_only CHECK (livemode = false),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rbpr_provider_ref_once UNIQUE (provider, recipient_ref)
);

-- ── rent_buddy_monthly_payouts ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rent_buddy_monthly_payouts (
  id                   uuid        PRIMARY KEY,
  recipient_user_id    uuid        NOT NULL,
  period               text        NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  currency             text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor         bigint      NOT NULL,
  state                text        NOT NULL CHECK (state IN ('planned', 'held', 'requested', 'pending', 'in_transit', 'paid', 'failed', 'returned', 'canceled', 'carried_forward')),
  idempotency_key      text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  payout_ref           text,
  recipient_ref        text        NOT NULL,
  booking_payment_ids  uuid[]      NOT NULL DEFAULT '{}',
  hold_reason          text        CHECK (hold_reason IS NULL OR length(hold_reason) BETWEEN 5 AND 2000),
  carry_reason         text,
  failure_code         text,
  last_snapshot        jsonb,
  livemode             boolean     NOT NULL DEFAULT false CONSTRAINT rbmp_test_mode_only CHECK (livemode = false),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rbmp_key_once UNIQUE (idempotency_key),
  CONSTRAINT rbmp_ref_once UNIQUE (payout_ref),
  CONSTRAINT rbmp_held_has_reason CHECK (state <> 'held' OR hold_reason IS NOT NULL),
  CONSTRAINT rbmp_paid_amount_positive CHECK (state IN ('carried_forward') OR amount_minor > 0)
);

-- ── rent_buddy_booking_payments ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rent_buddy_booking_payments (
  id                           uuid        PRIMARY KEY,
  booking_id                   uuid        NOT NULL REFERENCES public.rent_buddy_bookings(id) ON DELETE RESTRICT,
  attempt_no                   integer     NOT NULL CHECK (attempt_no >= 1),
  provider                     text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  idempotency_key              text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  intent_ref                   text,
  recipient_ref                text        NOT NULL,
  recipient_user_id            uuid        NOT NULL,
  charge_model                 text        NOT NULL CHECK (charge_model IN ('direct', 'destination', 'platform')),
  state                        text        NOT NULL CHECK (state IN ('creating', 'awaiting_payment', 'processing', 'succeeded', 'failed', 'canceled', 'refunded', 'partially_refunded', 'disputed', 'reversed')),
  intent_state                 text        CHECK (intent_state IS NULL OR intent_state IN ('requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'succeeded', 'canceled')),
  currency                     text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor                 bigint      NOT NULL CHECK (amount_minor > 0),
  service_minor                bigint      NOT NULL CHECK (service_minor >= 0),
  payer_fee_minor              bigint      NOT NULL CHECK (payer_fee_minor >= 0),
  tip_minor                    bigint      NOT NULL CHECK (tip_minor >= 0),
  tax_minor                    bigint      NOT NULL CHECK (tax_minor >= 0),
  commission_minor             bigint      NOT NULL CHECK (commission_minor >= 0),
  platform_payer_fee_minor     bigint      NOT NULL CHECK (platform_payer_fee_minor >= 0),
  platform_tax_minor           bigint      NOT NULL CHECK (platform_tax_minor >= 0),
  commission_bps               integer     NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  commission_rule_version      text        NOT NULL CHECK (length(commission_rule_version) > 0),
  tax_provider                 text        NOT NULL,
  tax_calculation_refs         text[]      NOT NULL DEFAULT '{}',
  buyer_market                 text        NOT NULL CHECK (buyer_market ~ '^[A-Z]{2}$'),
  seller_market                text        NOT NULL CHECK (seller_market ~ '^[A-Z]{2}$'),
  amount_captured_minor        bigint      NOT NULL DEFAULT 0,
  amount_refunded_minor        bigint      NOT NULL DEFAULT 0,
  platform_fee_collected_minor bigint      NOT NULL DEFAULT 0,
  platform_fee_refunded_minor  bigint      NOT NULL DEFAULT 0,
  settlement                   jsonb,
  last_snapshot                jsonb,
  failure_reason               text,
  payout_id                    uuid        REFERENCES public.rent_buddy_monthly_payouts(id) ON DELETE RESTRICT,
  livemode                     boolean     NOT NULL DEFAULT false CONSTRAINT rbbp_test_mode_only CHECK (livemode = false),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rbbp_key_once UNIQUE (idempotency_key),
  CONSTRAINT rbbp_intent_once UNIQUE (provider, intent_ref),
  CONSTRAINT rbbp_attempt_once UNIQUE (booking_id, attempt_no),
  CONSTRAINT rbbp_components_sum CHECK (service_minor + payer_fee_minor + tip_minor + tax_minor = amount_minor),
  CONSTRAINT rbbp_commission_from_service_only CHECK (commission_minor <= service_minor),
  CONSTRAINT rbbp_platform_tax_bounded CHECK (platform_tax_minor <= tax_minor),
  CONSTRAINT rbbp_captured_bounded CHECK (amount_captured_minor BETWEEN 0 AND amount_minor),
  CONSTRAINT rbbp_refunded_bounded CHECK (amount_refunded_minor BETWEEN 0 AND amount_captured_minor),
  CONSTRAINT rbbp_fee_refunded_bounded CHECK (platform_fee_refunded_minor BETWEEN 0 AND platform_fee_collected_minor)
);
CREATE INDEX IF NOT EXISTS rbbp_booking_idx ON public.rent_buddy_booking_payments (booking_id, attempt_no);
CREATE INDEX IF NOT EXISTS rbbp_unpaid_idx ON public.rent_buddy_booking_payments (recipient_user_id) WHERE payout_id IS NULL;

-- ── rent_buddy_payment_refunds ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rent_buddy_payment_refunds (
  id                   uuid        PRIMARY KEY,
  booking_payment_id   uuid        NOT NULL REFERENCES public.rent_buddy_booking_payments(id) ON DELETE RESTRICT,
  provider             text        NOT NULL,
  idempotency_key      text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  refund_ref           text,
  state                text        NOT NULL CHECK (state IN ('requested', 'pending', 'succeeded', 'failed', 'canceled', 'refused')),
  reason               text        NOT NULL CHECK (reason IN ('provider_cancelled', 'service_unavailable', 'safety_issue_upheld', 'cancelled_before_service', 'support_decision', 'duplicate')),
  amount_minor         bigint      CHECK (amount_minor IS NULL OR amount_minor > 0),
  currency             text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- REQUIRED, no default: the owner ruled "don't promise that fees … are non-refundable", so each refund states it
  refund_platform_fee  boolean     NOT NULL,
  requested_by         uuid        NOT NULL,
  last_snapshot        jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rbprf_key_once UNIQUE (idempotency_key),
  CONSTRAINT rbprf_ref_once UNIQUE (provider, refund_ref)
);
CREATE INDEX IF NOT EXISTS rbprf_payment_idx ON public.rent_buddy_payment_refunds (booking_payment_id);

-- ── payment_webhook_events ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  provider            text        NOT NULL,
  provider_event_id   text        NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 255),
  endpoint            text        NOT NULL CHECK (endpoint IN ('platform', 'connect')),
  event_type          text        NOT NULL,
  occurred_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  outcome             text        CHECK (outcome IS NULL OR outcome IN ('applied', 'duplicate', 'stale', 'ignored')),
  CONSTRAINT pwe_pk PRIMARY KEY (provider, provider_event_id),
  CONSTRAINT pwe_processed_has_outcome CHECK ((processed_at IS NULL) = (outcome IS NULL))
);

-- ── RLS + grants: deny-default; service_role reads and writes, never deletes ─
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rent_buddy_payment_recipients', 'rent_buddy_monthly_payouts', 'rent_buddy_booking_payments', 'rent_buddy_payment_refunds', 'payment_webhook_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO service_role', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.rent_buddy_booking_payments IS
  'One row per payment attempt for a Rent-a-Buddy booking (3931). Provider state and its projection; NOT the ledger (PR #598). Test mode only (livemode CHECK false). Original amount + currency never rewritten; commission <= pre-tax service; components sum to the amount.';
COMMENT ON TABLE public.payment_webhook_events IS
  'Provider webhook event ids (3931): recorded on arrival, marked processed only after the ledger posting and state writes succeed, so a failed processing is retried by the provider and converges.';

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['rent_buddy_payment_recipients', 'rent_buddy_monthly_payouts', 'rent_buddy_booking_payments', 'rent_buddy_payment_refunds', 'payment_webhook_events'] LOOP
    SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname = t AND c.relrowsecurity;
    IF n <> 1 THEN RAISE EXCEPTION '3931: POSTCONDITION FAILED: % missing or RLS off', t; END IF;
    IF has_table_privilege('anon', format('public.%I', t), 'SELECT') OR has_table_privilege('authenticated', format('public.%I', t), 'SELECT') THEN
      RAISE EXCEPTION '3931: POSTCONDITION FAILED: a client role can read %', t;
    END IF;
    IF has_table_privilege('service_role', format('public.%I', t), 'DELETE') THEN
      RAISE EXCEPTION '3931: POSTCONDITION FAILED: service_role can DELETE from % (financial records are never deleted here)', t;
    END IF;
  END LOOP;
  -- test mode is structural
  SELECT count(*) INTO n FROM pg_constraint WHERE conname IN ('rbpr_test_mode_only', 'rbmp_test_mode_only', 'rbbp_test_mode_only');
  IF n <> 3 THEN RAISE EXCEPTION '3931: POSTCONDITION FAILED: a livemode = false constraint is missing (found %)', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint WHERE conname IN ('rbbp_components_sum', 'rbbp_commission_from_service_only');
  IF n <> 2 THEN RAISE EXCEPTION '3931: POSTCONDITION FAILED: the amount/commission constraints are missing'; END IF;
END $$;
