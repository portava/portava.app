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
--   rb_booking_market                 THE definition of a booking's market: the
--                                     buddy's own country and city
--   rb_platform_fee_minor             THE commission arithmetic, in minor units
--   rb_booking_payment_terms          deposit / cash terms, behind ONE switch
--   rb_quote_booking                  what checkout is shown: price, commission
--                                     and terms, from the functions that post
--   rb_post_booking_ledger            THE write door: one call = one transaction
--   rb_booking_ledger_on_unfulfilled  trigger: an unfulfilled booking's earning
--                                     entries are reversed in the SAME
--                                     transaction that moves its status
--   rb_booking_refuse_uncancel        trigger: an unfulfilled booking is terminal
--   rb_buddy_ledger_totals            the earnings summary, folded in SQL
--   rb_admin_payout_transition        payout hold/release + its audit row
--   rent_buddy_bookings.creation_key  one booking per (traveller, creation key)
--   rent_buddy_global_controls.deposits_enabled   the ONE deposit switch, FALSE
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
--   * The base is the booking's service price (rent_buddy_bookings.total_usd),
--     ADD-ONS INCLUDED. No tax is computed anywhere in this tree, so that IS
--     the pre-tax price; the ruling names "the pre-tax service price" and an
--     add-on is a service the buddy is paid for, so it is priced at the rate the
--     booking was ledgered at (event 'addons').
--   * THE MARKET HAS ONE DEFINITION: the BUDDY's own country and city
--     (rb_booking_market), plus the booking's category. The quote a traveller
--     is shown before checkout (rb_quote_booking) and the posting both resolve
--     through it. The booking's `city` is a request-supplied string and its
--     `country_code` can be a request's snapshot; neither prices anything.
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
-- ── NO DEPOSIT, BEHIND ONE SWITCH (owner ruling 2026-10-04) ─────────────────
-- "Don't add a deposit in the first release." Booking creation used to compute
-- a 30 % split in JavaScript floats and store it. rb_booking_payment_terms is
-- now the only place a deposit can come from, and it reads ONE switch: the
-- column rent_buddy_global_controls.deposits_enabled, added FALSE here. While
-- it is FALSE every booking's deposit is 0. The columns stay. Turning it on is the
-- owner's decision ("with a defined reason and refund terms"); the arithmetic
-- it would then do is integer minor units, here, not in the API.
--
-- ── A CANCELLED BOOKING STAYS CANCELLED ─────────────────────────────────────
-- The state machine (lib/stateMachines/registry.ts, RAB_BOOKING_STATUS) has no
-- transition out of cancelled / cancelled_by_* / declined / expired, and no
-- route writes one. The table now refuses it (rbb_refuse_uncancel): an
-- un-cancelled booking would be live with its earning entries reversed, and a
-- re-post would answer "already ledgered" over a ledger that says zero.
--
-- ── IDEMPOTENT CREATION ─────────────────────────────────────────────────────
-- rent_buddy_bookings.creation_key + the unique index rbb_creation_key_once:
-- a creation retried with the same client Idempotency-Key (scoped by the acting
-- traveller and the resource) finds or collides with the original booking
-- instead of making a second one.
--
-- ── search_path ─────────────────────────────────────────────────────────────
-- Every function pins `pg_catalog, public, pg_temp` and schema-qualifies what
-- it reads. With `public` alone, pg_temp is searched FIRST for relations: a
-- session's temporary `rent_buddy_fee_rules` made the resolver answer 0 %.
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
    'rent_buddy_addons', 'rent_buddy_booking_addons', 'rent_buddy_global_controls', 'profiles'
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

-- ── 2b. Idempotent creation ─────────────────────────────────────────────────
-- `creation_key` is "<path>:<resource id>:<the client's Idempotency-Key>", set
-- by the API when a client sent one. Unique per traveller, so a retried create
-- cannot make a second booking: the retry either finds the original first or
-- collides with it on this index.
ALTER TABLE public.rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS creation_key text NULL;

ALTER TABLE public.rent_buddy_bookings
  DROP CONSTRAINT IF EXISTS rbb_creation_key_shape;
ALTER TABLE public.rent_buddy_bookings
  ADD CONSTRAINT rbb_creation_key_shape CHECK (
    creation_key IS NULL OR length(creation_key) BETWEEN 1 AND 400);

CREATE UNIQUE INDEX IF NOT EXISTS rbb_creation_key_once
  ON public.rent_buddy_bookings (traveler_id, creation_key)
  WHERE creation_key IS NOT NULL;

COMMENT ON COLUMN public.rent_buddy_bookings.creation_key IS
  'Idempotency key of the request that created this booking: "<path>:<resource id>:<client Idempotency-Key>", NULL when the client sent none. UNIQUE per traveller (rbb_creation_key_once), so a retried create returns the original booking instead of making a second (3824).';

-- ── 2c. The deposit switch, FALSE ───────────────────────────────────────────
-- Owner ruling 2026-10-04: no deposit in the first release. ONE switch, on the
-- lane's singleton of payment-policy controls (beside force_full_in_app and
-- cash_balance_paused), read by ONE function (rb_booking_payment_terms).
--
-- A COLUMN, not a feature_flags row, on purpose: its only reader is SQL, and a
-- feature flag no application code reads is exactly what check-flag-polarity
-- refuses. It is also not something to flip from a generic flag list — turning
-- it on needs the owner's reason and refund terms, and screens to show them.
--
-- ADD COLUMN IF NOT EXISTS: a re-run never changes a value an operator set. A
-- MISSING singleton row (id = 1) reads as FALSE.
ALTER TABLE public.rent_buddy_global_controls
  ADD COLUMN IF NOT EXISTS deposits_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.rent_buddy_global_controls.deposits_enabled IS
  'The ONE deposit switch. FALSE (the default; owner ruling 2026-10-04: no deposit in the first release) = every Rent-a-Buddy booking is stored with a deposit of 0. TRUE = a deposit_plus_cash booking carries a deposit share, computed in integer minor units by public.rb_booking_payment_terms (3824), its only reader. Turning it on needs a defined reason and refund terms, and screens that show them.';

