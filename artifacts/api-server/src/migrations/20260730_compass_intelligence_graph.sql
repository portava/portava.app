-- Migration: Compass Phase 15 — Travel Intelligence Graph
-- Persistent typed graph (People–Places–Events–Trips–Time–Vibe–Behavior–Outcomes),
-- per-city Destination World Model, and city-confidence index.
-- Built entirely from data the app already collects (stamps, trips, events,
-- served recommendations, outcome events, rank events). Service-role only:
-- privacy guards are applied at read time in CompassGraphEngine.

-- ── 1. compass_graph_nodes ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS compass_graph_nodes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type   text        NOT NULL CHECK (node_type IN
                ('person','place','event','trip','city','time_slice','vibe','behavior','outcome')),
  node_key    text        NOT NULL,
  city        text,
  attrs       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uix_graph_nodes_type_key
  ON compass_graph_nodes (node_type, node_key);
CREATE INDEX IF NOT EXISTS ix_graph_nodes_city ON compass_graph_nodes (city);

-- ── 2. compass_graph_edges ────────────────────────────────────────────────────
-- Edges reference nodes by (type, key) so batch builders can upsert without
-- id round-trips. observed_count accumulates repeat observations (the
-- cross-trip signal: the same person returning to the same city).

CREATE TABLE IF NOT EXISTS compass_graph_edges (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  src_type       text        NOT NULL,
  src_key        text        NOT NULL,
  dst_type       text        NOT NULL,
  dst_key        text        NOT NULL,
  edge_type      text        NOT NULL,
  weight         numeric     NOT NULL DEFAULT 1,
  observed_count integer     NOT NULL DEFAULT 1,
  first_seen     timestamptz,
  last_seen      timestamptz,
  attrs          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uix_graph_edges_identity
  ON compass_graph_edges (src_type, src_key, dst_type, dst_key, edge_type);
CREATE INDEX IF NOT EXISTS ix_graph_edges_src  ON compass_graph_edges (src_type, src_key);
CREATE INDEX IF NOT EXISTS ix_graph_edges_dst  ON compass_graph_edges (dst_type, dst_key);
CREATE INDEX IF NOT EXISTS ix_graph_edges_type ON compass_graph_edges (edge_type);

-- ── 3. compass_city_models — Destination World Model ─────────────────────────
-- One row per city. time_slices: {"fri:evening": {count, categories:{...}}, ...}
-- monthly: {"07": count, ...} for seasonal effects.

CREATE TABLE IF NOT EXISTS compass_city_models (
  city           text        PRIMARY KEY,
  time_slices    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  monthly        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  top_categories jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sample_size    integer     NOT NULL DEFAULT 0,
  built_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 4. compass_city_confidence — city-confidence index ───────────────────────

CREATE TABLE IF NOT EXISTS compass_city_confidence (
  city        text        PRIMARY KEY,
  depth_score numeric     NOT NULL DEFAULT 0,
  tier        text        NOT NULL DEFAULT 'thin' CHECK (tier IN ('deep','moderate','thin')),
  signals     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- ── 5. RLS — service_role only (privacy guards applied at read time in code) ─

ALTER TABLE compass_graph_nodes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE compass_graph_edges     ENABLE ROW LEVEL SECURITY;
ALTER TABLE compass_city_models     ENABLE ROW LEVEL SECURITY;
ALTER TABLE compass_city_confidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "graph_nodes_service_all" ON compass_graph_nodes;
CREATE POLICY "graph_nodes_service_all" ON compass_graph_nodes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "graph_edges_service_all" ON compass_graph_edges;
CREATE POLICY "graph_edges_service_all" ON compass_graph_edges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "city_models_service_all" ON compass_city_models;
CREATE POLICY "city_models_service_all" ON compass_city_models
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "city_confidence_service_all" ON compass_city_confidence;
CREATE POLICY "city_confidence_service_all" ON compass_city_confidence
  FOR ALL TO service_role USING (true) WITH CHECK (true);
