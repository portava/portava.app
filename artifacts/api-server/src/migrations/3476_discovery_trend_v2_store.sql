-- 3476_discovery_trend_v2_store.sql
-- Discovery trending v2 — the STORE (census-discovery §84, lane W10-R1).
--
-- `03` §13: "Prefer storing: raw behavior events, aggregated windows, trend state
-- snapshots, explanation features, model/version references." v2 computes more
-- evidence than v1 and every piece of it is stored beside the verdict, so no
-- stored state is one opaque number:
--
--   place_momentum (2892, 3410, 3435), NEW NULLABLE COLUMNS, written only by
--   3477's v2 rebuild (a v1 row leaves every one NULL):
--     recent/mid/prior_exposures   served impressions per window — the `03` §7
--                                  denominator (D-W10R1-1)
--     recent/mid/prior_groups      independence clusters per window (DV-34)
--     velocity                     ṽ: recent conversion over mid, after the
--                                  time-of-day and peer normalisers
--     time_of_day_factor           the time-of-day normaliser (DC-06)
--     peer_factor                  the creator / Trail / location normaliser
--     lifecycle_state              `03` §4's content-type lifecycle (DV-28)
--     driver                       what drove the claim (DV-33)
--     cell_key, city               the place's Local Pulse cell and city, which
--                                  the location lists filter by (DC-21)
--
--   area_momentum (NEW TABLE): the Local Pulse reading per cell and run (DV-29),
--   the same evidence at cell scope, plus the cell's display label (a named
--   neighbourhood; NULL for a grid cell).
--
--   discovery_trend_place_context(): the place facts v2 reads that rank_events
--   cannot supply — creator, cell, city, creation time, `03` §4 content class,
--   live Trails. Mirrored by lib/discoveryTrendNormalised.buildPlaceTrendContext
--   and compared with it on the harness (discoveryTrendNormalisedParity N-CTX).
--
-- Nothing here changes a value v1 computes or stores: the columns are nullable
-- with no default and no backfill, and the table is new.
--
-- APPLIED TO NO DATABASE by the lane that wrote it other than the local
-- PostgreSQL 16 harness. NOT applied to portava-ci (hwokxgbmezheskbzskfr).
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- `10` §4: EXPECTED CARDINALITY — area_momentum holds one row per cell per run:
-- far fewer than place_momentum's one per place. INDEX RATIONALE: one query
-- path, "the newest run for these cells" (lib/discoveryTrendExplanation), served
-- by the unique key (cell_key, computed_at) and one computed_at index for "the
-- newest run". No other.
--
-- Rollback: db/rollback/2026-09-28-3476-discovery-trend-v2-store-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.place_momentum') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3476): 2892''s place_momentum must exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'place_momentum' AND column_name = 'feature_version') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3476): 3435''s place_momentum.feature_version must exist. Apply 3435 first.';
  END IF;
  IF to_regclass('public.discovery_places') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3476): public.discovery_places must exist.';
  END IF;
END
$pre$;

ALTER TABLE public.place_momentum
  ADD COLUMN IF NOT EXISTS recent_exposures   integer          CHECK (recent_exposures   >= 0),
  ADD COLUMN IF NOT EXISTS mid_exposures      integer          CHECK (mid_exposures      >= 0),
  ADD COLUMN IF NOT EXISTS prior_exposures    integer          CHECK (prior_exposures    >= 0),
  ADD COLUMN IF NOT EXISTS recent_groups      integer          CHECK (recent_groups      >= 0),
  ADD COLUMN IF NOT EXISTS mid_groups         integer          CHECK (mid_groups         >= 0),
  ADD COLUMN IF NOT EXISTS prior_groups       integer          CHECK (prior_groups       >= 0),
  ADD COLUMN IF NOT EXISTS velocity           double precision CHECK (velocity           >= 0),
  ADD COLUMN IF NOT EXISTS time_of_day_factor double precision CHECK (time_of_day_factor >  0),
  ADD COLUMN IF NOT EXISTS peer_factor        double precision CHECK (peer_factor        >  0),
  ADD COLUMN IF NOT EXISTS lifecycle_state    text             CHECK (lifecycle_state = ANY (ARRAY[
      'unknown', 'emerging', 'growing', 'peak', 'cooling', 'evergreen', 'rediscovered', 'inactive']::text[])),
  ADD COLUMN IF NOT EXISTS driver             text             CHECK (driver = ANY (ARRAY[
      'trip_adds', 'saves', 'independent_groups']::text[])),
  ADD COLUMN IF NOT EXISTS cell_key           text,
  ADD COLUMN IF NOT EXISTS city               text;

COMMENT ON COLUMN public.place_momentum.recent_exposures IS
  '3476 (census-discovery §84): served impressions in the recent window — the 03 §7 exposure denominator. NULL on a v1 row.';
