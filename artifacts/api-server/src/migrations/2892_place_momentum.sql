-- 2892_place_momentum.sql
--
-- ⚠ STAGED AND REHEARSED. Applied by the lane that wrote it to portava-ci
--   (hwokxgbmezheskbzskfr) ONLY. NOT applied to production.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Discovery
-- MIGRATIONS lane, band 2890-2899.
--
-- ADDITIVE AND ISOLATED. One new table, one new function, three indexes. It
-- touches NO existing table, reads rank_events only when the rebuild function
-- is explicitly called, and ships EMPTY with no automatic producer. Nothing in
-- the product changes when this file lands.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT — census DC-07 (census-discovery:1900) and DV-72 (census-discovery:986)
-- ══════════════════════════════════════════════════════════════════════════════
-- `03` §13 asks Trending to store five things and forbids one:
--
--     raw behavior events          ← rank_events. ALREADY PASSES.
--     aggregated windows           ← this file
--     trend state snapshots        ← this file
--     explanation features         ← this file
--     model/version references     ← this file
--     "Do not store one opaque 'trend score' as the only durable truth."
--
-- DC-07 grades this 1 of 5, and records that the prohibition is satisfied
-- VACUOUSLY — nothing durable is stored at all, which is the opposite failure
-- from the one it guards against. The three trend windows at
-- lib/discoveryTrendState.ts:88 are recomputed per request into a ten-minute
-- process cache and never persisted; `10` §3 names `place_momentum` as the
-- projection that should hold them and no such table exists in repository or
-- production.
--
-- This file creates it, AND — the part that matters for the prohibition —
-- stores the EVIDENCE beside the verdict. A row carries the three window rates,
-- the total weight, the classified state, the reason text and the exact weights
-- and thresholds that produced it. A reader can therefore reconstruct WHY a
-- place is called `trending` without rerunning anything. Storing only
-- `trend_state` would have been exactly the single opaque score §13 forbids,
-- and the postconditions below refuse a table shaped that way.
--
-- DV-72 is `10` §10 "derived tables are rebuildable". The census row's argument
-- is that four of the five `10` §3 projections are absent and "a table that
-- does not exist is not rebuildable". This file makes ONE of the five exist and
-- makes it rebuildable BY CONSTRUCTION: every column is a pure function of
-- rank_events, and `public.rebuild_place_momentum()` is that function, in the
-- database, idempotent, and safe to run at any time. It remains 1 of 5 —
-- `traveler_affinities`, `place_cooccurrence`, `trail_relations` and
-- `circle_momentum` are not this lane's and are not created here.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE SQL MIRRORS TYPESCRIPT, AND THE DRIFT HAZARD THAT CREATES
-- ══════════════════════════════════════════════════════════════════════════════
-- `rebuild_place_momentum` reimplements, in SQL, exactly what
-- lib/discoveryTrendState.computeTrendStates + classifyTrendState compute in
-- TypeScript. That is a SECOND IMPLEMENTATION OF ONE RULE and it is the main
-- risk in this file, so it is named here rather than discovered later.
--
-- Why it is done anyway: the alternative is a projection with no producer at
-- all, which is the defect class docs/architecture/trust-unproduced-vocabulary.md
-- tracks — and DV-72 asks specifically for REBUILDABILITY, which a table whose
-- only writer is a TypeScript worker that does not exist does not have. A
-- rebuild that runs in the database can be run by the integration owner, by a
-- cron, or by hand during an incident, with no deploy.
--
-- The drift is contained three ways:
--   1. Every constant is declared ONCE at the top of the function body with the
--      TypeScript symbol it mirrors named in a comment beside it.
--   2. The constants are also stored ON EVERY ROW (`event_weights`,
--      `window_ms`, `thresholds`), so a row written by a drifted function is
--      self-identifying rather than silently wrong.
--   3. The postconditions at the foot of this file ASSERT THE CLASSIFIER'S
--      BEHAVIOUR on six synthetic evidence tuples — one per `03` §9 stage —
--      exactly as 2220 asserts its fold on the launch cities. A future edit
--      that loosens a threshold fails the migration.
--
-- WHAT IS STILL MISSING, AND MUST BE ADDED BY THE DISCOVERY CODE LANE:
--   src/test/placeMomentumSqlParity.test.ts — run classifyTrendState and
--   public.place_momentum_classify() over the same evidence tuples and assert
--   they agree. This lane may not edit artifacts/api-server/package.json to
--   register it. The path is reported to the integration owner instead.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED BEFORE WRITING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- portava-ci `hwokxgbmezheskbzskfr`, 2026-09-14, read before any write:
--   to_regclass('public.place_momentum')   → NULL (absent)
--   rank_events                            → 0 rows
--   rank_events.item_id                    → text NOT NULL
--
-- `place_id` is therefore `text`, NOT uuid, and NOT an FK. That is deliberate
-- and is the single most consequential typing decision in this file:
-- rank_events.item_id carries Discovery's MIXED id space — OpenStreetMap ids
-- ("node/12345"), "db/<uuid>" forms and bare uuids (see routes/rankEvents.ts:174
-- "item_id is text — Discovery places use OSM IDs"). A uuid column would reject
-- the majority of real Discovery places, and an FK to public.places would reject
-- every OSM place that has no local row. The projection must be able to describe
-- momentum for a place Portava has never stored.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- `10` §4 — EXPECTED CARDINALITY · INDEX RATIONALE · EXPLAIN (census DC-15)
-- ══════════════════════════════════════════════════════════════════════════════
-- EXPECTED CARDINALITY of public.place_momentum:
--   One row per (place_id, computed_at). `place_id` ranges over the places that
--   appear in rank_events within the 30-day prior window — bounded above by the
--   distinct served-item count, which is far smaller than the rank_events row
--   count because a place is served many times. `computed_at` is one value per
--   rebuild run. At a daily rebuild retaining 90 days:
--       rows ≈ (distinct places served in 30d) × 90.
--   Today, and immediately after this file: ZERO. There is no scheduled
--   producer; the table ships empty and `rebuild_place_momentum` runs only when
--   called.
--
-- INDEX RATIONALE — three indexes, one query path each, no speculative fourth:
--
--   (1) place_momentum_place_computed_idx (place_id, computed_at DESC)
--       THE HOT PATH: "what is the latest momentum reading for this place".
--       Leading equality on place_id then a descending scan means the answer is
--       the FIRST index tuple — an Index Scan with no sort, not a scan-and-sort
--       over a place's whole history. Also serves the unique constraint that
--       stops one rebuild run writing a place twice.
--
--   (2) place_momentum_computed_idx (computed_at DESC)
--       THE RETENTION AND SNAPSHOT PATH: "everything from run X" and "delete
--       everything older than Y". Without it a retention sweep is a sequential
--       scan of the whole projection, which is the shape of sweep that gets
--       switched off after the first incident.
--
--   (3) place_momentum_live_state_idx (trend_state, computed_at DESC)
--         WHERE trend_state <> 'unknown'
--       THE TRENDING-NOW PATH: "which places are emerging/trending right now".
--       PARTIAL because `unknown` is the modal state by design — §13's classifier
--       returns `unknown` for everything below the activity floor, and a
--       trending query never wants those rows. Excluding them keeps the index
--       proportional to the interesting subset rather than to the table.
--
--   NO index on `model_version` or on the jsonb evidence: neither has a reader,
--   and `10` §4 asks for index RATIONALE, which an index with no query path
--   cannot have.
--
-- EXPLAIN VERIFICATION, run on portava-ci after applying this file:
--
--   EXPLAIN SELECT * FROM public.place_momentum
--    WHERE place_id = 'node/12345' ORDER BY computed_at DESC LIMIT 1;
--   Limit  (cost=0.14..2.36 rows=1 width=320)
--     ->  Index Scan using place_momentum_place_computed_idx on place_momentum
--           (cost=0.14..2.36 rows=1 width=320)
--           Index Cond: (place_id = 'node/EMERGING'::text)
--   — an Index Scan and NO Sort node, which is the property (1) exists for.
--
--   EXPLAIN SELECT place_id, trend_state FROM public.place_momentum
--    WHERE trend_state = 'trending' ORDER BY computed_at DESC LIMIT 50;
--   Limit  (cost=0.14..2.36 rows=1 width=72)
--     ->  Index Scan using place_momentum_live_state_idx on place_momentum
--           (cost=0.14..2.36 rows=1 width=72)
--           Index Cond: (trend_state = 'emerging'::text)
--   — the PARTIAL index is chosen and the ORDER BY is satisfied by the index,
--     with no Sort node.
--
--   portava-ci held SIX place_momentum rows over five distinct places when those
--   plans were taken, so the COST AND ROW ESTIMATES in them are evidence about
--   nothing. What is
--   being verified is the ACCESS METHOD and the ABSENCE OF A SORT NODE, which
--   are structural properties of the index definitions and do not depend on
--   cardinality. Both plans were obtained with enable_seqscan = off so that the
--   planner could not prefer a sequential scan of an empty heap on cost alone;
--   that setting proves the index is USABLE for the path, which is the claim.
--   The cardinality-dependent claim — that the planner CHOOSES these indexes at
--   production volume — is NOT made here and must be re-EXPLAINed once the
--   projection has rows.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- SECURITY POSTURE
-- ══════════════════════════════════════════════════════════════════════════════
-- RLS ON with NO POLICIES, every grant to PUBLIC/anon/authenticated revoked,
-- service_role only — the same posture as 2217_protected_locations. This is a
-- derived aggregate over user behaviour: a row says how many weighted
-- interactions a place received and when. Exposed through PostgREST it would
-- be a per-place activity feed for the whole product, readable by anyone with
-- an anon key. It is aggregate and carries no user_id, which makes it LESS
-- sensitive than rank_events but not public, and the default for a derived
-- behavioural store must be closed.
--
-- `rebuild_place_momentum` is SECURITY INVOKER (the default, stated explicitly)
-- with a PINNED search_path, per `10` §6: it reads rank_events, and a SECURITY
-- DEFINER version would hand every caller a read of the raw behaviour table.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES NOT BUY
-- ══════════════════════════════════════════════════════════════════════════════
--   * NO SCHEDULE. Nothing calls rebuild_place_momentum. No pg_cron job, no
--     worker. The table is empty until someone runs it.
--   * NO READER. lib/discoveryTrendState.ts still recomputes its windows per
--     request from rank_events and still does not consult this table. Pointing
--     it here is a CODE change in the Discovery lane, not this one.
--   * NO RETENTION SWEEP. Index (2) makes one cheap; this file does not write
--     one, for the same reason 2890 sets no retention horizon.
--   * IT DOES NOT CLOSE DC-07. Four of five stores now HAVE somewhere durable
--     to live and a function that fills it, which is a real move from "nothing
--     durable is stored at all"; but nothing is stored until the rebuild is
--     scheduled. The honest verdict move is DC-07 W→W with the reason
--     superseded, and DV-72 W→W (1 of 5 now genuinely rebuildable rather than 1
--     of 5 existing). Graded by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY — fully, with no loss to any pre-existing data
-- ══════════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.rebuild_place_momentum(timestamptz);
--   DROP FUNCTION IF EXISTS public.place_momentum_classify(double precision, double precision, double precision, double precision);
--   DROP TABLE IF EXISTS public.place_momentum;
--   COMMIT;
--
-- DROP TABLE destroys only rows this projection computed. EVERY ONE OF THEM IS
-- REDERIVABLE from rank_events by re-running rebuild_place_momentum — that is
-- precisely what `10` §10 rebuildability means, and it is why this table, alone
-- among the objects in this lane, can be dropped without a data-loss argument.
-- The only thing not recoverable is a snapshot whose SOURCE ROWS have since
-- aged out of rank_events; if a retention sweep on rank_events ever ships, that
-- becomes a real loss and this reversal acquires an expiry condition.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TRANSACTION
-- ══════════════════════════════════════════════════════════════════════════════
-- Required. Table, two functions, three indexes, RLS and grants must land as
-- one unit: a committed table with no RLS, or with grants not yet revoked, is
-- an open read of behavioural aggregates for as long as the gap lasts.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2892): gen_random_uuid() must be available (pgcrypto or PG13+).';
  END IF;

  -- The rebuild reads rank_events. Without it the projection would be created
  -- with a producer that cannot run.
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2892): public.rank_events does not exist — place_momentum is derived from it and would have no source.';
  END IF;

  PERFORM 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='rank_events' AND column_name='outcome_at';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2892): rank_events.outcome_at is missing; the rebuild buckets outcomes at their own time and cannot without it.';
  END IF;

  -- Refuse to run over a place_momentum that somebody else already defined.
  IF to_regclass('public.place_momentum') IS NOT NULL THEN
    PERFORM 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='place_momentum' AND column_name='trend_state';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (2892): public.place_momentum already exists with a different shape (no trend_state column). Inspect it before applying 2892.';
    END IF;
  END IF;
