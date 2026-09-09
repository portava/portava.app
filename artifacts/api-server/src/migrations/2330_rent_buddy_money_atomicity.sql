-- 2330_rent_buddy_money_atomicity.sql
--
-- Atomic primitives for the rent-a-buddy money record.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2330.
-- Additive + idempotent. Safe to re-run. Creates no table, drops nothing,
-- changes no existing row. Three functions only.
--
-- ── THE DEFECTS ─────────────────────────────────────────────────────────────
--
-- M8  A SECOND TIP OVERWRITES THE FIRST.
--     routes/rentABuddyMarketplace.ts POST /rent-a-buddy/bookings/:id/tip does
--     three unrelated writes with no transaction:
--       1. an UPSERT into rent_buddy_tips with onConflict "booking_id" and a
--          bare `amount_usd: amountUsd` — the table carries
--          `rent_buddy_tips_booking_id_key UNIQUE (booking_id)`
--          (baseline:14551-14552), so the second tip on a booking REPLACES the
--          first instead of adding to it. The first tip is destroyed; there is
--          no other copy of it, and no later reconciliation can recover it.
--       2. a best-effort UPDATE of rent_buddy_earnings_ledger.tip_usd, and
--       3. a best-effort UPDATE of rent_buddy_bookings.tip_usd,
--          both to the SINGLE tip amount rather than the running total, and
--          both able to fail (logged only) leaving the three copies disagreeing.
--     `rb_accumulate_booking_tip` below is the correct primitive: one
--     invocation, one transaction, GREATEST(0, col + delta) accumulation, and
--     the two denormalised copies written from the accumulated total so they
--     cannot drift from the tips table that is the record of account.
--     09 §1.3 (the tip path); 12 §4 Stage 1B item 8.
--
-- M13 CASH CONFIRMATION RACES, AND THE AMOUNT IS UNBOUNDED.
--     routes/rentABuddy.ts POST /rent-a-buddy/bookings/:id/confirm-cash reads
--     the booking and then writes it in a SEPARATE statement, so two
--     simultaneous confirmations each read the other party's column as it was
--     BEFORE the other write and the later write reinstates the stale value —
--     a classic lost update on a money record. docs/rent-buddy-audit.md:397
--     names the second half: "A buddy could confirm an inflated cash amount."
--     `rb_confirm_booking_cash` takes the booking's row lock, settles party
--     identity and the amount bound under that lock, and writes BOTH
--     confirmation columns in ONE update whose CASE arms re-read the row under
--     the lock. A claimed amount above what the booking says is owed
--     (`cash_balance_usd`) is REFUSED, not written.
--     09 §9.2; 12 §4 Stage 1B item 13.
--
-- M7  EARNINGS AGGREGATES ARE SUMMED IN JAVASCRIPT OVER AN UNPAGINATED SELECT.
--     routes/rentABuddy.ts GET /rent-a-buddy/dashboard/earnings/summary pulls
--     every completed/disputed booking row for a buddy and sums them in the API
--     process with no pagination. PostgREST caps a select at its configured
--     max-rows and reports nothing when it truncates, so every buddy past that
--     cap is shown an earnings total that is silently too low — a wrong number
--     on screen today, not a latent one. 09 §1.3.4 calls this the read-side
--     twin of the counter problem in
--     .agents/memory/counter-update-atomicity.md.
--     `rb_buddy_earnings_summary` does the whole aggregation DB-side and
--     returns ONE jsonb row, so there is no row count to truncate. The fee rate
--     stays a PARAMETER: reconciling the three disagreeing take rates is M1 and
--     is blocked on verification V2 (does rent_buddy_fee_rules hold its five
--     seed rows in production?). This function must not answer that question by
--     hard-coding a fourth rate; it computes with whatever rate the caller
--     already uses, and M1's owner changes one call site.
--     12 §4 Stage 1B item 9.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────
-- No payout INSERT path (that is M2 — a capability awaiting a ruling, not a
-- repair). No money is moved, no flag is flipped, no fee rate is decided, and
-- no existing row is rewritten. The compare-and-swap on the two payout
-- transitions (M3) needs no database object at all: it is a single PostgREST
-- UPDATE carrying the expected status as a second predicate, and lives in
-- routes/rentABuddySpec.ts.
--
-- All three functions are SECURITY DEFINER with a pinned search_path, REVOKEd
-- from PUBLIC / anon / authenticated / service_role, then GRANTed EXECUTE to
-- service_role only. CREATE OR REPLACE preserves the grants of an existing
-- function but a NEWLY created one is EXECUTE-to-PUBLIC by default, so the
-- revoke/grant pair is unconditional rather than conditional on first apply.

