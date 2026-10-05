-- 3530_rb_earnings_summary_nothing_collected.sql
-- M5 / docs/architecture/09_Payment_Architecture.md §1.3.1, the SQL half.
-- Replaces the body of public.rb_buddy_earnings_summary (created by
-- 2330_rent_buddy_money_atomicity.sql). Depends on 2330 only for the function's
-- existence, and CREATE OR REPLACE creates it if 2330 has not been applied, so
-- this file is self-sufficient on any database.
--
-- ── WHAT IS WRONG TODAY ─────────────────────────────────────────────────────
-- `09` §1.3.1 names the defect: *"It records money as collected that was never
-- collected."* It was filed against the earnings-ledger WRITER, and the writer
-- was repaired — lib/rentBuddyEarningsLedger.ts now writes
-- `in_app_amount_collected` as 0, derived from append-only entries that cannot
-- assert a settlement (2901 CHECK-constrains `cash_settled_minor = 0`).
--
-- This function was not repaired in that change. It sums
-- `rent_buddy_bookings.deposit_usd` and publishes the total as
-- `totalInAppUsd` — "in app", i.e. money Portava took — and the same figure per
-- month as `monthlyBreakdown[].inApp`. So for the same bookings the ledger row
-- said nothing had been collected while this aggregate said a deposit had.
--
-- For `payment_mode = 'full_in_app'`, `deposit_usd` IS the whole booking total
-- (routes/rentABuddy.ts computes `depositUsd = totalUsd` for that mode), so the
-- aggregate claimed the ENTIRE booking value had been charged in app. Nothing
-- was: `pay-deposit` and `pay-full` both return 503 `payment_stub:true`, no
-- processor is chosen, and nothing in the tree inserts a payout row.
--
-- ── WHAT THIS FILE CHANGES, AND WHAT IT DELIBERATELY DOES NOT ───────────────
-- CHANGED — two renamings and two zeros:
--   * `totalInAppUsd`            → 0            (collected: nothing is)
--   * `totalInAppScheduledUsd`   → NEW, carries the former value: what the
--                                  bookings say WOULD be charged in app
--   * `monthlyBreakdown[].inApp` → 0
--   * `monthlyBreakdown[].inAppScheduled` → NEW, the former per-month value
--
-- UNCHANGED — every other key, byte for byte, including both totals:
--   * `totalNetUsd` stays `scheduled + cash - fees`, the same number 2330
--     produced. Deriving it from the collected zero would report a NEGATIVE
--     balance for every full_in_app booking, which is a second wrong number in
--     place of the first and not a repair.
--   * `monthlyBreakdown[].totalUsd`, `yearlyNetUsd`, `totalCashConfirmedUsd`,
--     `totalPlatformFeesUsd`, `totalDisputedUsd`, `totalPendingUsd`, the
--     disputed-booking rules, the month key, the sort order and the fee
--     parameter are all exactly as 2330 left them.
--
-- The scheduled figure is KEPT rather than dropped for the same reason the
-- ledger row keeps `deposit_amount` beside its zeroed `in_app_amount_collected`:
-- what a booking is worth, and what is owed, are not the false claim. That it
-- had already been paid was.
--
-- ── THIS IS NOT THE ONLY GUARD ──────────────────────────────────────────────
-- Migrations here are applied by hand after CI, so between this commit and the
-- press every database still holds 2330's body. routes/rentABuddy.ts therefore
-- RE-STATES whatever this function returns through
-- lib/rentBuddyCollectedMoney.ts:withNothingCollected, which maps the legacy
-- key shape onto the honest one. The route is correct before this file is
-- applied and after; applying it makes the database agree rather than making
-- the API honest.
--
-- No data is touched. No flag is flipped (`rent_buddy_enabled` is FALSE in
-- production and this file does not read it). No grant widens: the
-- revoke/grant pair below is the same one 2330 carries, repeated because a
-- NEWLY created function is EXECUTE-to-PUBLIC by default and this file may be
-- the one that creates it.
--
-- ROLLBACK: re-apply 2330's definition of the function. It is a pure
-- CREATE OR REPLACE with no dependent object, so reverting is one statement and
-- loses nothing.

BEGIN;