COMMENT ON COLUMN public.place_momentum.velocity IS
  '3476 (§84): v2''s normalised velocity (recent conversion over mid, after time-of-day and peer factors); NULL on a v1 row or without a mid reading.';
COMMENT ON COLUMN public.place_momentum.lifecycle_state IS
  '3476 (§84, DV-28): 03 §4''s content-type lifecycle; NULL on a v1 row.';

CREATE TABLE IF NOT EXISTS public.area_momentum (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cell_key                text NOT NULL,
  -- A named neighbourhood's display text, NULL for a grid cell. Stored so a
  -- reader can name it; SERVED only above the k-floor (D-W10R1-10).
  cell_label              text,
  city                    text,
  computed_at             timestamptz NOT NULL,
  recent_rate             double precision NOT NULL CHECK (recent_rate  >= 0),
  mid_rate                double precision NOT NULL CHECK (mid_rate     >= 0),
  prior_rate              double precision NOT NULL CHECK (prior_rate   >= 0),
  total_weight            double precision NOT NULL CHECK (total_weight >= 0),
  recent_exposures        integer NOT NULL CHECK (recent_exposures >= 0),
  mid_exposures           integer NOT NULL CHECK (mid_exposures    >= 0),
  prior_exposures         integer NOT NULL CHECK (prior_exposures  >= 0),
  recent_groups           integer NOT NULL CHECK (recent_groups    >= 0),
  mid_groups              integer NOT NULL CHECK (mid_groups       >= 0),
  prior_groups            integer NOT NULL CHECK (prior_groups     >= 0),
  velocity                double precision CHECK (velocity >= 0),
  time_of_day_factor      double precision NOT NULL CHECK (time_of_day_factor > 0),
  trend_state             text NOT NULL CHECK (trend_state = ANY (ARRAY[
                            'unknown', 'emerging', 'trending', 'established', 'cooling', 'rediscovered']::text[])),
  driver                  text CHECK (driver = ANY (ARRAY['trip_adds', 'saves', 'independent_groups']::text[])),
  recent_unique_travelers integer NOT NULL CHECK (recent_unique_travelers >= 0),
  window_unique_travelers integer NOT NULL CHECK (window_unique_travelers >= 0),
  model_version           text NOT NULL,
  feature_version         text NOT NULL,
  window_ms               jsonb NOT NULL,
  thresholds              jsonb NOT NULL,
  source_table            text NOT NULL DEFAULT 'rank_events',
  source_surface          text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT area_momentum_cell_run_key UNIQUE (cell_key, computed_at)
);
COMMENT ON TABLE public.area_momentum IS
  '03 §3 Local Pulse (census-discovery DV-29, §84): the v2 trend reading of one Local Pulse cell (a named neighbourhood within its city, else a 0.02-degree grid square) per rebuild run, with its evidence and versions. Written only by rebuild_place_momentum_v2 (3477); read only by lib/discoveryTrendExplanation. Service role only.';
CREATE INDEX IF NOT EXISTS area_momentum_computed_idx ON public.area_momentum (computed_at DESC);

ALTER TABLE public.area_momentum ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.area_momentum FROM PUBLIC;
REVOKE ALL ON public.area_momentum FROM anon;
REVOKE ALL ON public.area_momentum FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.area_momentum TO service_role;

-- 3390's explicit posture, for the new table: every client operation DENIED,
-- explicitly and restrictively, so a later permissive policy or re-GRANT cannot
-- reopen it silently. service_role (BYPASSRLS) is not affected.
DO $deny$
DECLARE v_op text; pname text;
BEGIN
  FOREACH v_op IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    pname := format('area_momentum_deny_%s_clients', lower(v_op));
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.area_momentum'::regclass AND polname = pname) THEN
      EXECUTE format('DROP POLICY %I ON public.area_momentum', pname);
    END IF;
    EXECUTE format('CREATE POLICY %I ON public.area_momentum AS RESTRICTIVE FOR %s TO anon, authenticated %s',
      pname, v_op,
      CASE v_op WHEN 'INSERT' THEN 'WITH CHECK (false)' WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)' ELSE 'USING (false)' END);
  END LOOP;
END
$deny$;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.area_momentum FROM anon, authenticated;