BEGIN;

-- ── 1. rb_accumulate_booking_tip — M8 ───────────────────────────────────────
--
-- Accumulate a tip on a booking and carry the running total to both
-- denormalised copies, in one transaction.
--
-- The ON CONFLICT arm takes the tips row's lock, so a concurrent second tip on
-- the same booking blocks until the first commits and then adds to the value
-- the first wrote. That ordering also serialises the two denormalised writes:
-- the later transaction cannot write a smaller total after the earlier one.
--
-- buddy_user_id is DERIVED from the booking rather than trusted from the
-- caller: the tips row names who is owed the money, and a caller-supplied
-- payee on a money row is a defect waiting to happen.
CREATE OR REPLACE FUNCTION public.rb_accumulate_booking_tip(
  p_booking_id  uuid,
  p_traveler_id uuid,
  p_amount_usd  numeric,
  p_note        text DEFAULT NULL
)
  RETURNS TABLE (tip_id uuid, total_tip_usd numeric)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $_$
DECLARE
  v_traveler   uuid;
  v_buddy_user uuid;
  v_id         uuid;
  v_total      numeric;
BEGIN
  IF p_booking_id IS NULL OR p_traveler_id IS NULL THEN
    RAISE EXCEPTION 'rb_accumulate_booking_tip: booking and traveller are required'
      USING ERRCODE = '22023';
  END IF;

  -- A tip is money moving one way. A non-positive delta here would be a
  -- clawback, which this function is not, so it is refused rather than clamped.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RAISE EXCEPTION 'rb_accumulate_booking_tip: amount must be positive (got %)', p_amount_usd
      USING ERRCODE = '22023';
  END IF;

  SELECT b.traveler_id, bp.user_id
    INTO v_traveler, v_buddy_user
    FROM rent_buddy_bookings b
    JOIN rent_buddy_profiles bp ON bp.id = b.buddy_id
   WHERE b.id = p_booking_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rb_accumulate_booking_tip: booking % not found', p_booking_id
      USING ERRCODE = 'P0002';
  END IF;

  IF p_traveler_id IS DISTINCT FROM v_traveler THEN
    RAISE EXCEPTION 'rb_accumulate_booking_tip: % is not the traveller on booking %',
      p_traveler_id, p_booking_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO rent_buddy_tips (booking_id, traveler_id, buddy_user_id, amount_usd, note)
  VALUES (p_booking_id, v_traveler, v_buddy_user, p_amount_usd, p_note)
  ON CONFLICT (booking_id) DO UPDATE
    SET amount_usd = GREATEST(0, rent_buddy_tips.amount_usd + EXCLUDED.amount_usd),
        note       = COALESCE(EXCLUDED.note, rent_buddy_tips.note)
  RETURNING rent_buddy_tips.id, rent_buddy_tips.amount_usd
       INTO v_id, v_total;

  -- Both copies get the RUNNING TOTAL, never the delta. They are projections of
  -- the tips row above; writing the delta is how they came to disagree with it.
  UPDATE rent_buddy_earnings_ledger
     SET tip_usd = v_total, updated_at = now()
   WHERE booking_id = p_booking_id;

  UPDATE rent_buddy_bookings
     SET tip_usd = v_total, updated_at = now()
   WHERE id = p_booking_id;

  tip_id        := v_id;
  total_tip_usd := v_total;
  RETURN NEXT;
END;
$_$;

