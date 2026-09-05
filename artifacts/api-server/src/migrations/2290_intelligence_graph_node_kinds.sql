-- 2290_intelligence_graph_node_kinds.sql
-- Compass Phase 15 intelligence graph — admit the `circle` and `experience`
-- node kinds named in docs/architecture/05_Graph_Engine.md.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2290.
--
-- Additive + idempotent. Safe to re-run. Widens ONE CHECK constraint and
-- touches nothing else: no new table, no grant, no RLS change (the graph
-- tables stay service_role-only per 20260730_compass_intelligence_graph.sql),
-- no data change, no flag.
--
-- WHY: compass_graph_nodes.node_type is CHECK-constrained to the nine kinds the
-- Phase 15 builders emitted (person, place, event, trip, city, time_slice,
-- vibe, behavior, outcome). 05_Graph_Engine names two more that the app has
-- real sources for and the graph could not store:
--
--   circle       public.circles (owner, city, visibility) + events.circle_id
--   experience   public.memories (a person's recorded experience at a place /
--                on a trip / at an event, published, not only_me)
--
-- The builders that emit them ship with this migration
-- (CompassGraphEngine.buildGraphFromSources §6, §7); GRAPH_NODE_KINDS in that
-- file is the TypeScript mirror of the list below and a test pins the two to
-- each other. `trail` is DELIBERATELY NOT admitted: the ROADMAP (owner ruling
-- 2026-08-15) marks Trails as a peer scoring system STALE and keeps trails as
-- a future modifier only; there is no trail construct to build a node from.
--
-- RUNTIME EFFECT: NONE on any served surface. The graph is rebuilt by its
-- scheduler; until the next rebuild no row of the new kinds exists. Reads
-- (world model, city confidence, context lines) are aggregates and unaffected.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.compass_graph_nodes') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.compass_graph_nodes does not exist (20260730_compass_intelligence_graph.sql).';
  END IF;
END $$;

-- ── Widen the CHECK (only if it does not already admit the new kinds) ────────
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'compass_graph_nodes'
     AND c.conname = 'compass_graph_nodes_node_type_check';

  IF def IS NOT NULL AND def LIKE '%''circle''%' AND def LIKE '%''experience''%' THEN
    RAISE NOTICE '2290: compass_graph_nodes_node_type_check already admits circle + experience; nothing to do';
    RETURN;
  END IF;

  ALTER TABLE public.compass_graph_nodes
    DROP CONSTRAINT IF EXISTS compass_graph_nodes_node_type_check;
  ALTER TABLE public.compass_graph_nodes
    ADD CONSTRAINT compass_graph_nodes_node_type_check CHECK (node_type IN (
      'person','place','event','trip','city','time_slice','vibe','behavior','outcome',
      'circle','experience'
    ));
END $$;

-- ── Postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE def text; k text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'compass_graph_nodes'
     AND c.conname = 'compass_graph_nodes_node_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: compass_graph_nodes_node_type_check is missing';
  END IF;
  FOREACH k IN ARRAY ARRAY[
    'person','place','event','trip','city','time_slice','vibe','behavior','outcome','circle','experience'
  ] LOOP
    IF def NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: node kind % is not admitted by compass_graph_nodes_node_type_check (%)', k, def;
    END IF;
  END LOOP;
  IF def LIKE '%''trail''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trail must NOT be admitted (ROADMAP: Trails as a peer system is STALE)';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.compass_graph_nodes WHERE node_type IN ('circle','experience');
--   DELETE FROM public.compass_graph_edges WHERE src_type IN ('circle','experience') OR dst_type IN ('circle','experience');
--   ALTER TABLE public.compass_graph_nodes DROP CONSTRAINT compass_graph_nodes_node_type_check;
--   ALTER TABLE public.compass_graph_nodes ADD CONSTRAINT compass_graph_nodes_node_type_check
--     CHECK (node_type IN ('person','place','event','trip','city','time_slice','vibe','behavior','outcome'));