CREATE OR REPLACE FUNCTION public.rb_buddy_earnings_summary(
  p_buddy_id         uuid,
  p_platform_fee_pct numeric
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  WITH src AS (
    SELECT
      COALESCE(
        to_char(b.completed_at AT TIME ZONE 'UTC', 'YYYY-MM'),
        to_char(b.booking_date, 'YYYY-MM'),
        ''
      )                                                                     AS month,
      b.status::text                                                        AS status,
      COALESCE(b.total_usd, 0)::numeric                                     AS gross,
      -- RENAMED from `in_app`. Same expression, a name that does not assert
      -- the money arrived.
      COALESCE(b.deposit_usd, 0)::numeric                                   AS in_app_scheduled,
      COALESCE(b.cash_balance_usd, 0)::numeric                              AS cash,
      ROUND(COALESCE(b.total_usd, 0)::numeric * COALESCE(p_platform_fee_pct, 0), 2) AS fee
    FROM rent_buddy_bookings b
    WHERE b.buddy_id = p_buddy_id
      AND b.status::text IN ('completed', 'disputed')
  ),
  monthly AS (
    SELECT
      s.month                                                                    AS month,
      COUNT(*)::int                                                              AS booking_count,
      SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.gross - s.fee END)       AS total_usd,
      SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.in_app_scheduled END)    AS in_app_scheduled,
      SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.cash END)                AS cash,
      SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.fee END)                 AS fees
    FROM src s
    GROUP BY s.month
  ),
  totals AS (
    SELECT
      COALESCE(SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.in_app_scheduled END), 0) AS total_in_app_scheduled,
      COALESCE(SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.cash   END), 0) AS total_cash,
      COALESCE(SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.fee    END), 0) AS total_fees,
      COALESCE(SUM(CASE WHEN s.status = 'disputed' THEN s.gross ELSE 0  END), 0) AS total_disputed
    FROM src s
  )
  SELECT jsonb_build_object(
    -- Collected in app. Nothing is: there is no payment path to collect it.
    -- A literal 0 and not an expression, because an expression over
    -- deposit_usd is exactly what this file removes.
    'totalInAppUsd',           0::numeric,
    'totalInAppScheduledUsd',  t.total_in_app_scheduled,
    'totalCashConfirmedUsd',   t.total_cash,
    'totalPlatformFeesUsd',    t.total_fees,
    'totalDisputedUsd',        t.total_disputed,
    'totalPendingUsd',         0,
    -- Unchanged: the estimate of what the buddy is OWED.
    'totalNetUsd',             t.total_in_app_scheduled + t.total_cash - t.total_fees,
    'yearlyNetUsd',            COALESCE((
                                 SELECT SUM(m.total_usd) FROM monthly m
                                  WHERE m.month LIKE to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '%'
                               ), 0),
    'monthlyBreakdown',        COALESCE((
                                 SELECT jsonb_agg(
                                          jsonb_build_object(
                                            'month',          m.month,
                                            'totalUsd',       m.total_usd,
                                            'bookingCount',   m.booking_count,
                                            'inApp',          0::numeric,
                                            'inAppScheduled', m.in_app_scheduled,
                                            'cash',           m.cash,
                                            'fees',           m.fees
                                          ) ORDER BY m.month DESC
                                        )
                                 FROM monthly m
                               ), '[]'::jsonb)
  )
  FROM totals t;
$$;

