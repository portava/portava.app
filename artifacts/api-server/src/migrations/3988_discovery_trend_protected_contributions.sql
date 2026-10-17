BEGIN;

CREATE OR REPLACE FUNCTION public.discovery_trend_position_is_clear(
  p_lat double precision, p_lng double precision)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  zone_row record;
  vertex jsonb;
  longitude_values double precision[];
  latitude_values double precision[];
  vertex_index integer;
  previous_index integer;
  next_index integer;
  other_index integer;
  other_next_index integer;
  vertex_count integer;
  longitude_value double precision;
  latitude_value double precision;
  point_longitude double precision;
  longitude_delta double precision;
  haversine_value double precision;
  cross_product double precision;
  signed_area double precision;
  inside_polygon boolean;
BEGIN
  IF (p_lat BETWEEN -90 AND 90 AND p_lng BETWEEN -180 AND 180) IS NOT TRUE THEN
    RETURN false;
  END IF;
  point_longitude := CASE WHEN p_lng = 180 THEN -180 ELSE p_lng END;
  FOR zone_row IN SELECT * FROM public.protected_zones WHERE active LOOP
    IF zone_row.shape = 'circle' THEN
      IF (zone_row.center_lat BETWEEN -90 AND 90
          AND zone_row.center_lng BETWEEN -180 AND 180
          AND zone_row.radius_meters > 0
          AND zone_row.radius_meters < 'Infinity'::double precision
          AND zone_row.ring IS NULL) IS NOT TRUE THEN
        RETURN false;
      END IF;
      longitude_delta := radians(p_lng - zone_row.center_lng);
      haversine_value := power(sin(radians(p_lat - zone_row.center_lat) / 2), 2)
        + cos(radians(p_lat)) * cos(radians(zone_row.center_lat)) * power(sin(longitude_delta / 2), 2);
      IF 2 * 6371000 * asin(sqrt(least(1, greatest(0, haversine_value)))) <= zone_row.radius_meters THEN
        RETURN false;
      END IF;
    ELSIF zone_row.shape = 'polygon' THEN
      IF jsonb_typeof(zone_row.ring) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      vertex_count := jsonb_array_length(zone_row.ring);
      IF vertex_count < 3 OR vertex_count > 257 OR zone_row.center_lat IS NOT NULL
          OR zone_row.center_lng IS NOT NULL OR zone_row.radius_meters IS NOT NULL THEN RETURN false; END IF;
      longitude_values := ARRAY[]::double precision[];
      latitude_values := ARRAY[]::double precision[];
      FOR vertex IN SELECT value FROM jsonb_array_elements(zone_row.ring) LOOP
        IF jsonb_typeof(vertex) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        IF jsonb_array_length(vertex) <> 2 OR jsonb_typeof(vertex->0) IS DISTINCT FROM 'number'
            OR jsonb_typeof(vertex->1) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        longitude_value := (vertex->>0)::double precision;
        latitude_value := (vertex->>1)::double precision;
        IF (longitude_value BETWEEN -180 AND 180 AND latitude_value > -90 AND latitude_value < 90) IS NOT TRUE THEN RETURN false; END IF;
        longitude_values := array_append(longitude_values, CASE WHEN longitude_value = 180 THEN -180 ELSE longitude_value END);
        latitude_values := array_append(latitude_values, latitude_value);
      END LOOP;
      IF longitude_values[1] = longitude_values[vertex_count]
          AND latitude_values[1] = latitude_values[vertex_count] THEN
        vertex_count := vertex_count - 1;
        longitude_values := longitude_values[1:vertex_count];
        latitude_values := latitude_values[1:vertex_count];
      END IF;
      IF vertex_count < 3 OR vertex_count > 256 THEN RETURN false; END IF;
      IF (SELECT max(value) - min(value) FROM unnest(longitude_values) AS value) > 180 THEN RETURN false; END IF;
      FOR vertex_index IN 1..vertex_count LOOP
        previous_index := CASE WHEN vertex_index = 1 THEN vertex_count ELSE vertex_index - 1 END;
        next_index := vertex_index % vertex_count + 1;
        IF point(longitude_values[previous_index], latitude_values[previous_index])
            <@ lseg(point(longitude_values[vertex_index], latitude_values[vertex_index]),
                    point(longitude_values[next_index], latitude_values[next_index]))
            OR point(longitude_values[next_index], latitude_values[next_index])
            <@ lseg(point(longitude_values[previous_index], latitude_values[previous_index]),
                    point(longitude_values[vertex_index], latitude_values[vertex_index])) THEN RETURN false; END IF;
        FOR other_index IN (vertex_index + 1)..vertex_count LOOP
          IF point(longitude_values[vertex_index], latitude_values[vertex_index])
              ~= point(longitude_values[other_index], latitude_values[other_index]) THEN RETURN false; END IF;
          other_next_index := other_index % vertex_count + 1;
          IF next_index <> other_index AND other_next_index <> vertex_index
              AND lseg(point(longitude_values[vertex_index], latitude_values[vertex_index]),
                       point(longitude_values[next_index], latitude_values[next_index]))
              ?# lseg(point(longitude_values[other_index], latitude_values[other_index]),
                      point(longitude_values[other_next_index], latitude_values[other_next_index])) THEN RETURN false; END IF;
        END LOOP;
      END LOOP;
      inside_polygon := false;
      signed_area := 0;
      previous_index := vertex_count;
      FOR vertex_index IN 1..vertex_count LOOP
        cross_product := (point_longitude - longitude_values[previous_index])
          * (latitude_values[vertex_index] - latitude_values[previous_index])
          - (p_lat - latitude_values[previous_index])
          * (longitude_values[vertex_index] - longitude_values[previous_index]);
        IF abs(cross_product) <= 1e-12
            AND point_longitude BETWEEN least(longitude_values[vertex_index], longitude_values[previous_index]) - 1e-12
                                    AND greatest(longitude_values[vertex_index], longitude_values[previous_index]) + 1e-12
            AND p_lat BETWEEN least(latitude_values[vertex_index], latitude_values[previous_index]) - 1e-12
                          AND greatest(latitude_values[vertex_index], latitude_values[previous_index]) + 1e-12 THEN RETURN false; END IF;
        IF (latitude_values[vertex_index] > p_lat) <> (latitude_values[previous_index] > p_lat) THEN
          IF point_longitude < (longitude_values[previous_index] - longitude_values[vertex_index])
              * (p_lat - latitude_values[vertex_index]) / (latitude_values[previous_index] - latitude_values[vertex_index])
              + longitude_values[vertex_index] THEN inside_polygon := NOT inside_polygon; END IF;
        END IF;
        signed_area := signed_area + longitude_values[previous_index] * latitude_values[vertex_index]
          - longitude_values[vertex_index] * latitude_values[previous_index];
        previous_index := vertex_index;
      END LOOP;
      IF inside_polygon OR abs(signed_area) <= 1e-12 THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END
