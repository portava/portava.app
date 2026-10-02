-- 3416_trail_relations_projection.sql
-- Discovery graph projections (census-discovery DV-72, §61): `10_Database_Architecture.md`
-- §3 "Graph projections … trail_relations … These are derived and rebuildable",
-- for the ONE of the five projections whose inputs are declared and editorial
-- rather than personal behaviour.
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness only (scripts/local-db/up.sh).
--
-- ── THE DEFINITION, AND WHERE EACH PART COMES FROM ──────────────────────────
-- `10` §3 names `trail_relations` and nothing more. `05_Graph_Engine.md` §2
-- defines the Trail Graph: "Edges from: parent/child, related topic, geographic
-- branch, common content, common traveler flow." §5: edges are "typed and
-- time-aware". §8: "Materialized/derived tables can serve: … Trail relations".
-- Of the five sources:
--   parent/child, related topic, geographic branch
--         are DECLARED relations the database already holds: `trail_edges`
--         (02 §6's six kinds) and `trails.parent_trail_id` (the pointer
--         TrailService.relatedTrails already reads beside the edge).
--   common content
--         two Trails that hold the same (source_type, source_id). A count over
--         `content_trails`, which records an editorial act (attach / suggest),
--         not anyone's behaviour.
--   common traveler flow
--         NOT BUILT. It is travellers' movement between Trails — a behavioural
--         inference over people — and needs a consent / data-use scope that no
--         Discovery purpose declares (census-discovery §61.5).
-- `05` §6's edge STRENGTH ("derived strength from recency, frequency, diversity,
-- confirmed experiences") has no formula anywhere, and §6 also says "Do not
-- store 'relationship truth' as a single permanent score". So no strength is
-- computed: a declared edge carries its declared `strength` verbatim, and a
-- common-content relation carries its COUNT and its time window — the
-- frequency and recency ingredients, not a score made of them.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
--   public.trail_relations                 the projection (service role only)
--   public.rebuild_trail_relations(ts)     recompute it from source rows,
--                                          atomically, idempotently
-- A relation row is one of:
--   (from, to, <edge_type>,    'declared_edge')   every trail_edges row, as is
--   (parent, child, 'child',   'parent_pointer')  a parent_trail_id with no
--                                                 declared (parent, child, child)
--                                                 edge beside it — the same
--                                                 de-duplication relatedTrails does
--   (a, b, 'common_content',   'shared_content')  a < b, count ≥ 1 distinct
--                                                 shared contents, any label
-- Every row carries `10` §9's lineage: its source window (the oldest and newest
-- source-row timestamps it rests on), a feature version, a model version (this
-- projection's definition) and its computation time.
--
-- NO READER. Nothing in the API reads this table, no flag gates a reader
-- because there is none to gate, and no ranker may read it
-- (docs/discovery/ROADMAP.md, 2026-08-15: "No optimising ranking machinery over
-- an empty corpus"). It is rebuilt only when rebuild_trail_relations is called;
-- no job calls it. A future reader must apply the viewer's visibility (archived
-- Trails, withheld members): the projection is a function of the source rows,
-- not of any viewer, and a common-content count includes members a given
-- viewer may not be served.
--
-- ── `10` §4 — cardinality, index, EXPLAIN ───────────────────────────────────
-- Production: 0 Trails, so 0 rows. At the harness's synthetic 2,000 Trails /
-- 50,000 memberships / 4,000 edges the rebuild is one statement: a scan of
-- trail_edges, a scan of trails, and a hash self-join of content_trails on
-- (source_type, source_id) (docs/discovery/query-paths.md QP-27). The primary
-- key (from, to, relation) serves "relations out of a Trail";
-- idx_trail_relations_to serves "relations into a Trail".
--
-- ── `10` §5 / §6 — RLS and SECURITY ─────────────────────────────────────────
-- RLS on; every operation explicitly DENIED to anon and authenticated by a
-- RESTRICTIVE policy, as 3390 does for the service-only Discovery tables;
-- service_role holds SELECT, INSERT and DELETE and nothing else (rows are only
-- replaced, never edited). The rebuild is SECURITY INVOKER with a pinned
-- search_path and is executable by service_role only.
--
-- Rollback: db/rollback/2026-09-27-3416-trail-relations-projection-rollback.sql
-- (drops the table and the function; the projection is derived, so nothing is
-- lost that a rebuild cannot restore).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trails') IS NULL OR to_regclass('public.trail_edges') IS NULL
     OR to_regclass('public.content_trails') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3416): the 2910 Trails tables are absent. Apply 2910_discovery_trails.sql first.';
  END IF;
  IF to_regclass('public.trail_relations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'trail_relations' AND column_name = 'basis') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3416): a public.trail_relations of another shape exists; this file will not re-assert over it.';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.trail_relations (
  from_trail_id        uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  to_trail_id          uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  relation             text        NOT NULL,
  basis                text        NOT NULL,
  -- A declared edge's own strength, verbatim; NULL for every other basis.
  declared_strength    numeric     NULL,
  -- common_content only: distinct (source_type, source_id) held by both Trails.
  shared_content_count integer     NULL,
  -- `10` §9 lineage.
  source_window_start  timestamptz NOT NULL,
  source_window_end    timestamptz NOT NULL,
  feature_version      text        NOT NULL,
  model_version        text        NOT NULL,
  computed_at          timestamptz NOT NULL,
  PRIMARY KEY (from_trail_id, to_trail_id, relation),
  CONSTRAINT trail_relations_relation_known CHECK (relation IN (
    'parent', 'child', 'related', 'seasonal_variant', 'geographic_sub', 'experience_branch', 'common_content')),
  CONSTRAINT trail_relations_basis_known CHECK (basis IN ('declared_edge', 'parent_pointer', 'shared_content')),
  CONSTRAINT trail_relations_basis_matches CHECK (
       (basis = 'shared_content' AND relation = 'common_content')
    OR (basis = 'parent_pointer' AND relation = 'child')
    OR (basis = 'declared_edge'  AND relation <> 'common_content')),
  CONSTRAINT trail_relations_no_self CHECK (from_trail_id <> to_trail_id),
  CONSTRAINT trail_relations_common_ordered CHECK (relation <> 'common_content' OR from_trail_id < to_trail_id),
  CONSTRAINT trail_relations_count_shape CHECK (
    (relation = 'common_content') = (shared_content_count IS NOT NULL)
    AND (shared_content_count IS NULL OR shared_content_count >= 1)),
  CONSTRAINT trail_relations_strength_shape CHECK (
    (basis = 'declared_edge') = (declared_strength IS NOT NULL)),
  CONSTRAINT trail_relations_window CHECK (source_window_start <= source_window_end)
);
COMMENT ON TABLE public.trail_relations IS
  '10 §3 graph projection (census-discovery DV-72, 3416): the Trail Graph of 05 §2 over DECLARED relations (trail_edges, trails.parent_trail_id) and COMMON CONTENT (content_trails). Derived: rebuild_trail_relations recomputes it from those rows. No strength is computed (05 §6 gives no formula). Common traveler flow is not here (behavioural; no consent scope). Read by nothing; no ranker may read it (ROADMAP 2026-08-15).';
CREATE INDEX IF NOT EXISTS idx_trail_relations_to ON public.trail_relations (to_trail_id, relation);

ALTER TABLE public.trail_relations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trail_relations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trail_relations FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.trail_relations TO service_role;

DO $policies$
DECLARE v_op text;
BEGIN
  FOREACH v_op IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.trail_relations', format('trail_relations_deny_%s_clients', lower(v_op)));
    EXECUTE format('CREATE POLICY %I ON public.trail_relations AS RESTRICTIVE FOR %s TO anon, authenticated %s',
      format('trail_relations_deny_%s_clients', lower(v_op)), v_op,
      CASE v_op WHEN 'INSERT' THEN 'WITH CHECK (false)'
                WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
                ELSE 'USING (false)' END);
    EXECUTE format('COMMENT ON POLICY %I ON public.trail_relations IS %L',
      format('trail_relations_deny_%s_clients', lower(v_op)),
      format('3416 (census-discovery DV-72, 10 §5): %s is DENIED to anon and authenticated on trail_relations, a derived projection read by the server only. Restrictive, so a later permissive policy or re-GRANT cannot reopen it silently.', v_op));
  END LOOP;
END
$policies$;

CREATE OR REPLACE FUNCTION public.rebuild_trail_relations(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER          -- `10` §6: nothing here needs definer rights.
SET search_path = pg_catalog
AS $fn$
DECLARE
  c_feature CONSTANT text := 'trail-relation-kinds-v1';
  c_model   CONSTANT text := 'trail-relations-projection-v1';
  n integer;
BEGIN
  -- One rebuild at a time; a second waits and then replaces the first's rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('rebuild_trail_relations', 0));

  DELETE FROM public.trail_relations WHERE true;

  INSERT INTO public.trail_relations (
    from_trail_id, to_trail_id, relation, basis, declared_strength, shared_content_count,
    source_window_start, source_window_end, feature_version, model_version, computed_at)
  -- 02 §6 declared relations, verbatim.
  SELECT e.from_trail_id, e.to_trail_id, e.edge_type, 'declared_edge', e.strength, NULL::integer,
         e.updated_at, e.updated_at, c_feature, c_model, p_now
    FROM public.trail_edges AS e
  UNION ALL
  -- The parent pointer, where no declared (parent, child, 'child') edge carries it.
  SELECT t.parent_trail_id, t.id, 'child', 'parent_pointer', NULL::numeric, NULL::integer,
         least(t.created_at, t.updated_at), greatest(t.created_at, t.updated_at), c_feature, c_model, p_now
    FROM public.trails AS t
   WHERE t.parent_trail_id IS NOT NULL
     AND t.parent_trail_id <> t.id
     AND NOT EXISTS (SELECT 1 FROM public.trail_edges AS e
                      WHERE e.from_trail_id = t.parent_trail_id AND e.to_trail_id = t.id AND e.edge_type = 'child')
  UNION ALL
  -- 05 §2 common content: distinct shared (source_type, source_id), each pair once (a < b).
  SELECT s.a, s.b, 'common_content', 'shared_content', NULL::numeric, count(*)::integer,
         min(s.first_at), max(s.last_at), c_feature, c_model, p_now
    FROM (
      SELECT x.trail_id AS a, y.trail_id AS b,
             least(x.first_at, y.first_at) AS first_at, greatest(x.last_at, y.last_at) AS last_at
        FROM (SELECT trail_id, source_type, source_id, min(created_at) AS first_at, max(created_at) AS last_at
                FROM public.content_trails GROUP BY 1, 2, 3) AS x
        JOIN (SELECT trail_id, source_type, source_id, min(created_at) AS first_at, max(created_at) AS last_at
                FROM public.content_trails GROUP BY 1, 2, 3) AS y
          ON y.source_type = x.source_type AND y.source_id = x.source_id AND x.trail_id < y.trail_id
    ) AS s
   GROUP BY s.a, s.b;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.rebuild_trail_relations(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_trail_relations(timestamptz) TO service_role;
COMMENT ON FUNCTION public.rebuild_trail_relations(timestamptz) IS
  '3416 (census-discovery DV-72): replaces every trail_relations row with the projection of trail_edges, trails.parent_trail_id and content_trails as they stand, stamped computed_at = p_now. One statement, one snapshot; idempotent for a given p_now. SECURITY INVOKER, pinned search_path (10 §6). Called by nothing yet.';

-- ── Behavioural postcondition, inside the applying transaction ──────────────
-- Three probe Trails: a declared related edge, a parent pointer with no edge,
-- and one content held by two of them. Rebuild twice; the second must equal the
-- first. The sentinel exception rolls the probes (and the rebuild) back.
DO $probe$
DECLARE
  a uuid := '00000000-0000-4000-8000-0000000034a0';
  b uuid := '00000000-0000-4000-8000-0000000034a1';
  c uuid := '00000000-0000-4000-8000-0000000034a2';
  n1 int; n2 int; got text; want text;
BEGIN
  BEGIN
    INSERT INTO public.trails (id, slug, title, lifecycle_status) VALUES
      (a, 'migration-3416-probe-a', 'probe a', 'proposed'),
      (b, 'migration-3416-probe-b', 'probe b', 'proposed');
    INSERT INTO public.trails (id, slug, title, lifecycle_status, parent_trail_id) VALUES
      (c, 'migration-3416-probe-c', 'probe c', 'proposed', a);
    INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type, strength) VALUES (a, b, 'related', 0.25);
    INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship) VALUES
      (a, 'place', '00000000-0000-4000-8000-0000000034b0', 'primary'),
      (c, 'place', '00000000-0000-4000-8000-0000000034b0', 'supporting');
    n1 := public.rebuild_trail_relations('2026-09-27T00:00:00Z');
    SELECT string_agg(concat_ws('|', from_trail_id, to_trail_id, relation, basis, declared_strength, shared_content_count), ',' ORDER BY from_trail_id, to_trail_id, relation)
      INTO got FROM public.trail_relations WHERE from_trail_id IN (a, b, c);
    want := concat_ws(',',
      concat_ws('|', a, b, 'related', 'declared_edge', 0.25),
      concat_ws('|', a, c, 'child', 'parent_pointer'),
      concat_ws('|', a, c, 'common_content', 'shared_content', 1));
    IF got IS DISTINCT FROM want THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3416): the projection of the probe is % (want %)', got, want;
    END IF;
    n2 := public.rebuild_trail_relations('2026-09-27T00:00:00Z');
    IF n1 <> n2 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3416): a second rebuild wrote % rows, the first %', n2, n1;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P3416', MESSAGE = '3416 probe rollback';
  EXCEPTION
    WHEN SQLSTATE 'P3416' THEN
      NULL;
  END;
END
$probe$;

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
DECLARE v_op text; v_role text;
BEGIN
  IF to_regclass('public.trail_relations') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416): public.trail_relations is absent.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trail_relations'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416): RLS is not enabled on trail_relations.';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_op IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.trail_relations', v_op) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3416): % holds % on trail_relations.', v_role, v_op;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role, 'public.rebuild_trail_relations(timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3416): % may execute rebuild_trail_relations.', v_role;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.trail_relations', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416): service_role must not UPDATE trail_relations (rows are replaced, never edited).';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.trail_relations'::regclass AND NOT polpermissive) <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416): expected four restrictive client-deny policies on trail_relations.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.rebuild_trail_relations(timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416): rebuild_trail_relations must be SECURITY INVOKER.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trails WHERE slug LIKE 'migration-3416-probe-%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3416): a probe Trail persisted.';
  END IF;
END
$post$;
