-- Rollback for 3603_rb_earnings_summary_floor_commission.sql
-- Written 2026-10-08 by lane P (PR #616). Rehearsed only on PGlite (WASM
-- PostgreSQL) with the forward files; NOT run against portava-ci
-- (hwokxgbmezheskbzskfr) or production (ajrurzioarfkagpuxfnb); 3603 itself is
-- applied to neither.
--
-- RUN IT SO THAT A REFUSAL STOPS THE RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/2026-10-08-3603-rb-earnings-summary-floor-commission-rollback.sql
--
-- WHAT 3603 DID: CREATE OR REPLACE public.rb_buddy_earnings_summary(uuid, numeric)
-- with one change to 3530's body (the per-booking fee FLOORs to the cent, the
-- checkout's commission rule, instead of ROUND(..., 2)), 3530's exact
-- REVOKE/GRANT set (EXECUTE to service_role only) and an updated comment.
--
-- WHAT THIS DOES: re-installs 3530's definition VERBATIM (the body, the same five
-- REVOKE/GRANT statements and 3530's comment, copied from
-- 3530_rb_earnings_summary_nothing_collected.sql). A pure CREATE OR REPLACE of a
-- function with no dependent object: no row is read or written, nothing is lost.
-- After it the RPC path rounds the fee half away from zero again while the
-- route's TypeScript fold floors; the route labels both isEstimated, so the
-- summary can differ from the charge by one cent per booking (3603's header).
--
-- It REFUSES unless the installed body is 3603's (it FLOORs the fee), so it never
-- overwrites a later replacement it does not know about.

BEGIN;

DO $pre$
DECLARE
  oid_ oid;
BEGIN
  SELECT p.oid INTO oid_
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rb_buddy_earnings_summary'
     AND pg_get_function_identity_arguments(p.oid) = 'p_buddy_id uuid, p_platform_fee_pct numeric';
  IF oid_ IS NULL THEN
    RAISE EXCEPTION '3603 rollback REFUSED: public.rb_buddy_earnings_summary(uuid, numeric) does not exist; this is not the state 3603 left.';
  END IF;
  IF pg_get_functiondef(oid_) !~ 'FLOOR\(COALESCE\(b\.total_usd, 0\)::numeric \* COALESCE\(p_platform_fee_pct, 0\) \* 100\) / 100' THEN
    RAISE EXCEPTION '3603 rollback REFUSED: the installed body does not FLOOR the per-booking fee, so it is not 3603''s (already rolled back, or replaced later); nothing is overwritten.';
  END IF;
END
$pre$;

-- ── 3530's definition, verbatim ─────────────────────────────────────────────
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

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3603_rb_earnings_summary_floor_commission.sql';
  END IF;
END $$;

-- ── Postconditions: 3530's body and 3530's privileges ───────────────────────
DO $post$
DECLARE
  oid_ oid;
  body text;
BEGIN
  SELECT p.oid INTO oid_
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rb_buddy_earnings_summary'
     AND pg_get_function_identity_arguments(p.oid) = 'p_buddy_id uuid, p_platform_fee_pct numeric';
  IF oid_ IS NULL THEN
    RAISE EXCEPTION '3603 rollback FAILED: rb_buddy_earnings_summary(uuid, numeric) does not exist';
  END IF;
  body := pg_get_functiondef(oid_);
  IF body !~ 'ROUND\(COALESCE\(b\.total_usd, 0\)::numeric \* COALESCE\(p_platform_fee_pct, 0\), 2\)' THEN
    RAISE EXCEPTION '3603 rollback FAILED: the installed body does not ROUND the per-booking fee as 3530 does';
  END IF;
  IF body ~ 'FLOOR\(COALESCE\(b\.total_usd' THEN
    RAISE EXCEPTION '3603 rollback FAILED: 3603''s FLOOR is still installed';
  END IF;
  IF body !~ '''totalInAppUsd''[[:space:]]*,[[:space:]]*0::numeric' OR body !~ 'totalInAppScheduledUsd' THEN
    RAISE EXCEPTION '3603 rollback FAILED: the installed body is not 3530''s (totalInAppUsd from a literal 0, totalInAppScheduledUsd present)';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = oid_) THEN
    RAISE EXCEPTION '3603 rollback FAILED: rb_buddy_earnings_summary is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = oid_ AND p.proconfig IS NOT NULL
                   AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')) THEN
    RAISE EXCEPTION '3603 rollback FAILED: rb_buddy_earnings_summary does not pin search_path';
  END IF;
  IF has_function_privilege('public', oid_, 'EXECUTE') OR has_function_privilege('anon', oid_, 'EXECUTE')
     OR has_function_privilege('authenticated', oid_, 'EXECUTE') THEN
    RAISE EXCEPTION '3603 rollback FAILED: a client role (PUBLIC, anon or authenticated) can execute rb_buddy_earnings_summary';
  END IF;
  IF NOT has_function_privilege('service_role', oid_, 'EXECUTE') THEN
    RAISE EXCEPTION '3603 rollback FAILED: service_role cannot execute rb_buddy_earnings_summary';
  END IF;
  RAISE NOTICE '3603 rollback OK: 3530''s rb_buddy_earnings_summary (half-up fee) is installed, EXECUTE to service_role only.';
END
$post$;

COMMIT;
