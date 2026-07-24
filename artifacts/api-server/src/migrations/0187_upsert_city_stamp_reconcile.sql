-- Migration 0187: reconcile the upsert_city_stamp() function into the chain
-- Captures the exact live definition so the chain is authoritative.
-- No-op on the live DB (identical CREATE OR REPLACE). Idempotent.
CREATE OR REPLACE FUNCTION public.upsert_city_stamp(
  p_user_id         uuid,
  p_location_city   text,
  p_location_country text,
  p_label           text,
  p_sublabel        text,
  p_postcard_id     uuid
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_city_norm  text;
  v_key        text;
  v_catalog_id uuid;
  v_active     uuid;
  v_inserted   boolean := false;
BEGIN
  IF p_user_id IS NULL OR p_location_city IS NULL OR btrim(p_location_city) = '' THEN
    RETURN;
  END IF;
  v_city_norm := lower(btrim(p_location_city));
  BEGIN v_city_norm := unaccent(v_city_norm); EXCEPTION WHEN undefined_function THEN NULL; END;
  v_city_norm := regexp_replace(v_city_norm, '[\s_/]+', '-', 'g');
  v_city_norm := regexp_replace(v_city_norm, '[^a-z0-9-]', '', 'g');
  v_city_norm := btrim(regexp_replace(v_city_norm, '-{2,}', '-', 'g'), '-');
  IF v_city_norm = '' THEN v_city_norm := 'unknown'; END IF;
  SELECT id, active_version_id INTO v_catalog_id, v_active
  FROM universal_stamp_catalog
  WHERE stamp_type = 'city'
    AND canonical_location_key LIKE 'city:%:' || v_city_norm
    AND status <> 'archived'
  ORDER BY (country_code = 'xx') ASC, created_at ASC
  LIMIT 1;
  IF v_catalog_id IS NULL THEN
    v_key := 'city:xx:' || v_city_norm;
    INSERT INTO universal_stamp_catalog
      (canonical_location_key, stamp_type, display_name, country, country_code, city)
    VALUES
      (v_key, 'city', COALESCE(NULLIF(btrim(p_label), ''), initcap(v_city_norm)),
       COALESCE(NULLIF(btrim(p_location_country), ''), 'Unknown'), 'xx', p_location_city)
    ON CONFLICT (canonical_location_key, stamp_type) DO NOTHING;
    SELECT id, active_version_id INTO v_catalog_id, v_active
    FROM universal_stamp_catalog
    WHERE canonical_location_key = v_key AND stamp_type = 'city';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM passport_stamps
    WHERE user_id = p_user_id AND stamp_type = 'city' AND lower(city) = lower(p_location_city)
  ) THEN
    INSERT INTO passport_stamps (user_id, stamp_type, country, city, awarded_at, catalog_id, source_type)
    VALUES (p_user_id, 'city', p_location_country, p_location_city, now(), v_catalog_id, 'posts');
    v_inserted := true;
  END IF;
  IF v_inserted AND v_catalog_id IS NOT NULL THEN
    UPDATE universal_stamp_catalog SET earn_count = earn_count + 1, updated_at = now()
    WHERE id = v_catalog_id;
  END IF;
  IF v_catalog_id IS NOT NULL AND v_active IS NULL THEN
    BEGIN
      INSERT INTO stamp_generation_queue (catalog_id, status, triggered_by_action)
      SELECT v_catalog_id, 'queued', 'stamp_award'
      WHERE NOT EXISTS (
        SELECT 1 FROM stamp_generation_queue
        WHERE catalog_id = v_catalog_id AND status IN ('queued', 'generating', 'review_required')
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $function$;
