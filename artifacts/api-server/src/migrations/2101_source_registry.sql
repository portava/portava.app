-- 2101_source_registry.sql
-- The place-origin source registry, and a deterministic backfill that attaches
-- an origin to every existing place row that already carries a provider/source
-- string.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION
-- ========================================
-- New 4-digit prefix in the 2100-2999 band (src/scripts/migrationPrefixRules.ts),
-- authored after the 2026-08-19 baseline cutover, applied by the OWNER in the
-- target environment. Until applied, `audit:schema` reports public.sources, the
-- three new source_id columns, and the read policy as MISSING-FROM-LIVE. That is
-- expected, not a finding.
--
-- WHAT THIS IS
-- ============
-- Today a place's origin lives implicitly on scattered provider/source columns
-- (external_place_references.provider, discovery_places.source, fsq_places.source)
-- and nowhere as a first-class value. `public.sources` makes origin explicit:
-- one row per distinct existing provider/source string, each mapped
-- DETERMINISTICALLY to exactly one of six origins. The six-origin taxonomy is
-- the target of this work and did not previously exist anywhere in the schema:
--
--   official     first-party verified / curated editorial
--   provider     an external data provider (Foursquare, OSM, Google)
--   buddy        (reserved — no existing string maps here yet)
--   traveler     user/community contributed
--   inferred     (reserved — no existing string maps here yet)
--   promotional  (reserved — no existing string maps here yet)
--
-- buddy/inferred/promotional are valid origins the CHECK accepts but have no
-- seed row yet, because no existing provider/source string denotes them. That
-- is honest: a seed is added when a real string needs it, never guessed.
--
-- DETERMINISTIC MAPPING (existing string -> seeded origin)
-- =======================================================
--   'portava'        -> official   (first-party verified images/refs)
--   'curated'        -> official   (seeded editorial discovery_places, 0075)
--   'fsq'            -> provider    (Foursquare external_place_references)
--   'fsq_os_places'  -> provider    (fsq_places.source constant, 0184)
--   'osm'            -> provider    (OpenStreetMap)
--   'google'         -> provider    (Google Places)
--   'user'           -> traveler    (user-created posts, placeResolve provider='user')
--   'traveler'       -> traveler    (community discovery_places, discovery.ts default)
--
-- NOT MAPPED, DELIBERATELY:
--   * discovery_places demo/QA fixtures ('seed_script','demo','qa_fixture') are
--     excluded from Discovery and are NOT production origins. No seed row exists
--     for them, so the backfill below leaves their source_id NULL (quarantined),
--     rather than inventing an origin.
--   * discovery_places.source IS NULL denotes legacy pre-source-column community
--     rows that must remain visible; the backfill maps those to 'traveler'.
--   * hidden_gems carries NO single source column — its origin is only derivable
--     from verification_level + submitted_by, which is a product/decision
--     heuristic and out of scope here. It gets NO source_id column in this
--     migration; that is a later, deliberate decision, not an omission.
--   * Any other/unknown string (e.g. test 'mock') has no seed row and is left
--     NULL. Unmapped FAILS CLOSED — nothing is guessed into an origin.
--
-- GUARDING (mirrors the canonical 2092/2093 style: NO manual BEGIN/COMMIT)
-- =======================================================================
-- Per the append-only packet, the canonical migrations use NO transaction-control
-- BEGIN/COMMIT — they rely on the runner's implicit per-file transaction and
-- achieve idempotency with IF NOT EXISTS / CREATE OR REPLACE guards. This file
-- follows that pattern exactly. The precondition and post-condition are plpgsql
-- DO blocks that RAISE EXCEPTION on a broken invariant; because they run inside
-- the runner's implicit transaction, a RAISE aborts the whole migration, which
-- is the guard property without a manual transaction wrapper.

-- ── Precondition ──────────────────────────────────────────────────────────────
-- The three carrier tables must exist before we can add source_id to them. If a
-- carrier is missing, stop rather than partially apply.
DO $$
BEGIN
  IF to_regclass('public.external_place_references') IS NULL
     OR to_regclass('public.discovery_places') IS NULL
     OR to_regclass('public.fsq_places') IS NULL THEN
    RAISE EXCEPTION
      'source registry precondition failed: expected external_place_references, discovery_places and fsq_places to exist';
  END IF;
END;
$$;

