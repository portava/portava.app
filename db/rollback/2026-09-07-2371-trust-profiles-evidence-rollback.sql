-- Rollback for 2371_trust_profiles_evidence.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2371 DID
-- =============
-- Added two nullable, default-less columns to public.trust_profiles:
--   evidence_weight NUMERIC(8,3)
--   evidence_count  INTEGER
-- plus a COMMENT on each. No policy, grant, index, flag or row.
--
-- WHAT DROPPING THEM DOES
-- =======================
-- Nothing a user can observe: no consumer reads the columns. The one writer,
-- TrustScoreService.recalculateTrustScore, writes them in a statement SEPARATE
-- from the score upsert and treats its failure as non-fatal (logged at WARN),
-- which is exactly how it already behaves against production, where the
-- columns have never existed. After this rollback CI behaves like production.
--
-- Data loss: whatever evidence figures the scheduler wrote since apply. They
-- are derived values, recomputed on every recalculation, so nothing is lost
-- that the next pass would not rewrite once the columns return.
--
-- Idempotent: DROP COLUMN IF EXISTS.

BEGIN;

ALTER TABLE public.trust_profiles
  DROP COLUMN IF EXISTS evidence_weight,
  DROP COLUMN IF EXISTS evidence_count;

COMMIT;