-- ── 2d. rb_booking_market — the ONE definition of a booking's market ────────
-- The buddy's own country and city, trimmed, exactly as
-- routes/rentABuddy.ts#deriveServiceCountry reads the country. Never a string a
-- request supplied. The quote and the posting both come through here.
CREATE OR REPLACE FUNCTION public.rb_booking_market(p_buddy_profile_id uuid)
  RETURNS TABLE (buddy_user_id uuid, buddy_level text, country text, city text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO pg_catalog, public, pg_temp
  AS $$
  SELECT bp.user_id,
         bp.buddy_level::text,
         NULLIF(btrim(COALESCE(bp.country, '')), ''),
         NULLIF(btrim(COALESCE(bp.city, '')), '')
    FROM public.rent_buddy_profiles bp
   WHERE bp.id = p_buddy_profile_id;
$$;

-- ── 2e. rb_platform_fee_minor — the ONE commission arithmetic ───────────────
-- Integer minor units; numeric division, rounded half away from zero.
CREATE OR REPLACE FUNCTION public.rb_platform_fee_minor(p_total_minor bigint, p_fee_percent integer)
  RETURNS bigint
  LANGUAGE sql
  IMMUTABLE
  SECURITY DEFINER
  SET search_path TO pg_catalog, public, pg_temp
  AS $$
  SELECT round((p_total_minor * p_fee_percent)::numeric / 100)::bigint;
$$;

-- ── 2f. rb_booking_payment_terms — deposit and cash, behind ONE switch ──────
-- OFF (the default, and what a MISSING singleton row means): deposit 0. A
-- deposit_plus_cash booking's cash balance is then the whole price; a
-- full_in_app booking's is 0. Nothing is multiplied.
-- ON: full_in_app keeps its old meaning (the whole price is the in-app share);
-- deposit_plus_cash takes p_deposit_percent of the price, or 30 — the literal
-- routes/rentABuddy.ts carried — when the caller names none.
CREATE OR REPLACE FUNCTION public.rb_booking_payment_terms(
  p_total_minor     bigint,
  p_payment_mode    text,
  p_deposit_percent integer DEFAULT NULL
)
  RETURNS TABLE (deposit_enabled boolean, payment_mode text, deposit_percent integer, deposit_minor bigint, cash_balance_minor bigint)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO pg_catalog, public, pg_temp
  AS $_$
DECLARE
  c_default_deposit_percent CONSTANT integer := 30;
  v_mode    text := COALESCE(NULLIF(btrim(COALESCE(p_payment_mode, '')), ''), 'full_in_app');
  v_enabled boolean;
  v_pct     integer;
BEGIN
  IF p_total_minor IS NULL OR p_total_minor < 0 THEN
    RAISE EXCEPTION 'rb_booking_payment_terms: invalid total (% minor units)', p_total_minor USING ERRCODE = '22023';
  END IF;
  IF v_mode NOT IN ('full_in_app', 'deposit_plus_cash') THEN
    RAISE EXCEPTION 'rb_booking_payment_terms: unknown payment mode %', v_mode USING ERRCODE = '22023';
  END IF;

  SELECT gc.deposits_enabled INTO v_enabled FROM public.rent_buddy_global_controls gc WHERE gc.id = 1;
  v_enabled := COALESCE(v_enabled, false);

  deposit_enabled := v_enabled;
  payment_mode    := v_mode;

  IF NOT v_enabled THEN
    deposit_percent    := 0;
    deposit_minor      := 0;
    cash_balance_minor := CASE WHEN v_mode = 'deposit_plus_cash' THEN p_total_minor ELSE 0 END;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_mode = 'full_in_app' THEN
    deposit_percent    := 100;
    deposit_minor      := p_total_minor;
    cash_balance_minor := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  v_pct := COALESCE(p_deposit_percent, c_default_deposit_percent);
  IF v_pct < 0 OR v_pct > 100 THEN
    RAISE EXCEPTION 'rb_booking_payment_terms: deposit percent % is outside 0..100', v_pct USING ERRCODE = '22023';
  END IF;
  deposit_percent    := v_pct;
  deposit_minor      := round((p_total_minor * v_pct)::numeric / 100)::bigint;
  cash_balance_minor := p_total_minor - deposit_minor;
  RETURN NEXT;
END;
$_$;

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
  SET search_path TO pg_catalog, public, pg_temp
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
    FROM public.rent_buddy_launch_controls lc
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
    FROM public.rent_buddy_fee_rules fr
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

-- ── 3b. rb_quote_booking — what checkout is shown ───────────────────────────
--
-- The price, the commission and the payment terms a booking WOULD carry, from
-- the same functions the posting uses: rb_booking_market for the market,
-- rb_resolve_platform_fee_percent for the rate, rb_platform_fee_minor for the
-- amount, rb_booking_payment_terms for the deposit. The API multiplies nothing:
-- it sends a unit price and a quantity (an hourly rate and hours; or a fixed
-- price and 1) and stores what comes back.
--
-- p_unit_price_usd NULL = a rate-only quote (the commission line at checkout).
-- Refusals are returned, like the posting's: { ok:false, refusal, detail }.
CREATE OR REPLACE FUNCTION public.rb_quote_booking(
  p_buddy_profile_id uuid,
  p_category         text,
  p_unit_price_usd   numeric DEFAULT NULL,
  p_quantity         numeric DEFAULT 1,
  p_payment_mode     text    DEFAULT NULL,
  p_deposit_percent  integer DEFAULT NULL
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO pg_catalog, public, pg_temp
  AS $_$
DECLARE
  c_special     CONSTANT numeric[] := ARRAY['NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric];
  v_category    text := NULLIF(btrim(COALESCE(p_category, '')), '');
  v_mode        text := NULLIF(btrim(COALESCE(p_payment_mode, '')), '');
  v_qty         numeric := COALESCE(p_quantity, 1);
  v_buddy_user  uuid;
  v_level       text;
  v_country     text;
  v_city        text;
  v_pct         integer;
  v_source      text;
  v_total_minor bigint;
  v_fee_minor   bigint;
  v_terms       record;
  v_out         jsonb;
BEGIN
  IF p_buddy_profile_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'buddy_not_found', 'detail', 'p_buddy_profile_id is null');
  END IF;
  SELECT m.buddy_user_id, m.buddy_level, m.country, m.city
    INTO v_buddy_user, v_level, v_country, v_city
    FROM public.rb_booking_market(p_buddy_profile_id) m;
  IF NOT FOUND OR v_buddy_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'buddy_not_found', 'detail', p_buddy_profile_id::text);
  END IF;
  IF v_mode IS NOT NULL AND v_mode NOT IN ('full_in_app', 'deposit_plus_cash') THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_payment_mode', 'detail', v_mode);
  END IF;

  SELECT f.fee_percent, f.fee_source INTO v_pct, v_source
    FROM public.rb_resolve_platform_fee_percent(v_level, v_country, v_city, v_category) f;

  v_out := jsonb_build_object(
    'ok', true,
    'buddy_profile_id', p_buddy_profile_id,
    'category', v_category,
    'market_country', v_country,
    'market_city', v_city,
    'fee_percent', v_pct,
    'fee_source', v_source,
    'tip_commission_percent', 0);

  IF p_unit_price_usd IS NULL THEN
    -- Rate only. The deposit switch is still reported (checkout says whether a
    -- deposit applies); the terms of a zero price carry no amount.
    RETURN v_out || jsonb_build_object(
      'priced', false,
      'deposit_enabled', (SELECT t.deposit_enabled FROM public.rb_booking_payment_terms(0, NULL, NULL) t));
  END IF;

  -- Compared in MINOR units, after rounding: 99999999.999 rounds to 10^8.
  IF p_unit_price_usd = ANY (c_special) OR v_qty = ANY (c_special)
     OR p_unit_price_usd < 0 OR v_qty <= 0
     OR round(p_unit_price_usd * v_qty * 100) >= 10000000000 THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_total',
      'detail', format('unit price %s × quantity %s is not a price a booking can carry', p_unit_price_usd, v_qty));
  END IF;
  IF p_deposit_percent IS NOT NULL AND (p_deposit_percent < 0 OR p_deposit_percent > 100) THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_arguments', 'detail', 'deposit percent must be 0..100');
  END IF;

  v_total_minor := round(p_unit_price_usd * v_qty * 100)::bigint;
  v_fee_minor   := public.rb_platform_fee_minor(v_total_minor, v_pct);
  SELECT t.* INTO v_terms FROM public.rb_booking_payment_terms(v_total_minor, v_mode, p_deposit_percent) t;

  RETURN v_out || jsonb_build_object(
    'priced', true,
    'total_minor', v_total_minor,
    'total_usd', round(v_total_minor / 100.0, 2),
    'fee_minor', v_fee_minor,
    'fee_usd', round(v_fee_minor / 100.0, 2),
    'buddy_net_usd', round((v_total_minor - v_fee_minor) / 100.0, 2),
    'payment_mode', v_terms.payment_mode,
    'deposit_enabled', v_terms.deposit_enabled,
    'deposit_percent', v_terms.deposit_percent,
    'deposit_usd', round(v_terms.deposit_minor / 100.0, 2),
    'cash_balance_usd', round(v_terms.cash_balance_minor / 100.0, 2));
