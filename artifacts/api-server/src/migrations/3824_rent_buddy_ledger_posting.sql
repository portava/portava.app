-- 3824_rent_buddy_ledger_posting.sql
-- One door for the Rent-a-Buddy earnings ledger: entries and their summary are
-- written together, in the database, or not at all.
--
-- CANONICAL FORWARD MIGRATION (3000-3999 band; payments range 3820-3859).
-- Additive and idempotent. It deletes nothing, rewrites no existing row and
-- changes no stored configuration value. PORTAVA STILL MOVES NO MONEY: nothing
-- here charges, captures, refunds or pays out, and no route can reach the one
-- event that would record a settlement.
--
-- ── WHAT WAS WRONG (payments requirements PAY-009/010/014/018/050/055/067/075) ──
--   PAY-050  A booking's ledger was two separate statements issued from the API
--            AFTER the booking committed, each allowed to fail silently
--            (`createEarningsLedgerEntry(...).catch(() => {})`). The entries
--            could exist without the summary, and a booking without either.
--   PAY-055  The fee and the split were computed in JavaScript floats.
--   PAY-014  A tip never reached rent_buddy_earnings_entries (2901): 2330's
--            rb_accumulate_booking_tip wrote the tips row and two tip_usd
--            copies, so after a tip the summary was no longer the fold of the
--            entries it claims to be a projection of.
--   PAY-018  With the function absent the API fell back to read-modify-write.
--   PAY-067  A cancelled, declined, expired or dispute-lost booking kept its
--            earning entries: lib/creatorLedgerEntries.ts#buildReversal had no
--            caller.
--   PAY-010  Nothing could ever clear is_estimated.
--   PAY-075  A payout hold/release wrote its audit row in a second statement
--            whose error nobody read.
--
-- ── WHAT THIS FILE ADDS ─────────────────────────────────────────────────────
--   rb_resolve_platform_fee_percent   the commission, resolved from configuration
--   rb_post_booking_ledger            THE write door: one call = one transaction
--   rb_booking_ledger_on_unfulfilled  trigger: an unfulfilled booking's earning
--                                     entries are reversed in the SAME
--                                     transaction that moves its status
--   rb_buddy_ledger_totals            the earnings summary, folded in SQL
--   rb_admin_payout_transition        payout hold/release + its audit row
--
-- ── THE COMMISSION (owner ruling 2026-10-04) ────────────────────────────────
-- "Start with a 10% platform commission on the pre-tax service price, shown
-- before checkout. Charge no platform commission on tips. Don't add a deposit
-- in the first release. ... keep them configurable by product and market."
--
--   * The rate is CONFIGURATION, resolved most-specific first:
--       1. rent_buddy_launch_controls.platform_fee_percent — a per-market,
--          per-product override on the table that already keys Rent-a-Buddy
--          policy by (country_code, city, category). New nullable column; NULL
--          on every existing row, so it changes nothing until an operator sets
--          one. The precedence is the one routes/rentABuddy.ts
--          #launchControlPrecedence already uses.
--       2. rent_buddy_fee_rules.platform_fee_percent for the buddy's level —
--          the existing schedule of record. NOT A SECOND FEE TABLE, and NOT
--          MODIFIED: the seed rows (new 25 / rising 22 / pro 15 / elite 12 /
--          city_ambassador 12, migrations/0048 in the frozen tree) differ from
--          the ruling's 10 %, and this migration deliberately does not rewrite
--          live configuration. While those rows stand they are what applies.
--       3. 10 — the ruling's starting value, used ONLY when neither of the
--          above has a row. This replaces the old "no row ⇒ no ledger entry"
--          refusal (lib/rentBuddyFeeSchedule.ts): 10 is now an owner-chosen
--          default, not a guess.
--   * The base is the booking's service price (rent_buddy_bookings.total_usd).
--     No tax is computed anywhere in this tree, so that IS the pre-tax price.
--   * A tip books exactly one pair (traveller → buddy) and no fee leg, so a
--     commission on a tip is not a rate set to zero but an entry that does not
--     exist. The postconditions and the database tests pin it.
--   * The traveller-side service fee (rent_buddy_fee_rules.traveler_service_fee_*)
--     is NOT booked. The ruling names one fee. Whether a second, traveller-side
--     fee exists is the unmade ruling R1 (08 §2.4); recording 5 % on every
--     ledger row the moment rent_buddy_enabled is switched on for testers is
--     what lib/rentBuddyFeeSchedule.ts#travelerServiceFeeIsChargeable warned
--     against. The columns stay; this function does not read them.
--   * Arithmetic is integer minor units in the database:
--       fee_minor = round(total_minor * percent / 100)   (numeric, half away from zero)
--     and the buddy's net is what the entries sum to, never a second subtraction.
--
-- ── NOTHING IS COLLECTED, AND THE ROW SAYS SO ───────────────────────────────
-- in_app_amount_collected is the fold of SETTLEMENT entries, which is 0 for
-- every booking because nothing can write one from the API: pay-deposit and
-- pay-full answer 503 and no processor is installed (09 §1.1). is_estimated is
-- cleared by a settlement entry and by nothing else.
--
-- 2901 admitted no entry_reason that asserts money arrived. This file adds
-- exactly one, 'settlement', and fences it:
--   * CHECK rbee_settlement_names_provider — a settlement row must name a
--     provider other than 'none' and an external reference. With no processor
--     installed there is nothing truthful to put there.
--   * rb_post_booking_ledger is the only writer, EXECUTE service_role only, and
--     no route calls it with event 'settlement'. The database test drives it
--     with a scripted provider; that is the only caller until the payment
--     state machine (PAY-T09) exists.
--   * 2901's CHECK (cash_settled_minor = 0) is NOT touched. A settlement is a
--     balanced pair (traveler_receivable / cash_external), which is the
--     double-entry way of saying it; the single-sided column stays zero.
--
-- ── REVERSAL IS A TRIGGER, ON PURPOSE ───────────────────────────────────────
-- Six writers move a booking to an unfulfilled terminal status (the cancel
-- route for either party, decline, the request sweeper's expiry, the admin
-- dispute resolution, and whatever is written next). An after-commit call from
-- each would be six chances to forget and a window in which the booking is
-- cancelled and its earning entries are not. A row-level AFTER UPDATE OF status
-- trigger puts the reversal in the transaction that makes the transition: both
-- happen or neither does, for every writer.
--
-- Creation is NOT a trigger. The existing database suites insert bookings and
-- then build their own ledger rows by hand, and a summary row appearing behind
-- them would change what those suites assert. Creation stays an explicit call.
--
-- Reversal scope: the EARNING transactions — booking_gross, platform_fee,
-- traveler_service_fee. A tip is a separate voluntary transaction; whether an
-- upheld dispute also returns a tip is a refund rule nobody has made, so tips
-- are left standing and the question is recorded in the handoff. (The tip
-- route admits only `completed` bookings and nothing moves a completed booking
-- to an unfulfilled status, so the two cannot meet through the API today.)
--
-- ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
-- Per (booking, event). The booking row is locked first, so two calls for one
-- booking are serialised; then
--   booking_created  a booking that already has a booking_gross entry — under
--                    ANY rule version, including the v1 entries the JavaScript
--                    writer left — is a replay and appends nothing;
--   reversal         only entries with no reversal are reversed, and 2901's
--                    partial unique index refuses a second one regardless;
--   tip, settlement  the caller's event key is part of the entries'
--                    idempotency_key (UNIQUE, 2901). The same key with the same
--                    amount is a replay; with a different amount it is refused.
-- Every INSERT also carries ON CONFLICT (idempotency_key) DO NOTHING: uniqueness
-- is a database index, not an application check (09 §7.2).
--
-- ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
-- No payout is created (PAY-T11). No payment intent, hold or capture exists
-- (PAY-T09). The general payment ledger (3821-3823) is another unit's and is
-- neither read nor written here. 2330's three functions are left in place; the
-- API stops calling rb_accumulate_booking_tip, and db/rollback restores that.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $pre$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rent_buddy_bookings', 'rent_buddy_profiles', 'rent_buddy_earnings_ledger',
    'rent_buddy_earnings_entries', 'rent_buddy_tips', 'rent_buddy_fee_rules',
    'rent_buddy_launch_controls', 'rent_buddy_payouts', 'rent_buddy_admin_actions',
    'profiles'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION '3824: PRECONDITION FAILED: public.% does not exist. rent_buddy_earnings_entries is 2901; apply the chain in order.', t;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'rbee_idempotency_key_once' AND relkind = 'i') THEN
    RAISE EXCEPTION '3824: PRECONDITION FAILED: rbee_idempotency_key_once (2901) is absent; the posting function''s ON CONFLICT target does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_earnings_ledger'::regclass
       AND contype = 'u' AND pg_get_constraintdef(oid) ILIKE '%UNIQUE (booking_id)%') THEN
    RAISE EXCEPTION '3824: PRECONDITION FAILED: rent_buddy_earnings_ledger has no UNIQUE (booking_id); the summary upsert cannot target it.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rent_buddy_tips'::regclass
       AND contype = 'u' AND pg_get_constraintdef(oid) ILIKE '%UNIQUE (booking_id)%') THEN
    RAISE EXCEPTION '3824: PRECONDITION FAILED: rent_buddy_tips has no UNIQUE (booking_id).';
  END IF;