$fn$;

REVOKE ALL ON FUNCTION public.discovery_trend_position_is_clear(double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_trend_position_is_clear(double precision, double precision) TO service_role;

DO $patch$
DECLARE
  function_signature text;
  function_definition text;
  source_fragment text;
  replacement_fragment text;
  patch_row record;
  expected_row record;
  actual_hash text;
  expected_functions jsonb := '[
    {"signature":"public.discovery_trend_place_context()","before":"9690429382f8b78a78b5164361c4cf640b28e6dcc0103935e6739cc60b452177","after":"fa94c17c81b241a434931c37865002f2f201b27b5fd2b133c705e59bc2b9a9bc"},
    {"signature":"public.discovery_trend_windows_v2(timestamptz,text)","before":"0adead359d36460924c2575b7edb155a0b47d93614b83241b3acb6c1dccf7958","after":"5ab09b001ac3a45bdc020301b9ad1c010f230031be6c42f1fc7072cf6395ad59"},
    {"signature":"public.discovery_trend_post_groups_v2(timestamptz)","before":"69e7206c9d541487bbe983d6102b5a6271c730042f612b3aadfc6a546f79e989","after":"9c7a079f2dd50ae97c19e4b7d54323ae3fc7544e51a83bc3dae9719cf6401655"},
    {"signature":"public.rebuild_place_momentum(timestamptz)","before":"4ba1cbf572793b53a5f39a310819d9524ea032694b475ea946fb86dc2e9c9844","after":"725253992dfe683d1226e0db78a73eb8c099ff9ce59e12fc4392da5d5522f9f4"},
    {"signature":"public.rebuild_place_momentum_v2(timestamptz)","before":"2560f3daa9859db172bac33a54dffa5160f41dd9c6cb918ef91e6478a299b9ba","after":"8c17befe9ccd0c811ee8635d634af2d60b2fb11ad3a23499057d76bdf25c3282"}
  ]';
