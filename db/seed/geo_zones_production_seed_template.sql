-- geo_zones_production_seed_template.sql
-- ══════════════════════════════════════════════════════════════════════════════
-- THE OWNER'S MANUAL SEED FOR public.geo_zones. NOT A MIGRATION. FILL IN, THEN
-- RUN BY HAND. Nothing in the repository invents production zones; this file
-- is the shape the owner's curated list is poured into.
-- ══════════════════════════════════════════════════════════════════════════════
--
-- WHY. geo_zones holds 0 rows in production (measured 2026-09-07). Map §10
-- Crowd Flow refuses with `no_zone_model` until at least one zone of a FLOW
-- type (city / neighborhood) covers the viewport — and it is right to refuse
-- rather than approximate. Populating the table is an ops action; the schema
-- already exists (0034, hardened by 2159). The API-side door for the same job
-- is POST /admin/geo-zones/import (routes/admin.ts, service role, dry-run);
-- both doors enforce the SAME four rules, which lib/geoZoneSeed.ts states once:
--
--   1. zone_type is one of the live CHECK: city | neighborhood | venue | custom
--      | airport | hotel.
--   2. Exactly one geometry: circle (center_lat, center_lng, radius_meters) or
--      a closed GeoJSON Polygon outer ring in polygon_geojson.
--   3. A city / neighborhood zone must be >= 250 m across (circle diameter or
--      polygon bounding box) — lib/mapProjection MIN_FLOW_ZONE_EXTENT_METERS —
--      or Crowd Flow drops it on read and the seed did nothing.
--   4. Names are unique, case- and whitespace-insensitively, within the batch
--      AND against rows already in geo_zones. A duplicated name resolves to
--      NO zone for the next-stop family (lib/mapProjection rule 3), so a
--      second "Downtown" silently disables the first.
--
-- HOW TO USE.
--   a. Replace every __FILL_ME__ row in `seed_zones` with real, curated data.
--      One row per zone. Use NULL for the geometry you are not supplying.
--   b. Run the whole file with the last line as ROLLBACK first: the validation
--      block raises on any rule violation and the POST query shows what WOULD
--      be inserted. Read it.
--   c. Change the last line to COMMIT and run it again.
--   d. Run the POST-VERIFICATION query at the bottom; Crowd Flow's zone read is
--      cached for 30 s, after which /map/projection?kinds=crowd_flow over the
--      seeded area reports crowdFlow.refusal = null and zoneModel.zones >= 1.
--
-- Rehearsed on portava-ci 2026-09-07 with the sample rows from
-- artifacts/api-server/src/test/fixtures/geo-zones.sample.json, ROLLED BACK.

BEGIN;

CREATE TEMP TABLE seed_zones (
  name            text        NOT NULL,
  zone_type       text        NOT NULL,
  city            text,
  country_code    text,
  center_lat      double precision,
  center_lng      double precision,
  radius_meters   integer,
  polygon_geojson jsonb,
  source          text        NOT NULL   -- provenance: where the shape came from, who curated it, when
) ON COMMIT DROP;

INSERT INTO seed_zones (name, zone_type, city, country_code, center_lat, center_lng, radius_meters, polygon_geojson, source) VALUES
  -- ('An Thuong', 'neighborhood', 'Da Nang', 'VN', 16.0500, 108.2000, 600, NULL, 'curated by <who> on <date> from <where>'),
  -- ('My Khe',    'neighborhood', 'Da Nang', 'VN', NULL, NULL, NULL,
  --    '{"type":"Polygon","coordinates":[[[108.235,16.062],[108.248,16.062],[108.248,16.078],[108.235,16.078],[108.235,16.062]]]}'::jsonb,
  --    'curated by <who> on <date> from <where>'),
  ('__FILL_ME__', 'neighborhood', NULL, NULL, NULL, NULL, NULL, NULL, '__FILL_ME__');

