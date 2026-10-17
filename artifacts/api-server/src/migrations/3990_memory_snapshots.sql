BEGIN;

CREATE SCHEMA IF NOT EXISTS memory_snapshot_private;
REVOKE ALL ON SCHEMA memory_snapshot_private FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.feature_flags(flag, enabled, description) VALUES
  ('memory_snapshots_enabled', false, 'Owner-only versioned Memory fact/evidence capture and replay. Requires memory_kernel_enabled and verified migration 3990. Purge remains available while disabled.')
ON CONFLICT (flag) DO NOTHING;

CREATE OR REPLACE FUNCTION memory_snapshot_private.enabled()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  PERFORM flag FROM public.feature_flags WHERE flag IN ('memory_snapshots_enabled', 'memory_kernel_enabled') ORDER BY flag FOR SHARE NOWAIT;
  RETURN (SELECT count(*) = 2 AND bool_and(enabled IS TRUE) FROM public.feature_flags
    WHERE flag IN ('memory_snapshots_enabled', 'memory_kernel_enabled'));
END;
$fn$;
REVOKE ALL ON FUNCTION memory_snapshot_private.enabled() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION memory_snapshot_private.capture_provenance(p_provenance jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT CASE WHEN jsonb_typeof(origin) = 'string' AND origin <> '""'::jsonb
    THEN origin #>> '{}' ELSE 'unknown' END
  FROM (SELECT coalesce(nullif(p_provenance->'captureProvenance', 'null'::jsonb),
    nullif(p_provenance->'capture_provenance', 'null'::jsonb), nullif(p_provenance->'origin', 'null'::jsonb)) AS origin) selected;
$fn$;
REVOKE ALL ON FUNCTION memory_snapshot_private.capture_provenance(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION memory_snapshot_private.canonical_json(p_value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $fn$
DECLARE encoded text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || memory_snapshot_private.canonical_json(value),
        ',' ORDER BY key COLLATE "C"), '') || '}' INTO encoded FROM jsonb_each(p_value);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(memory_snapshot_private.canonical_json(value), ',' ORDER BY ordinal), '') || ']'
        INTO encoded FROM jsonb_array_elements(p_value) WITH ORDINALITY elements(value, ordinal);
    WHEN 'number' THEN encoded := trim_scale(p_value::text::numeric)::text;
    ELSE encoded := p_value::text;
  END CASE;
  RETURN encoded;
END;
$fn$;
REVOKE ALL ON FUNCTION memory_snapshot_private.canonical_json(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.memory_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  revision bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  source_version text NOT NULL,
  source_token text NOT NULL CHECK (source_token ~ '^[a-f0-9]{64}$'),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  engine_versions jsonb NOT NULL CHECK (jsonb_typeof(engine_versions) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 2000000),
  source_evidence_ids uuid[] NOT NULL,
  source_episode_ids uuid[] NOT NULL,
  source_media_ids uuid[] NOT NULL,
  captured_at timestamptz NOT NULL,
  UNIQUE (owner_id, memory_id, source_token, schema_version, engine_versions)
);

ALTER TABLE public.memory_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_snapshots_owner_read ON public.memory_snapshots;
CREATE POLICY memory_snapshots_owner_read ON public.memory_snapshots
  FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
REVOKE ALL ON TABLE public.memory_snapshots FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.memory_snapshots_revision_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX IF NOT EXISTS memory_snapshots_memory_idx ON public.memory_snapshots (memory_id, owner_id, revision);
CREATE INDEX IF NOT EXISTS memory_snapshots_evidence_idx ON public.memory_snapshots USING gin (source_evidence_ids);
CREATE INDEX IF NOT EXISTS memory_snapshots_episode_idx ON public.memory_snapshots USING gin (source_episode_ids);
CREATE INDEX IF NOT EXISTS memory_snapshots_media_idx ON public.memory_snapshots USING gin (source_media_ids);