END
$pre$;

-- ── 1. Vocabulary: the one reason that asserts money arrived ────────────────
ALTER TABLE public.rent_buddy_earnings_entries
  DROP CONSTRAINT IF EXISTS rbee_entry_reason_check;
ALTER TABLE public.rent_buddy_earnings_entries
  ADD CONSTRAINT rbee_entry_reason_check CHECK (
    entry_reason IN ('booking_gross', 'tip', 'platform_fee', 'traveler_service_fee', 'reversal', 'settlement'));

ALTER TABLE public.rent_buddy_earnings_entries
  DROP CONSTRAINT IF EXISTS rbee_settlement_names_provider;
ALTER TABLE public.rent_buddy_earnings_entries
  ADD CONSTRAINT rbee_settlement_names_provider CHECK (
    entry_reason <> 'settlement'
    OR (provider <> 'none' AND external_ref IS NOT NULL AND length(btrim(external_ref)) > 0));

COMMENT ON TABLE public.rent_buddy_earnings_entries IS
  'Append-only, signed, minor-unit double-entry source for Rent-a-Buddy earnings. The balance is SUM(amount_minor) over these rows; rent_buddy_earnings_ledger is a projection of them. Written only by public.rb_post_booking_ledger (3824). A settlement is a balanced pair with entry_reason ''settlement'' that must name a provider and an external reference (rbee_settlement_names_provider); cash_settled_minor = 0 stays CHECK-enforced (2901). Corrections are new rows naming reverses_entry_id. No client grant.';

-- ── 2. Configuration: a per-market, per-product commission override ─────────
ALTER TABLE public.rent_buddy_launch_controls
  ADD COLUMN IF NOT EXISTS platform_fee_percent integer NULL;

ALTER TABLE public.rent_buddy_launch_controls
  DROP CONSTRAINT IF EXISTS rblc_platform_fee_percent_range;
ALTER TABLE public.rent_buddy_launch_controls
  ADD CONSTRAINT rblc_platform_fee_percent_range CHECK (
    platform_fee_percent IS NULL OR platform_fee_percent BETWEEN 0 AND 100);

COMMENT ON COLUMN public.rent_buddy_launch_controls.platform_fee_percent IS
  'Platform commission override for this (country_code, city, category), as a whole percentage of the pre-tax service price. NULL = no override: rent_buddy_fee_rules for the buddy''s level applies, then the owner default of 10 (ruling 2026-10-04). Read only by public.rb_resolve_platform_fee_percent (3824).';

-- ── 3. rb_resolve_platform_fee_percent ──────────────────────────────────────
--
-- The ONE place the commission is resolved. Returns exactly one row.
--   fee_source = 'launch_control'  an override on a matching launch control
--                'fee_schedule'    rent_buddy_fee_rules for the buddy's level
--                'owner_default'   neither exists: 10
-- A stored value outside 0..100 cannot occur on the override (CHECK above). On
-- rent_buddy_fee_rules there is no such CHECK in the live schema, so a row
-- carrying one is REFUSED (22023) rather than clamped or skipped: skipping it
-- would silently price the booking at the default while an operator believes
-- their row applies.
CREATE OR REPLACE FUNCTION public.rb_resolve_platform_fee_percent(
  p_buddy_level  text,
  p_country_code text,
  p_city         text,
  p_category     text
)
  RETURNS TABLE (fee_percent integer, fee_source text)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $_$
DECLARE
  v_level    text := COALESCE(NULLIF(btrim(COALESCE(p_buddy_level, '')), ''), 'new');
  v_country  text := NULLIF(btrim(COALESCE(p_country_code, '')), '');
  v_city     text := NULLIF(btrim(COALESCE(p_city, '')), '');
  v_category text := NULLIF(btrim(COALESCE(p_category, '')), '');
  v_pct      integer;
