-- 3491_discovery_recommendations_output_kinds_serve_point.sql
-- census-discovery §94 (lane W11-X2), §91.7 item 1 — DC-01's three output
-- kinds are LOGGED as the other serve points are: widen 3376's per-request
-- serve-point CHECK from 1–12 to 1–13.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W11-X2,
-- range 3490-3494). APPLIED TO NO DATABASE by the lane that wrote it other than
-- the local PostgreSQL 16 harness. It needs 3376 (public.recommendations),
-- which is itself applied to no Supabase project: the two ship together
-- (register W10D-A2 for 3376, AR-W11X2-2 for this file).
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- Serve point 13 is `GET /v1/discovery/recommendations/:kind`
-- (routes/discoveryOutputKinds.ts; lib/discoveryServeLog.ts
-- DiscoveryServePoint.OUTPUT_KINDS): Trails, Shared Moments and emerging
-- discoveries, ranked in the request by `rankForViewer`. 3376's
-- `recommendations_serve_point_check` admits 1–12, so the per-request row of
-- such a serve would be refused (23514) and the writer would report it as a
-- rejection. Register D-W10-I-A1 holds `discovery_output_kinds_enabled` until
-- this lands, so no kind is served unmeasured.
--
-- NOTHING ELSE CHANGES. `rank_events.item_kind` needs no new value: a Trail and
-- a Shared Moment are none of 0153's six kinds, so they are logged with a NULL
-- kind, which 0197 admits and which says "served, kind not applicable" — the
-- same rule search uses for a hashtag or a city (lib/discoveryServeLog.ts
-- searchTypeToItemKind). `recommendations.item_kinds` already admits '' for
-- exactly that element. An emerging discovery is a place, logged as 'place' or
-- 'gem' like every other place.
--
-- ── HOW ─────────────────────────────────────────────────────────────────────
-- The constraint is dropped and re-added in one transaction under its own name,
-- NOT VALID, then VALIDATEd: a widening admits every row the old one admitted,
-- and VALIDATE takes SHARE UPDATE EXCLUSIVE, so writes are not blocked while
-- existing rows are checked. Re-running is a no-op in effect: the same
-- constraint is re-created with the same definition.
--
-- ── `10` §4 ─────────────────────────────────────────────────────────────────
-- No new table, column or index; no query path changes. Cardinality: one more
-- `recommendations` row per served output-kind request, only while
-- discovery_output_kinds_enabled (3483, seeded FALSE) and
-- discovery_serve_log_enabled are both on.
--
-- Rollback: db/rollback/2026-09-28-3491-discovery-recommendations-output-kinds-serve-point-rollback.sql
-- (restores 1–12; REFUSES while any row carries serve point 13, because
-- narrowing would have to delete the only record of those serves).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.recommendations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3491): public.recommendations does not exist; apply 3376 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.recommendations'::regclass
                    AND conname = 'recommendations_serve_point_check') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3491): recommendations_serve_point_check is missing; this file widens 3376''s constraint and will not invent one.';
  END IF;
END $$;

ALTER TABLE public.recommendations DROP CONSTRAINT recommendations_serve_point_check;
ALTER TABLE public.recommendations
  ADD CONSTRAINT recommendations_serve_point_check CHECK (serve_point BETWEEN 1 AND 13) NOT VALID;
ALTER TABLE public.recommendations VALIDATE CONSTRAINT recommendations_serve_point_check;

COMMENT ON CONSTRAINT recommendations_serve_point_check ON public.recommendations IS
  '3376, widened by 3491 (census-discovery §94): lib/discoveryServeLog.ts DiscoveryServePoint 1–13; 13 = GET /v1/discovery/recommendations/:kind.';

-- ── Behavioural postconditions, INSIDE the applying transaction ────────────
-- These write (probes that are always rolled back by their own exception
-- blocks), so they run before COMMIT: the applier admits only read-only
-- assertions after the COMMIT, and a probe is not one (3376's rule).
DO $probe$
DECLARE
  probe text := 'AAAAAAAAAAAAAAAAAA3491';
BEGIN
  -- Serve point 13 is admitted through the one writer's door (then rolled back) ...
  BEGIN
    IF public.record_discovery_serve_request(jsonb_build_object(
         'id', probe, 'viewer_class', 'anonymous', 'session_id', gen_random_uuid(), 'surface', 'discovery',
         'serve_point', 13, 'model_version', 'probe', 'served_count', 0, 'served_at', now())) <> 'written'
    THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3491): a serve point 13 row was not written.';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P3491', MESSAGE = 'probe admitted';
  EXCEPTION
    WHEN SQLSTATE 'P3491' THEN NULL;  -- admitted; the block's rollback removed it
  END;
  -- ... and 14 is still refused, by this constraint and no other.
  BEGIN
    PERFORM public.record_discovery_serve_request(jsonb_build_object(
      'id', probe, 'viewer_class', 'anonymous', 'session_id', gen_random_uuid(), 'surface', 'discovery',
      'serve_point', 14, 'model_version', 'probe', 'served_count', 0, 'served_at', now()));
    RAISE EXCEPTION 'POSTCONDITION FAILED (3491): serve point 14 was admitted.';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT LIKE '%recommendations_serve_point_check%' THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3491): serve point 14 was refused by another check: %', SQLERRM;
      END IF;
  END;
END $probe$;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.recommendations'::regclass AND conname = 'recommendations_serve_point_check' AND convalidated;
  IF def IS NULL OR def NOT LIKE '%13%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3491): recommendations_serve_point_check is not the validated 1–13 range: %', def;
  END IF;
END $post$;
