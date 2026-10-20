-- 3871_layover_recommendation_status_and_supersession.sql
--
-- Layover spec §4 `layover_recommendations (id, session_id, snapshot_id, candidate_type, candidate_id, status,
-- plan_json, utility_score, risk_band, confidence, expires_at)` (census-layover L26), §4.1 `RecommendationStatus =
-- ELIGIBLE | TIGHT | BLOCKED | STALE | EXPIRED` (L38), §6.1 `if risk_band == UNSAFE: recommendation.status = BLOCKED`
-- (L50, the schema half), §5 `* → DISRUPTED ... Invalidate stale recommendations; replan; preserve audit trail` (L44)
-- and §11.1 step 6 `Invalidate recommendations whose snapshot is stale or no longer feasible` (L97).
-- Owner decisions 2026-10-18: "A blocked recommendation should remain visible as unavailable with a clear explanation,
-- where doing so does not disclose restricted information." "Stale recommendations must be invalidated by marking them
-- superseded, preserving their history and reason." "For L44, use versioned invalidation and preserve historical
-- decision evidence." "Follow the existing database convention of TEXT with CHECK constraints."
-- Layover 165 program, lane B2-RECS-A. POST-CUTOVER CANONICAL FORWARD MIGRATION (gap number 3871).
--
-- APPLIED TO NO DATABASE by the lane that wrote it. Additive: nine nullable columns and seven CHECK constraints on
-- layover_recommendations, one new append-only table with its index, trigger function and trigger, one flag row seeded
-- FALSE. No existing row is written, no existing column / constraint / policy / grant is changed, nothing is dropped.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PART 1 — the spec's columns on layover_recommendations
-- ══════════════════════════════════════════════════════════════════════════════
-- Already there: id, session_id (0127), snapshot_id (3623), candidate_type = rec_type (0127), candidate_id = place_id
-- (0127; null for a card that is not a place). Added here, all NULLABLE:
--   plan_json             JSONB  the card's §9 RecommendationContract as this tree states it (provenance and reason
--                                detail — no safety predicate or join reads it, §4's rule);
--   utility_score         DOUBLE PRECISION  the §9.1 objective's score (services/airport/layoverObjective.ts);
--   risk_band             TEXT   §4.1 RiskBand: LOW | MODERATE | HIGH | UNSAFE;
--   confidence            TEXT   §4.1 ConfidenceBand: HIGH | MEDIUM | LOW | INSUFFICIENT;
--   expires_at            TIMESTAMPTZ  the last instant the card can still be started and completed before its own
--                                hard return;
--   recommendation_status TEXT   §4.1 RecommendationStatus ELIGIBLE | TIGHT | BLOCKED | STALE | EXPIRED, plus
--                                SUPERSEDED (the owner's decision). It is NOT the existing `status` column: 0127's
--                                `status` ('active' | 'hidden' | 'flagged') is the ADMIN MODERATION state, written by
--                                POST /admin/airport/reports/:id/resolve and read by LayoverRecommendationService
--                                (USER_HIDDEN_RECOMMENDATION_STATUS: getRecommendations, the stable-id regeneration and
--                                the plan-add read). Repurposing it would let a regeneration un-hide a moderated card;
--                                the two are orthogonal (a BLOCKED card can be flagged; a hidden card can be ELIGIBLE).
--   status_reason         TEXT   a reason CODE ([a-z_]), never prose: why a card is BLOCKED / TIGHT / SUPERSEDED /
--                                EXPIRED. A code from a closed vocabulary cannot carry restricted text (another
--                                traveller, a moderation note, a place's private detail).
--   superseded_by_snapshot_id TEXT, superseded_at TIMESTAMPTZ  the versioned invalidation (Part 2).
-- EXISTING ROWS ARE LEFT NULL, deliberately, and NULL is a stated meaning: "written before 3871, or with
-- layover_recommendation_status_enabled OFF — never classified". It is NEVER read as ELIGIBLE: the read path serves a
-- NULL-status card exactly as before (no `status` / `available` key), and nothing that admits a card treats NULL as
-- available (services/layover/LayoverRecommendationStatus.ts). Every row is rewritten by the next generation anyway
-- (both regeneration paths re-write the session's cards), so a backfill would invent a classification for rows that
-- are about to be replaced.
--
-- THE CHECKS (TEXT + CHECK, the house convention):
--   layover_recs_risk_band_known / _confidence_known / _recommendation_status_known  — the §4.1 vocabularies;
--   layover_recs_status_reason_code   — a lower-snake code of at most 64 characters, or NULL;
--   layover_recs_status_follows_risk  — §6.1 and the §8 map bands, as ONE derivation the schema enforces:
--        ELIGIBLE ⇒ risk_band = LOW (SAFE = LOW risk), TIGHT ⇒ risk_band IN (MODERATE, HIGH),
--        risk_band = UNSAFE ⇒ status NOT IN (ELIGIBLE, TIGHT) — "if risk_band == UNSAFE: recommendation.status =
--        BLOCKED" (it may also be STALE/EXPIRED/SUPERSEDED later; it can never be AVAILABLE). No writer can store an
--        UNSAFE card as available, whatever route it came through.
--   layover_recs_blocked_explained    — BLOCKED ⇒ status_reason IS NOT NULL: visible as unavailable WITH a reason;
--   layover_recs_superseded_complete  — superseded_by_snapshot_id / superseded_at are set exactly when the status is
--        SUPERSEDED, and a SUPERSEDED card names its reason.
--   layover_recs_plan_json_object / layover_recs_utility_finite — shapes.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- PART 2 — versioned invalidation: public.layover_recommendation_supersessions
-- ══════════════════════════════════════════════════════════════════════════════
-- Before this file the only invalidation marker was 3623's citation, and invalidating a card CLEARED it (lane B1-P's
-- L44 path): the evidence of which snapshot certified the card was destroyed by the act of invalidating it, and the
-- next regeneration (delete+insert, or upsert in place) destroyed the rest. Now a card made stale by a newer snapshot,
-- or made infeasible by a disruption, is SUPERSEDED:
--   * its row keeps its citation, risk band, plan and deadline untouched and gains recommendation_status
--     'SUPERSEDED', status_reason, superseded_by_snapshot_id (the snapshot that superseded it) and superseded_at;
--   * one row is appended here, IMMUTABLE, holding the card's decision evidence as it stood (`card`, a JSON copy of the
--     certified columns — provenance detail, not a predicate), the snapshot it was certified under, the superseding
--     snapshot and its 3623 version, the reasons and the cause. A later regeneration may re-certify or replace the
--     card's row (it is the session's CURRENT card); it cannot reach this history.
-- The table: server-mediated like 2992's (RLS on, NO policy, every client grant revoked; the API serves it), erased
-- with its session (FK ON DELETE CASCADE — account deletion reaches it through the session), bounded by the session's
-- life. recommendation_id carries NO foreign key on purpose: the card it names may be regenerated or deleted later,
-- and a history row that disappeared with it would not be history. superseded/superseding snapshot ids carry no foreign
-- key for the same reason (compaction, L261, may later remove a snapshot; the history keeps the id it cited).
-- UNIQUE (recommendation_id, superseding_snapshot_id): superseding the same card by the same snapshot twice records
-- once (a retried replan is idempotent). A BEFORE UPDATE trigger refuses every UPDATE (2992's argument: the service
-- role bypasses RLS). DELETE is not blocked (the session cascade; retention).
--
-- THE FLAG: layover_recommendation_status_enabled, seeded FALSE. ON: generation writes the Part-1 columns, the replan
-- and the regeneration supersede instead of clearing, and the read paths serve status / availability. OFF / absent /
-- unreadable (the seed): no column of this file is named by any query, and every response is byte-identical to before.
-- REQUIRES 3623 (snapshot citations) as well as this file.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER (a gap number: applied at 3871 on a fresh replay, after 3999 on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 0127 (layover_recommendations, layover_sessions), 2410 (rec_key) and 3623 (snapshot_id) — all numbered
-- below; on production 3623 is packet step 197 (main run). The precondition refuses otherwise. Nothing numbered above
-- 3871 alters, drops or adds a constraint/trigger to layover_recommendations, or names any object of this file
-- (grep of every file 3872-3999, 2026-10-18: 3872, 3875, 3900 and 3996 reference layover_sessions by foreign key or
-- read only; none names layover_recommendations).
--
-- Rollback: db/rollback/2026-10-18-3871-layover-recommendation-status-and-supersession-rollback.sql (refuses while any
-- card carries a 3871 value, while any supersession is recorded, while the flag is TRUE, or while
-- feature_flag_audit_log holds its history).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_recommendations') IS NULL OR to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3871): public.layover_recommendations / public.layover_sessions do not exist (0127).';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'layover_recommendations' AND column_name IN ('rec_key', 'snapshot_id')) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3871): layover_recommendations lacks rec_key (2410) or snapshot_id (3623).';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
                AND column_name IN ('plan_json', 'utility_score', 'risk_band', 'confidence', 'expires_at',
                                    'recommendation_status', 'status_reason', 'superseded_by_snapshot_id', 'superseded_at')) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3871): a 3871 column already exists on layover_recommendations.';
  END IF;
  IF to_regclass('public.layover_recommendation_supersessions') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3871): public.layover_recommendation_supersessions already exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_recommendation_status_enabled' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3871): layover_recommendation_status_enabled already exists and is not FALSE; this file seeds it OFF and will not overwrite an operator''s setting.';
  END IF;