BEGIN
  -- Most specific first; the order is routes/rentABuddy.ts#launchControlPrecedence.
  -- Only a row that SETS a rate is a match: a more specific control that leaves
  -- the column NULL says nothing about the commission and does not hide a
  -- broader one that does.
  SELECT lc.platform_fee_percent
    INTO v_pct
    FROM rent_buddy_launch_controls lc
    JOIN (VALUES
      (1, v_country, v_city, v_category, (v_category IS NOT NULL AND v_city IS NOT NULL AND v_country IS NOT NULL)),
      (2, v_country, NULL,   v_category, (v_category IS NOT NULL AND v_country IS NOT NULL)),
      (3, v_country, v_city, NULL,       (v_city IS NOT NULL AND v_country IS NOT NULL)),
      (4, v_country, NULL,   NULL,       (v_country IS NOT NULL)),
      (5, NULL,      NULL,   v_category, (v_category IS NOT NULL)),
      (6, NULL,      NULL,   NULL,       true)
    ) AS spec(ord, country_code, city, category, applies)
      ON spec.applies
     AND lc.country_code IS NOT DISTINCT FROM spec.country_code
     AND lc.city         IS NOT DISTINCT FROM spec.city
     AND lc.category     IS NOT DISTINCT FROM spec.category
   WHERE lc.platform_fee_percent IS NOT NULL
   ORDER BY spec.ord, lc.updated_at DESC, lc.id
   LIMIT 1;

  IF FOUND THEN
    fee_percent := v_pct;
    fee_source  := 'launch_control';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT fr.platform_fee_percent
    INTO v_pct
    FROM rent_buddy_fee_rules fr
   WHERE fr.buddy_level = v_level;

  IF FOUND THEN
    IF v_pct IS NULL OR v_pct < 0 OR v_pct > 100 THEN
      RAISE EXCEPTION 'rb_resolve_platform_fee_percent: fee_config_invalid — rent_buddy_fee_rules row for level % carries platform_fee_percent % (expected 0..100)', v_level, v_pct
        USING ERRCODE = '22023';
    END IF;
    fee_percent := v_pct;
    fee_source  := 'fee_schedule';
    RETURN NEXT;
    RETURN;
  END IF;

  fee_percent := 10;
  fee_source  := 'owner_default';
  RETURN NEXT;
END;
$_$;