BEGIN
  FOR expected_row IN SELECT * FROM jsonb_to_recordset(expected_functions) AS expected(signature text, "before" text, "after" text) LOOP
    IF to_regprocedure(expected_row.signature) IS NULL THEN
      RAISE EXCEPTION '3988 requires %', expected_row.signature;
    END IF;
    actual_hash := encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(expected_row.signature)), 'UTF8')), 'hex');
    IF actual_hash NOT IN (expected_row."before", expected_row."after") THEN
      RAISE EXCEPTION '3988 refuses unreviewed definition for %', expected_row.signature;
    END IF;
  END LOOP;
  FOR patch_row IN SELECT * FROM (VALUES
    ('public.discovery_trend_place_context()',
     E'FROM public.discovery_places dp\n',
     E'FROM public.discovery_places dp\n     WHERE public.discovery_trend_position_is_clear(dp.lat, dp.lng)\n'),
    ('public.discovery_trend_windows_v2(timestamptz,text)',
     '      LEFT JOIN ctx x ON x.cpk = lower(regexp_replace(r.item_id, ''^db/'', ''''))',
     '      JOIN ctx x ON x.cpk = lower(regexp_replace(r.item_id, ''^db/'', ''''))'),
    ('public.discovery_trend_post_groups_v2(timestamptz)',
     '      LEFT JOIN ctx x ON x.cpk = lower(regexp_replace(r.item_id, ''^db/'', ''''))',
     '      JOIN ctx x ON x.cpk = lower(regexp_replace(r.item_id, ''^db/'', ''''))'),
    ('public.rebuild_place_momentum(timestamptz)',
     'WITH base AS (',
     'WITH eligible AS MATERIALIZED (SELECT place_key FROM public.discovery_trend_place_context()), base AS ('),
    ('public.rebuild_place_momentum(timestamptz)',
     'WHERE surface = c_surface',
     'WHERE surface = c_surface AND EXISTS (SELECT 1 FROM eligible WHERE place_key = lower(regexp_replace(item_id, ''^db/'', '''')))'),
    ('public.rebuild_place_momentum(timestamptz)',
     '''discovery-row-activity-v2''',
     '''discovery-row-activity-v2+protected-contributions-v1'''),
    ('public.rebuild_place_momentum_v2(timestamptz)',
     '''discovery-exposure-activity-v3''',
     '''discovery-exposure-activity-v3+protected-contributions-v1'''),
    ('public.rebuild_place_momentum_v2(timestamptz)',
     '''discovery-exposure-activity-v3+post-after-visit-v1''',
     '''discovery-exposure-activity-v3+post-after-visit-v1+protected-contributions-v1''')
  ) AS patches(signature, source, replacement) LOOP
    function_signature := patch_row.signature;
    source_fragment := patch_row.source;
    replacement_fragment := patch_row.replacement;
    IF to_regprocedure(function_signature) IS NULL THEN
      RAISE EXCEPTION '3988 requires %', function_signature;
    END IF;
    function_definition := pg_get_functiondef(to_regprocedure(function_signature));
    IF position(replacement_fragment IN function_definition) > 0 THEN CONTINUE; END IF;
    IF (length(function_definition) - length(replace(function_definition, source_fragment, ''))) / length(source_fragment) <> 1 THEN
      RAISE EXCEPTION '3988 refuses unexpected definition for %', function_signature;
    END IF;
    EXECUTE replace(function_definition, source_fragment, replacement_fragment);
  END LOOP;
  FOR expected_row IN SELECT * FROM jsonb_to_recordset(expected_functions) AS expected(signature text, "before" text, "after" text) LOOP
    actual_hash := encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(expected_row.signature)), 'UTF8')), 'hex');
    IF actual_hash IS DISTINCT FROM expected_row."after" THEN
      RAISE EXCEPTION '3988 postcondition failed for %', expected_row.signature;
    END IF;
  END LOOP;
  IF position('memory_resurfacing_preferences' IN pg_get_functiondef('public.discovery_trend_post_groups_v2(timestamptz)'::regprocedure)) = 0
      OR position('memory_corrections' IN pg_get_functiondef('public.discovery_trend_post_groups_v2(timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '3988 requires 3726 owner controls and latest-place correction';
  END IF;
END
$patch$;

REVOKE ALL ON FUNCTION public.discovery_trend_place_context(), public.discovery_trend_windows_v2(timestamptz,text),
  public.discovery_trend_post_groups_v2(timestamptz), public.rebuild_place_momentum(timestamptz),
  public.rebuild_place_momentum_v2(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_trend_place_context(), public.discovery_trend_windows_v2(timestamptz,text),
  public.discovery_trend_post_groups_v2(timestamptz), public.rebuild_place_momentum(timestamptz),
  public.rebuild_place_momentum_v2(timestamptz) TO service_role;

COMMIT;