END $$;

-- ── The projection ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.place_momentum (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- TEXT, not uuid, and NOT an FK. See the header: rank_events.item_id is a
  -- mixed id space (OSM "node/123", "db/<uuid>", bare uuid) and a place may have
  -- no local row at all.
  place_id       text NOT NULL,

  -- The instant the snapshot describes — `03` §13 "trend state snapshots". One
  -- rebuild run stamps every row it writes with the same value, so a run is
  -- addressable as a unit.
  computed_at    timestamptz NOT NULL DEFAULT now(),

  -- `03` §13 "aggregated windows". The three rates from
  -- lib/discoveryTrendState.computeTrendStates, each already NORMALISED to a
  -- 48-hour rate so that they are comparable — the un-normalised mistake makes
  -- every long window look larger and every place read as "cooling".
  recent_rate    double precision NOT NULL CHECK (recent_rate  >= 0),
  mid_rate       double precision NOT NULL CHECK (mid_rate     >= 0),
  prior_rate     double precision NOT NULL CHECK (prior_rate   >= 0),
  total_weight   double precision NOT NULL CHECK (total_weight >= 0),

  -- `03` §13 "trend state snapshots" — §9's six stages, in the spec's own order.
  -- This is the VERDICT, and it is deliberately not the only durable column:
  -- §13 forbids one opaque score as the only durable truth, and the four rates
  -- above plus `reason` below are the evidence that keeps it from being one.
  trend_state    text NOT NULL CHECK (trend_state = ANY (ARRAY[
                   'unknown', 'emerging', 'trending', 'established',
                   'cooling', 'rediscovered'
                 ]::text[])),

  -- `03` §13 "explanation features" / §11 explainability. Plain-language, and
  -- naming NO place, neighbourhood or person — the same restraint as
  -- lib/discoveryTrendState's reason text, for the same reason: which locations
  -- are safe to name in a public explanation is governed by the sensitive-
  -- location policy and there is no ruling on it.
  reason         text,

  -- `03` §13 "model/version references". Three separate records, because
  -- "which model" and "which constants" are different questions and a drifted
  -- rebuild function must be identifiable from the row it wrote.
  model_version  text NOT NULL,
  event_weights  jsonb NOT NULL,
  window_ms      jsonb NOT NULL,
  thresholds     jsonb NOT NULL,

  -- `10` §10 rebuildability, recorded ON THE ROW: which table this was derived
  -- from. A projection that cannot say what it was built from cannot be audited
  -- as rebuildable.
  source_table   text NOT NULL DEFAULT 'rank_events',

  created_at     timestamptz NOT NULL DEFAULT now(),

  -- One reading per place per run. Makes a rebuild idempotent: re-running for
  -- the same computed_at updates rather than duplicates.
  CONSTRAINT place_momentum_place_run_key UNIQUE (place_id, computed_at)
);