-- ── 4. rb_post_booking_ledger — THE write door ──────────────────────────────
--
-- p_event      'booking_created' | 'tip' | 'reversal' | 'settlement'
-- p_event_key  required for 'tip' and 'settlement' (the caller's event id);
--              ignored for the other two, which are one-per-booking
-- p_args       tip:        { traveler_id uuid, amount_usd numeric, note text? }
--              reversal:   { cause text? }
--              settlement: { provider text, external_ref text, amount_minor bigint }
--
-- Returns jsonb. EXPECTED refusals are a returned object — nothing was written,
-- so there is nothing to roll back — and the caller maps `refusal` to a status
-- code:
--   { ok: false, refusal: '<code>', detail: '<text>' }
-- Success:
--   { ok: true, event, replayed, entries_appended, summary: { … } }
-- Anything UNEXPECTED raises, which rolls the whole call back.
CREATE OR REPLACE FUNCTION public.rb_post_booking_ledger(
  p_booking_id uuid,
  p_event      text,
  p_event_key  text  DEFAULT NULL,
  p_args       jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $_$
DECLARE
  -- The rule generation stamped on entries this function prices. v1 was the
  -- JavaScript writer (lib/creatorLedgerRows.ts#RENT_BUDDY_FEE_RULE_VERSION).
  c_rule_version   CONSTANT text := 'rent-buddy-fee-schedule/v2';
  c_unfulfilled    CONSTANT text[] := ARRAY['cancelled', 'cancelled_by_traveler', 'cancelled_by_buddy', 'declined', 'expired'];
  c_earning        CONSTANT text[] := ARRAY['booking_gross', 'platform_fee', 'traveler_service_fee'];

  v_args           jsonb := COALESCE(p_args, '{}'::jsonb);
  v_key            text  := NULLIF(btrim(COALESCE(p_event_key, '')), '');

  v_status         text;
  v_traveler       uuid;
  v_total_usd      numeric;
  v_addons_usd     numeric;
  v_deposit_usd    numeric;
  v_cash_usd       numeric;
  v_pricing_type   text;
  v_city           text;
  v_category       text;
  v_country        text;
  v_buddy_user     uuid;
  v_buddy_level    text;

  v_has_gross      boolean;
  v_live_gross     boolean;
  v_fee_percent    integer;      -- set only when THIS call priced the booking
  v_fee_source     text;
  v_total_minor    bigint;
  v_fee_minor      bigint;
  v_amount_minor   bigint;
  v_amount_usd     numeric;
  v_existing_minor bigint;
  v_tx             text;
  v_note           text;
  v_actor          uuid;
  v_provider       text;
  v_external_ref   text;
  v_outstanding    bigint;
  v_legacy_minor   bigint;
  v_tip_fold       bigint;
  v_cause          text;

  v_appended       integer := 0;
  v_n              integer;
  v_replayed       boolean := false;
  v_tip_replay     boolean := false;
  v_summary        jsonb;
  v_summary_note   text;
BEGIN
  IF p_booking_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'booking_required', 'detail', 'p_booking_id is null');
  END IF;
  IF p_event IS NULL OR p_event NOT IN ('booking_created', 'tip', 'reversal', 'settlement') THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'unknown_event', 'detail', COALESCE(p_event, 'null'));
  END IF;
  IF p_event IN ('tip', 'settlement') THEN
    IF v_key IS NULL OR length(v_key) > 120 OR v_key !~ '^[A-Za-z0-9_.:-]+$' THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'event_key_required',
        'detail', 'a tip or settlement needs an event key of 1-120 characters [A-Za-z0-9_.:-], derived from the event and not from the attempt');
    END IF;
  END IF;

  -- ── The critical section: every ledger event of one booking is serialised ──
  SELECT b.status::text, b.traveler_id, b.total_usd, b.addons_total_usd, b.deposit_usd,
         b.cash_balance_usd, b.pricing_type, b.city, b.category,
         -- The booking's own snapshot; a row from before the snapshot existed
         -- falls back to the buddy's registered country, which is what
         -- routes/rentABuddy.ts#deriveServiceCountry snapshots.
         COALESCE(NULLIF(btrim(COALESCE(b.country_code, '')), ''), NULLIF(btrim(COALESCE(bp.country, '')), '')),
         bp.user_id, bp.buddy_level::text
    INTO v_status, v_traveler, v_total_usd, v_addons_usd, v_deposit_usd,
         v_cash_usd, v_pricing_type, v_city, v_category, v_country,
         v_buddy_user, v_buddy_level
    FROM rent_buddy_bookings b
    LEFT JOIN rent_buddy_profiles bp ON bp.id = b.buddy_id
   WHERE b.id = p_booking_id
     FOR NO KEY UPDATE OF b;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'booking_not_found', 'detail', p_booking_id::text);
  END IF;

  SELECT EXISTS (
           SELECT 1 FROM rent_buddy_earnings_entries e
            WHERE e.booking_id = p_booking_id AND e.entry_reason = 'booking_gross'),
         EXISTS (
           SELECT 1 FROM rent_buddy_earnings_entries e
            WHERE e.booking_id = p_booking_id AND e.entry_reason = 'booking_gross'
              AND NOT EXISTS (SELECT 1 FROM rent_buddy_earnings_entries r WHERE r.reverses_entry_id = e.id))
    INTO v_has_gross, v_live_gross;

  -- ── tip: every refusal is decided HERE, before anything is written ─────────
  -- The "ensure" step below may append the booking's own entries, so a tip that
  -- is going to be refused must be refused first.
  IF p_event = 'tip' THEN
    BEGIN
      v_actor      := NULLIF(v_args->>'traveler_id', '')::uuid;
      v_amount_usd := NULLIF(v_args->>'amount_usd', '')::numeric;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_arguments',
        'detail', 'a tip needs traveler_id (uuid) and amount_usd (numeric)');
    END;
    v_note := NULLIF(v_args->>'note', '');

    IF v_actor IS NULL OR v_actor IS DISTINCT FROM v_traveler THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'not_traveler',
        'detail', 'only the traveller on the booking can tip');
    END IF;
    IF v_amount_usd IS NULL OR v_amount_usd <= 0 OR round(v_amount_usd * 100) < 1 THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_amount',
        'detail', format('a tip must be at least one minor unit (got %s)', COALESCE(v_amount_usd::text, 'null')));
    END IF;
    IF v_status <> 'completed' THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'booking_not_completed',
        'detail', format('booking is %s; a tip follows a completed booking', v_status));
    END IF;
    IF v_buddy_user IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'buddy_not_found', 'detail', 'the booking has no payee');
    END IF;
    IF v_total_usd IS NULL OR v_total_usd < 0 THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_total', 'detail', COALESCE(v_total_usd::text, 'null'));
    END IF;

    v_amount_minor := round(v_amount_usd * 100)::bigint;

    SELECT e.amount_minor INTO v_existing_minor
      FROM rent_buddy_earnings_entries e
     WHERE e.idempotency_key = format('booking:%s:tip:%s#1', p_booking_id, v_key);
    IF FOUND THEN
      IF v_existing_minor <> v_amount_minor THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'idempotency_key_reused',
          'detail', format('event key %s already recorded a tip of %s minor units, not %s', v_key, v_existing_minor, v_amount_minor));
      END IF;
      v_tip_replay := true;
    END IF;
  END IF;

  -- ── booking_created (also the "ensure" step of tip) ───────────────────────
  IF p_event = 'booking_created' OR (p_event = 'tip' AND NOT v_has_gross) THEN
    IF v_has_gross THEN
      -- Already ledgered, by this function or by the JavaScript writer it
      -- replaces. Appends nothing; the summary is re-derived below, which also
      -- heals a booking whose entries landed and whose summary did not.
      v_replayed := true;
    ELSE
      IF v_status = ANY (c_unfulfilled) THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'booking_not_ledgerable',
          'detail', format('booking is %s; an unfulfilled booking has no earning to record', v_status));
      END IF;
      IF v_buddy_user IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'buddy_not_found',
          'detail', 'the booking''s buddy profile has no user; an entry with no beneficiary cannot be audited');
      END IF;
      IF v_total_usd IS NULL OR v_total_usd < 0 THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_total', 'detail', COALESCE(v_total_usd::text, 'null'));
      END IF;

      SELECT f.fee_percent, f.fee_source
        INTO v_fee_percent, v_fee_source
        FROM rb_resolve_platform_fee_percent(v_buddy_level, v_country, v_city, v_category) f;

      v_total_minor := round(v_total_usd * 100)::bigint;
      v_fee_minor   := round((v_total_minor * v_fee_percent)::numeric / 100)::bigint;

      IF v_total_minor <> 0 THEN
        v_tx := format('booking:%s:booking_gross:%s', p_booking_id, c_rule_version);
        INSERT INTO rent_buddy_earnings_entries
          (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
           attribution_kind, attribution_id, beneficiary_user_id, provider, idempotency_key)
        VALUES
          (v_tx, p_booking_id, 'traveler_receivable', 'booking_gross', -v_total_minor, 'USD', c_rule_version,
           'booking', p_booking_id, NULL,         'none', v_tx || '#0'),
          (v_tx, p_booking_id, 'buddy_payable',       'booking_gross',  v_total_minor, 'USD', c_rule_version,
           'booking', p_booking_id, v_buddy_user, 'none', v_tx || '#1')
        ON CONFLICT (idempotency_key) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_appended := v_appended + v_n;
      END IF;

      IF v_fee_minor <> 0 THEN
        v_tx := format('booking:%s:platform_fee:%s', p_booking_id, c_rule_version);
        INSERT INTO rent_buddy_earnings_entries
          (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
           attribution_kind, attribution_id, beneficiary_user_id, provider, idempotency_key)
        VALUES
          (v_tx, p_booking_id, 'buddy_payable',    'platform_fee', -v_fee_minor, 'USD', c_rule_version,
           'booking', p_booking_id, v_buddy_user, 'none', v_tx || '#0'),
          (v_tx, p_booking_id, 'platform_revenue', 'platform_fee',  v_fee_minor, 'USD', c_rule_version,
           'booking', p_booking_id, NULL,         'none', v_tx || '#1')
        ON CONFLICT (idempotency_key) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_appended := v_appended + v_n;
      END IF;
    END IF;
  END IF;

  -- ── tip ────────────────────────────────────────────────────────────────────
  IF p_event = 'tip' THEN
    v_tx := format('booking:%s:tip:%s', p_booking_id, v_key);

    IF v_tip_replay THEN
      v_replayed := true;
    ELSE
      -- A tip left before this function existed is in rent_buddy_tips and in no
      -- entry. Carry it over ONCE, so that from here on the tips row is a
      -- projection of the entries rather than a second total beside them.
      SELECT COALESCE(round(t.amount_usd * 100)::bigint, 0) INTO v_legacy_minor
        FROM rent_buddy_tips t WHERE t.booking_id = p_booking_id;
      v_legacy_minor := COALESCE(v_legacy_minor, 0);

      SELECT COALESCE(SUM(e.amount_minor), 0) INTO v_tip_fold
        FROM rent_buddy_earnings_entries e
        LEFT JOIN rent_buddy_earnings_entries o ON o.id = e.reverses_entry_id
       WHERE e.booking_id = p_booking_id AND e.account = 'buddy_payable'
         AND COALESCE(o.entry_reason, e.entry_reason) = 'tip';

      IF v_legacy_minor > v_tip_fold THEN
        INSERT INTO rent_buddy_earnings_entries
          (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
           attribution_kind, attribution_id, beneficiary_user_id, provider, idempotency_key)
        VALUES
          (format('booking:%s:tip:carried-over', p_booking_id), p_booking_id, 'traveler_receivable', 'tip',
           -(v_legacy_minor - v_tip_fold), 'USD', c_rule_version, 'booking', p_booking_id, NULL, 'none',
           format('booking:%s:tip:carried-over#0', p_booking_id)),
          (format('booking:%s:tip:carried-over', p_booking_id), p_booking_id, 'buddy_payable', 'tip',
           (v_legacy_minor - v_tip_fold), 'USD', c_rule_version, 'booking', p_booking_id, v_buddy_user, 'none',
           format('booking:%s:tip:carried-over#1', p_booking_id))
        ON CONFLICT (idempotency_key) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_appended := v_appended + v_n;
      END IF;

      -- THE TIP: one balanced pair, traveller → buddy. There is no fee leg.
      INSERT INTO rent_buddy_earnings_entries
        (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
         attribution_kind, attribution_id, beneficiary_user_id, provider, idempotency_key)
      VALUES
        (v_tx, p_booking_id, 'traveler_receivable', 'tip', -v_amount_minor, 'USD', c_rule_version,
         'booking', p_booking_id, NULL,         'none', v_tx || '#0'),
        (v_tx, p_booking_id, 'buddy_payable',       'tip',  v_amount_minor, 'USD', c_rule_version,
         'booking', p_booking_id, v_buddy_user, 'none', v_tx || '#1')
      ON CONFLICT (idempotency_key) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_appended := v_appended + v_n;
    END IF;
  END IF;

  -- ── reversal ───────────────────────────────────────────────────────────────
  IF p_event = 'reversal' THEN
    IF NOT (v_status = ANY (c_unfulfilled)) THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'booking_not_reversible',
        'detail', format('booking is %s; only a cancelled, declined or expired booking is reversed', v_status));
    END IF;
    v_cause := COALESCE(NULLIF(btrim(COALESCE(v_args->>'cause', '')), ''), v_status);

    -- Exact negation of every earning entry that has no reversal yet. The
    -- reversal carries the ORIGINAL's rule version: it is a fact about that
    -- computation, not about today's (lib/creatorLedgerEntries.ts#buildReversal).
    INSERT INTO rent_buddy_earnings_entries
      (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
       attribution_kind, attribution_id, beneficiary_user_id, reverses_entry_id, provider, external_ref,
       idempotency_key)
    SELECT 'reversal:' || o.transaction_key, o.booking_id, o.account, 'reversal', -o.amount_minor, o.currency,
           o.rule_version, o.attribution_kind, o.attribution_id, o.beneficiary_user_id, o.id, o.provider,
           o.external_ref, 'reversal:' || o.idempotency_key
      FROM rent_buddy_earnings_entries o
     WHERE o.booking_id = p_booking_id
       AND o.entry_reason = ANY (c_earning)
       AND NOT EXISTS (SELECT 1 FROM rent_buddy_earnings_entries r WHERE r.reverses_entry_id = o.id)
    ON CONFLICT (idempotency_key) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_appended := v_appended + v_n;

    IF v_n = 0 THEN
      IF NOT v_has_gross AND NOT EXISTS (SELECT 1 FROM rent_buddy_earnings_ledger l WHERE l.booking_id = p_booking_id) THEN
        -- Never ledgered: there is nothing to reverse and nothing to project.
        RETURN jsonb_build_object('ok', true, 'event', p_event, 'replayed', false,
          'entries_appended', 0, 'outcome', 'nothing_to_reverse', 'summary', NULL);
      END IF;
      v_replayed := true;
    ELSE
      v_summary_note := format('Earning entries reversed: booking %s.', v_cause);
    END IF;
  END IF;

  -- ── settlement ─────────────────────────────────────────────────────────────
  IF p_event = 'settlement' THEN
    v_provider     := NULLIF(btrim(COALESCE(v_args->>'provider', '')), '');
    v_external_ref := NULLIF(btrim(COALESCE(v_args->>'external_ref', '')), '');
    BEGIN
      v_amount_minor := NULLIF(v_args->>'amount_minor', '')::bigint;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_arguments', 'detail', 'amount_minor must be an integer number of minor units');
    END;

    IF v_provider IS NULL OR v_provider = 'none' OR v_external_ref IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'settlement_provider_required',
        'detail', 'a settlement names the provider that moved the money and that provider''s reference; no provider is installed (09 §1.1)');
    END IF;
    IF v_amount_minor IS NULL OR v_amount_minor <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_amount', 'detail', COALESCE(v_amount_minor::text, 'null'));
    END IF;
    IF NOT v_live_gross THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'booking_not_ledgered',
        'detail', 'there is no unreversed booking_gross entry to settle against');
    END IF;

    v_tx := format('booking:%s:settlement:%s', p_booking_id, v_key);

    SELECT e.amount_minor INTO v_existing_minor
      FROM rent_buddy_earnings_entries e
     WHERE e.idempotency_key = v_tx || '#0';

    IF FOUND THEN
      IF v_existing_minor <> v_amount_minor THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'idempotency_key_reused',
          'detail', format('event key %s already recorded a settlement of %s minor units, not %s', v_key, v_existing_minor, v_amount_minor));
      END IF;
      v_replayed := true;
    ELSE
      -- What the traveller still owes: the receivable is negative while owed.
      SELECT -COALESCE(SUM(e.amount_minor), 0) INTO v_outstanding
        FROM rent_buddy_earnings_entries e
       WHERE e.booking_id = p_booking_id AND e.account = 'traveler_receivable';

      IF v_amount_minor > v_outstanding THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'settlement_exceeds_receivable',
          'detail', format('%s minor units offered against %s outstanding', v_amount_minor, v_outstanding));
      END IF;

      INSERT INTO rent_buddy_earnings_entries
        (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
         attribution_kind, attribution_id, beneficiary_user_id, provider, external_ref, idempotency_key)
      VALUES
        (v_tx, p_booking_id, 'traveler_receivable', 'settlement',  v_amount_minor, 'USD', c_rule_version,
         'booking', p_booking_id, NULL, v_provider, v_external_ref, v_tx || '#0'),
        (v_tx, p_booking_id, 'cash_external',       'settlement', -v_amount_minor, 'USD', c_rule_version,
         'booking', p_booking_id, NULL, v_provider, v_external_ref, v_tx || '#1')
      ON CONFLICT (idempotency_key) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_appended := v_appended + v_n;
    END IF;
  END IF;

  -- ── The summary: DERIVED by folding the entries, in this transaction ──────
  --
  -- `base` is the reason an entry is ABOUT: its own, or — for a reversal — the
  -- reason of the entry it negates. Every money figure on the row is a SUM over
  -- the entries; none is computed a second way.
  WITH e AS (
    SELECT x.account, x.amount_minor, COALESCE(o.entry_reason, x.entry_reason) AS base
      FROM rent_buddy_earnings_entries x
      LEFT JOIN rent_buddy_earnings_entries o ON o.id = x.reverses_entry_id
     WHERE x.booking_id = p_booking_id
  ), f AS (
    SELECT
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'buddy_payable'       AND base = 'booking_gross'), 0)        AS gross_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'buddy_payable'       AND base = 'tip'), 0)                  AS tip_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'platform_revenue'    AND base = 'platform_fee'), 0)         AS fee_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'platform_revenue'    AND base = 'traveler_service_fee'), 0) AS tsf_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'buddy_payable'), 0)                                         AS net_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'traveler_receivable' AND base = 'settlement'), 0)           AS settled_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'traveler_receivable'), 0)                                   AS receivable_minor
    FROM e
  ), up AS (
    INSERT INTO rent_buddy_earnings_ledger AS l
      (booking_id, buddy_user_id, traveler_id, pricing_type, total_booking_usd, addons_usd, tip_usd,
       platform_fee_percent, platform_fee_amount, traveler_service_fee_amount, buddy_gross_amount,
       buddy_net_estimated_amount, deposit_amount, in_app_amount_collected, cash_balance_due,
       cash_balance_confirmed, is_estimated, note)
    SELECT
      p_booking_id, v_buddy_user, v_traveler, COALESCE(v_pricing_type, 'hourly'),
      f.gross_minor / 100.0, COALESCE(v_addons_usd, 0), f.tip_minor / 100.0,
      v_fee_percent, f.fee_minor / 100.0, f.tsf_minor / 100.0, (f.gross_minor + f.tip_minor) / 100.0,
      f.net_minor / 100.0,
      -- The in-app share the booking's payment mode NAMES. A term of the
      -- booking, copied as it always was; it is not a collection and not a
      -- deposit taken (in_app_amount_collected is the collection, and it is 0).
      COALESCE(v_deposit_usd, 0),
      f.settled_minor / 100.0,
      COALESCE(v_cash_usd, 0),
      false,
      -- Cleared by a settlement entry and by nothing else: money was settled
      -- AND nothing is left owing.
      NOT (f.settled_minor > 0 AND f.receivable_minor = 0),
      v_summary_note
    FROM f
    ON CONFLICT (booking_id) DO UPDATE SET
      total_booking_usd           = EXCLUDED.total_booking_usd,
      tip_usd                     = EXCLUDED.tip_usd,
      platform_fee_percent        = COALESCE(EXCLUDED.platform_fee_percent, l.platform_fee_percent),
      platform_fee_amount         = EXCLUDED.platform_fee_amount,
      traveler_service_fee_amount = EXCLUDED.traveler_service_fee_amount,
      buddy_gross_amount          = EXCLUDED.buddy_gross_amount,
      buddy_net_estimated_amount  = EXCLUDED.buddy_net_estimated_amount,
      in_app_amount_collected     = EXCLUDED.in_app_amount_collected,
      is_estimated                = EXCLUDED.is_estimated,
      note                        = COALESCE(EXCLUDED.note, l.note),
      updated_at                  = now()
    RETURNING l.*
  )
  SELECT jsonb_build_object(
           'booking_id',                  up.booking_id,
           'total_booking_usd',           up.total_booking_usd,
           'tip_usd',                     up.tip_usd,
           'platform_fee_percent',        up.platform_fee_percent,
           'platform_fee_amount',         up.platform_fee_amount,
           'traveler_service_fee_amount', up.traveler_service_fee_amount,
           'buddy_gross_amount',          up.buddy_gross_amount,
           'buddy_net_estimated_amount',  up.buddy_net_estimated_amount,
           'in_app_amount_collected',     up.in_app_amount_collected,
           'is_estimated',                up.is_estimated)
    INTO v_summary
    FROM up;

  -- ── A tip's two other copies are projections of the same fold ─────────────
  IF p_event = 'tip' THEN
    SELECT (v_summary->>'tip_usd')::numeric INTO v_amount_usd;

    INSERT INTO rent_buddy_tips (booking_id, traveler_id, buddy_user_id, amount_usd, note)
    VALUES (p_booking_id, v_traveler, v_buddy_user, v_amount_usd, v_note)
    ON CONFLICT (booking_id) DO UPDATE
      SET amount_usd = EXCLUDED.amount_usd,
          note       = COALESCE(EXCLUDED.note, rent_buddy_tips.note);

    UPDATE rent_buddy_bookings
       SET tip_usd = v_amount_usd, updated_at = now()
     WHERE id = p_booking_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'event', p_event,
    'replayed', v_replayed AND v_appended = 0,
    'entries_appended', v_appended,
    'fee_percent', v_fee_percent,
    'fee_source', v_fee_source,
    'rule_version', c_rule_version,
    'summary', v_summary);
