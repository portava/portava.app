-- compass_search_signal_log
--
-- Tracks the cumulative search-nudge contribution per (user, category) so
-- that the Compass profile service can decay old search signals over time
-- instead of letting a one-time curiosity search permanently skew the feed.
--
-- Design:
--   • One row per (user_id, category) — the last-nudge timestamp drives decay.
--   • search_weight   — total +1 nudges accumulated via POST /compass/signals/search.
--   • last_nudge_at   — updated on every nudge; used as the reference point for
--                       the half-life decay calculation on next profile read.
--
-- Decay formula (applied on-read in CompassProfileService):
--   decay_factor = 0.5 ^ (age_days / SEARCH_SIGNAL_DECAY_DAYS)
--   effective_search_weight = round(search_weight * decay_factor)
--   category_weight is reduced by (search_weight - effective_search_weight)

CREATE TABLE IF NOT EXISTS compass_search_signal_log (
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category       text        NOT NULL CHECK (char_length(category) BETWEEN 1 AND 100),
  last_nudge_at  timestamptz NOT NULL DEFAULT now(),
  search_weight  integer     NOT NULL DEFAULT 1 CHECK (search_weight >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

-- Fast lookup by user during profile build
CREATE INDEX IF NOT EXISTS compass_search_signal_log_user_idx
  ON compass_search_signal_log (user_id);

-- RLS: users can only see and write their own rows; service role bypasses.
ALTER TABLE compass_search_signal_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'compass_search_signal_log'
      AND policyname = 'compass_search_signal_log_select_own'
  ) THEN
    CREATE POLICY compass_search_signal_log_select_own
      ON compass_search_signal_log FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'compass_search_signal_log'
      AND policyname = 'compass_search_signal_log_write_own'
  ) THEN
    CREATE POLICY compass_search_signal_log_write_own
      ON compass_search_signal_log FOR ALL
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── Add numeric_value to feature_flags ────────────────────────────────────────
-- Allows numeric configuration values (not just boolean on/off) to live
-- alongside the existing `enabled` column.  All existing rows get NULL,
-- which the application treats as "use the built-in default".
ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS numeric_value double precision;

-- ── Atomic upsert RPC ────────────────────────────────────────────────────────
-- A single-statement INSERT … ON CONFLICT DO UPDATE ensures the increment is
-- applied atomically, avoiding lost-update races when a user's client fires two
-- concurrent search signals for the same category.
--
-- Called from the API server via the service_role client only.
-- p_delta is the EFFECTIVE weight delta that was actually applied (0 when the
-- stored weight was already at the ±10 clamp), so search_weight only grows when
-- the real category weight grew too.
--
-- Security hardening:
--   • SECURITY DEFINER with SET search_path = public prevents search-path
--     injection attacks against SECURITY DEFINER routines.
--   • REVOKE EXECUTE FROM PUBLIC + GRANT only to service_role ensures no
--     end-user Postgres role can call this function directly, preventing IDOR
--     (a caller manipulating another user's personalization data).
--   • Defense-in-depth: the function body also rejects calls where p_user_id
--     does not match auth.uid() and the caller is not the service_role, so
--     even a misconfigured grant cannot be exploited by an authenticated user.
CREATE OR REPLACE FUNCTION public.upsert_compass_search_signal(
  p_user_id  uuid,
  p_category text,
  p_delta    integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Defense-in-depth: reject if called by an authenticated (non-service) role
  -- attempting to write on behalf of a different user.
  IF current_setting('role', true) NOT IN ('service_role', 'supabase_admin')
     AND auth.uid() IS DISTINCT FROM p_user_id
  THEN
    RAISE EXCEPTION 'unauthorized: cannot write signal for another user';
  END IF;

  INSERT INTO public.compass_search_signal_log (user_id, category, last_nudge_at, search_weight)
  VALUES (p_user_id, p_category, now(), p_delta)
  ON CONFLICT (user_id, category) DO UPDATE
    SET search_weight  = public.compass_search_signal_log.search_weight + EXCLUDED.search_weight,
        last_nudge_at  = now();
END;
$$;

-- Revoke the default PUBLIC execute privilege; only service_role may call this.
REVOKE EXECUTE ON FUNCTION public.upsert_compass_search_signal(uuid, text, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.upsert_compass_search_signal(uuid, text, integer) TO service_role;

-- ── Seed the SEARCH_SIGNAL_DECAY_DAYS flag ────────────────────────────────────
-- Default 7 days half-life.  enabled=true activates decay; set enabled=false
-- to disable decay entirely (weights never time-decay).
INSERT INTO feature_flags (flag, enabled, numeric_value, description)
VALUES (
  'SEARCH_SIGNAL_DECAY_DAYS',
  true,
  7,
  'Half-life in days for search-nudge category weights. After this many days the search-contributed weight halves. Set enabled=false to disable decay. numeric_value controls the half-life (default 7).'
)
ON CONFLICT (flag) DO NOTHING;