END
$pre$;

-- ── PART 1 ───────────────────────────────────────────────────────────────────
ALTER TABLE public.layover_recommendations
  ADD COLUMN plan_json                 JSONB            NULL,
  ADD COLUMN utility_score             DOUBLE PRECISION NULL,
  ADD COLUMN risk_band                 TEXT             NULL,
  ADD COLUMN confidence                TEXT             NULL,
  ADD COLUMN expires_at                TIMESTAMPTZ      NULL,
  ADD COLUMN recommendation_status     TEXT             NULL,
  ADD COLUMN status_reason             TEXT             NULL,
  ADD COLUMN superseded_by_snapshot_id TEXT             NULL,
  ADD COLUMN superseded_at             TIMESTAMPTZ      NULL,
  ADD CONSTRAINT layover_recs_risk_band_known
    CHECK (risk_band IS NULL OR risk_band IN ('LOW', 'MODERATE', 'HIGH', 'UNSAFE')),
  ADD CONSTRAINT layover_recs_confidence_known
    CHECK (confidence IS NULL OR confidence IN ('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT')),
  ADD CONSTRAINT layover_recs_recommendation_status_known
    CHECK (recommendation_status IS NULL OR recommendation_status IN ('ELIGIBLE', 'TIGHT', 'BLOCKED', 'STALE', 'EXPIRED', 'SUPERSEDED')),
  ADD CONSTRAINT layover_recs_status_reason_code
    CHECK (status_reason IS NULL OR status_reason ~ '^[a-z][a-z_]{1,63}$'),
  ADD CONSTRAINT layover_recs_status_follows_risk
    CHECK ((recommendation_status IS DISTINCT FROM 'ELIGIBLE' OR risk_band IS NOT DISTINCT FROM 'LOW')
       AND (recommendation_status IS DISTINCT FROM 'TIGHT' OR COALESCE(risk_band, '') IN ('MODERATE', 'HIGH'))
       AND NOT (risk_band IS NOT DISTINCT FROM 'UNSAFE' AND COALESCE(recommendation_status, '') IN ('ELIGIBLE', 'TIGHT'))),
  ADD CONSTRAINT layover_recs_blocked_explained
    CHECK (recommendation_status IS DISTINCT FROM 'BLOCKED' OR status_reason IS NOT NULL),
  ADD CONSTRAINT layover_recs_superseded_complete
    CHECK ((recommendation_status IS NOT DISTINCT FROM 'SUPERSEDED')
             = (superseded_by_snapshot_id IS NOT NULL AND superseded_at IS NOT NULL)
       AND (recommendation_status IS DISTINCT FROM 'SUPERSEDED' OR status_reason IS NOT NULL)),
  ADD CONSTRAINT layover_recs_plan_json_object
    CHECK (plan_json IS NULL OR jsonb_typeof(plan_json) = 'object'),
  ADD CONSTRAINT layover_recs_utility_finite
    CHECK (utility_score IS NULL OR utility_score BETWEEN -100 AND 100);