END;
$_$;

-- ── 4. rb_post_booking_ledger — THE write door ──────────────────────────────
--
-- p_event      'booking_created' | 'tip' | 'addons' | 'reversal' | 'settlement'
-- p_event_key  required for 'tip' and 'settlement' (the caller's event id);
--              ignored for the others. 'carried-over' is RESERVED: it is the key
--              this function gives a pre-3824 tip it carries into the entries.
-- p_args       tip:        { traveler_id uuid, amount_usd numeric, note text? }
--              addons:     { traveler_id uuid, addon_ids uuid[], allowed_statuses text[],
--                            payment_mode text?, deposit_percent int?,
--                            deposit_rule text?, deposit_reason text? }
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
  SET search_path TO pg_catalog, public, pg_temp
  AS $_$
DECLARE
  -- The rule generation stamped on entries this function prices. v1 was the
  -- JavaScript writer (lib/creatorLedgerRows.ts#RENT_BUDDY_FEE_RULE_VERSION).
  c_rule_version   CONSTANT text := 'rent-buddy-fee-schedule/v2';
  c_unfulfilled    CONSTANT text[] := ARRAY['cancelled', 'cancelled_by_traveler', 'cancelled_by_buddy', 'declined', 'expired'];
  c_earning        CONSTANT text[] := ARRAY['booking_gross', 'platform_fee', 'traveler_service_fee'];
  c_special        CONSTANT numeric[] := ARRAY['NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric];

  v_args           jsonb := COALESCE(p_args, '{}'::jsonb);
  v_key            text  := NULLIF(btrim(COALESCE(p_event_key, '')), '');

  v_status         text;
  v_buddy_id       uuid;
  v_payment_mode   text;
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

  -- addons
  v_addon_ids      uuid[];
  v_new_ids        uuid[];
  v_allowed        text[];
  v_new_mode       text;
  v_dep_pct        integer;
  v_addons_add     numeric := 0;
  v_addons_n       integer := 0;
  v_valid_n        integer := 0;
  v_terms          record;
  v_adj_pct        integer;
  v_gross_fold     bigint;
  v_fee_fold       bigint;
  v_delta          bigint;
  v_fee_delta      bigint;
  v_seq            integer;
BEGIN
  IF p_booking_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'booking_required', 'detail', 'p_booking_id is null');
  END IF;
  IF p_event IS NULL OR p_event NOT IN ('booking_created', 'tip', 'addons', 'reversal', 'settlement') THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'unknown_event', 'detail', COALESCE(p_event, 'null'));
  END IF;
  IF p_event IN ('tip', 'settlement') THEN
    IF v_key IS NULL OR length(v_key) > 120 OR v_key !~ '^[A-Za-z0-9_.:-]+$' THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'event_key_required',
        'detail', 'a tip or settlement needs an event key of 1-120 characters [A-Za-z0-9_.:-], derived from the event and not from the attempt');
    END IF;
    -- RESERVED. "booking:<id>:tip:carried-over" is the transaction this function
    -- writes when it carries a pre-3824 tips row into the entries. A caller's
    -- key of the same spelling would collide with it: ON CONFLICT DO NOTHING
    -- would drop the new tip and the call would still answer ok.
    IF lower(v_key) = 'carried-over' THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'event_key_reserved',
        'detail', 'the event key "carried-over" is reserved for the ledger''s own use');
    END IF;
  END IF;

  -- ── The critical section: every ledger event of one booking is serialised ──
  SELECT b.status::text, b.traveler_id, b.buddy_id, b.total_usd, b.addons_total_usd, b.deposit_usd,
         b.cash_balance_usd, b.pricing_type, b.category, b.payment_mode::text
    INTO v_status, v_traveler, v_buddy_id, v_total_usd, v_addons_usd, v_deposit_usd,
         v_cash_usd, v_pricing_type, v_category, v_payment_mode
    FROM public.rent_buddy_bookings b
   WHERE b.id = p_booking_id
     FOR NO KEY UPDATE OF b;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'booking_not_found', 'detail', p_booking_id::text);
  END IF;

  -- THE MARKET: the buddy's own country and city — the same rb_booking_market
  -- row rb_quote_booking showed the traveller before checkout. The booking's
  -- `city` is whatever the request said and prices nothing.
  SELECT m.buddy_user_id, m.buddy_level, m.country, m.city
    INTO v_buddy_user, v_buddy_level, v_country, v_city
    FROM public.rb_booking_market(v_buddy_id) m;

  SELECT EXISTS (
           SELECT 1 FROM public.rent_buddy_earnings_entries e
            WHERE e.booking_id = p_booking_id AND e.entry_reason = 'booking_gross'),
         EXISTS (
           SELECT 1 FROM public.rent_buddy_earnings_entries e
            WHERE e.booking_id = p_booking_id AND e.entry_reason = 'booking_gross'
              AND NOT EXISTS (SELECT 1 FROM public.rent_buddy_earnings_entries r WHERE r.reverses_entry_id = e.id))
    INTO v_has_gross, v_live_gross;

  -- ── A live booking whose earning entries are ALL reversed ─────────────────
  -- It cannot exist: the table refuses to move a booking out of an unfulfilled
  -- status (rbb_refuse_uncancel). If one is found anyway (a superuser bypassing
  -- triggers), every EARNING event is REFUSED by name. Answering "already
  -- ledgered" — or recording a tip or an add-on — over a ledger that folds to
  -- zero is the defect that trigger exists to prevent.
  IF p_event IN ('booking_created', 'tip', 'addons')
     AND v_has_gross AND NOT v_live_gross AND NOT (v_status = ANY (c_unfulfilled)) THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'booking_reversed',
      'detail', format('booking is %s but its earning entries were reversed; a reversed booking is terminal', v_status));
  END IF;

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
    -- NaN compares GREATER than every number in PostgreSQL, so `<= 0` does not
    -- catch it, and Infinity or anything at or above 10^8 overflows numeric(10,2)
    -- further down — as an exception, i.e. a 503. They are refusals.
    IF v_amount_usd IS NULL OR v_amount_usd = ANY (c_special) OR v_amount_usd <= 0
       OR round(v_amount_usd * 100) >= 10000000000 OR round(v_amount_usd * 100) < 1 THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_amount',
        'detail', format('a tip must be at least one minor unit and below 100000000 (got %s)', COALESCE(v_amount_usd::text, 'null')));
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
      FROM public.rent_buddy_earnings_entries e
     WHERE e.idempotency_key = format('booking:%s:tip:%s#1', p_booking_id, v_key);
    IF FOUND THEN
      IF v_existing_minor <> v_amount_minor THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'idempotency_key_reused',
          'detail', format('event key %s already recorded a tip of %s minor units, not %s', v_key, v_existing_minor, v_amount_minor));
      END IF;
      v_tip_replay := true;
    END IF;
  END IF;

  -- ── addons: attach, re-total and re-term the booking under its row lock ────
  -- Every refusal is decided before anything is written, as for a tip.
  IF p_event = 'addons' THEN
    BEGIN
      v_actor   := NULLIF(v_args->>'traveler_id', '')::uuid;
      v_dep_pct := NULLIF(v_args->>'deposit_percent', '')::integer;
      SELECT array_agg(DISTINCT x::uuid) INTO v_addon_ids
        FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(v_args->'addon_ids') = 'array' THEN v_args->'addon_ids' ELSE '[]'::jsonb END) AS x;
      SELECT array_agg(x) INTO v_allowed
        FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(v_args->'allowed_statuses') = 'array' THEN v_args->'allowed_statuses' ELSE '[]'::jsonb END) AS x;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_arguments',
        'detail', 'addons needs traveler_id (uuid), addon_ids (uuid[]) and allowed_statuses (text[])');
    END;
    v_new_mode := NULLIF(btrim(COALESCE(v_args->>'payment_mode', '')), '');

    IF v_actor IS NULL OR v_actor IS DISTINCT FROM v_traveler THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'not_traveler',
        'detail', 'only the traveller on the booking can attach add-ons');
    END IF;
    IF v_addon_ids IS NULL OR cardinality(v_addon_ids) = 0 OR v_allowed IS NULL OR cardinality(v_allowed) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_arguments',
        'detail', 'addon_ids and allowed_statuses must be non-empty arrays');
    END IF;
    IF NOT (v_status = ANY (v_allowed)) THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'booking_not_open',
        'detail', format('booking is %s; add-ons attach only before a booking starts', v_status));
    END IF;
    IF v_new_mode IS NOT NULL AND v_new_mode NOT IN ('full_in_app', 'deposit_plus_cash') THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_arguments', 'detail', 'unknown payment_mode');
    END IF;
    IF v_dep_pct IS NOT NULL AND (v_dep_pct < 0 OR v_dep_pct > 100) THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_arguments', 'detail', 'deposit_percent must be 0..100');
    END IF;
    IF v_buddy_user IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'buddy_not_found', 'detail', 'the booking has no payee');
    END IF;
    IF v_total_usd IS NULL OR v_total_usd < 0 THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_total', 'detail', COALESCE(v_total_usd::text, 'null'));
    END IF;

    SELECT count(*) INTO v_valid_n
      FROM public.rent_buddy_addons a
     WHERE a.id = ANY (v_addon_ids) AND a.is_active;
    IF v_valid_n = 0 THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'no_valid_addons', 'detail', 'none of the add-ons exists and is active');
    END IF;

    -- IDEMPOTENT BY STATE: an add-on already attached to this booking is not
    -- attached, priced or ledgered again. Under the row lock a retry and a
    -- double-tap are serialised, so the second sees the first's rows.
    SELECT COALESCE(array_agg(a.id), '{}'::uuid[]), COALESCE(SUM(a.price_usd), 0), count(*)
      INTO v_new_ids, v_addons_add, v_addons_n
      FROM public.rent_buddy_addons a
     WHERE a.id = ANY (v_addon_ids) AND a.is_active
       AND NOT EXISTS (SELECT 1 FROM public.rent_buddy_booking_addons ba
                        WHERE ba.booking_id = p_booking_id AND ba.addon_id = a.id);

    IF v_addons_n = 0 THEN
      v_replayed := true;
    ELSE
      IF v_total_usd + v_addons_add >= 100000000 THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'invalid_total',
          'detail', 'the booking total with these add-ons is not a price a booking can carry');
      END IF;

      INSERT INTO public.rent_buddy_booking_addons (booking_id, addon_id, title, price_usd)
      SELECT p_booking_id, a.id, a.title, a.price_usd
        FROM public.rent_buddy_addons a
       WHERE a.id = ANY (v_new_ids);

      v_total_usd    := v_total_usd + v_addons_add;
      v_addons_usd   := COALESCE(v_addons_usd, 0) + v_addons_add;
      v_payment_mode := COALESCE(v_new_mode, v_payment_mode);

      SELECT t.* INTO v_terms
        FROM public.rb_booking_payment_terms(round(v_total_usd * 100)::bigint, v_payment_mode, v_dep_pct) t;
      v_deposit_usd := round(v_terms.deposit_minor / 100.0, 2);
      v_cash_usd    := round(v_terms.cash_balance_minor / 100.0, 2);

      UPDATE public.rent_buddy_bookings
         SET total_usd            = v_total_usd,
             addons_total_usd     = v_addons_usd,
             deposit_usd          = v_deposit_usd,
             cash_balance_usd     = v_cash_usd,
             payment_mode         = v_terms.payment_mode::public.rent_buddy_payment_mode,
             deposit_percent      = v_terms.deposit_percent,
             deposit_rule_applied = CASE WHEN v_terms.deposit_enabled
                                         THEN COALESCE(NULLIF(v_args->>'deposit_rule', ''), deposit_rule_applied)
                                         ELSE 'no_deposit' END,
             deposit_reason       = CASE WHEN v_terms.deposit_enabled
                                         THEN COALESCE(NULLIF(v_args->>'deposit_reason', ''), deposit_reason)
                                         ELSE 'No deposit is taken in the first release (owner ruling 2026-10-04).' END,
             updated_at           = now()
       WHERE id = p_booking_id;
    END IF;
  END IF;

  -- ── booking_created (also the "ensure" step of tip and addons) ────────────
  IF p_event = 'booking_created' OR (p_event IN ('tip', 'addons') AND NOT v_has_gross) THEN
    IF v_has_gross THEN
      -- (A live booking whose earning entries are all reversed was refused
      -- above, as `booking_reversed`.)
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
        FROM public.rb_resolve_platform_fee_percent(v_buddy_level, v_country, v_city, v_category) f;

      v_total_minor := round(v_total_usd * 100)::bigint;
      v_fee_minor   := public.rb_platform_fee_minor(v_total_minor, v_fee_percent);

      IF v_total_minor <> 0 THEN
        v_tx := format('booking:%s:booking_gross:%s', p_booking_id, c_rule_version);
        INSERT INTO public.rent_buddy_earnings_entries
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
        INSERT INTO public.rent_buddy_earnings_entries
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

  -- ── addons: ADJUSTMENT entries, so the fold equals the new total ──────────
  -- (A booking that had no entries was just ledgered above, at its new total.)
  -- The commission applies to the add-on at the rate the BOOKING was ledgered
  -- at — a booking keeps the rate it was priced at — and the fee leg is the
  -- difference between the commission on the new total and the commission
  -- already booked, so the fold is round(total × rate), not a sum of roundings.
  IF p_event = 'addons' AND v_has_gross AND v_addons_n > 0 THEN
    SELECT l.platform_fee_percent INTO v_adj_pct
      FROM public.rent_buddy_earnings_ledger l WHERE l.booking_id = p_booking_id;
    IF v_adj_pct IS NULL THEN
      SELECT f.fee_percent, f.fee_source INTO v_fee_percent, v_fee_source
        FROM public.rb_resolve_platform_fee_percent(v_buddy_level, v_country, v_city, v_category) f;
      v_adj_pct := v_fee_percent;
    END IF;

    SELECT COALESCE(SUM(x.amount_minor) FILTER (WHERE x.account = 'buddy_payable'    AND COALESCE(o.entry_reason, x.entry_reason) = 'booking_gross'), 0),
           COALESCE(SUM(x.amount_minor) FILTER (WHERE x.account = 'platform_revenue' AND COALESCE(o.entry_reason, x.entry_reason) = 'platform_fee'), 0)
      INTO v_gross_fold, v_fee_fold
      FROM public.rent_buddy_earnings_entries x
      LEFT JOIN public.rent_buddy_earnings_entries o ON o.id = x.reverses_entry_id
     WHERE x.booking_id = p_booking_id;

    v_total_minor := round(v_total_usd * 100)::bigint;
    v_delta       := v_total_minor - v_gross_fold;
    v_fee_delta   := public.rb_platform_fee_minor(v_total_minor, v_adj_pct) - v_fee_fold;

    SELECT count(DISTINCT split_part(e.transaction_key, ':', 4)) + 1 INTO v_seq
      FROM public.rent_buddy_earnings_entries e
     WHERE e.booking_id = p_booking_id
       AND e.transaction_key LIKE format('booking:%s:addons:%%', p_booking_id);

    IF v_delta <> 0 THEN
      v_tx := format('booking:%s:addons:%s:booking_gross', p_booking_id, v_seq);
      INSERT INTO public.rent_buddy_earnings_entries
        (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
         attribution_kind, attribution_id, beneficiary_user_id, provider, idempotency_key)
      VALUES
        (v_tx, p_booking_id, 'traveler_receivable', 'booking_gross', -v_delta, 'USD', c_rule_version,
         'booking', p_booking_id, NULL,         'none', v_tx || '#0'),
        (v_tx, p_booking_id, 'buddy_payable',       'booking_gross',  v_delta, 'USD', c_rule_version,
         'booking', p_booking_id, v_buddy_user, 'none', v_tx || '#1')
      ON CONFLICT (idempotency_key) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_appended := v_appended + v_n;
    END IF;

    IF v_fee_delta <> 0 THEN
      v_tx := format('booking:%s:addons:%s:platform_fee', p_booking_id, v_seq);
      INSERT INTO public.rent_buddy_earnings_entries
        (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
         attribution_kind, attribution_id, beneficiary_user_id, provider, idempotency_key)
      VALUES
        (v_tx, p_booking_id, 'buddy_payable',    'platform_fee', -v_fee_delta, 'USD', c_rule_version,
         'booking', p_booking_id, v_buddy_user, 'none', v_tx || '#0'),
        (v_tx, p_booking_id, 'platform_revenue', 'platform_fee',  v_fee_delta, 'USD', c_rule_version,
         'booking', p_booking_id, NULL,         'none', v_tx || '#1')
      ON CONFLICT (idempotency_key) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_appended := v_appended + v_n;
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
        FROM public.rent_buddy_tips t WHERE t.booking_id = p_booking_id;
      v_legacy_minor := COALESCE(v_legacy_minor, 0);

      SELECT COALESCE(SUM(e.amount_minor), 0) INTO v_tip_fold
        FROM public.rent_buddy_earnings_entries e
        LEFT JOIN public.rent_buddy_earnings_entries o ON o.id = e.reverses_entry_id
       WHERE e.booking_id = p_booking_id AND e.account = 'buddy_payable'
         AND COALESCE(o.entry_reason, e.entry_reason) = 'tip';

      IF v_legacy_minor > v_tip_fold THEN
        INSERT INTO public.rent_buddy_earnings_entries
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
      INSERT INTO public.rent_buddy_earnings_entries
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
    INSERT INTO public.rent_buddy_earnings_entries
      (transaction_key, booking_id, account, entry_reason, amount_minor, currency, rule_version,
       attribution_kind, attribution_id, beneficiary_user_id, reverses_entry_id, provider, external_ref,
       idempotency_key)
    SELECT 'reversal:' || o.transaction_key, o.booking_id, o.account, 'reversal', -o.amount_minor, o.currency,
           o.rule_version, o.attribution_kind, o.attribution_id, o.beneficiary_user_id, o.id, o.provider,
           o.external_ref, 'reversal:' || o.idempotency_key
      FROM public.rent_buddy_earnings_entries o
     WHERE o.booking_id = p_booking_id
       AND o.entry_reason = ANY (c_earning)
       AND NOT EXISTS (SELECT 1 FROM public.rent_buddy_earnings_entries r WHERE r.reverses_entry_id = o.id)
    ON CONFLICT (idempotency_key) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_appended := v_appended + v_n;

    IF v_n = 0 THEN
      IF NOT v_has_gross AND NOT EXISTS (SELECT 1 FROM public.rent_buddy_earnings_ledger l WHERE l.booking_id = p_booking_id) THEN
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
      FROM public.rent_buddy_earnings_entries e
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
        FROM public.rent_buddy_earnings_entries e
       WHERE e.booking_id = p_booking_id AND e.account = 'traveler_receivable';

      IF v_amount_minor > v_outstanding THEN
        RETURN jsonb_build_object('ok', false, 'refusal', 'settlement_exceeds_receivable',
          'detail', format('%s minor units offered against %s outstanding', v_amount_minor, v_outstanding));
      END IF;

      INSERT INTO public.rent_buddy_earnings_entries
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
      FROM public.rent_buddy_earnings_entries x
      LEFT JOIN public.rent_buddy_earnings_entries o ON o.id = x.reverses_entry_id
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
    INSERT INTO public.rent_buddy_earnings_ledger AS l
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
      addons_usd                  = EXCLUDED.addons_usd,
      deposit_amount              = EXCLUDED.deposit_amount,
      cash_balance_due            = EXCLUDED.cash_balance_due,
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

    INSERT INTO public.rent_buddy_tips (booking_id, traveler_id, buddy_user_id, amount_usd, note)
    VALUES (p_booking_id, v_traveler, v_buddy_user, v_amount_usd, v_note)
    ON CONFLICT (booking_id) DO UPDATE
      SET amount_usd = EXCLUDED.amount_usd,
          note       = COALESCE(EXCLUDED.note, rent_buddy_tips.note);

    UPDATE public.rent_buddy_bookings
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
    'addons_added', CASE WHEN p_event = 'addons' THEN v_addons_n ELSE NULL END,
    'booking', CASE WHEN p_event = 'addons' THEN jsonb_build_object(
                 'total_usd', v_total_usd, 'addons_total_usd', COALESCE(v_addons_usd, 0),
                 'deposit_usd', COALESCE(v_deposit_usd, 0), 'cash_balance_usd', COALESCE(v_cash_usd, 0),
                 'payment_mode', v_payment_mode, 'added_usd', COALESCE(v_addons_add, 0)) ELSE NULL END,
    'summary', v_summary);
