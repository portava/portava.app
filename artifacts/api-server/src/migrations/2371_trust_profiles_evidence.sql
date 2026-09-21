-- 2371_trust_profiles_evidence.sql
--
-- Two nullable columns on trust_profiles that let a consumer tell a 50 built
-- on nothing from a 50 built on a year of events. No default, no backfill, no
-- policy, no flag, no reader.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2371.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE STATE THIS MIGRATION IS WRITTEN AGAINST — MEASURED, NOT INFERRED
-- ══════════════════════════════════════════════════════════════════════════════
-- Read 2026-09-07 from BOTH databases:
--
--                                              production     portava-ci
--   feature_flags.trust_engine_enabled         TRUE (2026-07-17)   NO ROW (-> false)
--   trust_events rows                          5              0
--   trust_profiles rows                        2              0
--   trust_profiles.evidence_weight             absent         absent
--   trust_profiles.evidence_count              absent         absent
--
-- WHAT IS MISSING, AND WHOSE OBLIGATION IT IS
-- ===========================================
-- The Passport spec's trust pipeline (§9, line 97) is
--   Trust Evidence → Trust Events → Domain Trust → Trust Confidence → Policy
-- and §10 (line 115) makes the stage concrete: "an 82 with high evidence is not
-- equivalent to an 82 with little evidence". The Trust engine is the owner of
-- that stage, and it has never published one. `trust_profiles` carries nine
-- category scores and an overall — every one of which defaults to 50 — and
-- nothing that says how much evidence stands behind them. The scorer ALREADY
-- computes the quantity: TrustScoreService.computeCategoryScore ramps positive
-- movement by `totalWeight / EARN_CONFIDENCE_WEIGHT`, where totalWeight is the
-- decay-weighted count of applied/confirmed events. It uses the number and
-- throws it away.
--
-- Because the engine publishes no evidence measure, the only consumer that
-- shows a confidence band (services/passport/PassportProjectionService.ts
-- buildTrust) derives it from stamps and trips — travel volume, not trust
-- evidence — which is the defect docs/architecture/census-passport.md records
-- as P50. PR #467 does not touch that derivation; it cannot, because there is
-- nothing on the trust side for Passport to read instead. This migration is
-- the trust side.
--
-- WHAT THE COLUMNS MEAN
-- =====================
--   evidence_weight  NUMERIC(8,3)  Sum of decay weights (2^(-age/half_life))
--                                  over the applied+confirmed events inside the
--                                  365-day scoring window — the same quantity,
--                                  same decay, same window the scores use. Five
--                                  events today read 5.000; the same five read
--                                  ~2.500 after one 90-day half-life. Evidence
--                                  erodes on the score's own clock.
--   evidence_count   INTEGER       Raw count of those events, undecayed. A
--                                  second, simpler number for a reader that
--                                  wants "how many things happened" rather than
--                                  "how much do they still weigh".
--
-- NULL means NOT YET MEASURED (a row written before this migration, or by a
-- server build that predates it). 0 means MEASURED AND EMPTY. The distinction
-- is the whole point of leaving the columns nullable with no default: a
-- consumer that sees NULL must not read it as "no evidence".
--
-- The banding of these numbers into words ("low / medium / high") is a
-- presentation decision and is NOT made here or by the engine. It belongs to
-- whichever surface presents it.
--
-- INERT BY CONSTRUCTION
-- =====================
-- No reader exists. TrustScoreService.recalculateTrustScore writes the two
-- columns in a SEPARATE statement after the existing profile upsert, so a
-- database that has not applied this migration (production, today) rejects
-- only that second statement — logged at WARN, naming this migration — and
-- the score persist it has always done is unaffected. Nothing a user sees
-- changes until a consumer chooses to read the new columns.
--
-- POSTCONDITION: the DO block RAISES unless both columns exist, are nullable,
-- and have no default.
--
-- ROLLBACK: db/rollback/2026-09-07-2371-trust-profiles-evidence-rollback.sql

BEGIN;

ALTER TABLE public.trust_profiles
  ADD COLUMN IF NOT EXISTS evidence_weight NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS evidence_count  INTEGER;

COMMENT ON COLUMN public.trust_profiles.evidence_weight IS
  'Decay-weighted count of the applied/confirmed trust_events inside the 365-day scoring window at last recalculation (TrustScoreService). NULL = not yet measured; 0 = measured, no evidence. Spec: Passport §9 "Trust Confidence" stage.';
COMMENT ON COLUMN public.trust_profiles.evidence_count IS
  'Undecayed count of the applied/confirmed trust_events inside the 365-day scoring window at last recalculation. NULL = not yet measured; 0 = measured, no evidence.';

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'trust_profiles'
     AND column_name IN ('evidence_weight', 'evidence_count')
     AND is_nullable = 'YES'
     AND column_default IS NULL;
  IF n <> 2 THEN
    RAISE EXCEPTION '2371 postcondition: expected 2 nullable, default-less evidence columns on trust_profiles, found %', n;
  END IF;
END $$;

COMMIT;
