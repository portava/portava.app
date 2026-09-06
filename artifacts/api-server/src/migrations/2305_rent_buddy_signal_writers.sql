-- 2305_rent_buddy_signal_writers.sql
-- Give two read-only rent_buddy_profiles signals a writer.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2305.
-- Additive + idempotent. Safe to re-run. Changes no existing data.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- Two columns of rent_buddy_profiles are READ by production code and WRITTEN by
-- nothing anywhere in src/ (only by src/scripts/seed-demo-buddies.ts, which does
-- not run in production):
--
--   response_time_h  read by the buddy-search ranker
--                    (routes/rentABuddy.ts, scoreProfile: +15 at <=0.5h, +10 at
--                    <=1h, +5 at <=4h) and by lib/buddyMapRead.ts. With no
--                    writer the column is NULL for every real buddy, `Number(
--                    null ?? Infinity)` lands in the else branch, and every
--                    buddy scores 0 on responsiveness forever. A ranking signal
--                    that is constant across all candidates is not a signal.
--
--   profile_views    read by GET /rent-a-buddy/me/dashboard
--                    (routes/rentABuddyMarketplace.ts: `profileViews:
--                    buddyProfile.profile_views ?? 0`). Buddies were shown a
--                    hard 0 regardless of traffic. The unrelated `profile_views`
--                    TABLE that routes/profile.ts writes is a different object
--                    and never touches this column.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
-- 1. Widens rb_adjust_buddy_counter's column allowlist to admit profile_views
--    alongside the three reliability counters it already accepts. The function
--    body, its clamping, its SECURITY DEFINER posture and its
--    service_role-only grant are unchanged; only the IN-list grows. Keeping one
--    atomic single-statement updater means the new counter cannot lose
--    increments under concurrency any more than the existing three can.
--
-- 2. Adds rb_record_buddy_response(buddy_id, hours), an exponentially-weighted
--    mean of the buddy's response latency, written when the buddy answers a
--    booking request (accept or decline). EWMA rather than a plain mean because
--    the column is the only storage there is -- no per-response row exists to
--    average over -- and because recency is what the ranker is trying to
--    reward. alpha = 0.3: a buddy who goes quiet is penalised within a handful
--    of bookings, and one slow reply cannot erase a good history.
--
--    The value is clamped into what numeric(4,1) can hold (<= 999.9) and
--    rounded to the column's own scale, so a pathological sample -- a request
--    answered after a year -- saturates instead of raising a numeric overflow
--    on a fire-and-forget write.
--
-- Both functions stay REVOKEd from PUBLIC and GRANTed to service_role only.
-- profile_views is one of the 24 authority/derived columns migration 2145
-- deliberately withholds from `authenticated`; routing its only writer through
-- a service_role-only SECURITY DEFINER function keeps that boundary intact.

BEGIN;

-- ── 1. rb_adjust_buddy_counter — admit profile_views ────────────────────────

CREATE OR REPLACE FUNCTION public.rb_adjust_buddy_counter(p_buddy_id uuid, p_column text, p_delta integer)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $_$
BEGIN
  IF p_column NOT IN ('completed_count', 'cancel_count', 'no_show_count', 'profile_views') THEN
    RAISE EXCEPTION 'rb_adjust_buddy_counter: invalid column %', p_column;
  END IF;
  EXECUTE format(
    'UPDATE rent_buddy_profiles SET %I = GREATEST(0, COALESCE(%I, 0) + $1), updated_at = NOW() WHERE id = $2',
    p_column, p_column
  ) USING p_delta, p_buddy_id;
END;
$_$;

REVOKE ALL ON FUNCTION public.rb_adjust_buddy_counter(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rb_adjust_buddy_counter(uuid, text, integer) TO service_role;

-- ── 2. rb_record_buddy_response — the response-time signal's writer ─────────

CREATE OR REPLACE FUNCTION public.rb_record_buddy_response(p_buddy_id uuid, p_hours numeric)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  UPDATE rent_buddy_profiles
  SET response_time_h = ROUND(
        LEAST(
          999.9::numeric,
          GREATEST(
            0::numeric,
            CASE
              WHEN response_time_h IS NULL THEN p_hours
              ELSE response_time_h * 0.7 + p_hours * 0.3
            END
          )
        ),
        1
      ),
      updated_at = NOW()
  WHERE id = p_buddy_id
    AND p_hours IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.rb_record_buddy_response(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rb_record_buddy_response(uuid, numeric) TO service_role;

-- ── Postconditions ──────────────────────────────────────────────────────────
-- Assertions about this migration's own effect. Conditional RAISE only.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rb_adjust_buddy_counter'
      AND pg_get_functiondef(p.oid) LIKE '%profile_views%'
  ) THEN
    RAISE EXCEPTION '2305: rb_adjust_buddy_counter still refuses profile_views';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rb_record_buddy_response'
  ) THEN
    RAISE EXCEPTION '2305: rb_record_buddy_response was not created';
  END IF;
END $$;

COMMIT;