END;
$_$;

-- ── 5. Reversal in the transaction that makes the booking unfulfilled ───────
CREATE OR REPLACE FUNCTION public.rb_booking_ledger_on_unfulfilled()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO pg_catalog, public, pg_temp
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

-- ── 5b. An unfulfilled booking is terminal ──────────────────────────────────
-- No route moves a booking out of cancelled / cancelled_by_* / declined /
-- expired, and the state machine has no such transition. If one did, the
-- booking would be live with its earning entries reversed. Moving BETWEEN
-- unfulfilled statuses is not refused.
CREATE OR REPLACE FUNCTION public.rb_booking_refuse_uncancel()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO pg_catalog, public, pg_temp
  AS $_$
BEGIN
  RAISE EXCEPTION 'rb_booking_refuse_uncancel: booking % is % and cannot become %: an unfulfilled booking is terminal, and its earning entries were reversed in the transaction that ended it',
    OLD.id, OLD.status, NEW.status
    USING ERRCODE = '23514';
END;
$_$;

DROP TRIGGER IF EXISTS rbb_refuse_uncancel ON public.rent_buddy_bookings;
CREATE TRIGGER rbb_refuse_uncancel
  BEFORE UPDATE OF status ON public.rent_buddy_bookings
  FOR EACH ROW
  WHEN (OLD.status IN ('cancelled', 'cancelled_by_traveler', 'cancelled_by_buddy', 'declined', 'expired')
        AND NEW.status NOT IN ('cancelled', 'cancelled_by_traveler', 'cancelled_by_buddy', 'declined', 'expired'))
  EXECUTE FUNCTION public.rb_booking_refuse_uncancel();