END;
$_$;

-- ── 5. Reversal in the transaction that makes the booking unfulfilled ───────
CREATE OR REPLACE FUNCTION public.rb_booking_ledger_on_unfulfilled()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $_$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.rb_post_booking_ledger(NEW.id, 'reversal', NULL, jsonb_build_object('cause', NEW.status::text));
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN
    -- Fail CLOSED: a booking must not become cancelled with its earning entries
    -- standing. Raising aborts the status change with it.
    RAISE EXCEPTION 'rb_booking_ledger_on_unfulfilled: reversal refused for booking % (%): %',
      NEW.id, v_result->>'refusal', v_result->>'detail';
  END IF;
  RETURN NULL;
END;
$_$;

DROP TRIGGER IF EXISTS rbb_reverse_ledger_on_unfulfilled ON public.rent_buddy_bookings;
CREATE TRIGGER rbb_reverse_ledger_on_unfulfilled
  AFTER UPDATE OF status ON public.rent_buddy_bookings
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        AND NEW.status IN ('cancelled', 'cancelled_by_traveler', 'cancelled_by_buddy', 'declined', 'expired'))
  EXECUTE FUNCTION public.rb_booking_ledger_on_unfulfilled();

-- ── 6. rb_buddy_ledger_totals — the earnings summary, folded in SQL ─────────
--
-- One jsonb row for one buddy (profiles.id), over their COMPLETED bookings, so
-- no row cap can truncate it and no figure is recomputed in the API process.
-- Money figures come from the entries; a completed booking with no entries is
-- COUNTED (unledgered_completed_count) and contributes no money, rather than
-- being priced on the fly at a rate nobody recorded for it.
CREATE OR REPLACE FUNCTION public.rb_buddy_ledger_totals(p_buddy_user_id uuid)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  WITH done AS (
    SELECT b.id, b.total_usd, b.cash_balance_usd, b.cash_balance_confirmed_by_buddy
      FROM rent_buddy_bookings b
      JOIN rent_buddy_profiles bp ON bp.id = b.buddy_id
     WHERE bp.user_id = p_buddy_user_id
       AND b.status::text = 'completed'
  ), e AS (
    SELECT x.booking_id, x.account, x.amount_minor, COALESCE(o.entry_reason, x.entry_reason) AS base
      FROM rent_buddy_earnings_entries x
      LEFT JOIN rent_buddy_earnings_entries o ON o.id = x.reverses_entry_id
     WHERE x.booking_id IN (SELECT id FROM done)
  ), f AS (
    SELECT
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'buddy_payable'       AND base = 'booking_gross'), 0) AS gross_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'buddy_payable'       AND base = 'tip'), 0)           AS tip_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'platform_revenue'    AND base = 'platform_fee'), 0)  AS fee_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'buddy_payable'), 0)                                  AS net_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE account = 'traveler_receivable' AND base = 'settlement'), 0)    AS settled_minor,
      COUNT(*) FILTER (WHERE account = 'buddy_payable' AND base = 'tip' AND amount_minor > 0)                  AS tip_count
    FROM e
  ), l AS (
    SELECT COUNT(*) AS ledgered,
           COALESCE(bool_or(is_estimated), true) AS any_estimated
      FROM rent_buddy_earnings_ledger
     WHERE booking_id IN (SELECT id FROM done)
  )
  SELECT jsonb_build_object(
    'completedCount',            (SELECT COUNT(*) FROM done),
    'unledgeredCompletedCount',  (SELECT COUNT(*) FROM done) - l.ledgered,
    'completedTotalUsd',         (SELECT COALESCE(SUM(total_usd), 0) FROM done),
    'ledgeredGrossUsd',          round(f.gross_minor / 100.0, 2),
    'estimatedPlatformFeeUsd',   round(f.fee_minor / 100.0, 2),
    'estimatedBuddyEarningsUsd', round((f.net_minor - f.tip_minor) / 100.0, 2),
    'tipsTotalUsd',              round(f.tip_minor / 100.0, 2),
    'tipCount',                  f.tip_count,
    'inAppAmountCollectedUsd',   round(f.settled_minor / 100.0, 2),
    'cashBalanceDueUsd',         (SELECT COALESCE(SUM(cash_balance_usd), 0) FROM done WHERE cash_balance_confirmed_by_buddy IS NOT TRUE),
    'cashBalanceConfirmedUsd',   (SELECT COALESCE(SUM(cash_balance_usd), 0) FROM done WHERE cash_balance_confirmed_by_buddy IS TRUE),
    'isEstimated',               l.any_estimated OR (SELECT COUNT(*) FROM done) = 0 OR (SELECT COUNT(*) FROM done) > l.ledgered
  )
  FROM f, l;
