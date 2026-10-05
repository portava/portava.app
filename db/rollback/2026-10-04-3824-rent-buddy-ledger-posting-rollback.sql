-- Rollback for 3824_rent_buddy_ledger_posting.sql
-- Written 2026-10-04 by the payments lane (PAY-D: PAY-T12 / PAY-T21).
-- Rehearsed on a private throwaway PostgreSQL 16 only (apply, re-apply, rollback,
-- re-apply; src/test/db/rentBuddyLedgerPosting.db.test.ts M1-M7).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3824 DID
-- =============
-- (1) Widened rent_buddy_earnings_entries.rbee_entry_reason_check to admit
--     'settlement', and added rbee_settlement_names_provider.
-- (2) Added the nullable column rent_buddy_launch_controls.platform_fee_percent
--     and its range CHECK.
-- (3) Added ten functions — rb_resolve_platform_fee_percent, rb_booking_market,
--     rb_platform_fee_minor, rb_booking_payment_terms, rb_quote_booking,
--     rb_post_booking_ledger, rb_booking_ledger_on_unfulfilled,
--     rb_booking_refuse_uncancel, rb_buddy_ledger_totals,
--     rb_admin_payout_transition — and two triggers on rent_buddy_bookings:
--     rbb_reverse_ledger_on_unfulfilled and rbb_refuse_uncancel.
-- (4) Added the nullable column rent_buddy_bookings.creation_key, its CHECK and
--     the partial unique index rbb_creation_key_once.
-- (5) Added the column rent_buddy_global_controls.deposits_enabled, FALSE: the
--     one deposit switch.
-- (6) Replaced the body of rb_buddy_earnings_summary (2330's function, last
--     defined by 3530_rb_earnings_summary_nothing_collected.sql) so that the
--     in-app share is read from the payment mode instead of from deposit_usd.
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- It REFUSES, changing nothing, while either of these holds:
--   * a 'settlement' entry exists. Restoring 2901's vocabulary would make that
--     row violate its own table's CHECK, and the entries are append-only: the
--     row cannot be removed to make room (3510 refuses the DELETE too).
--   * a launch control carries a non-NULL platform_fee_percent. Dropping the
--     column would silently discard an operator's configured commission.
--   * the deposit switch rent_buddy_global_controls.deposits_enabled is ON.
--     Dropping the column would silently discard the owner's decision to take
--     deposits.
-- Otherwise it drops the two triggers, the ten functions, the override column,
-- the creation-key column and the (FALSE) deposit switch, restores 2901's
-- entry_reason CHECK exactly as 2901 wrote it, puts 3530's definition of
-- rb_buddy_earnings_summary back (copied from that file, byte for byte), and
-- deletes 3824's ledger row.
--
-- WHAT IT COSTS — read before running it
-- ======================================
--   * ROLLING 3824 BACK REQUIRES ROLLING THE API BACK. The API at or after
--     this change calls rb_quote_booking and rb_post_booking_ledger for every
--     booking creation, tip and add-on, rb_buddy_ledger_totals for the earnings
--     summary and rb_admin_payout_transition for payout hold / release, writes
--     rent_buddy_bookings.creation_key, and has NO fallback: with these gone
--     all five booking-creation paths, checkout confirm, tips, payout hold /
--     release and the earnings summary answer 503. A refusal is the designed
--     behaviour; a silent read-modify-write is the defect 3824 removed.
--   * Bookings created with an Idempotency-Key lose that key: a client retry
--     after the rollback is not recognised as a retry.
--   * A cancelled / declined / expired booking can again be moved back to a
--     live status by direct SQL (no route does).
--   * A booking moved to cancelled / declined / expired after the rollback
--     keeps its earning entries: nothing reverses them. That is the pre-3824
--     state (PAY-067).
--   * rb_buddy_earnings_summary goes back to 3530's body, which reads the
--     in-app share from deposit_usd. Bookings created through 3824 while no
--     deposit is taken carry deposit_usd = 0; for a full_in_app one of those,
--     3530's body reports totalNetUsd = -fees. It still reports NOTHING as
--     collected (that is 3530's guarantee and it is kept). If such bookings
--     exist, do not leave the database in this state: re-apply 3824.
--   * No entry and no summary row is touched. Reversal, tip and v2 booking
--     entries written through 3824 stay exactly as they are; they are ordinary
--     append-only rows and remain a correct record.

BEGIN;

DO $pre$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.rent_buddy_earnings_entries') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.rent_buddy_earnings_entries WHERE entry_reason = 'settlement';
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3824): % settlement entr(y/ies) exist. 2901''s entry_reason CHECK cannot be restored over them and the entries are append-only. Nothing has been changed.', n;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rent_buddy_launch_controls'
                AND column_name = 'platform_fee_percent') THEN
    SELECT count(*) INTO n FROM public.rent_buddy_launch_controls WHERE platform_fee_percent IS NOT NULL;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3824): % launch control(s) carry a commission override. Dropping the column would discard configuration an operator set. Clear the overrides deliberately first. Nothing has been changed.', n;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rent_buddy_global_controls'
                AND column_name = 'deposits_enabled') THEN
    EXECUTE 'SELECT count(*) FROM public.rent_buddy_global_controls WHERE deposits_enabled' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3824): the deposit switch rent_buddy_global_controls.deposits_enabled is ON. Dropping it would discard that decision. Turn it off deliberately first. Nothing has been changed.';
    END IF;
  END IF;
END
$pre$;