-- ── 6. rb_buddy_ledger_totals — the earnings summary, folded in SQL ─────────
--
-- One jsonb row for one buddy (profiles.id), over their COMPLETED bookings, so
-- no row cap can truncate it and no figure is recomputed in the API process.
-- Money figures come from the entries; a completed booking with no entries is
-- COUNTED (unledgeredCompletedCount) and contributes no money, rather than
-- being priced on the fly at a rate nobody recorded for it.
--
-- "Ledgered" means it has ENTRIES. A booking completed before 2901 has a
-- summary row (the JavaScript writer's) and no entries, and 2901 backfilled
-- none: counting summary rows called it ledgered while its money was in no
-- fold, so it was silently missing from every figure. A booking whose price is
-- 0 has, correctly, no entries and nothing to miss; it is not counted.
CREATE OR REPLACE FUNCTION public.rb_buddy_ledger_totals(p_buddy_user_id uuid)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO pg_catalog, public, pg_temp
  AS $$
  WITH done AS (
    SELECT b.id, b.total_usd, b.cash_balance_usd, b.cash_balance_confirmed_by_buddy
      FROM public.rent_buddy_bookings b
      JOIN public.rent_buddy_profiles bp ON bp.id = b.buddy_id
     WHERE bp.user_id = p_buddy_user_id
       AND b.status::text = 'completed'
  ), e AS (
    SELECT x.booking_id, x.account, x.amount_minor, COALESCE(o.entry_reason, x.entry_reason) AS base
      FROM public.rent_buddy_earnings_entries x
      LEFT JOIN public.rent_buddy_earnings_entries o ON o.id = x.reverses_entry_id
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
    SELECT COALESCE(bool_or(is_estimated), true) AS any_estimated
      FROM public.rent_buddy_earnings_ledger
     WHERE booking_id IN (SELECT id FROM done)
  ), u AS (
    SELECT COUNT(*) AS unledgered
      FROM done d
     WHERE COALESCE(d.total_usd, 0) <> 0
       AND NOT EXISTS (SELECT 1 FROM public.rent_buddy_earnings_entries x
                        WHERE x.booking_id = d.id AND x.entry_reason = 'booking_gross')
  )
  SELECT jsonb_build_object(
    'completedCount',            (SELECT COUNT(*) FROM done),
    'unledgeredCompletedCount',  u.unledgered,
    'completedTotalUsd',         (SELECT COALESCE(SUM(total_usd), 0) FROM done),
    'ledgeredGrossUsd',          round(f.gross_minor / 100.0, 2),
    'estimatedPlatformFeeUsd',   round(f.fee_minor / 100.0, 2),
    'estimatedBuddyEarningsUsd', round((f.net_minor - f.tip_minor) / 100.0, 2),
    'tipsTotalUsd',              round(f.tip_minor / 100.0, 2),
    'tipCount',                  f.tip_count,
    'inAppAmountCollectedUsd',   round(f.settled_minor / 100.0, 2),
    'cashBalanceDueUsd',         (SELECT COALESCE(SUM(cash_balance_usd), 0) FROM done WHERE cash_balance_confirmed_by_buddy IS NOT TRUE),
    'cashBalanceConfirmedUsd',   (SELECT COALESCE(SUM(cash_balance_usd), 0) FROM done WHERE cash_balance_confirmed_by_buddy IS TRUE),
    'isEstimated',               l.any_estimated OR (SELECT COUNT(*) FROM done) = 0 OR u.unledgered > 0
  )
  FROM f, l, u;
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
--   hold     from 'pending' only
--   release  from 'on_hold' only
-- `status` is free text with no CHECK, and the route's rule was "anything but
-- on_hold or released", which let a row marked `paid` be held and then
-- released. A payout that has left `pending` any other way is not held here.
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
  SET search_path TO pg_catalog, public, pg_temp
  AS $_$
DECLARE
  v_reason  text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_from    text;
  v_to      text;
  v_row     public.rent_buddy_payouts%ROWTYPE;
  v_audit   uuid;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('hold', 'release') THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'unknown_action', 'detail', COALESCE(p_action, 'null'));
  END IF;
  IF p_payout_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'not_found', 'detail', 'p_payout_id is null');
  END IF;
  IF p_admin_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_admin_id AND p.role::text = 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'not_admin', 'detail', 'the acting profile is not an admin');
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 1000 THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'reason_required',
      'detail', 'a payout hold or release needs a reason of 1-1000 characters');
  END IF;

  SELECT * INTO v_row FROM public.rent_buddy_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refusal', 'not_found', 'detail', p_payout_id::text);
  END IF;
  v_from := v_row.status;

  IF p_action = 'hold' THEN
    IF v_from IS DISTINCT FROM 'pending' THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'conflict', 'current_status', v_from,
        'detail', format('Payout is %s; only a pending payout can be held.', COALESCE(v_from, 'null')));
    END IF;
    v_to := 'on_hold';
    UPDATE public.rent_buddy_payouts
       SET status = v_to, hold_reason = v_reason, held_by = p_admin_id, held_at = now(), updated_at = now()
     WHERE id = p_payout_id
    RETURNING * INTO v_row;
  ELSE
    IF v_from IS DISTINCT FROM 'on_hold' THEN
      RETURN jsonb_build_object('ok', false, 'refusal', 'conflict', 'current_status', v_from,
        'detail', format('Payout is %s; this transition requires on_hold.', v_from));
    END IF;
    v_to := 'released';
    UPDATE public.rent_buddy_payouts
       SET status = v_to, notes = v_reason, released_by = p_admin_id, released_at = now(), updated_at = now()
     WHERE id = p_payout_id
    RETURNING * INTO v_row;
  END IF;

  -- Same transaction. If this INSERT fails the UPDATE above is undone with it.
  INSERT INTO public.rent_buddy_admin_actions (admin_id, target_type, target_id, action, notes, details)
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