COMMENT ON COLUMN public.layover_recommendations.recommendation_status IS
  '3871 (Layover §4.1 RecommendationStatus + SUPERSEDED, census-layover L38/L50/L44/L97): ELIGIBLE (LOW) | TIGHT (MODERATE/HIGH) | BLOCKED (UNSAFE / outside the certified envelope; served visible-but-unavailable with status_reason) | STALE | EXPIRED | SUPERSEDED (versioned invalidation; history in layover_recommendation_supersessions). NULL = never classified (before 3871 / flag OFF) — never read as ELIGIBLE. NOT the moderation `status`.';
COMMENT ON COLUMN public.layover_recommendations.plan_json IS
  '3871 (census-layover L26): the card''s §9 RecommendationContract as this tree states it; provenance detail, never a predicate.';

-- ── PART 2 ───────────────────────────────────────────────────────────────────
CREATE TABLE public.layover_recommendation_supersessions (
  id                           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                   UUID        NOT NULL REFERENCES public.layover_sessions (id) ON DELETE CASCADE,
  recommendation_id            UUID        NOT NULL,
  rec_key                      TEXT        NULL,
  superseded_snapshot_id       TEXT        NULL,
  superseding_snapshot_id      TEXT        NOT NULL,
  superseding_snapshot_version INTEGER     NULL CHECK (superseding_snapshot_version IS NULL OR superseding_snapshot_version >= 1),
  prior_status                 TEXT        NULL
                                 CHECK (prior_status IS NULL OR prior_status IN ('ELIGIBLE', 'TIGHT', 'BLOCKED', 'STALE', 'EXPIRED')),
  reasons                      TEXT[]      NOT NULL
                                 CHECK (cardinality(reasons) BETWEEN 1 AND 2
                                        AND reasons <@ ARRAY['stale_certification', 'no_longer_feasible']::text[]),
  cause                        TEXT        NOT NULL
                                 CHECK (cause IN ('window_edit', 'external_event', 'reported_disruption', 'regeneration')),
  card                         JSONB       NOT NULL CHECK (jsonb_typeof(card) = 'object'),
  superseded_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT layover_rec_supersessions_once UNIQUE (recommendation_id, superseding_snapshot_id)
);