$$;

-- ── 7. rb_admin_payout_transition — the transition AND its audit row ────────
--
-- PAY-075. Hold and release were an UPDATE followed by a separate audit INSERT
-- whose error was never read, so a failed audit left an unlogged release. Here
-- both are one function call, i.e. one transaction: if the audit row cannot be
-- written the exception aborts the status change with it.
--
-- The state rules are the ones routes/rentABuddySpec.ts already enforces by
-- compare-and-swap (09 §9.1), now under the payout's row lock:
--   hold     from any status except 'on_hold' and 'released'
--   release  from 'on_hold' only
-- No payout is created here and NO MONEY MOVES: `released` is a status on a row
-- that nothing in this tree can insert (09 §1.4; PAY-T11 is the lifecycle).
--
-- The admin role is re-checked in SQL. The route checks it too; a money
-- transition does not rest on one caller remembering to.
CREATE OR REPLACE FUNCTION public.rb_admin_payout_transition(
  p_payout_id uuid,
  p_action    text,
  p_admin_id  uuid,
  p_reason    text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $_$
DECLARE
  v_reason  text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_from    text;
  v_to      text;
  v_row     rent_buddy_payouts%ROWTYPE;
  v_audit   uuid;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('hold', 'release') THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'unknown_action', 'detail', COALESCE(p_action, 'null'));
  END IF;
  IF p_payout_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'not_found', 'detail', 'p_payout_id is null');
  END IF;
  IF p_admin_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = p_admin_id AND p.role::text = 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'not_admin', 'detail', 'the acting profile is not an admin');
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 1000 THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'reason_required',
      'detail', 'a payout hold or release needs a reason of 1-1000 characters');
  END IF;

  SELECT * INTO v_row FROM rent_buddy_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'not_found', 'detail', p_payout_id::text);
  END IF;
  v_from := v_row.status;

  IF p_action = 'hold' THEN
    IF v_from IN ('on_hold', 'released') THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'conflict', 'current_status', v_from,
        'detail', format('Payout is %s; this transition requires a status other than on_hold or released.', v_from));
    END IF;
    v_to := 'on_hold';
    UPDATE rent_buddy_payouts
       SET status = v_to, hold_reason = v_reason, held_by = p_admin_id, held_at = now(), updated_at = now()
     WHERE id = p_payout_id
    RETURNING * INTO v_row;
  ELSE
    IF v_from <> 'on_hold' THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'conflict', 'current_status', v_from,
        'detail', format('Payout is %s; this transition requires on_hold.', v_from));
    END IF;
    v_to := 'released';
    UPDATE rent_buddy_payouts
       SET status = v_to, notes = v_reason, released_by = p_admin_id, released_at = now(), updated_at = now()
     WHERE id = p_payout_id
    RETURNING * INTO v_row;
  END IF;

  -- Same transaction. If this INSERT fails the UPDATE above is undone with it.
  INSERT INTO rent_buddy_admin_actions (admin_id, target_type, target_id, action, notes, details)
  VALUES (p_admin_id, 'payout', p_payout_id::text,
          CASE WHEN p_action = 'hold' THEN 'payout_held' ELSE 'payout_released' END,
          v_reason,
          jsonb_build_object('from_status', v_from, 'to_status', v_to, 'amount_usd', v_row.amount_usd,
                             'booking_id', v_row.booking_id))
  RETURNING id INTO v_audit;

  RETURN jsonb_build_object('ok', true, 'action', p_action, 'from_status', v_from, 'to_status', v_to,
                            'audit_id', v_audit, 'payout', to_jsonb(v_row));