REVOKE ALL ON FUNCTION public.rb_booking_refuse_uncancel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_booking_refuse_uncancel() FROM anon;
REVOKE ALL ON FUNCTION public.rb_booking_refuse_uncancel() FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_booking_refuse_uncancel() FROM service_role;

-- Internal: called only from the SECURITY DEFINER functions in this file, which
-- run as their owner. No role calls them over REST.
REVOKE ALL ON FUNCTION public.rb_booking_market(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_booking_market(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.rb_booking_market(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_booking_market(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.rb_platform_fee_minor(bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_platform_fee_minor(bigint, integer) FROM anon;
REVOKE ALL ON FUNCTION public.rb_platform_fee_minor(bigint, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_platform_fee_minor(bigint, integer) FROM service_role;

REVOKE ALL ON FUNCTION public.rb_booking_payment_terms(bigint, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_booking_payment_terms(bigint, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.rb_booking_payment_terms(bigint, text, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_booking_payment_terms(bigint, text, integer) FROM service_role;

REVOKE ALL ON FUNCTION public.rb_quote_booking(uuid, text, numeric, numeric, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_quote_booking(uuid, text, numeric, numeric, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.rb_quote_booking(uuid, text, numeric, numeric, text, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_quote_booking(uuid, text, numeric, numeric, text, integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.rb_quote_booking(uuid, text, numeric, numeric, text, integer) TO service_role;

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
  'THE write door of the Rent-a-Buddy earnings ledger. One call appends an event''s entries to rent_buddy_earnings_entries AND re-derives rent_buddy_earnings_ledger by folding them, in one transaction; idempotent per (booking, event). Events: booking_created (gross + commission, priced in SQL on the buddy''s market), tip (one pair, no commission), addons (attach + re-total + adjustment entries, so the fold equals the new total), reversal (exact negation of the earning entries of an unfulfilled booking), settlement (must name a provider; no route calls it). Expected refusals are returned as {ok:false, refusal}.';
COMMENT ON FUNCTION public.rb_booking_market(uuid) IS
  'THE definition of a Rent-a-Buddy booking''s market: the buddy profile''s own country and city (trimmed), with the payee and the buddy level. rb_quote_booking and rb_post_booking_ledger both price through it, so the commission shown before checkout and the commission posted cannot be resolved for two different markets.';
COMMENT ON FUNCTION public.rb_platform_fee_minor(bigint, integer) IS
  'The Rent-a-Buddy commission arithmetic: round(total_minor × percent / 100) in integer minor units. The only place it is written.';
COMMENT ON FUNCTION public.rb_booking_payment_terms(bigint, text, integer) IS
  'Deposit and cash-balance terms of a booking, behind ONE switch: rent_buddy_global_controls.deposits_enabled (FALSE by default; owner ruling 2026-10-04, no deposit in the first release). OFF or missing: deposit 0. ON: full_in_app = whole price in-app; deposit_plus_cash = the named percent (default 30) in integer minor units.';
COMMENT ON FUNCTION public.rb_quote_booking(uuid, text, numeric, numeric, text, integer) IS
  'What checkout is shown and what booking creation stores: the price (unit × quantity, numeric), the commission and the payment terms a booking with this buddy and category would carry, from the same functions rb_post_booking_ledger uses. Computes nothing the posting computes differently. Refusals are returned as {ok:false, refusal}.';
COMMENT ON FUNCTION public.rb_booking_refuse_uncancel() IS
  'Trigger function for rbb_refuse_uncancel: refuses (23514) moving a booking out of cancelled / cancelled_by_* / declined / expired. An unfulfilled booking is terminal; its earning entries were reversed when it ended.';
COMMENT ON FUNCTION public.rb_booking_ledger_on_unfulfilled() IS
  'Trigger function for rbb_reverse_ledger_on_unfulfilled: reverses a booking''s earning entries in the transaction that moves it to cancelled / cancelled_by_* / declined / expired. Raises, aborting the status change, if the reversal is refused.';
COMMENT ON FUNCTION public.rb_buddy_ledger_totals(uuid) IS
  'A buddy''s earnings summary over their completed bookings, folded from rent_buddy_earnings_entries in SQL and returned as one jsonb row. Completed bookings with a price and no ENTRIES are counted in unledgeredCompletedCount and contribute no money. inAppAmountCollectedUsd is the fold of settlement entries.';
COMMENT ON FUNCTION public.rb_admin_payout_transition(uuid, text, uuid, text) IS
  'PAY-075. Applies an admin payout hold or release under the row lock AND writes its rent_buddy_admin_actions row in the same transaction; a failing audit insert leaves the status unchanged. Hold from pending only; release from on_hold only. Requires an admin profile and a reason. Moves no money and creates no payout.';

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
    'rb_booking_market|p_buddy_profile_id uuid',
    'rb_platform_fee_minor|p_total_minor bigint, p_fee_percent integer',
    'rb_booking_payment_terms|p_total_minor bigint, p_payment_mode text, p_deposit_percent integer',
    'rb_quote_booking|p_buddy_profile_id uuid, p_category text, p_unit_price_usd numeric, p_quantity numeric, p_payment_mode text, p_deposit_percent integer',
    'rb_post_booking_ledger|p_booking_id uuid, p_event text, p_event_key text, p_args jsonb',
    'rb_booking_ledger_on_unfulfilled|',
    'rb_booking_refuse_uncancel|',
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
    -- pg_catalog FIRST and pg_temp LAST, spelled out: with `public` alone,
    -- pg_temp is searched first for relations and a session's temporary table
    -- shadows the configuration these functions read.
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = oid_ AND p.proconfig IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                      WHERE replace(cfg, ' ', '') = 'search_path=pg_catalog,public,pg_temp')) THEN
      RAISE EXCEPTION '3824: POSTCONDITION FAILED: public.% does not pin search_path to pg_catalog, public, pg_temp', fn;
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
    IF fn IN ('rb_resolve_platform_fee_percent', 'rb_quote_booking', 'rb_post_booking_ledger',
              'rb_buddy_ledger_totals', 'rb_admin_payout_transition')
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
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.rent_buddy_bookings'::regclass
     AND tgname = 'rbb_refuse_uncancel' AND NOT tgisinternal;
  IF n <> 1 THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rbb_refuse_uncancel is not installed; a cancelled booking could be made live with its earning entries reversed';
  END IF;

  -- Idempotent creation rests on a unique index, not on an application check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.rent_buddy_bookings'::regclass
       AND c.relname = 'rbb_creation_key_once' AND i.indisunique AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rbb_creation_key_once is not a partial unique index on rent_buddy_bookings';
  END IF;

  -- The deposit switch exists, NOT NULL, defaulting to FALSE. Its VALUE is an
  -- operator''s and is not asserted.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rent_buddy_global_controls' AND column_name = 'deposits_enabled'
     AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false';
  IF n <> 1 THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rent_buddy_global_controls.deposits_enabled is not a NOT NULL boolean defaulting to false';
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
  IF def NOT LIKE '%public.rb_booking_market(v_buddy_id)%' OR def LIKE '%b.city%' OR def LIKE '%b.country_code%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_post_booking_ledger does not price on the buddy''s market alone — the quote and the posting could disagree';
  END IF;
  IF def NOT LIKE '%public.rb_platform_fee_minor(%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_post_booking_ledger carries its own commission arithmetic';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rb_quote_booking';
  IF def NOT LIKE '%public.rb_booking_market(%' OR def NOT LIKE '%public.rb_platform_fee_minor(%'
     OR def NOT LIKE '%public.rb_resolve_platform_fee_percent(%' OR def NOT LIKE '%public.rb_booking_payment_terms(%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_quote_booking does not quote through the functions the posting uses';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rb_booking_payment_terms';
  IF def NOT LIKE '%gc.deposits_enabled%' OR def NOT LIKE '%COALESCE(v_enabled, false)%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_booking_payment_terms does not default to no deposit';
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
  IF def NOT LIKE '%FOR UPDATE%' OR def NOT LIKE '%INSERT INTO public.rent_buddy_admin_actions%'
     OR def NOT LIKE '%IS DISTINCT FROM ''pending''%' THEN
    RAISE EXCEPTION '3824: POSTCONDITION FAILED: rb_admin_payout_transition does not lock the payout, hold from pending only, and write its audit row in one call';
  END IF;
END
$post$;

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- db/rollback/2026-10-04-3824-rent-buddy-ledger-posting-rollback.sql. It drops
-- the two triggers, the functions, the override column, the creation-key column
-- and the deposit switch, and restores 2901's entry_reason CHECK — which it
-- REFUSES to do while a settlement entry or a non-NULL override exists or the
-- deposit switch is ON, because each would be destroyed or orphaned.
-- No entry or summary row written through this door is touched: they are
-- ordinary append-only ledger rows and dropping the writer does not make them
-- wrong.
