-- 3466_layover_place_dwell.sql
-- The Layover domain's curated per-place DWELL (census-discovery A14, §37.5
-- item 2, §81; register D-W10S2-3).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-S2,
-- 3465-3469). APPLIED TO NO SHARED DATABASE; rehearsed on the local
-- PostgreSQL 16 harness only.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- §37.5: "A dwell source with real provenance — a duration column, or a
-- derived figure carrying a source class and confidence … Not a category
-- average." One row per discovery_places row: the minutes a visit takes, WHO
-- stated it (`source_class`: the venue's own published figure, or a curator's
-- timed visit), how sure (`confidence`), and the evidence in words. There is
-- deliberately no `category_default` class, and no class derived from other
-- travellers' plan stops (that would be a use of their itineraries they never
-- agreed to). `activity_min` has layover_plan_stops.duration_min's own bounds
-- (5-720), so both producers of the activity term mean the same range.
--
-- ── WHO WRITES AND READS IT ─────────────────────────────────────────────────
-- Written only by PUT /api/admin/airport/place-dwell/:placeId (requireAdmin,
-- services/airport/LayoverPlaceDwell.ts upsertCuratedDwell) and removed by its
-- DELETE twin. Read only by readCuratedDwell for Discovery's Layover mode, and
-- only while `layover_place_dwell_enabled` (3465) is ON. Service role only:
-- RLS on, every client operation denied by a RESTRICTIVE policy (3390's
-- pattern), service_role holds SELECT, INSERT, UPDATE, DELETE.
--
-- ── CARDINALITY ─────────────────────────────────────────────────────────────
-- At most one row per curated place (primary key place_id); the only read is
-- `place_id = ANY(page of ids)`, served by the primary key. 0 rows until an
-- administrator curates one.
--
-- Rollback: db/rollback/2026-09-28-3466-layover-place-dwell-rollback.sql
-- (drops the table; its rows are curated statements, which the rollback
-- reports by count before dropping).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.discovery_places') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3466): public.discovery_places does not exist.';
  END IF;
  IF to_regclass('public.layover_place_dwell') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'layover_place_dwell' AND column_name = 'source_class') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3466): a public.layover_place_dwell of another shape exists; this file will not re-assert over it.';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.layover_place_dwell (
  place_id      uuid        PRIMARY KEY REFERENCES public.discovery_places(id) ON DELETE CASCADE,
  activity_min  integer     NOT NULL,
  source_class  text        NOT NULL,
  confidence    text        NOT NULL,
  evidence      text        NOT NULL,
  stated_by     uuid        NULL,
  stated_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT layover_place_dwell_minutes CHECK (activity_min BETWEEN 5 AND 720),
  CONSTRAINT layover_place_dwell_source_class CHECK (source_class IN ('venue_stated', 'curator_measured')),
  CONSTRAINT layover_place_dwell_confidence CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT layover_place_dwell_evidence CHECK (length(btrim(evidence)) BETWEEN 1 AND 500)
);
COMMENT ON TABLE public.layover_place_dwell IS
  'census-discovery A14 (§81, D-W10S2-3; 3466): a curated per-place dwell with provenance (source_class, confidence, evidence) for Discovery''s Layover mode. Written only by the admin place-dwell route; read only while layover_place_dwell_enabled is ON. No category defaults; nothing derived from travellers'' plans.';

ALTER TABLE public.layover_place_dwell ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_place_dwell FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.layover_place_dwell TO service_role;

DO $policies$
DECLARE v_op text;
BEGIN
  FOREACH v_op IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.layover_place_dwell', format('layover_place_dwell_deny_%s_clients', lower(v_op)));
    EXECUTE format('CREATE POLICY %I ON public.layover_place_dwell AS RESTRICTIVE FOR %s TO anon, authenticated %s',
      format('layover_place_dwell_deny_%s_clients', lower(v_op)), v_op,
      CASE v_op WHEN 'INSERT' THEN 'WITH CHECK (false)'
                WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
                ELSE 'USING (false)' END);
  END LOOP;
END
$policies$;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.layover_place_dwell') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3466): layover_place_dwell was not created.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.layover_place_dwell'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3466): RLS is not enabled on layover_place_dwell.';
  END IF;
  IF has_table_privilege('authenticated', 'public.layover_place_dwell', 'SELECT')
     OR has_table_privilege('anon', 'public.layover_place_dwell', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3466): a client role can read layover_place_dwell.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'layover_place_dwell' AND permissive = 'RESTRICTIVE') <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3466): expected four restrictive client-deny policies.';
  END IF;
END $post$;