CREATE OR REPLACE FUNCTION memory_snapshot_private.refuse_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION 'Memory snapshots are immutable' USING ERRCODE = '23001';
END;
$fn$;
REVOKE ALL ON FUNCTION memory_snapshot_private.refuse_update() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS memory_snapshots_immutable ON public.memory_snapshots;
CREATE TRIGGER memory_snapshots_immutable BEFORE UPDATE ON public.memory_snapshots
  FOR EACH ROW EXECUTE FUNCTION memory_snapshot_private.refuse_update();

CREATE OR REPLACE FUNCTION memory_snapshot_private.prepare(p_owner_id uuid, p_memory_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  memory_row public.memories%ROWTYPE;
  episode_ids uuid[];
  evidence_ids uuid[];
  media_ids uuid[];
  captures jsonb;
  source jsonb;
  source_refs jsonb;
  cursor_value text;
BEGIN
  IF NOT memory_snapshot_private.enabled() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'feature_disabled');
  END IF;
  PERFORM id FROM auth.users WHERE id = p_owner_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  SELECT * INTO memory_row FROM public.memories
    WHERE id = p_memory_id AND owner_id = p_owner_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR memory_row.state IS NULL OR memory_row.state NOT IN ('draft', 'published', 'archived') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT coalesce(array_agg(DISTINCT episode_id ORDER BY episode_id), '{}'::uuid[]) INTO episode_ids
    FROM public.memory_evidence WHERE user_id = p_owner_id AND source_table = 'memories' AND source_id = p_memory_id::text;
  PERFORM id FROM public.memory_evidence WHERE episode_id = ANY(episode_ids) ORDER BY id FOR SHARE NOWAIT;
  IF EXISTS (SELECT 1 FROM unnest(episode_ids) linked(episode_id) WHERE NOT EXISTS (
    SELECT 1 FROM public.memory_evidence evidence WHERE evidence.episode_id = linked.episode_id
      AND evidence.user_id = p_owner_id AND evidence.source_table = 'memories' AND evidence.source_id = p_memory_id::text)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict');
  END IF;
  PERFORM id FROM public.memory_episodes WHERE id = ANY(episode_ids) ORDER BY id FOR SHARE NOWAIT;
  PERFORM policy.retention_class FROM public.memory_policy policy
    WHERE policy.retention_class IN (SELECT retention_class FROM public.memory_episodes WHERE id = ANY(episode_ids))
    ORDER BY policy.retention_class FOR SHARE NOWAIT;
  IF (SELECT count(*) FROM public.memory_episodes WHERE id = ANY(episode_ids)) <> cardinality(episode_ids)
    OR EXISTS (SELECT 1 FROM public.memory_episodes episode
    LEFT JOIN public.memory_policy policy USING (retention_class)
    WHERE episode.id = ANY(episode_ids) AND (episode.user_id <> p_owner_id
      OR episode.state NOT IN ('confirmed', 'active', 'archived') OR policy.retention_class IS NULL
      OR policy.ttl IS NOT NULL OR policy.deletion_behavior <> 'erase_with_account')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
  END IF;
  IF EXISTS (SELECT 1 FROM public.memory_evidence WHERE episode_id = ANY(episode_ids)
    AND (user_id <> p_owner_id OR NOT (source_table = 'media_assets'
      OR (source_table = 'memories' AND source_id = p_memory_id::text)))) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
  END IF;
  IF EXISTS (SELECT 1 FROM public.memory_evidence WHERE episode_id = ANY(episode_ids)
    AND source_table = 'media_assets' AND source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
  END IF;
  SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO evidence_ids
    FROM public.memory_evidence WHERE episode_id = ANY(episode_ids);
  SELECT coalesce(array_agg(DISTINCT source_id::uuid ORDER BY source_id::uuid), '{}'::uuid[]) INTO media_ids
    FROM public.memory_evidence WHERE episode_id = ANY(episode_ids) AND source_table = 'media_assets';
  IF cardinality(media_ids) > 500 OR cardinality(evidence_ids) > 1000 OR cardinality(episode_ids) > 1000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
  END IF;
  PERFORM id FROM public.media_assets WHERE id = ANY(media_ids) ORDER BY id FOR SHARE NOWAIT;
  IF (SELECT count(*) FROM public.media_assets WHERE id = ANY(media_ids)
    AND owner_user_id = p_owner_id AND deleted_at IS NULL AND processing_status = 'ready'
    AND moderation_status IN ('approved', 'active', 'pending', 'processing')
    AND coalesce(source_type, 'user') = 'user' AND captured_at IS NOT NULL
    AND memory_snapshot_private.capture_provenance(provenance) NOT IN ('screenshot', 'downloaded', 'imported_without_capture')) <> cardinality(media_ids) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'owner_user_id', owner_user_id, 'media_type', media_type, 'captured_at', captured_at,
    'provenance', jsonb_strip_nulls(jsonb_build_object('captureProvenance', provenance->'captureProvenance',
      'capture_provenance', provenance->'capture_provenance', 'origin', provenance->'origin'))
  ) ORDER BY id), '[]'::jsonb) INTO captures FROM public.media_assets WHERE id = ANY(media_ids);
  SELECT max(sequence)::text INTO cursor_value FROM public.memory_domain_events WHERE memory_id = p_memory_id;
  source := jsonb_build_object(
    'memory_id', p_memory_id, 'owner_id', p_owner_id, 'source_version', memory_row.updated_at::text,
    'command_cursor', cursor_value, 'trip_id', memory_row.trip_id, 'captures', captures,
    'facts', jsonb_build_object('title', memory_row.title, 'caption', memory_row.caption, 'original_language', 'und',
      'starts_at', memory_row.starts_at, 'ends_at', memory_row.ends_at, 'place_id', memory_row.place_id,
      'location_city', memory_row.location_city, 'location_country', memory_row.location_country),
    'detector_context', jsonb_build_object('visited_place_ids', '[]'::jsonb, 'user_splits', '[]'::jsonb,
      'user_merges', '[]'::jsonb, 'thresholds', '{}'::jsonb),
    'eligibility_context', jsonb_build_object('mode', 'USER_INITIATED', 'suppressed_classes', '[]'::jsonb)
  );
  source_refs := jsonb_build_object('evidence_ids', evidence_ids, 'episode_ids', episode_ids, 'media_ids', media_ids);
  source := source || jsonb_build_object('source_token', encode(sha256(convert_to((source || source_refs)::text, 'UTF8')), 'hex'),
    'captured_at', statement_timestamp());
  RETURN jsonb_build_object('ok', true, 'value', source, 'references', source_refs);
