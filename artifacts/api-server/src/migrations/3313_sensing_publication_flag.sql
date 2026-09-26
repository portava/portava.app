-- 3313_sensing_publication_flag.sql
-- Sensing — ONE capability flag for the PUBLISHER of k-gated cohort aggregates
-- into 3110's durable store (census-sensing S39 / S24, §26), seeded OFF.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- lib/sensingPublicationScheduler runs on its own clock and, per live cohort,
-- aggregates 2315's contributions under the k-gate and hands a PUBLISHABLE
-- aggregate to lib/sensingDifferencingGate.publishThroughDifferencingGate,
-- which records into sensing_published_aggregates (3110). That scheduler is
-- the first and only caller of the gate outside tests — census-sensing §21.4
-- blocker #2.
--
-- ── WHAT THIS FLAG CANNOT DO, BY CONSTRUCTION ───────────────────────────────
-- It is the SECOND of the scheduler's gates. The first is the contribution
-- policy: `lib/sensingContributionPolicy.SENSING_ANON_GRANTED_SCOPES` must
-- contain `surface`, which it does not — that is an OWNER CONSENT ACT (§21.2),
-- separate from any flag, and the scheduler checks it before it obtains a
-- client, so this flag is never even read while the scope is ungranted.
-- Flipping this row alone therefore publishes nothing. It exists so that,
-- the day the owner grants the scope, the operational switch is a real
-- one-step action with a row to flip, rather than a migration to write first
-- (3004's reasoning, applied to the publisher).
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON.
-- Reader: lib/sensingPublicationScheduler (literal name, isFlagEnabled).
-- Rollback: db/rollback/2026-09-26-3313-sensing-publication-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'sensing_publication_enabled',
    false,
    'Sensing: the publisher of k-gated cohort aggregates into sensing_published_aggregates (census-sensing S39/S24, §26). ON: lib/sensingPublicationScheduler runs publishThroughDifferencingGate per live cohort on its own clock — k-gate first, then the anti-differencing floor, then a durable record; counts only in logs. OFF (the seed): nothing publishes and the store stays empty. This is the SECOND gate: the contribution policy must grant `surface` first (an owner consent act, not a flag), and while it does not this flag is never read. Flipping it alone publishes nothing.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'sensing_publication_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected sensing_publication_enabled present, found %', present;
  END IF;

  -- Seeded ON would mean this migration took the owner's publication decision.
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'sensing_publication_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_publication_enabled seeded ON — publishing a sensing aggregate is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
