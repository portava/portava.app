-- 2122_freshness_policies.sql
-- Per-claim-type freshness TTLs: how long a claim of a given kind may be
-- labelled "live" before it must be treated as stale.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION
-- ========================================
-- New 4-digit prefix in the 2100-2999 band (src/scripts/migrationPrefixRules.ts),
-- authored after the 2026-08-19 baseline cutover, applied by the OWNER in the
-- target environment. Until applied, `audit:schema` reports public.freshness_policies
-- and its read policy as MISSING-FROM-LIVE. That is expected, not a finding.
--
-- WHAT THIS IS
-- ===========
-- A tiny reference table keyed by claim_type. Each row says how many seconds a
-- claim of that kind stays fresh. src/lib/freshnessPolicy.ts reads it (with a
-- 30s in-memory cache) to answer isStale()/expiresAt(). An UNKNOWN claim_type
-- is treated as stale / no live label (fail-closed) — a claim we have no policy
-- for is never labelled live.
--
-- THE SEEDED DEFAULTS ARE OWNER-TUNABLE
-- ====================================
-- The four TTLs below are the blueprint defaults, not constants. They are
-- ordinary data rows: the owner can UPDATE any ttl_seconds without a migration.
-- They are seeded here only so the table is useful the moment it exists.
--
--   crowd        900       (15 minutes) — how busy a place is, changes fast
--   vibe         1800      (30 minutes) — atmosphere, changes over a sitting
--   price        172800    (48 hours)   — pricing, changes slowly
--   structural   15552000  (180 days)   — hours/existence, effectively static

CREATE TABLE IF NOT EXISTS freshness_policies (
  claim_type   text        PRIMARY KEY,
  ttl_seconds  integer     NOT NULL,
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE freshness_policies IS
  'Per-claim-type freshness TTLs (seconds). Owner-tunable defaults from the blueprint; an unknown claim_type is treated as stale (fail-closed). Reference data — service_role writes, anon/authenticated read.';

-- ── RLS: reference data, world-readable, service_role writes ──────────────────

ALTER TABLE freshness_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_freshness_policies"
  ON freshness_policies
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "reference_read_freshness_policies"
  ON freshness_policies
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ── Privileges — mutable reference table, so service_role keeps full access ────

REVOKE ALL ON freshness_policies FROM PUBLIC;
REVOKE ALL ON freshness_policies FROM anon;
REVOKE ALL ON freshness_policies FROM authenticated;
GRANT SELECT ON freshness_policies TO anon;
GRANT SELECT ON freshness_policies TO authenticated;
GRANT ALL ON freshness_policies TO service_role;

-- ── Seed the blueprint defaults ───────────────────────────────────────────────
-- Mirrors SEED_FRESHNESS_POLICIES in src/lib/freshnessPolicy.ts exactly.
-- Idempotent via ON CONFLICT (claim_type).
INSERT INTO freshness_policies (claim_type, ttl_seconds, note) VALUES
  ('crowd',      900,      'How busy a place is — 15 minutes.'),
  ('vibe',       1800,     'Atmosphere / feel — 30 minutes.'),
  ('price',      172800,   'Pricing — 48 hours.'),
  ('structural', 15552000, 'Hours / existence — 180 days, effectively static.')
ON CONFLICT (claim_type) DO UPDATE
  SET ttl_seconds = EXCLUDED.ttl_seconds,
      note        = EXCLUDED.note,
      updated_at  = now();