EXCEPTION WHEN lock_not_available THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
END;
$fn$;
REVOKE ALL ON FUNCTION memory_snapshot_private.prepare(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.memory_snapshot_prepare_v1(p_owner_id uuid, p_memory_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT memory_snapshot_private.prepare(p_owner_id, p_memory_id) - 'references';
$fn$;
REVOKE ALL ON FUNCTION public.memory_snapshot_prepare_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.memory_snapshot_prepare_v1(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.memory_snapshot_append_v1(p_owner_id uuid, p_memory_id uuid, p_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  prepared jsonb;
  source jsonb;
  expected_source jsonb;
  stored public.memory_snapshots%ROWTYPE;
BEGIN
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' OR octet_length(p_snapshot::text) > 2000000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict');
  END IF;
  prepared := memory_snapshot_private.prepare(p_owner_id, p_memory_id);
  IF prepared->'ok' <> 'true'::jsonb THEN RETURN prepared - 'references'; END IF;
  source := p_snapshot->'source';
  expected_source := prepared->'value';
  IF NOT (p_snapshot ?& ARRAY['schema_version', 'engine_versions', 'source', 'content_hash'])
    OR p_snapshot - ARRAY['schema_version', 'engine_versions', 'source', 'content_hash'] <> '{}'::jsonb
    OR p_snapshot->'schema_version' IS DISTINCT FROM '1'::jsonb
    OR p_snapshot->'engine_versions' IS DISTINCT FROM '{"normalizer":"memory-evidence-normalizer@1","eligibility":"memory-eligibility@1","detector":"memory-episode-detector@1"}'::jsonb
    OR (source - 'signals' - 'captured_at') IS DISTINCT FROM (expected_source - 'captures' - 'trip_id' - 'captured_at')
    OR jsonb_typeof(source->'signals') IS DISTINCT FROM 'array'
    OR jsonb_typeof(source->'captured_at') IS DISTINCT FROM 'string'
    OR coalesce(source->>'captured_at', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    OR jsonb_typeof(p_snapshot->'content_hash') IS DISTINCT FROM 'string'
    OR coalesce(p_snapshot->>'content_hash', '') !~ '^[a-f0-9]{64}$'
    OR octet_length(p_snapshot::text) > 2000000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict');
  END IF;
  IF (source->>'captured_at')::timestamptz > statement_timestamp()
    OR (source->>'captured_at')::timestamptz < statement_timestamp() - interval '5 minutes'
    OR jsonb_array_length(source->'signals') <> jsonb_array_length(expected_source->'captures')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(source->'signals') signal
      WHERE signal->>'owner_id' IS DISTINCT FROM p_owner_id::text
        OR signal->>'source_type' IS DISTINCT FROM 'CAMERA_CAPTURE'
        OR signal->>'assertion_type' IS DISTINCT FROM 'CAPTURED_MEDIA'
        OR NOT (prepared->'references'->'media_ids' ? (signal->>'source_id')))
    OR (SELECT count(DISTINCT signal->>'source_id') FROM jsonb_array_elements(source->'signals') signal)
      <> jsonb_array_length(source->'signals') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(source->'signals') signal
    JOIN public.media_assets media ON media.id::text = signal->>'source_id'
    WHERE signal IS DISTINCT FROM jsonb_build_object(
      'owner_id', p_owner_id, 'source_type', 'CAMERA_CAPTURE', 'source_id', media.id,
      'assertion_type', 'CAPTURED_MEDIA', 'observed_at', media.captured_at,
      'confidence', 0.7, 'provenance_json', jsonb_build_object('table', 'media_assets', 'id', media.id),
      'assertion_json', jsonb_build_object('trip_id', expected_source->'trip_id', 'media_type', media.media_type,
        'capture_provenance', memory_snapshot_private.capture_provenance(media.provenance)))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict');
  END IF;
  IF source->'signals' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(signal ORDER BY memory_snapshot_private.canonical_json(signal) COLLATE "C"), '[]'::jsonb)
      FROM jsonb_array_elements(source->'signals') signal)
    OR p_snapshot->>'content_hash' IS DISTINCT FROM encode(sha256(convert_to(
      memory_snapshot_private.canonical_json(p_snapshot - 'content_hash'), 'UTF8')), 'hex') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict');
  END IF;
  INSERT INTO public.memory_snapshots(owner_id, memory_id, source_version, source_token, schema_version,
    engine_versions, content_hash, snapshot, source_evidence_ids, source_episode_ids, source_media_ids, captured_at)
  VALUES (p_owner_id, p_memory_id, source->>'source_version', source->>'source_token', 1,
    p_snapshot->'engine_versions', p_snapshot->>'content_hash', p_snapshot,
    ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(prepared->'references'->'evidence_ids')),
    ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(prepared->'references'->'episode_ids')),
    ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(prepared->'references'->'media_ids')),
    (source->>'captured_at')::timestamptz)
  ON CONFLICT (owner_id, memory_id, source_token, schema_version, engine_versions) DO NOTHING;
  SELECT * INTO stored FROM public.memory_snapshots WHERE owner_id = p_owner_id AND memory_id = p_memory_id
    AND source_token = source->>'source_token' AND schema_version = 1 AND engine_versions = p_snapshot->'engine_versions';
  RETURN jsonb_build_object('ok', true, 'value', jsonb_build_object('id', stored.id, 'revision', stored.revision::text, 'snapshot', stored.snapshot));