-- ── VALIDATION — the four rules, enforced before a single row is written ─────
DO $$
DECLARE
  r record;
  ring jsonb;
  n int;
  min_lat double precision; max_lat double precision; min_lng double precision; max_lng double precision;
  extent_m double precision;
  problems text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM seed_zones WHERE name = '__FILL_ME__' OR source = '__FILL_ME__') THEN
    RAISE EXCEPTION 'SEED REFUSED: the template placeholder row is still present. Replace __FILL_ME__ with curated data.';
  END IF;

  FOR r IN SELECT * FROM seed_zones LOOP
    -- Rule 1
    IF r.zone_type NOT IN ('city','neighborhood','venue','custom','airport','hotel') THEN
      problems := problems || format('[%s] zone_type %L is not in geo_zones_zone_type_check; ', r.name, r.zone_type);
    END IF;
    IF r.country_code IS NOT NULL AND r.country_code !~ '^[A-Z]{2}$' THEN
      problems := problems || format('[%s] country_code %L is not ISO 3166-1 alpha-2 upper case; ', r.name, r.country_code);
    END IF;

    -- Rule 2
    IF (r.center_lat IS NOT NULL OR r.center_lng IS NOT NULL OR r.radius_meters IS NOT NULL)
       AND NOT (r.center_lat IS NOT NULL AND r.center_lng IS NOT NULL AND r.radius_meters IS NOT NULL) THEN
      problems := problems || format('[%s] a circle needs center_lat, center_lng AND radius_meters; ', r.name);
    END IF;
    IF r.center_lat IS NOT NULL AND r.polygon_geojson IS NOT NULL THEN
      problems := problems || format('[%s] give a circle OR a polygon, not both; ', r.name);
    END IF;
    IF r.center_lat IS NULL AND r.polygon_geojson IS NULL THEN
      problems := problems || format('[%s] a zone needs a circle or a polygon; ', r.name);
    END IF;
    IF r.center_lat IS NOT NULL AND (abs(r.center_lat) > 90 OR abs(r.center_lng) > 180 OR r.radius_meters <= 0 OR r.radius_meters > 100000) THEN
      problems := problems || format('[%s] circle out of range (|lat|<=90, |lng|<=180, 0<radius<=100000); ', r.name);
    END IF;

    extent_m := NULL;
    IF r.center_lat IS NOT NULL THEN
      extent_m := r.radius_meters * 2;
    ELSIF r.polygon_geojson IS NOT NULL THEN
      IF r.polygon_geojson->>'type' IS DISTINCT FROM 'Polygon' OR jsonb_typeof(r.polygon_geojson->'coordinates') <> 'array' THEN
        problems := problems || format('[%s] polygon_geojson must be a GeoJSON Polygon; ', r.name);
      ELSE
        ring := r.polygon_geojson->'coordinates'->0;
        n := jsonb_array_length(ring);
        IF n < 4 OR (ring->0) <> (ring->(n-1)) THEN
          problems := problems || format('[%s] polygon outer ring must have >= 4 positions and be closed; ', r.name);
        ELSE
          SELECT min((p->>1)::float8), max((p->>1)::float8), min((p->>0)::float8), max((p->>0)::float8)
            INTO min_lat, max_lat, min_lng, max_lng
            FROM jsonb_array_elements(ring) p;
          IF abs(min_lat) > 90 OR abs(max_lat) > 90 OR abs(min_lng) > 180 OR abs(max_lng) > 180 THEN
            problems := problems || format('[%s] polygon position out of range; ', r.name);
          ELSE
            -- Haversine of the bounding-box diagonal, as lib/mapProjection.ringExtentMeters.
            extent_m := 2 * 6371000 * asin(sqrt(
              power(sin(radians(max_lat - min_lat) / 2), 2)
              + cos(radians(min_lat)) * cos(radians(max_lat)) * power(sin(radians(max_lng - min_lng) / 2), 2)));
          END IF;
        END IF;
      END IF;
    END IF;

    -- Rule 3
    IF r.zone_type IN ('city','neighborhood') AND extent_m IS NOT NULL AND extent_m < 250 THEN
      problems := problems || format('[%s] a %s zone must be >= 250 m across (is %s m) or Crowd Flow drops it; ', r.name, r.zone_type, round(extent_m));
    END IF;
  END LOOP;

  -- Rule 4 (batch)
  FOR r IN
    SELECT lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS key, count(*) AS c
      FROM seed_zones GROUP BY 1 HAVING count(*) > 1
  LOOP
    problems := problems || format('name %L appears %s times in the batch (ambiguous names resolve to nothing); ', r.key, r.c);
  END LOOP;
  -- Rule 4 (store)
  FOR r IN
    SELECT s.name FROM seed_zones s
     WHERE EXISTS (SELECT 1 FROM public.geo_zones g
                    WHERE lower(regexp_replace(btrim(g.name), '\s+', ' ', 'g'))
                        = lower(regexp_replace(btrim(s.name), '\s+', ' ', 'g')))
  LOOP
    problems := problems || format('[%s] a zone with this name already exists in geo_zones (both would become unresolvable); ', r.name);
  END LOOP;

  IF problems <> '' THEN
    RAISE EXCEPTION 'SEED REFUSED — nothing written: %', problems;
  END IF;
END $$;

-- ── THE WRITE ─────────────────────────────────────────────────────────────────
INSERT INTO public.geo_zones
  (name, zone_type, city, country_code, center_lat, center_lng, radius_meters, polygon_geojson,
   is_system, verified, featured, metadata)
SELECT name, zone_type, city, country_code, center_lat, center_lng, radius_meters, polygon_geojson,
       true, true, false,
       jsonb_build_object('seed_source', source, 'seeded_at', now())
  FROM seed_zones;

-- ── POST (inside the transaction: what this run wrote) ───────────────────────
SELECT zone_type, count(*) AS zones,
       count(*) FILTER (WHERE zone_type IN ('city','neighborhood')) AS flow_eligible
  FROM public.geo_zones
 WHERE metadata->>'seeded_at' IS NOT NULL
 GROUP BY zone_type ORDER BY zone_type;

ROLLBACK;   -- ← first run. Change to COMMIT; once the POST output is what you meant.

-- ── POST-VERIFICATION (run separately, after COMMIT) ─────────────────────────
-- SELECT zone_type, count(*) FROM public.geo_zones GROUP BY 1 ORDER BY 1;
-- SELECT name, zone_type, city, country_code,
--        CASE WHEN polygon_geojson IS NOT NULL THEN 'polygon' ELSE 'circle' END AS shape
--   FROM public.geo_zones ORDER BY city, zone_type, name;
-- Then: GET /map/projection?bbox=<seeded area>&zoom=14&kinds=crowd_flow →
--   crowdFlow.refusal = null, crowdFlow.zoneModel.zones >= 1 (after the 30 s cache).