COMMENT ON TABLE public.layover_recommendation_supersessions IS
  '3871 (census-layover L44/L97, owner decision 2026-10-18 "invalidated by marking them superseded, preserving their history and reason"): one IMMUTABLE row per card superseded — its decision evidence as it stood, the snapshot it cited, the superseding snapshot and version, the reasons and the cause. Server-mediated (no client privilege); erased with its session.';

CREATE INDEX layover_rec_supersessions_session_idx
  ON public.layover_recommendation_supersessions (session_id, superseded_at DESC);

ALTER TABLE public.layover_recommendation_supersessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_recommendation_supersessions FROM PUBLIC;
REVOKE ALL ON public.layover_recommendation_supersessions FROM anon;
REVOKE ALL ON public.layover_recommendation_supersessions FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.layover_recommendation_supersessions TO service_role;

CREATE OR REPLACE FUNCTION public.layover_rec_supersessions_are_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION
    'IMMUTABLE (3871): layover_recommendation_supersessions row % may not be UPDATEd. It is the history of a superseded recommendation (census L44/L97).',
    OLD.id
    USING ERRCODE = '55000';
END
$fn$;
REVOKE ALL ON FUNCTION public.layover_rec_supersessions_are_immutable() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER layover_rec_supersessions_immutable
  BEFORE UPDATE ON public.layover_recommendation_supersessions
  FOR EACH ROW EXECUTE FUNCTION public.layover_rec_supersessions_are_immutable();

