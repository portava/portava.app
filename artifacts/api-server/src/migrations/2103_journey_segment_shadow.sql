-- 2103_journey_segment_shadow.sql
-- Shadow-only movement/stop/dwell segment revisions.
--
-- No Compass, Sense, Autopilot, Social, Outcome, or Graph table references this
-- table. Exact coordinates and raw observation IDs are deliberately impossible
-- to store in this schema. location_session_id is not an FK yet because the
-- repository contains incompatible legacy session schemas; the restricted
-- worker must freshly verify consent/session ownership before calling the RPC.

CREATE TABLE IF NOT EXISTS journey_segment_revisions (
  id                    uuid PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  location_session_id   uuid NOT NULL,
  segment_key           uuid NOT NULL,
  supersedes_id         uuid REFERENCES journey_segment_revisions(id) ON DELETE SET NULL,
  revision_index        integer NOT NULL CHECK (revision_index >= 0),
  state                 text NOT NULL CHECK (
    state IN ('moving', 'candidate_stop', 'dwelling', 'departed', 'discarded')
  ),
  started_at            timestamptz NOT NULL,
  ended_at              timestamptz,
  duration_s            integer CHECK (duration_s IS NULL OR duration_s >= 0),
  world_ref             jsonb NOT NULL DEFAULT
    '{"countryCode":null,"regionId":null,"cityId":null,"districtId":null,"placeId":null}'::jsonb,
  movement_class        text NOT NULL CHECK (
    movement_class IN ('unknown', 'walking', 'vehicle', 'transit')
  ),
  uncertainty_score     numeric(4,3) NOT NULL CHECK (
    uncertainty_score >= 0 AND uncertainty_score <= 1
  ),
  uncertainty_tier      text NOT NULL CHECK (
    uncertainty_tier IN ('low', 'medium', 'high')
  ),
  reason_codes          text[] NOT NULL,
  median_accuracy_m     numeric CHECK (median_accuracy_m IS NULL OR median_accuracy_m > 0),
  max_gap_seconds       numeric CHECK (max_gap_seconds IS NULL OR max_gap_seconds >= 0),
  stop_radius_m         numeric NOT NULL CHECK (stop_radius_m > 0),
  uncertainty_computed_at timestamptz NOT NULL,
  algorithm_version     text NOT NULL CHECK (length(algorithm_version) BETWEEN 1 AND 100),
  observation_count     integer NOT NULL CHECK (observation_count >= 1),
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journey_segment_time_order CHECK (
    ended_at IS NULL OR ended_at >= started_at
  ),
  CONSTRAINT journey_segment_world_ref_object CHECK (
    jsonb_typeof(world_ref) = 'object'
  ),
  CONSTRAINT journey_segment_world_ref_keys CHECK (
    (
      world_ref - ARRAY['countryCode', 'regionId', 'cityId', 'districtId', 'placeId']::text[]
    ) = '{}'::jsonb
  ),
  CONSTRAINT journey_segment_world_ref_required_keys CHECK (
    world_ref ?& ARRAY['countryCode', 'regionId', 'cityId', 'districtId', 'placeId']::text[]
  ),
  CONSTRAINT journey_segment_world_ref_value_shapes CHECK (
    (
      (world_ref->'countryCode' = 'null'::jsonb) OR
      (
        jsonb_typeof(world_ref->'countryCode') = 'string' AND
        (world_ref->>'countryCode') ~ '^[A-Z]{2}$'
      )
    ) AND
    (
      (world_ref->'regionId' = 'null'::jsonb) OR
      (
        jsonb_typeof(world_ref->'regionId') = 'string' AND
        (world_ref->>'regionId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    ) AND
    (
      (world_ref->'cityId' = 'null'::jsonb) OR
      (
        jsonb_typeof(world_ref->'cityId') = 'string' AND
        (world_ref->>'cityId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    ) AND
    (
      (world_ref->'districtId' = 'null'::jsonb) OR
      (
        jsonb_typeof(world_ref->'districtId') = 'string' AND
        (world_ref->>'districtId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    ) AND
    (
      (world_ref->'placeId' = 'null'::jsonb) OR
      (
        jsonb_typeof(world_ref->'placeId') = 'string' AND
        (world_ref->>'placeId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    )
  ),
  CONSTRAINT journey_segment_reason_codes_known CHECK (
    cardinality(reason_codes) > 0 AND reason_codes <@ ARRAY[
      'candidate_not_confirmed',
      'candidate_threshold_met',
      'confirmed_dwell_departure',
      'continuous_sampling',
      'discarded_evidence',
      'dwell_closed_before_gap',
      'dwell_threshold_met',
      'enough_samples',
      'good_accuracy',
      'insufficient_continuity',
      'limited_samples',
      'long_gap',
      'low_accuracy',
      'moderate_accuracy',
      'movement_observed',
      'outside_departure_radius',
      'segment_closed',
      'session_ended',
      'short_pause',
      'single_sample',
      'sparse_sampling',
      'within_stop_radius'
    ]::text[]
  ),
  CONSTRAINT journey_segment_retention_cap CHECK (
    expires_at <= created_at + interval '30 days'
  ),
  UNIQUE (segment_key, algorithm_version, revision_index)
);

CREATE INDEX IF NOT EXISTS journey_segment_user_session_idx
  ON journey_segment_revisions (user_id, location_session_id, segment_key, revision_index DESC);
CREATE INDEX IF NOT EXISTS journey_segment_expires_idx
  ON journey_segment_revisions (expires_at);

ALTER TABLE journey_segment_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE journey_segment_revisions FORCE ROW LEVEL SECURITY;

-- No authenticated policy: owners cannot query sensitive behavioral segments
-- through PostgREST. Only the service-role shadow worker/purge may access them.
REVOKE ALL ON TABLE journey_segment_revisions FROM anon, authenticated, service_role;
-- INSERT is RPC-only so every write repeats fresh flags, consent, ownership,
-- session, and payload validation. SELECT supports private shadow analysis;
-- DELETE supports retention, revocation, and account erasure.
GRANT SELECT, DELETE ON TABLE journey_segment_revisions TO service_role;

CREATE OR REPLACE FUNCTION append_journey_segment_revisions(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  inserted_count integer;
  row_user_id uuid;
  row_session_id uuid;
  session_started_at timestamptz;
  session_expires_at timestamptz;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS row
    WHERE jsonb_typeof(row) <> 'object'
  ) THEN
    RAISE EXCEPTION 'every journey segment row must be an object';
  END IF;

  SELECT (row->>'user_id')::uuid, (row->>'location_session_id')::uuid
  INTO row_user_id, row_session_id
  FROM jsonb_array_elements(p_rows) AS row
  LIMIT 1;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS row
    WHERE (row->>'user_id')::uuid <> row_user_id
       OR (row->>'location_session_id')::uuid <> row_session_id
  ) THEN
    RAISE EXCEPTION 'one append batch must belong to one user and session';
  END IF;

  -- Serialize appends against consent revocation/account deletion cleanup.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || row_user_id::text, 0)
  );

  -- Lock every control row before evaluating it. Admin flag changes then
  -- serialize with this append: a stop/disable that has committed can never be
  -- followed by a write authorized from a stale flag snapshot.
  PERFORM flag
    FROM feature_flags
    WHERE flag IN (
      'COMPASS_JOURNEY_ENGINE_ENABLED',
      'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
      'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED',
      'disable_location_sharing'
    )
    ORDER BY flag
    FOR SHARE;

  IF (
    SELECT count(*)
    FROM feature_flags
    WHERE flag IN (
      'COMPASS_JOURNEY_ENGINE_ENABLED',
      'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
      'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'
    )
      AND enabled = true
  ) <> 3 THEN
    RAISE EXCEPTION 'journey shadow disabled' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM feature_flags
    WHERE flag = 'disable_location_sharing'
      AND enabled = true
  ) THEN
    RAISE EXCEPTION 'journey shadow disabled' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM user_location_preferences p
    WHERE p.user_id = row_user_id
      AND p.journey_observation_enabled = true
      AND COALESCE(p.sharing_paused, false) = false
      AND p.location_mode::text IN ('live_during_activity', 'trusted_circle_live')
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journey authorization required' USING ERRCODE = '42501';
  END IF;

  SELECT
    s.started_at,
    NULLIF(to_jsonb(s)->>'expires_at', '')::timestamptz
  INTO session_started_at, session_expires_at
    FROM location_sessions s
    WHERE s.id = row_session_id
      AND s.user_id = row_user_id
      AND s.ended_at IS NULL
      AND (
        NULLIF(to_jsonb(s)->>'expires_at', '') IS NULL OR
        (to_jsonb(s)->>'expires_at')::timestamptz > now()
      )
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journey authorization required' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS row
    WHERE (
      row - ARRAY[
        'id', 'user_id', 'location_session_id', 'segment_key',
        'supersedes_id', 'revision_index', 'state', 'started_at',
        'ended_at', 'duration_s', 'world_ref', 'movement_class',
        'uncertainty_score', 'uncertainty_tier', 'reason_codes',
        'median_accuracy_m', 'max_gap_seconds', 'stop_radius_m',
        'uncertainty_computed_at', 'algorithm_version',
        'observation_count', 'expires_at'
      ]::text[]
    ) <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'unsupported journey segment field';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS row
    WHERE jsonb_typeof(row->'world_ref') <> 'object'
       OR jsonb_typeof(row->'reason_codes') <> 'array'
       OR (row->>'started_at')::timestamptz < session_started_at
       OR (row->>'started_at')::timestamptz > now() + interval '5 minutes'
       OR (
         NULLIF(row->>'ended_at', '') IS NOT NULL AND
         (row->>'ended_at')::timestamptz > now() + interval '5 minutes'
       )
       OR (
         session_expires_at IS NOT NULL AND
         (
           (row->>'started_at')::timestamptz > session_expires_at OR
           (
             NULLIF(row->>'ended_at', '') IS NOT NULL AND
             (row->>'ended_at')::timestamptz > session_expires_at
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'journey segment is outside its authorized session';
  END IF;

  WITH inserted AS (
    INSERT INTO journey_segment_revisions (
      id,
      user_id,
      location_session_id,
      segment_key,
      supersedes_id,
      revision_index,
      state,
      started_at,
      ended_at,
      duration_s,
      world_ref,
      movement_class,
      uncertainty_score,
      uncertainty_tier,
      reason_codes,
      median_accuracy_m,
      max_gap_seconds,
      stop_radius_m,
      uncertainty_computed_at,
      algorithm_version,
      observation_count,
      expires_at
    )
    SELECT
      (row->>'id')::uuid,
      (row->>'user_id')::uuid,
      (row->>'location_session_id')::uuid,
      (row->>'segment_key')::uuid,
      NULLIF(row->>'supersedes_id', '')::uuid,
      (row->>'revision_index')::integer,
      row->>'state',
      (row->>'started_at')::timestamptz,
      NULLIF(row->>'ended_at', '')::timestamptz,
      NULLIF(row->>'duration_s', '')::integer,
      COALESCE(row->'world_ref', '{}'::jsonb),
      row->>'movement_class',
      (row->>'uncertainty_score')::numeric,
      row->>'uncertainty_tier',
      ARRAY(
        SELECT jsonb_array_elements_text(COALESCE(row->'reason_codes', '[]'::jsonb))
      ),
      NULLIF(row->>'median_accuracy_m', '')::numeric,
      NULLIF(row->>'max_gap_seconds', '')::numeric,
      (row->>'stop_radius_m')::numeric,
      (row->>'uncertainty_computed_at')::timestamptz,
      row->>'algorithm_version',
      (row->>'observation_count')::integer,
      (row->>'expires_at')::timestamptz
    FROM jsonb_array_elements(p_rows) AS row
    ON CONFLICT (id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted_count FROM inserted;

  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION append_journey_segment_revisions(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION append_journey_segment_revisions(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION delete_journey_segments_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || p_user_id::text, 0)
  );
  DELETE FROM journey_segment_revisions WHERE user_id = p_user_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION delete_journey_segments_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_journey_segments_for_user(uuid) TO service_role;

-- Apply a canonical location-consent revocation and erase every derived Journey
-- segment in one transaction. The shared advisory lock serializes this operation
-- against append_journey_segment_revisions, so a successful return means no row
-- from before or during the revocation can survive.
CREATE OR REPLACE FUNCTION revoke_journey_consent_and_delete_segments(
  p_user_id uuid,
  p_preferences jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_preferences IS NULL OR jsonb_typeof(p_preferences) <> 'object' THEN
    RAISE EXCEPTION 'p_preferences must be a JSON object';
  END IF;
  IF (
    p_preferences - ARRAY[
      'location_mode',
      'sharing_paused',
      'pulse_visibility',
      'discovery_visibility',
      'safe_return_enabled',
      'trusted_circle_share',
      'hotel_blur_enabled',
      'journey_observation_enabled'
    ]::text[]
  ) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unsupported location preference field';
  END IF;

  IF p_preferences ? 'location_mode' AND (
    jsonb_typeof(p_preferences->'location_mode') <> 'string' OR
    p_preferences->>'location_mode' NOT IN (
      'off', 'city_only', 'nearby', 'live_during_activity', 'trusted_circle_live'
    )
  ) THEN
    RAISE EXCEPTION 'invalid location_mode';
  END IF;

  IF p_preferences ? 'sharing_paused' AND
     jsonb_typeof(p_preferences->'sharing_paused') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid sharing_paused';
  END IF;
  IF p_preferences ? 'safe_return_enabled' AND
     jsonb_typeof(p_preferences->'safe_return_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid safe_return_enabled';
  END IF;
  IF p_preferences ? 'trusted_circle_share' AND
     jsonb_typeof(p_preferences->'trusted_circle_share') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid trusted_circle_share';
  END IF;
  IF p_preferences ? 'hotel_blur_enabled' AND
     jsonb_typeof(p_preferences->'hotel_blur_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid hotel_blur_enabled';
  END IF;
  IF p_preferences ? 'journey_observation_enabled' AND
     jsonb_typeof(p_preferences->'journey_observation_enabled') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid journey_observation_enabled';
  END IF;

  IF p_preferences ? 'pulse_visibility' AND
     p_preferences->'pulse_visibility' <> 'null'::jsonb AND (
       jsonb_typeof(p_preferences->'pulse_visibility') <> 'string' OR
       p_preferences->>'pulse_visibility' NOT IN (
         'city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'
       )
     ) THEN
    RAISE EXCEPTION 'invalid pulse_visibility';
  END IF;
  IF p_preferences ? 'discovery_visibility' AND
     p_preferences->'discovery_visibility' <> 'null'::jsonb AND (
       jsonb_typeof(p_preferences->'discovery_visibility') <> 'string' OR
       p_preferences->>'discovery_visibility' NOT IN (
         'city_only', 'neighborhood', 'venue_tagged', 'exact_hidden', 'no_location'
       )
     ) THEN
    RAISE EXCEPTION 'invalid discovery_visibility';
  END IF;

  IF COALESCE(p_preferences->>'location_mode', '') NOT IN ('off', 'city_only', 'nearby') AND
     COALESCE((p_preferences->>'sharing_paused')::boolean, false) = false AND
     COALESCE((p_preferences->>'journey_observation_enabled')::boolean, true) = true THEN
    RAISE EXCEPTION 'preference patch must revoke Journey consent' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('journey-segments:' || p_user_id::text, 0)
  );

  -- Delete before changing the preference row so the observation-foundation
  -- revocation trigger can independently enforce direct owner writes without
  -- consuming this RPC's deletion count. Any later preference-write failure
  -- rolls the deletion back with the transaction.
  DELETE FROM journey_segment_revisions WHERE user_id = p_user_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  INSERT INTO user_location_preferences AS current_preferences (
    user_id,
    location_mode,
    sharing_paused,
    pulse_visibility,
    discovery_visibility,
    safe_return_enabled,
    trusted_circle_share,
    hotel_blur_enabled,
    journey_observation_enabled,
    updated_at
  )
  VALUES (
    p_user_id,
    COALESCE(p_preferences->>'location_mode', 'city_only'),
    COALESCE((p_preferences->>'sharing_paused')::boolean, false),
    CASE
      WHEN p_preferences ? 'pulse_visibility' THEN p_preferences->>'pulse_visibility'
      ELSE NULL
    END,
    CASE
      WHEN p_preferences ? 'discovery_visibility' THEN p_preferences->>'discovery_visibility'
      ELSE NULL
    END,
    COALESCE((p_preferences->>'safe_return_enabled')::boolean, true),
    COALESCE((p_preferences->>'trusted_circle_share')::boolean, false),
    COALESCE((p_preferences->>'hotel_blur_enabled')::boolean, true),
    COALESCE((p_preferences->>'journey_observation_enabled')::boolean, false),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    location_mode = CASE
      WHEN p_preferences ? 'location_mode' THEN EXCLUDED.location_mode
      ELSE current_preferences.location_mode
    END,
    sharing_paused = CASE
      WHEN p_preferences ? 'sharing_paused' THEN EXCLUDED.sharing_paused
      ELSE current_preferences.sharing_paused
    END,
    pulse_visibility = CASE
      WHEN p_preferences ? 'pulse_visibility' THEN EXCLUDED.pulse_visibility
      ELSE current_preferences.pulse_visibility
    END,
    discovery_visibility = CASE
      WHEN p_preferences ? 'discovery_visibility' THEN EXCLUDED.discovery_visibility
      ELSE current_preferences.discovery_visibility
    END,
    safe_return_enabled = CASE
      WHEN p_preferences ? 'safe_return_enabled' THEN EXCLUDED.safe_return_enabled
      ELSE current_preferences.safe_return_enabled
    END,
    trusted_circle_share = CASE
      WHEN p_preferences ? 'trusted_circle_share' THEN EXCLUDED.trusted_circle_share
      ELSE current_preferences.trusted_circle_share
    END,
    hotel_blur_enabled = CASE
      WHEN p_preferences ? 'hotel_blur_enabled' THEN EXCLUDED.hotel_blur_enabled
      ELSE current_preferences.hotel_blur_enabled
    END,
    journey_observation_enabled = CASE
      WHEN p_preferences ? 'journey_observation_enabled'
        THEN EXCLUDED.journey_observation_enabled
      ELSE current_preferences.journey_observation_enabled
    END,
    updated_at = now();

  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION revoke_journey_consent_and_delete_segments(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_journey_consent_and_delete_segments(uuid, jsonb)
  TO service_role;

INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES
  (
    'COMPASS_JOURNEY_ENGINE_ENABLED',
    false,
    'Master capability gate for Journey observation and shadow segmentation paths.',
    '{"default":"off","privacy_review_required":true}'::jsonb
  ),
  (
    'COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED',
    false,
    'Accept consented Journey observations inside explicit active sessions.',
    '{"default":"off","not_enabled_by_segment_shadow":true}'::jsonb
  ),
  (
    'COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED',
    false,
    'Persist mechanical movement/stop/dwell revisions for aggregate shadow quality review only.',
    '{"default":"off","consumer_access":false}'::jsonb
  )
ON CONFLICT (flag) DO UPDATE SET
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata;