-- ── The registry table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sources (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text        NOT NULL UNIQUE,
  display_name  text,
  origin        text        NOT NULL CHECK (origin IN (
                  'official','provider','buddy','traveler','inferred','promotional')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE sources IS
  'Place-origin source registry: one row per distinct provider/source string, each mapped to one of six origins (official|provider|buddy|traveler|inferred|promotional). Reference data — service_role writes, anon/authenticated read.';

-- ── RLS: reference data, world-readable, service_role writes ──────────────────

ALTER TABLE sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_sources"
  ON sources
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "reference_read_sources"
  ON sources
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ── Privileges — mutable reference table, so service_role keeps full access ────

REVOKE ALL ON sources FROM PUBLIC;
REVOKE ALL ON sources FROM anon;
REVOKE ALL ON sources FROM authenticated;
GRANT SELECT ON sources TO anon;
GRANT SELECT ON sources TO authenticated;
GRANT ALL ON sources TO service_role;

-- ── Seed: one row per distinct existing provider/source string ────────────────
-- Mirrors SEED_SOURCES in src/lib/sourceRegistry.ts exactly. Idempotent via
-- ON CONFLICT (key): re-applying updates the mapping to match this file.
INSERT INTO sources (key, display_name, origin) VALUES
  ('portava',       'Portava (first-party verified)', 'official'),
  ('curated',       'Curated editorial',              'official'),
  ('fsq',           'Foursquare',                     'provider'),
  ('fsq_os_places', 'Foursquare OS Places',           'provider'),
  ('osm',           'OpenStreetMap',                  'provider'),
  ('google',        'Google Places',                  'provider'),
  ('user',          'Traveler-contributed',           'traveler'),
  ('traveler',      'Traveler community',             'traveler')
ON CONFLICT (key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      origin       = EXCLUDED.origin;

-- ── Attach a source_id FK to each carrier table ───────────────────────────────

ALTER TABLE external_place_references
  ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES public.sources(id);
ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES public.sources(id);
ALTER TABLE fsq_places
  ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES public.sources(id);

CREATE INDEX IF NOT EXISTS external_place_references_source_id
  ON external_place_references (source_id);
CREATE INDEX IF NOT EXISTS discovery_places_source_id
  ON discovery_places (source_id);
CREATE INDEX IF NOT EXISTS fsq_places_source_id
  ON fsq_places (source_id);

-- ── Deterministic backfill ────────────────────────────────────────────────────
-- external_place_references.provider is the seeded key directly.
UPDATE external_place_references e
   SET source_id = s.id
  FROM sources s
 WHERE s.key = e.provider
   AND e.source_id IS NULL;

-- fsq_places.source is the constant 'fsq_os_places'.
UPDATE fsq_places f
   SET source_id = s.id
  FROM sources s
 WHERE s.key = 'fsq_os_places'
   AND f.source_id IS NULL;

-- discovery_places: exact-match keys first (curated/traveler/osm, and any
-- literal 'fsq'/'fsq_os_places').
UPDATE discovery_places d
   SET source_id = s.id
  FROM sources s
 WHERE s.key = d.source
   AND d.source_id IS NULL;

-- discovery_places: fsq-prefixed variants (e.g. 'fsq_places') -> provider 'fsq'.
UPDATE discovery_places d
   SET source_id = s.id
  FROM sources s
 WHERE s.key = 'fsq'
   AND d.source LIKE 'fsq%'
   AND d.source_id IS NULL;

-- discovery_places: legacy pre-source-column community rows (source IS NULL)
-- must remain visible -> traveler.
UPDATE discovery_places d
   SET source_id = s.id
  FROM sources s
 WHERE s.key = 'traveler'
   AND d.source IS NULL
   AND d.source_id IS NULL;
-- Demo/QA fixtures ('seed_script','demo','qa_fixture') and any unknown string
-- match no seed row and are left NULL (quarantined / fail-closed) — intentional.

-- ── Post-condition ────────────────────────────────────────────────────────────
-- Assert the seed is complete and the backfill left no known provider unmapped.
-- A RAISE here aborts the implicit transaction, so a broken invariant undoes the
-- whole migration.
DO $$
DECLARE
  seeded   int;
  orphaned int;
BEGIN
  SELECT count(*) INTO seeded FROM sources
   WHERE key IN ('portava','curated','fsq','fsq_os_places','osm','google','user','traveler');
  IF seeded <> 8 THEN
    RAISE EXCEPTION 'source registry seed incomplete: expected 8 seeded keys, found %', seeded;
  END IF;

  SELECT count(*) INTO orphaned FROM external_place_references e
   WHERE e.source_id IS NULL
     AND e.provider IN (SELECT key FROM sources);
  IF orphaned <> 0 THEN
    RAISE EXCEPTION
      'backfill left % external_place_references row(s) with a seeded provider still unmapped', orphaned;
  END IF;
END;
$$;