REVOKE ALL ON FUNCTION public.rb_accumulate_booking_tip(uuid, uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_accumulate_booking_tip(uuid, uuid, numeric, text) FROM anon;
REVOKE ALL ON FUNCTION public.rb_accumulate_booking_tip(uuid, uuid, numeric, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_accumulate_booking_tip(uuid, uuid, numeric, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.rb_accumulate_booking_tip(uuid, uuid, numeric, text) TO service_role;

COMMENT ON FUNCTION public.rb_accumulate_booking_tip(uuid, uuid, numeric, text) IS
  'M8. Accumulates a tip on rent_buddy_tips (GREATEST(0, amount_usd + delta)) and writes the running total to rent_buddy_earnings_ledger.tip_usd and rent_buddy_bookings.tip_usd in ONE transaction. Replaces the replacing upsert in routes/rentABuddyMarketplace.ts, under which a second tip destroyed the first.';

-- ── 2. rb_confirm_booking_cash — M13 ────────────────────────────────────────
--
-- Record one party's cash-balance confirmation atomically, refusing a claim
-- larger than the booking says is owed.
--
-- Returns exactly one row. `outcome` is the verdict the caller maps to a status
-- code; the remaining columns are the POST-WRITE state of the booking, so the
-- caller never has to re-read (re-reading is what made the route racy).
--
--   'confirmed'          the write happened; both confirmation columns returned
--   'not_found'          no such booking
--   'not_party'          the actor is neither the traveller nor the buddy
--   'amount_exceeds_due' a positive confirmation claimed more than
--                        cash_balance_usd; NOTHING was written
CREATE OR REPLACE FUNCTION public.rb_confirm_booking_cash(
  p_booking_id uuid,
  p_actor_id   uuid,
  p_confirmed  boolean,
  p_amount_usd numeric DEFAULT NULL
)
  RETURNS TABLE (
    outcome            text,
    acted_as_traveler  boolean,
    acted_as_buddy     boolean,
    traveler_confirmed boolean,
    buddy_confirmed    boolean,
    traveler_user_id   uuid,
    booking_status     text,
    cash_due_usd       numeric,
    dispute_expires_at timestamptz
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $_$
DECLARE
  v_traveler   uuid;
  v_buddy_user uuid;
  v_due        numeric;
BEGIN
  -- FOR NO KEY UPDATE on the booking row is what makes the whole confirmation
  -- one critical section: party identity, the amount bound and the write all
  -- see the same row, and a concurrent confirmation by the other party waits
  -- here rather than overwriting the column this call is about to set.
  -- `b` is the preserved side of the outer join, so it is lockable.
  SELECT b.traveler_id, bp.user_id, b.cash_balance_usd
    INTO v_traveler, v_buddy_user, v_due
    FROM rent_buddy_bookings b
    LEFT JOIN rent_buddy_profiles bp ON bp.id = b.buddy_id
   WHERE b.id = p_booking_id
     FOR NO KEY UPDATE OF b;

  IF NOT FOUND THEN
    outcome := 'not_found';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_actor_id IS NULL
     OR (p_actor_id IS DISTINCT FROM v_traveler AND p_actor_id IS DISTINCT FROM v_buddy_user) THEN
    outcome := 'not_party';
    RETURN NEXT;
    RETURN;
  END IF;

  -- THE INFLATION BOUND (docs/rent-buddy-audit.md:397). A confirmation asserts
  -- that a specific sum changed hands; it may never assert more than the
  -- booking itself says is owed. The half-cent tolerance absorbs float
  -- round-tripping through JSON, not a genuine overclaim.
  IF p_confirmed IS TRUE
     AND p_amount_usd IS NOT NULL
     AND p_amount_usd > COALESCE(v_due, 0) + 0.005 THEN
    outcome      := 'amount_exceeds_due';
    cash_due_usd := COALESCE(v_due, 0);
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE rent_buddy_bookings b
     SET cash_balance_confirmed_by_traveler =
           CASE WHEN b.traveler_id = p_actor_id
                THEN p_confirmed
                ELSE b.cash_balance_confirmed_by_traveler END,
         cash_balance_confirmed_by_buddy =
           CASE WHEN v_buddy_user IS NOT NULL AND v_buddy_user = p_actor_id
                THEN p_confirmed
                ELSE b.cash_balance_confirmed_by_buddy END,
         updated_at = now()
   WHERE b.id = p_booking_id
  RETURNING 'confirmed'::text,
            (b.traveler_id = p_actor_id),
            (v_buddy_user IS NOT NULL AND v_buddy_user = p_actor_id),
            b.cash_balance_confirmed_by_traveler,
            b.cash_balance_confirmed_by_buddy,
            b.traveler_id,
            b.status::text,
            b.cash_balance_usd,
            b.dispute_window_expires_at
       INTO outcome, acted_as_traveler, acted_as_buddy,
            traveler_confirmed, buddy_confirmed, traveler_user_id,
            booking_status, cash_due_usd, dispute_expires_at;

  RETURN NEXT;
END;
$_$;

REVOKE ALL ON FUNCTION public.rb_confirm_booking_cash(uuid, uuid, boolean, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rb_confirm_booking_cash(uuid, uuid, boolean, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.rb_confirm_booking_cash(uuid, uuid, boolean, numeric) FROM authenticated;
REVOKE ALL ON FUNCTION public.rb_confirm_booking_cash(uuid, uuid, boolean, numeric) FROM service_role;
GRANT EXECUTE ON FUNCTION public.rb_confirm_booking_cash(uuid, uuid, boolean, numeric) TO service_role;

COMMENT ON FUNCTION public.rb_confirm_booking_cash(uuid, uuid, boolean, numeric) IS
  'M13. Records one party''s cash-balance confirmation in a single locked statement (no read-then-write race) and refuses a claimed amount above rent_buddy_bookings.cash_balance_usd. Returns the post-write state so the caller need not re-read.';

-- ── 3. rb_buddy_earnings_summary — M7 ───────────────────────────────────────
--
-- The earnings summary, aggregated DB-side and returned as ONE jsonb row.
--
-- Shape and semantics are IDENTICAL to the JavaScript loop this replaces, so
-- the repair is "the same answer, correctly" and not a silent restatement of
-- what a buddy is owed:
--   * rows are the buddy's bookings with status completed or disputed;
--   * fee    = ROUND(total_usd * p_platform_fee_pct, 2) per booking;
--   * a DISPUTED booking contributes its gross to totalDisputedUsd, counts
--     toward its month's bookingCount, and contributes NOTHING to that month's
--     totalUsd / inApp / cash / fees;
--   * a non-disputed booking contributes deposit_usd to inApp,
--     cash_balance_usd to cash, its fee to fees and (gross - fee) to totalUsd;
--   * the month key is the first seven characters of completed_at, else
--     booking_date — matching the JS `(completed_at ?? booking_date ?? "")
--     .slice(0, 7)`; PostgREST renders timestamptz in UTC, so the month is
--     computed AT TIME ZONE 'UTC' to keep the boundary in the same place;
--   * monthlyBreakdown is sorted by month descending;
--   * yearlyNetUsd sums the monthly totalUsd of the current UTC year.
--
-- p_platform_fee_pct is a FRACTION (0.15 == 15 %), passed by the caller. See
-- the header: choosing the rate is M1 and is blocked on V2.
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
      COALESCE(b.deposit_usd, 0)::numeric                                   AS in_app,
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
      SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.in_app END)              AS in_app,
      SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.cash END)                AS cash,
      SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.fee END)                 AS fees
    FROM src s
    GROUP BY s.month
  ),
  totals AS (
    SELECT
      COALESCE(SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.in_app END), 0) AS total_in_app,
      COALESCE(SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.cash   END), 0) AS total_cash,
      COALESCE(SUM(CASE WHEN s.status = 'disputed' THEN 0 ELSE s.fee    END), 0) AS total_fees,
      COALESCE(SUM(CASE WHEN s.status = 'disputed' THEN s.gross ELSE 0  END), 0) AS total_disputed
    FROM src s
  )
  SELECT jsonb_build_object(
    'totalInAppUsd',         t.total_in_app,
    'totalCashConfirmedUsd', t.total_cash,
    'totalPlatformFeesUsd',  t.total_fees,
    'totalDisputedUsd',      t.total_disputed,
    'totalPendingUsd',       0,
    'totalNetUsd',           t.total_in_app + t.total_cash - t.total_fees,
    'yearlyNetUsd',          COALESCE((
                               SELECT SUM(m.total_usd) FROM monthly m
                                WHERE m.month LIKE to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '%'
                             ), 0),
    'monthlyBreakdown',      COALESCE((
                               SELECT jsonb_agg(
                                        jsonb_build_object(
                                          'month',        m.month,
                                          'totalUsd',     m.total_usd,
                                          'bookingCount', m.booking_count,
                                          'inApp',        m.in_app,
                                          'cash',         m.cash,
                                          'fees',         m.fees
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
  'M7. DB-side earnings aggregation for one buddy, returned as a single jsonb row so no PostgREST row cap can truncate the sum. Same semantics as the JavaScript loop it replaces in routes/rentABuddy.ts; the platform fee rate stays a parameter because reconciling the three take rates is M1 and is blocked on V2.';

-- ── Postconditions ──────────────────────────────────────────────────────────
-- Assertions about this migration's own effect, and about the one pre-existing
-- object M8 depends on. Conditional RAISE only; no data is touched.

DO $$
DECLARE
  fn        text;
  fn_args   text;
  oid_      oid;
  def       text;
  role_name text;
BEGIN
  -- The tip accumulation is expressed as ON CONFLICT (booking_id). Without the
  -- unique constraint that arm is not merely wrong, it fails at runtime — so
  -- the constraint is asserted here rather than assumed.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname = 'rent_buddy_tips'
       AND c.contype = 'u'
       AND pg_get_constraintdef(c.oid) ILIKE '%UNIQUE (booking_id)%'
  ) THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: rent_buddy_tips has no UNIQUE (booking_id) — rb_accumulate_booking_tip''s ON CONFLICT arm cannot fire.';
  END IF;

  FOREACH fn_args IN ARRAY ARRAY[
    'rb_accumulate_booking_tip|uuid, uuid, numeric, text',
    'rb_confirm_booking_cash|uuid, uuid, boolean, numeric',
    'rb_buddy_earnings_summary|uuid, numeric'
  ] LOOP
    fn := split_part(fn_args, '|', 1);

    SELECT p.oid INTO oid_
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = fn
       AND pg_get_function_identity_arguments(p.oid) = split_part(fn_args, '|', 2);

    IF oid_ IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: public.%(%) was not created', fn, split_part(fn_args, '|', 2);
    END IF;

    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = oid_) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: public.% is not SECURITY DEFINER', fn;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = oid_
         AND p.proconfig IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')
    ) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: public.% does not pin search_path', fn;
    END IF;

    IF has_function_privilege('public', oid_, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: PUBLIC can execute public.%', fn;
    END IF;

    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
         AND has_function_privilege(role_name, oid_, 'EXECUTE') THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % can execute public.%', role_name, fn;
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND NOT has_function_privilege('service_role', oid_, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot execute public.% — the only caller has no grant', fn;
    END IF;
  END LOOP;

  -- The whole point of M8 is that the tip ADDS. A future edit that reverts the
  -- ON CONFLICT arm to a bare assignment restores the defect silently, so the
  -- accumulating shape is asserted, not just the function's existence.
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rb_accumulate_booking_tip';
  IF def NOT LIKE '%GREATEST(0, rent_buddy_tips.amount_usd + EXCLUDED.amount_usd)%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: rb_accumulate_booking_tip does not accumulate — a second tip would still replace the first.';
  END IF;

  -- Likewise the inflation bound: without the cash_balance_usd comparison the
  -- confirm path is back to accepting any claimed amount.
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rb_confirm_booking_cash';
  IF def NOT LIKE '%amount_exceeds_due%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: rb_confirm_booking_cash has no amount bound — an inflated cash confirmation would be accepted.';
  END IF;
  IF def NOT LIKE '%FOR NO KEY UPDATE%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: rb_confirm_booking_cash does not lock the booking row — two simultaneous confirmations would still race.';
  END IF;
END $$;

COMMIT;

-- ── ROLLBACK (manual, if ever needed) ───────────────────────────────────────
-- Dropping these three functions returns the routes to their pre-2330
-- behaviour, because every caller keeps a fallback for the case where the
-- function is absent (an un-applied migration, or a partial test client):
--
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.rb_accumulate_booking_tip(uuid, uuid, numeric, text);
--   DROP FUNCTION IF EXISTS public.rb_confirm_booking_cash(uuid, uuid, boolean, numeric);
--   DROP FUNCTION IF EXISTS public.rb_buddy_earnings_summary(uuid, numeric);
--   COMMIT;
--
-- Be clear about what a rollback costs, per function:
--   * rb_accumulate_booking_tip  — the tip path returns to an upsert that
--     REPLACES, so a second tip on a booking destroys the first with no
--     recoverable copy. This is the one that loses money; do not roll it back
--     to fix an unrelated problem.
--   * rb_confirm_booking_cash    — cash confirmation returns to read-then-write
--     (lost updates under concurrency) and to accepting any claimed amount.
--   * rb_buddy_earnings_summary  — the summary route falls back to summing in
--     JavaScript. The fallback added alongside this migration paginates
--     exhaustively, so it is slower but NOT truncating; the pre-2330 silent
--     under-reporting does not come back with the DROP alone.
--
-- No data written by these functions needs undoing: rows in rent_buddy_tips and
-- the two tip_usd copies are ordinary money records, and dropping the writer
-- does not make them wrong.