DROP TRIGGER IF EXISTS rbb_reverse_ledger_on_unfulfilled ON public.rent_buddy_bookings;
DROP TRIGGER IF EXISTS rbb_refuse_uncancel ON public.rent_buddy_bookings;

DROP FUNCTION IF EXISTS public.rb_booking_ledger_on_unfulfilled();
DROP FUNCTION IF EXISTS public.rb_booking_refuse_uncancel();
DROP FUNCTION IF EXISTS public.rb_quote_booking(uuid, text, numeric, numeric, text, integer);
DROP FUNCTION IF EXISTS public.rb_booking_payment_terms(bigint, text, integer);
DROP FUNCTION IF EXISTS public.rb_platform_fee_minor(bigint, integer);
DROP FUNCTION IF EXISTS public.rb_booking_market(uuid);
DROP FUNCTION IF EXISTS public.rb_post_booking_ledger(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.rb_resolve_platform_fee_percent(text, text, text, text);
DROP FUNCTION IF EXISTS public.rb_buddy_ledger_totals(uuid);
DROP FUNCTION IF EXISTS public.rb_admin_payout_transition(uuid, text, uuid, text);

-- 3530's definition, grants and comment, exactly as that file carries them.
-- (If 3530 was never applied this creates what 3530 would have: an aggregate
-- that reports nothing as collected. It is not dropped — 2330 created it.)
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

ALTER TABLE public.rent_buddy_launch_controls
  DROP CONSTRAINT IF EXISTS rblc_platform_fee_percent_range;
ALTER TABLE public.rent_buddy_launch_controls
  DROP COLUMN IF EXISTS platform_fee_percent;

DROP INDEX IF EXISTS public.rbb_creation_key_once;
ALTER TABLE public.rent_buddy_bookings
  DROP CONSTRAINT IF EXISTS rbb_creation_key_shape;
ALTER TABLE public.rent_buddy_bookings
  DROP COLUMN IF EXISTS creation_key;

-- The switch is FALSE here (the precondition refused otherwise).
ALTER TABLE public.rent_buddy_global_controls
  DROP COLUMN IF EXISTS deposits_enabled;

ALTER TABLE public.rent_buddy_earnings_entries
  DROP CONSTRAINT IF EXISTS rbee_settlement_names_provider;
ALTER TABLE public.rent_buddy_earnings_entries
  DROP CONSTRAINT IF EXISTS rbee_entry_reason_check;
-- NOTHING here asserts money arrived, left or settled (2901's own words).
ALTER TABLE public.rent_buddy_earnings_entries
  ADD CONSTRAINT rbee_entry_reason_check CHECK (
    entry_reason IN ('booking_gross', 'tip', 'platform_fee', 'traveler_service_fee', 'reversal'));

COMMENT ON TABLE public.rent_buddy_earnings_entries IS
  'Append-only, signed, minor-unit double-entry source for Rent-a-Buddy earnings. The balance is SUM(amount_minor) over these rows; rent_buddy_earnings_ledger is a projection of them and no longer a source. Records no settlement: cash_settled_minor = 0 is CHECK-enforced (2170:40 shape). Corrections are new rows naming reverses_entry_id. No client grant.';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3824_rent_buddy_ledger_posting.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE def text;
BEGIN
  IF to_regprocedure('public.rb_post_booking_ledger(uuid,text,text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.rb_resolve_platform_fee_percent(text,text,text,text)') IS NOT NULL
     OR to_regprocedure('public.rb_booking_ledger_on_unfulfilled()') IS NOT NULL
     OR to_regprocedure('public.rb_buddy_ledger_totals(uuid)') IS NOT NULL
     OR to_regprocedure('public.rb_admin_payout_transition(uuid,text,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.rb_booking_refuse_uncancel()') IS NOT NULL
     OR to_regprocedure('public.rb_quote_booking(uuid,text,numeric,numeric,text,integer)') IS NOT NULL
     OR to_regprocedure('public.rb_booking_payment_terms(bigint,text,integer)') IS NOT NULL
     OR to_regprocedure('public.rb_platform_fee_minor(bigint,integer)') IS NOT NULL
     OR to_regprocedure('public.rb_booking_market(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3824 rollback): a 3824 function still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.rent_buddy_bookings'::regclass
                AND tgname IN ('rbb_reverse_ledger_on_unfulfilled', 'rbb_refuse_uncancel')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3824 rollback): a 3824 trigger still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rent_buddy_bookings'
                AND column_name = 'creation_key') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3824 rollback): rent_buddy_bookings.creation_key still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rent_buddy_global_controls'
                AND column_name = 'deposits_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3824 rollback): rent_buddy_global_controls.deposits_enabled still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rent_buddy_launch_controls'
                AND column_name = 'platform_fee_percent') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3824 rollback): rent_buddy_launch_controls.platform_fee_percent still exists.';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass AND conname = 'rbee_entry_reason_check';
  IF def IS NULL OR def LIKE '%settlement%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3824 rollback): 2901''s entry_reason CHECK was not restored (%).', def;
  END IF;
  -- 3530's body is back: nothing collected, and no trace of 3824's CASE.
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rb_buddy_earnings_summary';
  IF def IS NULL OR def !~ '''totalInAppUsd''[[:space:]]*,[[:space:]]*0::numeric' OR def ~ 'payment_mode' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3824 rollback): rb_buddy_earnings_summary is not 3530''s definition.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3824_rent_buddy_ledger_posting.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3824 rollback): the ledger still records 3824 as applied.';
  END IF;
END $post$;