-- ── the gate, seeded OFF ─────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_recommendation_status_enabled',
    false,
    'Layover §4/§4.1/§6.1/§11.1 (census-layover L26 L38 L44 L50 L97; migration 3871). ON: recommendation generation writes plan_json, utility_score, risk_band, confidence, expires_at and the spec recommendation_status (ELIGIBLE/TIGHT/BLOCKED; UNSAFE is BLOCKED and served visible-but-unavailable with a reason code); a replan or a regeneration under a newer snapshot SUPERSEDES stale / no-longer-feasible cards (status, reason, superseding snapshot, and an immutable history row in layover_recommendation_supersessions) instead of clearing their citation; the read paths and the plan-add refuse any card that is not available. OFF / absent / unreadable (the seed): no 3871 column is named and every response is byte-identical to before. REQUIRES 3623 and 3871 applied. Fail-closed via isFlagEnabled.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (catalog only, re-runnable standalone) ─────────────────────
DO $post$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_recommendations' AND is_nullable = 'YES'
     AND column_name IN ('plan_json', 'utility_score', 'risk_band', 'confidence', 'expires_at',
                         'recommendation_status', 'status_reason', 'superseded_by_snapshot_id', 'superseded_at');
  IF n <> 9 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): % of the nine nullable layover_recommendations columns exist', n;
  END IF;
  SELECT count(*) INTO n FROM pg_catalog.pg_constraint
   WHERE conrelid = 'public.layover_recommendations'::regclass AND contype = 'c' AND convalidated
     AND conname IN ('layover_recs_risk_band_known', 'layover_recs_confidence_known', 'layover_recs_recommendation_status_known',
                     'layover_recs_status_reason_code', 'layover_recs_status_follows_risk', 'layover_recs_blocked_explained',
                     'layover_recs_superseded_complete', 'layover_recs_plan_json_object', 'layover_recs_utility_finite');
  IF n <> 9 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): % of the nine CHECK constraints are present and validated', n;
  END IF;
  -- The moderation `status` keeps its own vocabulary: this file did not repurpose it.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_recommendations' AND column_name = 'status') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): the moderation status column is missing';
  END IF;
  SELECT count(*) INTO n FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'layover_recommendations' AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('INSERT', 'UPDATE')
     AND column_name IN ('plan_json', 'utility_score', 'risk_band', 'confidence', 'expires_at',
                         'recommendation_status', 'status_reason', 'superseded_by_snapshot_id', 'superseded_at');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): a client role can write a certification column of layover_recommendations (% grants)', n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
                  WHERE oid = 'public.layover_recommendation_supersessions'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): RLS is not enabled on layover_recommendation_supersessions';
  END IF;
  SELECT count(*) INTO n FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_recommendation_supersessions';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): layover_recommendation_supersessions has % policies; it is server-mediated (none)', n;
  END IF;
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'layover_recommendation_supersessions' AND grantee IN ('anon', 'authenticated');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): a client role holds % privilege(s) on layover_recommendation_supersessions', n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'public.layover_recommendation_supersessions'::regclass
                    AND tgname = 'layover_rec_supersessions_immutable' AND NOT tgisinternal AND tgenabled <> 'D' AND tgtype = 19) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): the immutability trigger on layover_recommendation_supersessions is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.layover_recommendation_supersessions'::regclass AND contype = 'f'
                    AND confrelid = 'public.layover_sessions'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): layover_recommendation_supersessions must be erased with its session (ON DELETE CASCADE)';
  END IF;
  IF has_function_privilege('authenticated', 'public.layover_rec_supersessions_are_immutable()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): a client role may execute the immutability function';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_recommendation_status_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3871): layover_recommendation_status_enabled is not present';
  END IF;
END
$post$;