END;
$fn$;
REVOKE ALL ON FUNCTION public.memory_snapshot_append_v1(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.memory_snapshot_append_v1(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.memory_snapshot_read_v1(p_owner_id uuid, p_memory_id uuid, p_snapshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE stored public.memory_snapshots%ROWTYPE;
BEGIN
  IF NOT memory_snapshot_private.enabled() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'feature_disabled');
  END IF;
  PERFORM id FROM auth.users WHERE id = p_owner_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  PERFORM id FROM public.memories WHERE id = p_memory_id AND owner_id = p_owner_id
    AND state IN ('draft', 'published', 'archived') FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  SELECT * INTO stored FROM public.memory_snapshots WHERE id = p_snapshot_id AND memory_id = p_memory_id AND owner_id = p_owner_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  PERFORM id FROM public.memory_evidence WHERE id = ANY(stored.source_evidence_ids) ORDER BY id FOR SHARE NOWAIT;
  PERFORM id FROM public.memory_episodes WHERE id = ANY(stored.source_episode_ids) ORDER BY id FOR SHARE NOWAIT;
  PERFORM policy.retention_class FROM public.memory_policy policy
    WHERE policy.retention_class IN (SELECT retention_class FROM public.memory_episodes WHERE id = ANY(stored.source_episode_ids))
    ORDER BY policy.retention_class FOR SHARE NOWAIT;
  PERFORM id FROM public.media_assets WHERE id = ANY(stored.source_media_ids) ORDER BY id FOR SHARE NOWAIT;
  IF (SELECT count(*) FROM public.memory_episodes episode JOIN public.memory_policy policy USING (retention_class)
      WHERE episode.id = ANY(stored.source_episode_ids) AND episode.user_id = p_owner_id
        AND episode.state IN ('confirmed', 'active', 'archived') AND policy.ttl IS NULL
        AND policy.deletion_behavior = 'erase_with_account') <> cardinality(stored.source_episode_ids)
    OR (SELECT count(*) FROM public.memory_evidence WHERE id = ANY(stored.source_evidence_ids) AND user_id = p_owner_id)
      <> cardinality(stored.source_evidence_ids)
    OR (SELECT count(*) FROM public.media_assets WHERE id = ANY(stored.source_media_ids) AND owner_user_id = p_owner_id
      AND deleted_at IS NULL AND processing_status = 'ready' AND moderation_status IN ('approved','active','pending','processing')
      AND coalesce(source_type, 'user') = 'user' AND captured_at IS NOT NULL
      AND memory_snapshot_private.capture_provenance(provenance) NOT IN ('screenshot', 'downloaded', 'imported_without_capture')) <> cardinality(stored.source_media_ids)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(stored.snapshot->'source'->'signals') signal
      JOIN public.media_assets media ON media.id::text = signal->>'source_id'
      WHERE media.captured_at IS DISTINCT FROM (signal->>'observed_at')::timestamptz
        OR media.media_type IS DISTINCT FROM signal->'assertion_json'->>'media_type'
        OR memory_snapshot_private.capture_provenance(media.provenance) IS DISTINCT FROM signal->'assertion_json'->>'capture_provenance') THEN
    PERFORM id FROM public.memory_snapshots WHERE id = p_snapshot_id AND owner_id = p_owner_id FOR UPDATE NOWAIT;
    DELETE FROM public.memory_snapshots WHERE id = p_snapshot_id AND owner_id = p_owner_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT * INTO stored FROM public.memory_snapshots WHERE id = p_snapshot_id AND memory_id = p_memory_id AND owner_id = p_owner_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'value', jsonb_build_object('id', stored.id, 'revision', stored.revision::text, 'snapshot', stored.snapshot));
