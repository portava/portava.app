-- 2174_intel_system_claim_promotion.sql
-- Service-owned automatic claim promotion (observation -> active claim), plus the
-- provenance + idempotency schema it needs. Requires 2172 (consent).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- The projection scheduler aggregates only claims whose status is active/
-- conflicting, but a Quick Signal writes an OBSERVATION only — nothing promotes it
-- to a claim without an admin pressing approveClaim. The route already anticipated
-- this: "A system/service auto-promotion path, if one is built later, would call
-- approveClaim with the service client directly, not through this user-facing
-- route." This is that path, built as a service-owned function — NOT by widening
-- who may approve. Admin approveClaim authorization is untouched.
--
-- ── WHAT PROMOTION MEANS ─────────────────────────────────────────────────────
-- "This claim has enough ADMISSIBLE evidence to ENTER AGGREGATION." It does NOT
-- mean the claim is publicly true/live: the privacy gate (>=15 actors, >=5 groups,
-- <=20% single-group share, delay), confidence bands, freshness and the kill
-- switch all still decide, downstream, whether anything is ever served. Promotion
-- creates exactly one anchor claim per (subject, zone, claim_type); the projection
-- then counts the real cohort behind it.
--
-- ── DETERMINISTIC ELIGIBILITY (an observation qualifies iff ALL hold) ─────────
--   • its actor's consent is currently valid (enabled AND not withdrawn) — 2172;
--   • moderation_state is pilot-claimable (pending/allowed) — the same whitelist
--     proposeClaim applies; restricted/blocked/removed never qualify;
--   • it is still fresh (expires_at > now) — expired evidence does not qualify;
--   • its claim_type is not aggregate-only (experience.next_move is cohort-only and
--     never a single-user claim — mirrors lib/trailFollowup.mustAggregate);
--   • no active/conflicting claim already anchors that (subject, zone, claim_type).
-- NONE of the public privacy thresholds (>=15 / >=5 / <=20%) is a promotion
-- prerequisite — those are serving gates, deliberately downstream.
--
-- ── IDEMPOTENCY / CONCURRENCY ────────────────────────────────────────────────
-- A partial UNIQUE index guarantees at most one active/conflicting claim per
-- (subject_id, coalesce(zone_id,''), claim_type). The promote function does a
-- DISTINCT-ON insert guarded by NOT EXISTS and ON CONFLICT DO NOTHING, so repeated
-- or concurrent runs never create a duplicate active claim.
--
-- ── PROVENANCE ───────────────────────────────────────────────────────────────
-- promotion_source records WHO promoted: 'system' (this function) vs 'admin'
-- (approveClaim). NULL on an un-promoted candidate.

BEGIN;

-- ── Provenance column ────────────────────────────────────────────────────────
ALTER TABLE public.intel_claims
  ADD COLUMN IF NOT EXISTS promotion_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'intel_claims_promotion_source_check'
  ) THEN
    ALTER TABLE public.intel_claims
      ADD CONSTRAINT intel_claims_promotion_source_check
      CHECK (promotion_source IS NULL OR promotion_source IN ('admin', 'system'));
  END IF;
END $$;

COMMENT ON COLUMN public.intel_claims.promotion_source IS
  'Who promoted this claim to active: ''system'' (system_promote_admissible_intel_claims) or ''admin'' (approveClaim). NULL for an un-promoted candidate.';

-- ── Idempotency backbone: at most one live claim per (subject, zone, type) ────
-- coalesce(zone_id,'') so a NULL zone collapses to one slot rather than many
-- (NULLs are distinct in a plain unique index). Partial so superseded/expired/
-- rejected history is unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS intel_claims_one_live_per_subject_zone_type
  ON public.intel_claims (subject_id, (coalesce(zone_id, '')), claim_type)
  WHERE status IN ('active', 'conflicting');

-- ── The service-owned promotion function ─────────────────────────────────────
-- SECURITY DEFINER + granted to service_role ONLY: an ordinary authenticated user
-- has no EXECUTE and cannot invoke it. p_now is injectable for deterministic tests.
CREATE OR REPLACE FUNCTION public.system_promote_admissible_intel_claims(p_now timestamptz DEFAULT now())
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
BEGIN
  INSERT INTO public.intel_claims
    (subject_kind, subject_id, zone_id, claim_type, value, status,
     source_count, observed_at, expires_at, hard_expires_at, promotion_source)
  SELECT DISTINCT ON (o.subject_id, coalesce(o.zone_id, ''), o.claim_type)
    o.subject_kind, o.subject_id, o.zone_id, o.claim_type, o.value, 'active',
    1, o.observed_at, o.expires_at, NULL::timestamptz, 'system'
  FROM public.intel_observations o
  JOIN public.intel_contribution_consent c
    ON c.user_id = o.actor_id
   AND c.enabled = true
   AND c.withdrawn_at IS NULL                                   -- valid current consent
  WHERE o.moderation_state IN ('pending', 'allowed')            -- admissible moderation
    AND o.expires_at IS NOT NULL AND o.expires_at > p_now       -- fresh
    AND o.claim_type <> 'experience.next_move'                  -- aggregate-only: never single-user
    AND NOT EXISTS (
      SELECT 1 FROM public.intel_claims a
      WHERE a.subject_id = o.subject_id
        AND coalesce(a.zone_id, '') = coalesce(o.zone_id, '')
        AND a.claim_type = o.claim_type
        AND a.status IN ('active', 'conflicting')
    )
  ORDER BY o.subject_id, coalesce(o.zone_id, ''), o.claim_type, o.observed_at DESC
  ON CONFLICT (subject_id, (coalesce(zone_id, '')), claim_type)
    WHERE status IN ('active', 'conflicting')
    DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.system_promote_admissible_intel_claims(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.system_promote_admissible_intel_claims(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.system_promote_admissible_intel_claims(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.system_promote_admissible_intel_claims(timestamptz) TO service_role;

COMMENT ON FUNCTION public.system_promote_admissible_intel_claims(timestamptz) IS
  'Service-owned automatic promotion: creates one active (promotion_source=''system'') anchor claim per (subject, zone, claim_type) that has an admissible, fresh, consented observation and no existing live claim. Idempotent (partial unique index + NOT EXISTS + ON CONFLICT DO NOTHING). Does NOT bypass moderation/consent/freshness, and does NOT touch the downstream privacy/confidence/serving gates. service_role only.';

DO $$
BEGIN
  IF to_regprocedure('public.system_promote_admissible_intel_claims(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: system_promote_admissible_intel_claims is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'intel_claims_one_live_per_subject_zone_type') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: partial unique index intel_claims_one_live_per_subject_zone_type is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='intel_claims' AND column_name='promotion_source') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_claims.promotion_source is missing';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.system_promote_admissible_intel_claims(timestamptz);
--   DROP INDEX IF EXISTS public.intel_claims_one_live_per_subject_zone_type;
--   ALTER TABLE public.intel_claims DROP COLUMN IF EXISTS promotion_source;
