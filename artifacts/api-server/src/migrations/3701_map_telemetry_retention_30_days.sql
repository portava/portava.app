-- 3701_map_telemetry_retention_30_days.sql
-- Per-user map telemetry is kept 30 days, not 90. Basis: owner decision OD-INPUT-2
-- (30 days for per-user behavioural counters, unconditional); the Discovery
-- ruling Q11(a) (30 days for raw behavioural rows, a PROPOSED default pending
-- legal review) is the analogue, not the authority.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane L band 3700-3719). APPLIED TO
-- NO DATABASE by the lane that wrote it. Sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- 2202_map_telemetry.sql gives both tables
--
--     expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days')
--
-- and 2960_map_telemetry_retention.sql's sweep (purge_expired_map_telemetry,
-- driven by lib/intelRetentionScheduler.ts behind
-- map_telemetry_retention_enabled) deletes a row once expires_at has passed.
-- Each map_telemetry_events row is a raw behavioural event stamped with the
-- viewer's id (viewer_id, from the bearer token); each map_telemetry_drops row
-- is per-viewer, per-session drop accounting. No owner decision names Map
-- telemetry. The closest is OD-INPUT-2 (docs/ops/owner-decisions-20261004.md),
-- for per-user outcome counters: "Retain for 30 days, then delete or
-- irreversibly aggregate." Its analogue Q11(a) answers a Discovery question
-- (recommendations, rank_events dwell, ranking_debug_samples) and is itself a
-- proposed default "pending the required legal review", so it is cited here
-- only as agreeing, never as the authority. The change only tightens privacy
-- and contradicts no ruling: OD-MAP-7's 180 days is for contributions, and
-- docs/ops/retention-policy.md's 90 days is the orphan-quarantine window.
--
-- So the default becomes 30 days on both tables, and any row already stamped
-- with a later expiry is brought back to received_at + 30 days (production held
-- 0 rows when last measured, census-map §43.1; collection is off,
-- map_telemetry_enabled FALSE). The sweep is unchanged: it already deletes on
-- expires_at, so it now deletes at 30 days.
--
-- NOT CHANGED: the hourly, viewer-less disabled-discard counter
-- (2964_map_telemetry_disabled_discards.sql) carries no identity and is not a
-- behavioural row.
--
-- Rollback: db/rollback/2026-10-06-3701-map-telemetry-retention-30-days-rollback.sql
-- (restores the 90-day DEFAULT; it does not lengthen any row's expiry).

BEGIN;

DO $pre$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['map_telemetry_events','map_telemetry_drops'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3701): public.% does not exist; 2202 must be applied first.', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = t AND column_name = 'expires_at')
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = t AND column_name = 'received_at') THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3701): public.% lacks expires_at or received_at.', t;
    END IF;
  END LOOP;
END $pre$;

ALTER TABLE public.map_telemetry_events ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days');
ALTER TABLE public.map_telemetry_drops  ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days');

-- Shorten, never lengthen: a row whose expiry is already sooner keeps it.
UPDATE public.map_telemetry_events SET expires_at = received_at + interval '30 days'
 WHERE expires_at > received_at + interval '30 days';
UPDATE public.map_telemetry_drops  SET expires_at = received_at + interval '30 days'
 WHERE expires_at > received_at + interval '30 days';

COMMIT;

DO $post$
DECLARE
  t   text;
  def text;
  n   bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['map_telemetry_events','map_telemetry_drops'] LOOP
    SELECT column_default INTO def FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t AND column_name = 'expires_at';
    IF def IS NULL OR def !~ '30 days' OR def ~ '90 days' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3701): public.%.expires_at default is %, not now() + 30 days.', t, coalesce(def, 'NULL');
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE expires_at > received_at + interval ''30 days''', t) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3701): % row(s) of public.% still expire more than 30 days after receipt.', n, t;
    END IF;
  END LOOP;
  RAISE NOTICE '3701 postcondition: map_telemetry_events and map_telemetry_drops default to 30 days and no row outlives received_at + 30 days.';
END $post$;