END;
$_$;

-- ── Grants: SECURITY DEFINER, service_role only ─────────────────────────────
-- A newly created function is EXECUTE-to-PUBLIC by default, so the revoke/grant
-- pair is unconditional (2330's shape).
REVOKE ALL ON FUNCTION public.rb_resolve_platform_fee_percent(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_resolve_platform_fee_percent(text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.rb_resolve_platform_fee_percent(text, text, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_resolve_platform_fee_percent(text, text, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.rb_resolve_platform_fee_percent(text, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.rb_post_booking_ledger(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_post_booking_ledger(uuid, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.rb_post_booking_ledger(uuid, text, text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_post_booking_ledger(uuid, text, text, jsonb) FROM service_role;
GRANT EXECUTE ON FUNCTION public.rb_post_booking_ledger(uuid, text, text, jsonb) TO service_role;

-- A trigger function is never called over REST; trigger execution does not
-- depend on the invoking role holding EXECUTE (2130:120-127).
REVOKE ALL ON FUNCTION public.rb_booking_ledger_on_unfulfilled() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_booking_ledger_on_unfulfilled() FROM anon;
REVOKE ALL ON FUNCTION public.rb_booking_ledger_on_unfulfilled() FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_booking_ledger_on_unfulfilled() FROM service_role;

REVOKE ALL ON FUNCTION public.rb_buddy_ledger_totals(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_buddy_ledger_totals(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.rb_buddy_ledger_totals(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_buddy_ledger_totals(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.rb_buddy_ledger_totals(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.rb_admin_payout_transition(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_admin_payout_transition(uuid, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.rb_admin_payout_transition(uuid, text, uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_admin_payout_transition(uuid, text, uuid, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.rb_admin_payout_transition(uuid, text, uuid, text) TO service_role;

COMMENT ON FUNCTION public.rb_resolve_platform_fee_percent(text, text, text, text) IS
  'The Rent-a-Buddy platform commission as a whole percentage of the pre-tax service price, resolved from configuration: a rent_buddy_launch_controls.platform_fee_percent override for the market/product (most specific first), else rent_buddy_fee_rules for the buddy level, else the owner default of 10 (ruling 2026-10-04). Refuses (22023) a schedule row outside 0..100.';
COMMENT ON FUNCTION public.rb_post_booking_ledger(uuid, text, text, jsonb) IS
  'THE write door of the Rent-a-Buddy earnings ledger. One call appends an event''s entries to rent_buddy_earnings_entries AND re-derives rent_buddy_earnings_ledger by folding them, in one transaction; idempotent per (booking, event). Events: booking_created (gross + commission, priced in SQL), tip (one pair, no commission), reversal (exact negation of the earning entries of an unfulfilled booking), settlement (must name a provider; no route calls it). Expected refusals are returned as {ok:false, refusal}.';
COMMENT ON FUNCTION public.rb_booking_ledger_on_unfulfilled() IS
  'Trigger function for rbb_reverse_ledger_on_unfulfilled: reverses a booking''s earning entries in the transaction that moves it to cancelled / cancelled_by_* / declined / expired. Raises, aborting the status change, if the reversal is refused.';
COMMENT ON FUNCTION public.rb_buddy_ledger_totals(uuid) IS
  'A buddy''s earnings summary over their completed bookings, folded from rent_buddy_earnings_entries in SQL and returned as one jsonb row. Completed bookings with no entries are counted in unledgeredCompletedCount and contribute no money. inAppAmountCollectedUsd is the fold of settlement entries.';
COMMENT ON FUNCTION public.rb_admin_payout_transition(uuid, text, uuid, text) IS
  'PAY-075. Applies an admin payout hold or release under the row lock AND writes its rent_buddy_admin_actions row in the same transaction; a failing audit insert leaves the status unchanged. Requires an admin profile and a reason. Moves no money and creates no payout.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE
  fn_args   text;
  fn        text;
  oid_      oid;
  role_name text;
  def       text;
  n         integer;
BEGIN
  FOREACH fn_args IN ARRAY ARRAY[
    'rb_resolve_platform_fee_percent|p_buddy_level text, p_country_code text, p_city text, p_category text',
    'rb_post_booking_ledger|p_booking_id uuid, p_event text, p_event_key text, p_args jsonb',
    'rb_booking_ledger_on_unfulfilled|',
    'rb_buddy_ledger_totals|p_buddy_user_id uuid',
    'rb_admin_payout_transition|p_payout_id uuid, p_action text, p_admin_id uuid, p_reason text'
  ] LOOP
    fn := split_part(fn_args, '|', 1);
    SELECT p.oid INTO oid_
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = fn
       AND pg_get_function_identity_arguments(p.oid) = split_part(fn_args, '|', 2);
    IF oid_ IS NULL THEN
      RAISE EXCEPTION '3824: POSTCONDITION FAILED: public.%(%) was not created', fn, split_part(fn_args, '|', 2);
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = oid_) THEN
      RAISE EXCEPTION '3824: POSTCONDITION FAILED: public.% is not SECURITY DEFINER', fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = oid_ AND p.proconfig IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')) THEN
      RAISE EXCEPTION '3824: POSTCONDITION FAILED: public.% does not pin search_path', fn;
    END IF;
    IF has_function_privilege('public', oid_, 'EXECUTE') THEN
      RAISE EXCEPTION '3824: POSTCONDITION FAILED: PUBLIC can execute public.%', fn;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
         AND has_function_privilege(role_name, oid_, 'EXECUTE') THEN
        RAISE EXCEPTION '3824: POSTCONDITION FAILED: % can execute public.%', role_name, fn;
      END IF;
    END LOOP;
    IF fn <> 'rb_booking_ledger_on_unfulfilled'
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND NOT has_function_privilege('service_role', oid_, 'EXECUTE') THEN
      RAISE EXCEPTION '3824: POSTCONDITION FAILED: service_role cannot execute public.% — its only caller has no grant', fn;
    END IF;
  END LOOP;

  -- The reversal trigger is installed, row-level, AFTER UPDATE.
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.rent_buddy_bookings'::regclass
     AND tgname = 'rbb_reverse_ledger_on_unfulfilled' AND NOT tgisinternal;
  IF n <> 1 THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rbb_reverse_ledger_on_unfulfilled is not installed; a cancelled booking would keep its earning entries';
  END IF;

  -- 2901's financial-control boundary is exactly as this migration found it.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass
     AND pg_get_constraintdef(oid) LIKE '%cash_settled_minor = 0%';
  IF n <> 1 THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: the cash_settled_minor = 0 boundary (2901) is not intact';
  END IF;
  IF has_table_privilege('service_role', 'public.rent_buddy_earnings_entries', 'UPDATE') THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: service_role has UPDATE on the entries. Corrections are new rows.';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.rent_buddy_earnings_entries'::regclass AND tgname = 'rbee_no_update';
  IF n <> 1 THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rbee_no_update (2901) is gone';
  END IF;

  -- A settlement that names no provider is refused by the table itself.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass
     AND conname = 'rbee_settlement_names_provider';
  IF n <> 1 THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rbee_settlement_names_provider is absent; a settlement could be recorded with no provider';
  END IF;

  -- The posting function carries the shapes this file exists for. A later edit
  -- that drops one restores a defect silently, so the shape is asserted.
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rb_post_booking_ledger';
  IF def NOT LIKE '%FOR NO KEY UPDATE%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_post_booking_ledger does not lock the booking row — two events on one booking would race';
  END IF;
  IF def NOT LIKE '%ON CONFLICT (idempotency_key) DO NOTHING%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_post_booking_ledger does not rest its replay on the unique index';
  END IF;
  IF def NOT LIKE '%rb_resolve_platform_fee_percent%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_post_booking_ledger does not read the commission from configuration';
  END IF;

  -- The owner default is 10 and is the LAST arm, behind both configured sources.
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rb_resolve_platform_fee_percent';
  IF def NOT LIKE '%fee_percent := 10;%' OR def NOT LIKE '%rent_buddy_fee_rules%' OR def NOT LIKE '%rent_buddy_launch_controls%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_resolve_platform_fee_percent does not resolve override → schedule → 10';
  END IF;

  -- The override column is additive: NULL everywhere unless an operator set it.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rent_buddy_launch_controls'
     AND column_name = 'platform_fee_percent' AND is_nullable = 'YES' AND column_default IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rent_buddy_launch_controls.platform_fee_percent is not a nullable, default-free column';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rb_admin_payout_transition';
  IF def NOT LIKE '%FOR UPDATE%' OR def NOT LIKE '%INSERT INTO rent_buddy_admin_actions%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_admin_payout_transition does not lock the payout and write its audit row in one call';
  END IF;
END
$post$;

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- db/rollback/2026-10-04-3824-rent-buddy-ledger-posting-rollback.sql. It drops
-- the trigger and the five functions and the override column, and restores
-- 2901's entry_reason CHECK — which it REFUSES to do while a settlement entry
-- or a non-NULL override exists, because both would be destroyed or orphaned.
-- No entry or summary row written through this door is touched: they are
-- ordinary append-only ledger rows and dropping the writer does not make them
-- wrong.