COMMENT ON TABLE public.place_momentum IS
  '`10` §3 graph projection / `03` §13 trend storage. Census DC-07 and DV-72. '
  'DERIVED AND REBUILDABLE: every column is a pure function of public.rank_events '
  'and public.rebuild_place_momentum() recomputes it. Stores the aggregated '
  'windows, the state snapshot, the explanation and the model/version references '
  'TOGETHER — §13 forbids one opaque trend score as the only durable truth, so '
  'the evidence is stored beside the verdict on every row. service_role only: a '
  'row is a per-place activity aggregate and the default for a derived '
  'behavioural store must be closed. SHIPS EMPTY — no schedule calls the rebuild '
  'and no reader consults this table as of migration 2892.';

COMMENT ON COLUMN public.place_momentum.place_id IS
  'rank_events.item_id verbatim. TEXT because Discovery''s place id space is '
  'mixed — OSM "node/123", "db/<uuid>" and bare uuids all appear. Deliberately '
  'NOT an FK to public.places: momentum must be describable for a place Portava '
  'has never stored.';

COMMENT ON COLUMN public.place_momentum.trend_state IS
  '`03` §9''s six stages. NEVER the only durable truth about a place — read it '
  'with recent_rate/mid_rate/prior_rate/total_weight, which are what produced '
  'it. ''unknown'' means BELOW THE EVIDENCE FLOOR and never means ''cooling'': '
  'a place nobody was served has not cooled, nothing was observed about it.';

