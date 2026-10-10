-- 3603_rb_earnings_summary_floor_commission.sql
-- Lane P, PR #616, 2026-10-06. Replaces the body of
-- public.rb_buddy_earnings_summary(uuid, numeric) once more (2330 created it,
-- 3530 made it report nothing collected). CREATE OR REPLACE, so it is
-- self-sufficient on any database; it sorts after 3530 and keeps every key and
-- every number 3530 produces EXCEPT the per-booking platform fee's rounding.
--
-- ── THE ONE CHANGE ─────────────────────────────────────────────────────────
--   fee = ROUND(total_usd * rate, 2)              (2330, 3530: half away from 0)
--   fee = FLOOR(total_usd * rate * 100) / 100     (this file)
--
-- WHY. The owner's decision is a flat 10 % commission on the pre-tax service
-- price, none on tips (OD-PAY-3, 2026-10-04). The commission actually TAKEN
-- at checkout is computed by lane B's payment slice as
-- commissionMinor(service, bps) = floor(service x bps / 10000): the seller
-- keeps the remainder, so commission + seller share = service exactly. This
-- function is the buddy's EARNINGS SUMMARY for the same bookings. Rounding the
-- other way here made the summary one cent higher in fee (one cent lower in
-- net) than the checkout takes on HALF of all cent amounts at 10 % — every
-- amount whose last digit is 5-9 — which is not an edge case. The TypeScript
-- fold and the per-booking ledger (lib/rentBuddyFeeSchedule.ts
-- applyBasisPoints) floor in the same change; this file is the SQL half.
--
-- EXACTNESS. `total_usd` is numeric(10,2) and the route passes the rate as the
-- exact decimal bps/10000 (basisPointsAsRateFraction), so total x rate x 100 is
-- an exact numeric and FLOOR is exact. Every amount is non-negative (a booking
-- total), so floor and truncation coincide.
--
-- WHAT IT DOES NOT CHANGE. Signature, SECURITY DEFINER, pinned search_path, the
-- grants (EXECUTE to service_role only), totalInAppUsd = 0, the scheduled sum,
-- totalNetUsd = scheduled + cash - fees, the disputed rules, the month key and
-- the sort order are exactly 3530's.
--
-- NOT APPLIED ANYWHERE. Like 3530 and 3601/3602 it waits on the ordinary
-- reviewed path (owner authorization 2026-10-06: portava-ci through CI, never
-- production by hand from here). rent_buddy_enabled is FALSE; this file reads no
-- flag and writes no data. Before it is applied the route's RPC path returns
-- 3530's (or 2330's) half-up fee while the fallback fold floors; the route
-- already labels both isEstimated.
--
-- ROLLBACK: re-apply 3530's definition of the function (a pure CREATE OR
-- REPLACE with no dependent object; one statement, nothing lost).

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
      -- 3603: FLOOR to the cent, the rule the checkout's commission uses
      -- (lane B: commissionMinor = floor(service x bps / 10000)), so this
      -- summary, the TypeScript fold and the charge agree cent for cent.
      FLOOR(COALESCE(b.total_usd, 0)::numeric * COALESCE(p_platform_fee_pct, 0) * 100) / 100 AS fee
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
  'M7 + M5. DB-side earnings aggregation for one buddy as a single jsonb row, so no PostgREST row cap can truncate the sum. Reports totalInAppUsd = 0 and monthlyBreakdown[].inApp = 0 because nothing is ever collected in app (pay-deposit / pay-full are 503s); the deposit sum it used to publish under those names is now totalInAppScheduledUsd / inAppScheduled. totalNetUsd is unchanged. The per-booking platform fee is FLOOR(total x rate x 100) / 100, the checkout''s commission rule (3603). Superseded 2330''s and 3530''s bodies; see 3603_rb_earnings_summary_floor_commission.sql.';

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
      '3603: POSTCONDITION FAILED: public.rb_buddy_earnings_summary(p_buddy_id uuid, p_platform_fee_pct numeric) does not exist';
  END IF;

  -- The security properties 2330 established must survive the replacement.
  -- CREATE OR REPLACE keeps them, which is precisely why it is worth asserting:
  -- a future hand-edit that drops SECURITY DEFINER or the pinned search_path
  -- would turn an aggregate over one buddy's money into a caller-privileged
  -- read, and nothing else in this file would notice.
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = oid_) THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: rb_buddy_earnings_summary is not SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = oid_
       AND p.proconfig IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')
  ) THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: rb_buddy_earnings_summary does not pin search_path';
  END IF;

  IF has_function_privilege('public', oid_, 'EXECUTE') THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: PUBLIC can execute rb_buddy_earnings_summary';
  END IF;

  IF has_function_privilege('anon', oid_, 'EXECUTE') THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: anon can execute rb_buddy_earnings_summary';
  END IF;

  IF has_function_privilege('authenticated', oid_, 'EXECUTE') THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: authenticated can execute rb_buddy_earnings_summary';
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
      '3603: POSTCONDITION FAILED: the installed body has no totalInAppScheduledUsd — 2330''s definition is still in place';
  END IF;

  IF body !~ '''totalInAppUsd''[[:space:]]*,[[:space:]]*0::numeric' THEN
    RAISE EXCEPTION
      '3603: POSTCONDITION FAILED: totalInAppUsd is not built from a literal 0 in the installed body';
  END IF;

  -- 3603's own change, asserted on the installed source: the fee is floored,
  -- and no ROUND(..., 2) of the fee survives beside it.
  IF body !~ 'FLOOR\(COALESCE\(b\.total_usd, 0\)::numeric \* COALESCE\(p_platform_fee_pct, 0\) \* 100\) / 100' THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: the installed body does not FLOOR the per-booking fee';
  END IF;
  IF body ~ 'ROUND\(COALESCE\(b\.total_usd' THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: the installed body still ROUNDs the per-booking fee half away from zero';
  END IF;

  -- The defect itself, named: 2330 built the collected key from the deposit
  -- sum. No installed body may do that again, whatever else it does.
  IF body ~ '''totalInAppUsd''[[:space:]]*,[[:space:]]*t\.total_in_app[[:space:]]*,' THEN
    RAISE EXCEPTION
      '3603: POSTCONDITION FAILED: the installed body still builds totalInAppUsd from the deposit sum';
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
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: the aggregate returned NULL for a buddy with no bookings';
  END IF;

  IF (result ->> 'totalInAppUsd')::numeric <> 0 THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: totalInAppUsd is % and not 0', result ->> 'totalInAppUsd';
  END IF;

  IF NOT (result ? 'totalInAppScheduledUsd') THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: totalInAppScheduledUsd is absent from the result';
  END IF;

  IF NOT (result ? 'totalNetUsd') THEN
    RAISE EXCEPTION '3603: POSTCONDITION FAILED: totalNetUsd is absent — the route keys its preferred path off it';
  END IF;
END
$probe$;

COMMIT;