-- ── The place context v2 reads (mirrored by buildPlaceTrendContext) ─────────
-- 2910's Trail tables are absent from production. The Trail half is therefore
-- chosen at run time: with them, the live (non-archived) memberships; without
-- them, none — a fact about the deployment, never a failure. Dynamic SQL, so a
-- database without 2910 never plans a statement naming its tables.
CREATE OR REPLACE FUNCTION public.discovery_trend_place_context()
RETURNS TABLE (place_key text, creator_id text, cell_key text, cell_label text, city text,
               created_at timestamptz, content_class text, trail_ids text[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_members text := CASE
    WHEN to_regclass('public.content_trails') IS NOT NULL AND to_regclass('public.trails') IS NOT NULL THEN
      $m$SELECT lower(ct.source_id::text) AS pkey,
                array_agg(DISTINCT lower(ct.trail_id::text) ORDER BY lower(ct.trail_id::text)) AS tids
           FROM public.content_trails ct JOIN public.trails t ON t.id = ct.trail_id
          WHERE ct.source_type = 'place' AND t.lifecycle_status <> 'archived'
          GROUP BY lower(ct.source_id::text)$m$
    ELSE $m$SELECT NULL::text AS pkey, NULL::text[] AS tids WHERE false$m$
  END;
BEGIN
  -- lib/discoveryTrendNormalised EPHEMERAL_TYPES / ENDURING_TYPES / TREND_V2_CELL_DEG (0.02).
  RETURN QUERY EXECUTE format($q$
  WITH p AS (
    SELECT lower(dp.id::text) AS pkey,
           lower(dp.submitted_by::text) AS creator,
           NULLIF(lower(btrim(COALESCE(dp.city, ''), ' ')), '') AS pcity,
           NULLIF(btrim(COALESCE(dp.neighborhood, ''), ' '), '') AS hood,
           dp.lat, dp.lng, dp.created_at AS pcreated,
           lower(btrim(COALESCE(dp.category, ''), ' '))   AS cat,
           lower(btrim(COALESCE(dp.place_type, ''), ' ')) AS typ
      FROM public.discovery_places dp
  ), keyed AS (
    SELECT p.*,
           CASE WHEN p.hood IS NOT NULL AND p.pcity IS NOT NULL THEN 'n:' || p.pcity || ':' || lower(p.hood)
                WHEN p.lat IS NOT NULL AND p.lng IS NOT NULL
                  THEN 'g:' || floor(p.lat / 0.02::double precision)::bigint::text || ':' || floor(p.lng / 0.02::double precision)::bigint::text
           END AS ckey
      FROM p
  ), members AS (%s)
  SELECT k.pkey, k.creator, k.ckey,
         CASE WHEN k.ckey LIKE 'n:%%' THEN min(k.hood COLLATE "C") OVER (PARTITION BY k.ckey) END,
         k.pcity, k.pcreated,
         CASE WHEN k.cat = ANY (ARRAY['event','events','festival','concert','performance','party']) THEN 'ephemeral'
              WHEN k.cat = ANY (ARRAY['temple','church','cathedral','mosque','shrine','monument','palace','castle','fort','ruins',
                                      'landmark','museum','heritage site','historic district','attraction','beach','park','garden','viewpoint']) THEN 'enduring'
              WHEN k.typ = ANY (ARRAY['event','events','festival','concert','performance','party']) THEN 'ephemeral'
              WHEN k.typ = ANY (ARRAY['temple','church','cathedral','mosque','shrine','monument','palace','castle','fort','ruins',
                                      'landmark','museum','heritage site','historic district','attraction','beach','park','garden','viewpoint']) THEN 'enduring'
              ELSE 'standard' END,
         COALESCE(mm.tids, ARRAY[]::text[])
    FROM keyed k LEFT JOIN members mm ON mm.pkey = k.pkey
  $q$, v_members);
END
$fn$;

REVOKE ALL ON FUNCTION public.discovery_trend_place_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discovery_trend_place_context() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_trend_place_context() TO service_role;
COMMENT ON FUNCTION public.discovery_trend_place_context() IS
  '3476 (census-discovery §84): the place facts the v2 trend model reads that rank_events cannot supply — creator, Local Pulse cell and its label, city, creation time, 03 §4 content class, live Trails (none where 2910 is absent). Mirrors lib/discoveryTrendNormalised.buildPlaceTrendContext; service_role only.';

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'place_momentum'
     AND column_name IN ('recent_exposures','mid_exposures','prior_exposures','recent_groups','mid_groups','prior_groups',
                         'velocity','time_of_day_factor','peer_factor','lifecycle_state','driver','cell_key','city');
  IF n <> 13 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3476): expected 13 v2 columns on place_momentum, found %', n;
  END IF;
  IF to_regclass('public.area_momentum') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3476): area_momentum is missing.';
  END IF;
  IF has_table_privilege('anon', 'public.area_momentum', 'SELECT') OR has_table_privilege('authenticated', 'public.area_momentum', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3476): a client role may read area_momentum.';
  END IF;
  IF has_function_privilege('anon', 'public.discovery_trend_place_context()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discovery_trend_place_context()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3476): a client role may execute discovery_trend_place_context.';
  END IF;
END
$post$;