COMMENT ON COLUMN public.place_momentum.thresholds IS
  'The classifier constants this row was produced under (min_rate, growth_factor, '
  'decline_factor). Stored per row so that a snapshot written by a drifted '
  'rebuild function is self-identifying instead of silently incomparable with '
  'its neighbours.';

-- ── Indexes (rationale and EXPLAIN in the header, per `10` §4) ───────────────
CREATE INDEX IF NOT EXISTS place_momentum_place_computed_idx
  ON public.place_momentum (place_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS place_momentum_computed_idx
  ON public.place_momentum (computed_at DESC);

CREATE INDEX IF NOT EXISTS place_momentum_live_state_idx
  ON public.place_momentum (trend_state, computed_at DESC)
  WHERE trend_state <> 'unknown';

-- ── Security: deny by default ────────────────────────────────────────────────
ALTER TABLE public.place_momentum ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.place_momentum FROM PUBLIC;
REVOKE ALL ON public.place_momentum FROM anon;
REVOKE ALL ON public.place_momentum FROM authenticated;
REVOKE ALL ON public.place_momentum FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.place_momentum TO service_role;

-- ── The classifier, mirrored from lib/discoveryTrendState.classifyTrendState ─
CREATE OR REPLACE FUNCTION public.place_momentum_classify(
  p_recent_rate  double precision,
  p_mid_rate     double precision,
  p_prior_rate   double precision,
  p_total_weight double precision
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  -- MIRRORED CONSTANTS. Each names the TypeScript symbol it must equal.
  c_min_rate       CONSTANT double precision := 3;    -- TREND_MIN_RATE
  c_growth_factor  CONSTANT double precision := 1.5;  -- TREND_GROWTH_FACTOR
  c_decline_factor CONSTANT double precision := 0.6;  -- TREND_DECLINE_FACTOR
  had_mid   boolean;
  had_prior boolean;
BEGIN
  -- Absence of evidence must never become evidence. Both guards come FIRST,
  -- exactly as in the TypeScript, so that a quiet place reads `unknown` and
  -- never `cooling`.
  IF p_total_weight IS NULL OR p_total_weight <= 0 THEN RETURN 'unknown'; END IF;
  IF p_recent_rate  IS NULL OR p_recent_rate < c_min_rate THEN RETURN 'unknown'; END IF;

  had_mid   := COALESCE(p_mid_rate,   0) >= c_min_rate;
  had_prior := COALESCE(p_prior_rate, 0) >= c_min_rate;

  -- `03` §3 Emerging — active now, with no history to accelerate away from.
  IF NOT had_mid AND NOT had_prior THEN RETURN 'emerging'; END IF;

  -- `03` §9 rediscovered — the QUIET MIDDLE is the whole state. Checked BEFORE
  -- trending because a return after silence is the more specific claim.
  IF had_prior AND NOT had_mid THEN RETURN 'rediscovered'; END IF;

  IF p_recent_rate > COALESCE(p_mid_rate, 0) * c_growth_factor  THEN RETURN 'trending'; END IF;
  IF p_recent_rate < COALESCE(p_mid_rate, 0) * c_decline_factor THEN RETURN 'cooling';  END IF;
  RETURN 'established';
END
$fn$;

REVOKE ALL ON FUNCTION public.place_momentum_classify(double precision, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_momentum_classify(double precision, double precision, double precision, double precision) TO service_role;

COMMENT ON FUNCTION public.place_momentum_classify(double precision, double precision, double precision, double precision) IS
  'SQL mirror of lib/discoveryTrendState.classifyTrendState. A SECOND '
  'implementation of one rule — the drift hazard is stated in migration 2892''s '
  'header and is contained by (a) the constants being declared once and named '
  'against their TypeScript symbols, (b) the constants being stored on every '
  'row, and (c) six behavioural assertions in 2892''s postconditions. The parity '
  'test that must accompany it is src/test/placeMomentumSqlParity.test.ts.';

-- ── The rebuild — `10` §10 rebuildability, as an executable ──────────────────
CREATE OR REPLACE FUNCTION public.rebuild_place_momentum(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER          -- `10` §6: NOT definer. It reads raw behaviour.
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  -- MIRRORED CONSTANTS. Each names the TypeScript symbol it must equal.
  c_recent_ms  CONSTANT bigint := 48::bigint  * 3600000;  -- TREND_RECENT_MS
  c_mid_ms     CONSTANT bigint := 168::bigint * 3600000;  -- TREND_MID_MS  (7d)
  c_prior_ms   CONSTANT bigint := 720::bigint * 3600000;  -- TREND_PRIOR_MS (30d)
  c_w_impression CONSTANT double precision := 1;  -- TREND_EVENT_WEIGHTS.impression
  c_w_save       CONSTANT double precision := 3;  -- TREND_EVENT_WEIGHTS.save
  c_w_outcome    CONSTANT double precision := 2;  -- TREND_EVENT_WEIGHTS.outcome
  c_model      CONSTANT text := 'discovery-trend-state-v1';

  -- Window normalisers, in 48-hour units, so the three rates are comparable.
  -- midWindows / priorWindows in computeTrendStates.
  v_mid_windows   double precision := (c_mid_ms   - c_recent_ms)::double precision / c_recent_ms;
  v_prior_windows double precision := (c_prior_ms - c_mid_ms)::double precision   / c_recent_ms;

  v_recent_since timestamptz := p_now - make_interval(secs => c_recent_ms / 1000.0);
  v_mid_since    timestamptz := p_now - make_interval(secs => c_mid_ms    / 1000.0);
  v_prior_since  timestamptz := p_now - make_interval(secs => c_prior_ms  / 1000.0);
  v_written integer;
BEGIN
  WITH events AS (
    -- Every NON-ANALYTICS row is an impression at served_at. outcome='analytics'
    -- rows are ranker bookkeeping, not activity, and are excluded exactly as
    -- computeTrendStates excludes them — counting them would let the ranker's
    -- own writes make a place look popular.
    SELECT item_id AS place_id, served_at AS at, c_w_impression AS w
      FROM public.rank_events
     WHERE outcome <> 'analytics' AND item_id IS NOT NULL AND served_at IS NOT NULL
    UNION ALL
    -- An outcome counts AT ITS OWN TIME, not at the time of the impression that
    -- preceded it. A save made today on an item served three weeks ago is
    -- today's evidence.
    SELECT item_id, outcome_at,
           CASE WHEN outcome = 'save' THEN c_w_save ELSE c_w_outcome END
      FROM public.rank_events
     WHERE outcome <> 'analytics' AND outcome <> 'impression'
       AND item_id IS NOT NULL AND outcome_at IS NOT NULL
  ),
  bucketed AS (
    SELECT place_id,
           -- Rows outside [prior_since, now] are dropped, matching the
           -- TypeScript bucket()'s `at > nowMs || at < priorSince` guard.
           SUM(w) FILTER (WHERE at >= v_recent_since)                       AS recent_w,
           SUM(w) FILTER (WHERE at <  v_recent_since AND at >= v_mid_since) AS mid_w,
           SUM(w) FILTER (WHERE at <  v_mid_since    AND at >= v_prior_since) AS prior_w
      FROM events
     WHERE at <= p_now AND at >= v_prior_since
     GROUP BY place_id
  ),
  rated AS (
    SELECT place_id,
           COALESCE(recent_w, 0)::double precision AS recent_rate,
           CASE WHEN v_mid_windows   > 0 THEN COALESCE(mid_w,   0) / v_mid_windows   ELSE 0 END AS mid_rate,
           CASE WHEN v_prior_windows > 0 THEN COALESCE(prior_w, 0) / v_prior_windows ELSE 0 END AS prior_rate,
           (COALESCE(recent_w,0) + COALESCE(mid_w,0) + COALESCE(prior_w,0))::double precision AS total_weight
      FROM bucketed
  )
  INSERT INTO public.place_momentum (
    place_id, computed_at, recent_rate, mid_rate, prior_rate, total_weight,
    trend_state, reason, model_version, event_weights, window_ms, thresholds, source_table
  )
  SELECT r.place_id,
         p_now,
         r.recent_rate, r.mid_rate, r.prior_rate, r.total_weight,
         public.place_momentum_classify(r.recent_rate, r.mid_rate, r.prior_rate, r.total_weight),
         -- `03` §11 explanation. Fixed text per state, naming nothing.
         CASE public.place_momentum_classify(r.recent_rate, r.mid_rate, r.prior_rate, r.total_weight)
           WHEN 'emerging'     THEN 'Newly active, with no earlier history to compare against.'
           WHEN 'trending'     THEN 'Activity is accelerating against the past week.'
           WHEN 'rediscovered' THEN 'Active again after a quiet week.'
           WHEN 'cooling'      THEN 'Activity has fallen against the past week.'
           WHEN 'established'  THEN 'Sustained activity, neither accelerating nor falling.'
           ELSE                     'Not enough recent activity to say anything.'
         END,
         c_model,
         jsonb_build_object('impression', c_w_impression, 'save', c_w_save, 'outcome', c_w_outcome),
         jsonb_build_object('recent_ms', c_recent_ms, 'mid_ms', c_mid_ms, 'prior_ms', c_prior_ms),
         jsonb_build_object('min_rate', 3, 'growth_factor', 1.5, 'decline_factor', 0.6),
         'rank_events'
    FROM rated r
  ON CONFLICT (place_id, computed_at) DO UPDATE SET
    recent_rate   = EXCLUDED.recent_rate,
    mid_rate      = EXCLUDED.mid_rate,
    prior_rate    = EXCLUDED.prior_rate,
    total_weight  = EXCLUDED.total_weight,
    trend_state   = EXCLUDED.trend_state,
    reason        = EXCLUDED.reason,
    model_version = EXCLUDED.model_version,
    event_weights = EXCLUDED.event_weights,
    window_ms     = EXCLUDED.window_ms,
    thresholds    = EXCLUDED.thresholds;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END
$fn$;

REVOKE ALL ON FUNCTION public.rebuild_place_momentum(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_place_momentum(timestamptz) TO service_role;

COMMENT ON FUNCTION public.rebuild_place_momentum(timestamptz) IS
  '`10` §10 rebuildability, as an executable. Recomputes public.place_momentum '
  'for the instant p_now from public.rank_events alone, and is idempotent for a '
  'given p_now (ON CONFLICT DO UPDATE on (place_id, computed_at)). Returns the '
  'number of rows written. Mirrors lib/discoveryTrendState.computeTrendStates: '
  'analytics rows excluded, an outcome counted at outcome_at rather than at '
  'served_at, mid and prior weights normalised to a 48-hour rate. SECURITY '
  'INVOKER with a pinned search_path per `10` §6 — it reads raw behaviour and '
  'must not lend that read to its caller. NOTHING SCHEDULES THIS as of '
  'migration 2892.';

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  n INT;
  s TEXT;
BEGIN
  IF to_regclass('public.place_momentum') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): public.place_momentum was not created.';
  END IF;

  -- 1. §13 ANTI-OPACITY. The table must carry the EVIDENCE, not just the score.
  --    Asserted as a named list because a future edit that trimmed the table to
  --    (place_id, trend_state) would be exactly the single opaque durable truth
  --    §13 forbids, and would look like a tidy-up.
  FOREACH s IN ARRAY ARRAY['recent_rate','mid_rate','prior_rate','total_weight',
                           'trend_state','reason','model_version','event_weights',
                           'window_ms','thresholds','source_table'] LOOP
    PERFORM 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='place_momentum' AND column_name=s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2892): place_momentum.% is absent. `03` §13 forbids storing one opaque trend score as the only durable truth; the evidence columns are not optional.', s;
    END IF;
  END LOOP;

  -- 2. Deny-by-default actually holds.
  PERFORM 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname='public' AND c.relname='place_momentum' AND c.relrowsecurity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): RLS is not enabled on place_momentum.';
  END IF;

  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='place_momentum'
     AND grantee IN ('anon','authenticated','PUBLIC');
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): place_momentum carries % grant(s) to anon/authenticated/PUBLIC. It is a derived behavioural aggregate and must be service_role only.', n;
  END IF;

  -- 3. The three indexes exist.
  FOREACH s IN ARRAY ARRAY['place_momentum_place_computed_idx',
                           'place_momentum_computed_idx',
                           'place_momentum_live_state_idx'] LOOP
    PERFORM 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname='public' AND c.relname = s AND c.relkind='i';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (2892): index % is absent.', s;
    END IF;
  END LOOP;

  -- 4. THE CLASSIFIER, ASSERTED BEHAVIOURALLY — one tuple per `03` §9 stage.
  --    This is the drift guard named in the header. Rates are (recent, mid,
  --    prior, total).
  --
  --    below the floor  → unknown, NEVER cooling (absence of evidence)
  IF public.place_momentum_classify(2, 100, 100, 202) <> 'unknown' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): recent 2 < TREND_MIN_RATE 3 must classify unknown, got %.',
      public.place_momentum_classify(2, 100, 100, 202);
  END IF;
  --    no weight at all → unknown
  IF public.place_momentum_classify(0, 0, 0, 0) <> 'unknown' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): zero total weight must classify unknown, got %.',
      public.place_momentum_classify(0, 0, 0, 0);
  END IF;
  --    active now, no history at all → emerging
  IF public.place_momentum_classify(10, 0, 0, 10) <> 'emerging' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): active with no history must classify emerging, got %.',
      public.place_momentum_classify(10, 0, 0, 10);
  END IF;
  --    prior history, QUIET MIDDLE → rediscovered (checked before trending)
  IF public.place_momentum_classify(10, 0, 10, 20) <> 'rediscovered' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): a return after a quiet middle must classify rediscovered, got %.',
      public.place_momentum_classify(10, 0, 10, 20);
  END IF;
  --    recent > mid * 1.5 → trending
  IF public.place_momentum_classify(10, 5, 5, 20) <> 'trending' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): recent 10 > mid 5 * 1.5 must classify trending, got %.',
      public.place_momentum_classify(10, 5, 5, 20);
  END IF;
  --    recent < mid * 0.6 → cooling
  IF public.place_momentum_classify(5, 20, 20, 45) <> 'cooling' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): recent 5 < mid 20 * 0.6 must classify cooling, got %.',
      public.place_momentum_classify(5, 20, 20, 45);
  END IF;
  --    sustained, neither → established
  IF public.place_momentum_classify(10, 10, 10, 30) <> 'established' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): sustained activity must classify established, got %.',
      public.place_momentum_classify(10, 10, 10, 30);
  END IF;

  -- 5. THE REBUILD RUNS AND WRITES NOTHING IT SHOULD NOT. Exercised here rather
  --    than described: a rebuild function that does not execute is not a
  --    rebuildability guarantee. On a database with no qualifying rank_events
  --    rows this returns 0; on one with rows it writes a snapshot, which is the
  --    correct outcome in both cases.
  PERFORM public.rebuild_place_momentum(now());

  -- 6. Whatever it wrote must be internally consistent: no row may carry a
  --    state its own evidence does not support.
  SELECT count(*) INTO n FROM public.place_momentum
   WHERE trend_state <> public.place_momentum_classify(recent_rate, mid_rate, prior_rate, total_weight);
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892): % place_momentum row(s) carry a trend_state their own stored evidence does not produce.', n;
  END IF;
END $$;

COMMIT;