EXCEPTION WHEN lock_not_available THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
END;
$fn$;
REVOKE ALL ON FUNCTION public.memory_snapshot_read_v1(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.memory_snapshot_read_v1(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.memory_snapshot_purge_v1(p_owner_id uuid, p_memory_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE purged integer;
BEGIN
  PERFORM id FROM public.memories WHERE id = p_memory_id AND owner_id = p_owner_id AND state IN ('deleted','removed') FOR UPDATE;
  IF NOT FOUND AND EXISTS (SELECT 1 FROM public.memories WHERE id = p_memory_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  DELETE FROM public.memory_snapshots WHERE memory_id = p_memory_id AND owner_id = p_owner_id;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'value', jsonb_build_object('purged', purged));
END;
$fn$;
REVOKE ALL ON FUNCTION public.memory_snapshot_purge_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.memory_snapshot_purge_v1(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION memory_snapshot_private.revoke_sources()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'memories' THEN
    IF NEW.state IS NULL OR NEW.state NOT IN ('draft','published','archived') OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
      DELETE FROM public.memory_snapshots WHERE memory_id = OLD.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'media_assets' THEN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM public.memory_snapshots WHERE source_media_ids @> ARRAY[OLD.id];
    ELSIF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.deleted_at IS NOT NULL
      OR NEW.captured_at IS NULL OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
      OR NEW.media_type IS DISTINCT FROM OLD.media_type
      OR memory_snapshot_private.capture_provenance(NEW.provenance) IS DISTINCT FROM memory_snapshot_private.capture_provenance(OLD.provenance)
      OR memory_snapshot_private.capture_provenance(NEW.provenance) IN ('screenshot', 'downloaded', 'imported_without_capture')
      OR NEW.processing_status IS DISTINCT FROM 'ready' OR NEW.moderation_status IS NULL
      OR NEW.moderation_status NOT IN ('approved','active','pending','processing') OR coalesce(NEW.source_type,'user') <> 'user' THEN
      DELETE FROM public.memory_snapshots WHERE source_media_ids @> ARRAY[OLD.id];
    END IF;
  ELSIF TG_TABLE_NAME = 'memory_evidence' THEN
    DELETE FROM public.memory_snapshots WHERE source_evidence_ids @> ARRAY[OLD.id];
  ELSIF TG_TABLE_NAME = 'memory_episodes' THEN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM public.memory_snapshots WHERE source_episode_ids @> ARRAY[OLD.id];
    ELSIF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
      OR NEW.state NOT IN ('confirmed','active','archived') THEN
      DELETE FROM public.memory_snapshots WHERE source_episode_ids @> ARRAY[OLD.id];
    END IF;
  ELSIF TG_TABLE_NAME = 'memory_policy' THEN
    DELETE FROM public.memory_snapshots snapshot USING public.memory_episodes episode
      WHERE episode.retention_class = OLD.retention_class AND snapshot.source_episode_ids @> ARRAY[episode.id];
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION memory_snapshot_private.revoke_sources() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS memory_snapshots_memory_revoked ON public.memories;
CREATE TRIGGER memory_snapshots_memory_revoked AFTER UPDATE OF state, owner_id ON public.memories
  FOR EACH ROW EXECUTE FUNCTION memory_snapshot_private.revoke_sources();
DROP TRIGGER IF EXISTS memory_snapshots_media_revoked ON public.media_assets;
CREATE TRIGGER memory_snapshots_media_revoked AFTER UPDATE OR DELETE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION memory_snapshot_private.revoke_sources();
DROP TRIGGER IF EXISTS memory_snapshots_evidence_revoked ON public.memory_evidence;
CREATE TRIGGER memory_snapshots_evidence_revoked AFTER UPDATE OR DELETE ON public.memory_evidence
  FOR EACH ROW EXECUTE FUNCTION memory_snapshot_private.revoke_sources();
DROP TRIGGER IF EXISTS memory_snapshots_episode_revoked ON public.memory_episodes;
CREATE TRIGGER memory_snapshots_episode_revoked AFTER UPDATE OR DELETE ON public.memory_episodes
  FOR EACH ROW EXECUTE FUNCTION memory_snapshot_private.revoke_sources();
DROP TRIGGER IF EXISTS memory_snapshots_policy_revoked ON public.memory_policy;
CREATE TRIGGER memory_snapshots_policy_revoked AFTER UPDATE OR DELETE ON public.memory_policy
  FOR EACH ROW EXECUTE FUNCTION memory_snapshot_private.revoke_sources();

COMMIT;