REVOKE ALL ON FUNCTION public.rb_buddy_earnings_summary(uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_buddy_earnings_summary(uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.rb_buddy_earnings_summary(uuid, numeric) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_buddy_earnings_summary(uuid, numeric) FROM service_role;
GRANT EXECUTE ON FUNCTION public.rb_buddy_earnings_summary(uuid, numeric) TO service_role;

COMMENT ON FUNCTION public.rb_buddy_earnings_summary(uuid, numeric) IS
  'M7 + M5. DB-side earnings aggregation for one buddy as a single jsonb row, so no PostgREST row cap can truncate the sum. Reports totalInAppUsd = 0 and monthlyBreakdown[].inApp = 0 because nothing is ever collected in app (pay-deposit / pay-full are 503s); the deposit sum it used to publish under those names is now totalInAppScheduledUsd / inAppScheduled. totalNetUsd is unchanged. Superseded 2330''s body; see 3530_rb_earnings_summary_nothing_collected.sql.';

-- ── Postconditions ──────────────────────────────────────────────────────────
-- Assertions about this file's own effect. Conditional RAISE only; no data is
-- written, and the probe below only SELECTs through the function.

DO $post$
DECLARE
  oid_ oid;
  body text;
BEGIN
  SELECT p.oid INTO oid_
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'rb_buddy_earnings_summary'
     AND pg_get_function_identity_arguments(p.oid) = 'p_buddy_id uuid, p_platform_fee_pct numeric';

  IF oid_ IS NULL THEN
    RAISE EXCEPTION
      '3530: POSTCONDITION FAILED: public.rb_buddy_earnings_summary(p_buddy_id uuid, p_platform_fee_pct numeric) does not exist';
  END IF;

  -- The security properties 2330 established must survive the replacement.
  -- CREATE OR REPLACE keeps them, which is precisely why it is worth asserting:
  -- a future hand-edit that drops SECURITY DEFINER or the pinned search_path
  -- would turn an aggregate over one buddy's money into a caller-privileged
  -- read, and nothing else in this file would notice.
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = oid_) THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: rb_buddy_earnings_summary is not SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = oid_
       AND p.proconfig IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')
  ) THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: rb_buddy_earnings_summary does not pin search_path';
  END IF;

  IF has_function_privilege('public', oid_, 'EXECUTE') THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: PUBLIC can execute rb_buddy_earnings_summary';
  END IF;

  IF has_function_privilege('anon', oid_, 'EXECUTE') THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: anon can execute rb_buddy_earnings_summary';
  END IF;

  IF has_function_privilege('authenticated', oid_, 'EXECUTE') THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: authenticated can execute rb_buddy_earnings_summary';
  END IF;

  -- The replacement actually took. Asserting the OID exists proves only that
  -- SOME definition is installed; 2330's body would satisfy every check above.
  -- So the installed source is read, and these three assertions are written as
  -- POSIX regexes over structure rather than as LIKE patterns over exact
  -- spacing: a postcondition that a reformat can break is one an operator will
  -- learn to work around, and this file is applied by hand.
  body := pg_get_functiondef(oid_);

  IF body !~ 'totalInAppScheduledUsd' THEN
    RAISE EXCEPTION
      '3530: POSTCONDITION FAILED: the installed body has no totalInAppScheduledUsd — 2330''s definition is still in place';
  END IF;

  IF body !~ '''totalInAppUsd''[[:space:]]*,[[:space:]]*0::numeric' THEN
    RAISE EXCEPTION
      '3530: POSTCONDITION FAILED: totalInAppUsd is not built from a literal 0 in the installed body';
  END IF;

  -- The defect itself, named: 2330 built the collected key from the deposit
  -- sum. No installed body may do that again, whatever else it does.
  IF body ~ '''totalInAppUsd''[[:space:]]*,[[:space:]]*t\.total_in_app[[:space:]]*,' THEN
    RAISE EXCEPTION
      '3530: POSTCONDITION FAILED: the installed body still builds totalInAppUsd from the deposit sum';
  END IF;
END
$post$;

-- A behavioural postcondition, not a textual one: drive the function over a
-- buddy id that cannot exist and assert the SHAPE it answers with. An empty
-- aggregate still has to carry both keys, because the route reads them.
DO $probe$
DECLARE
  result jsonb;
BEGIN
  SELECT public.rb_buddy_earnings_summary('00000000-0000-0000-0000-000000000000'::uuid, 0.15)
    INTO result;

  IF result IS NULL THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: the aggregate returned NULL for a buddy with no bookings';
  END IF;

  IF (result ->> 'totalInAppUsd')::numeric <> 0 THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: totalInAppUsd is % and not 0', result ->> 'totalInAppUsd';
  END IF;

  IF NOT (result ? 'totalInAppScheduledUsd') THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: totalInAppScheduledUsd is absent from the result';
  END IF;

  IF NOT (result ? 'totalNetUsd') THEN
    RAISE EXCEPTION '3530: POSTCONDITION FAILED: totalNetUsd is absent — the route keys its preferred path off it';
  END IF;
END
$probe$;

COMMIT;
