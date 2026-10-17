BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('memory_video_segments_enabled', false, 'Owner-created logical video references; requires memory_kernel_enabled and migration 3991 lifecycle checks. No recognition or copied media.')
ON CONFLICT (flag) DO NOTHING;

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.media_assets'::regclass
    AND tgname = 'media_assets_version_bump' AND tgenabled IN ('O', 'A')) THEN
    RAISE EXCEPTION '3991 requires the 3320 canonical asset revision trigger';
  END IF;
  PERFORM deleted_at, duration_ms, version FROM public.media_assets LIMIT 0;
  PERFORM id, memory_id, media_url FROM public.memory_items LIMIT 0;
  PERFORM id, owner_id, state FROM public.memories LIMIT 0;
END
$pre$;

CREATE SCHEMA IF NOT EXISTS memory_video_segments_private;
REVOKE ALL ON SCHEMA memory_video_segments_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA memory_video_segments_private TO service_role;

CREATE TABLE IF NOT EXISTS public.memory_video_segment_operations (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.memory_items(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES public.media_assets(id) ON DELETE CASCADE
);

ALTER TABLE public.memory_video_segment_operations ALTER COLUMN asset_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.memory_video_segments (
  id uuid PRIMARY KEY REFERENCES public.memory_video_segment_operations(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.memory_items(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  asset_version integer NOT NULL CHECK (asset_version > 0),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  label text CHECK (label IS NULL OR (length(btrim(label)) BETWEEN 1 AND 160 AND label = btrim(label))),
  source text NOT NULL DEFAULT 'owner_asserted' CHECK (source = 'owner_asserted'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT memory_video_segment_bounds CHECK (start_ms >= 0 AND start_ms < end_ms AND end_ms <= duration_ms)
);

CREATE INDEX IF NOT EXISTS memory_video_segments_item_idx ON public.memory_video_segments (item_id, start_ms, id);
CREATE INDEX IF NOT EXISTS memory_video_segments_memory_idx ON public.memory_video_segments (memory_id);
CREATE INDEX IF NOT EXISTS memory_video_segments_owner_idx ON public.memory_video_segments (owner_id);
CREATE INDEX IF NOT EXISTS memory_video_segments_asset_idx ON public.memory_video_segments (asset_id);
CREATE INDEX IF NOT EXISTS memory_video_segment_operations_item_idx ON public.memory_video_segment_operations (item_id);
CREATE INDEX IF NOT EXISTS memory_video_segment_operations_memory_idx ON public.memory_video_segment_operations (memory_id);
CREATE INDEX IF NOT EXISTS memory_video_segment_operations_owner_idx ON public.memory_video_segment_operations (owner_id);
CREATE INDEX IF NOT EXISTS memory_video_segment_operations_asset_idx ON public.memory_video_segment_operations (asset_id);

ALTER TABLE public.memory_video_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_video_segment_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_video_segments, public.memory_video_segment_operations FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION memory_video_segments_private.erase_with_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'media_assets' THEN
    DELETE FROM public.memory_video_segments WHERE asset_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'memory_items' THEN
    IF NEW.memory_id IS DISTINCT FROM OLD.memory_id OR NEW.media_url IS DISTINCT FROM OLD.media_url THEN
      DELETE FROM public.memory_video_segments WHERE item_id = NEW.id;
    END IF;
  ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.state IS NULL OR NEW.state NOT IN ('draft', 'published', 'archived') THEN
    DELETE FROM public.memory_video_segment_operations WHERE memory_id = NEW.id;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION memory_video_segments_private.erase_with_source() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS memory_video_segments_asset_invalidation ON public.media_assets;
CREATE TRIGGER memory_video_segments_asset_invalidation AFTER UPDATE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION memory_video_segments_private.erase_with_source();
DROP TRIGGER IF EXISTS memory_video_segments_item_invalidation ON public.memory_items;
CREATE TRIGGER memory_video_segments_item_invalidation AFTER UPDATE ON public.memory_items
  FOR EACH ROW EXECUTE FUNCTION memory_video_segments_private.erase_with_source();
DROP TRIGGER IF EXISTS memory_video_segments_memory_invalidation ON public.memories;
CREATE TRIGGER memory_video_segments_memory_invalidation AFTER UPDATE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION memory_video_segments_private.erase_with_source();

CREATE OR REPLACE FUNCTION memory_video_segments_private.as_json(segment public.memory_video_segments)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT jsonb_build_object(
    'id', segment.id, 'memoryId', segment.memory_id, 'itemId', segment.item_id, 'ownerId', segment.owner_id,
    'assetId', segment.asset_id, 'assetVersion', segment.asset_version, 'durationMs', segment.duration_ms,
    'startMs', segment.start_ms, 'endMs', segment.end_ms, 'label', segment.label,
    'source', segment.source, 'createdAt', segment.created_at
  );
$fn$;
REVOKE ALL ON FUNCTION memory_video_segments_private.as_json(public.memory_video_segments) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION memory_video_segments_private.execute(p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  actor_id uuid;
  target_memory_id uuid;
  target_item_id uuid;
  operation text;
  source_input jsonb;
  segment_input jsonb;
  segment_id uuid;
  first_ms integer;
  last_ms integer;
  segment_label text;
  memory_row public.memories%ROWTYPE;
  item_row public.memory_items%ROWTYPE;
  asset_row public.media_assets%ROWTYPE;
  segment_row public.memory_video_segments%ROWTYPE;
  operation_row public.memory_video_segment_operations%ROWTYPE;
  result_rows jsonb;
  row_count integer;
  failure jsonb := jsonb_build_object('contractVersion', 1, 'ok', false);
  success jsonb := jsonb_build_object('contractVersion', 1, 'ok', true);
BEGIN
  IF p_command IS NULL OR jsonb_typeof(p_command) <> 'object'
    OR p_command->'contractVersion' IS DISTINCT FROM '1'::jsonb THEN
    RETURN failure || jsonb_build_object('reason', 'invalid_payload');
  END IF;
  actor_id := (p_command->>'ownerId')::uuid;
  target_memory_id := (p_command->>'memoryId')::uuid;
  target_item_id := (p_command->>'itemId')::uuid;
  operation := p_command->>'operation';
  IF actor_id IS NULL OR target_memory_id IS NULL OR target_item_id IS NULL
    OR operation IS NULL OR operation NOT IN ('list', 'create', 'delete') THEN
    RETURN failure || jsonb_build_object('reason', 'invalid_payload');
  END IF;
  PERFORM flag FROM public.feature_flags WHERE flag IN ('memory_kernel_enabled', 'memory_video_segments_enabled')
    ORDER BY flag FOR SHARE;
  IF (SELECT count(*) FROM public.feature_flags WHERE flag IN ('memory_kernel_enabled', 'memory_video_segments_enabled') AND enabled IS TRUE) <> 2 THEN
    RETURN failure || jsonb_build_object('reason', 'disabled');
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O', 'A') AND (
    (tgrelid = 'public.media_assets'::regclass AND tgname = 'media_assets_version_bump'
      AND tgfoid = 'public.media_assets_bump_version()'::regprocedure)
    OR (tgrelid = 'public.media_assets'::regclass AND tgname = 'memory_video_segments_asset_invalidation'
      AND tgfoid = 'memory_video_segments_private.erase_with_source()'::regprocedure)
    OR (tgrelid = 'public.memory_items'::regclass AND tgname = 'memory_video_segments_item_invalidation'
      AND tgfoid = 'memory_video_segments_private.erase_with_source()'::regprocedure)
    OR (tgrelid = 'public.memories'::regclass AND tgname = 'memory_video_segments_memory_invalidation'
      AND tgfoid = 'memory_video_segments_private.erase_with_source()'::regprocedure)
  )) <> 4 OR EXISTS (
    SELECT 1 FROM pg_class WHERE oid IN ('public.memory_video_segments'::regclass, 'public.memory_video_segment_operations'::regclass)
      AND NOT relrowsecurity
  ) OR (SELECT count(*) FROM pg_constraint WHERE conrelid IN (
    'public.memory_video_segments'::regclass, 'public.memory_video_segment_operations'::regclass
  ) AND contype = 'f' AND convalidated AND confdeltype = 'c') <> 9 THEN
    RETURN failure || jsonb_build_object('reason', 'unavailable');
  END IF;
  PERFORM id FROM auth.users WHERE id = actor_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN
    RETURN failure || jsonb_build_object('reason', 'not_found');
  END IF;
  SELECT * INTO memory_row FROM public.memories WHERE id = target_memory_id FOR SHARE;
  IF NOT FOUND OR memory_row.owner_id IS DISTINCT FROM actor_id OR memory_row.state IS NULL
    OR memory_row.state NOT IN ('draft', 'published', 'archived') THEN
    RETURN failure || jsonb_build_object('reason', 'not_found');
  END IF;
  SELECT * INTO item_row FROM public.memory_items WHERE id = target_item_id FOR UPDATE;
  IF NOT FOUND OR item_row.memory_id IS DISTINCT FROM target_memory_id THEN
    RETURN failure || jsonb_build_object('reason', 'not_found');
  END IF;
  IF operation = 'delete' THEN
    segment_id := (p_command->>'segmentId')::uuid;
    IF segment_id IS NULL THEN RETURN failure || jsonb_build_object('reason', 'invalid_payload'); END IF;
    INSERT INTO public.memory_video_segment_operations (id, memory_id, item_id, owner_id)
      VALUES (segment_id, target_memory_id, target_item_id, actor_id) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO operation_row FROM public.memory_video_segment_operations WHERE id = segment_id FOR UPDATE;
    IF NOT FOUND OR operation_row.memory_id IS DISTINCT FROM target_memory_id
      OR operation_row.item_id IS DISTINCT FROM target_item_id OR operation_row.owner_id IS DISTINCT FROM actor_id THEN
      RETURN failure || jsonb_build_object('reason', 'not_found');
    END IF;
    DELETE FROM public.memory_video_segments AS stored WHERE stored.id = segment_id
      AND stored.memory_id = target_memory_id AND stored.item_id = target_item_id AND stored.owner_id = actor_id;
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RETURN success || jsonb_build_object('operation', operation, 'deleted', row_count = 1);
  END IF;
  source_input := p_command->'source';
  IF jsonb_typeof(source_input) IS DISTINCT FROM 'object'
    OR jsonb_typeof(source_input->'assetVersion') IS DISTINCT FROM 'number'
    OR jsonb_typeof(source_input->'durationMs') IS DISTINCT FROM 'number' THEN
    RETURN failure || jsonb_build_object('reason', 'invalid_payload');
  END IF;
  SELECT * INTO asset_row FROM public.media_assets WHERE id = (source_input->>'assetId')::uuid FOR SHARE;
  IF NOT FOUND OR asset_row.owner_user_id IS DISTINCT FROM actor_id OR asset_row.media_type IS DISTINCT FROM 'video'
    OR asset_row.processing_status IS DISTINCT FROM 'ready' OR asset_row.moderation_status IS NULL
    OR asset_row.moderation_status NOT IN ('active', 'approved') OR asset_row.deleted_at IS NOT NULL THEN
    RETURN failure || jsonb_build_object('reason', 'not_found');
  END IF;
  IF asset_row.duration_ms IS NULL OR asset_row.duration_ms <= 0 OR asset_row.version IS NULL OR asset_row.version <= 0 THEN
    RETURN failure || jsonb_build_object('reason', 'unavailable');
  END IF;
  IF asset_row.version IS DISTINCT FROM (source_input->>'assetVersion')::integer
    OR asset_row.duration_ms IS DISTINCT FROM (source_input->>'durationMs')::integer
    OR asset_row.storage_bucket IS DISTINCT FROM 'post-media'
    OR asset_row.storage_bucket IS DISTINCT FROM (source_input->>'storageBucket')
    OR asset_row.storage_path IS DISTINCT FROM (source_input->>'storagePath')
    OR item_row.media_url IS DISTINCT FROM (source_input->>'itemMediaUrl') THEN
    RETURN failure || jsonb_build_object('reason', 'source_changed');
  END IF;
  IF operation = 'list' THEN
    SELECT COALESCE(jsonb_agg(memory_video_segments_private.as_json(stored::public.memory_video_segments) ORDER BY stored.start_ms, stored.id), '[]'::jsonb)
      INTO result_rows FROM (
        SELECT * FROM public.memory_video_segments AS segment WHERE segment.item_id = target_item_id
          AND segment.memory_id = target_memory_id AND segment.owner_id = actor_id
          AND segment.asset_id = asset_row.id AND segment.asset_version = asset_row.version
          AND segment.duration_ms = asset_row.duration_ms ORDER BY segment.start_ms, segment.id LIMIT 101
      ) AS stored;
    RETURN success || jsonb_build_object('operation', operation, 'segments', result_rows);
  END IF;
  segment_input := p_command->'segment';
  IF jsonb_typeof(segment_input) IS DISTINCT FROM 'object'
    OR jsonb_typeof(segment_input->'startMs') IS DISTINCT FROM 'number'
    OR jsonb_typeof(segment_input->'endMs') IS DISTINCT FROM 'number'
    OR jsonb_typeof(segment_input->'assetVersion') IS DISTINCT FROM 'number'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(segment_input) AS entry(key)
      WHERE key NOT IN ('operationId', 'assetId', 'assetVersion', 'startMs', 'endMs', 'label')) THEN
    RETURN failure || jsonb_build_object('reason', 'invalid_payload');
  END IF;
  segment_id := (segment_input->>'operationId')::uuid;
  first_ms := (segment_input->>'startMs')::integer;
  last_ms := (segment_input->>'endMs')::integer;
  segment_label := segment_input->>'label';
  IF segment_id IS NULL OR (segment_input->>'assetId')::uuid IS DISTINCT FROM asset_row.id
    OR (segment_input->>'assetVersion')::integer IS DISTINCT FROM asset_row.version
    OR (segment_input ? 'label' AND jsonb_typeof(segment_input->'label') NOT IN ('null', 'string'))
    OR (segment_label IS NOT NULL AND (length(btrim(segment_label)) NOT BETWEEN 1 AND 160 OR segment_label <> btrim(segment_label))) THEN
    RETURN failure || jsonb_build_object('reason', 'invalid_payload');
  END IF;
  IF first_ms < 0 OR first_ms >= last_ms OR last_ms > asset_row.duration_ms THEN
    RETURN failure || jsonb_build_object('reason', 'invalid_bounds');
  END IF;
  IF EXISTS (SELECT 1 FROM public.memory_video_segment_operations WHERE id = segment_id) THEN
    SELECT * INTO segment_row FROM public.memory_video_segments WHERE id = segment_id;
    IF NOT FOUND OR segment_row.owner_id IS DISTINCT FROM actor_id OR segment_row.memory_id IS DISTINCT FROM target_memory_id
      OR segment_row.item_id IS DISTINCT FROM target_item_id OR segment_row.asset_id IS DISTINCT FROM asset_row.id
      OR segment_row.asset_version IS DISTINCT FROM asset_row.version OR segment_row.duration_ms IS DISTINCT FROM asset_row.duration_ms
      OR segment_row.start_ms IS DISTINCT FROM first_ms OR segment_row.end_ms IS DISTINCT FROM last_ms
      OR segment_row.label IS DISTINCT FROM segment_label THEN
      RETURN failure || jsonb_build_object('reason', 'idempotency_conflict');
    END IF;
    RETURN success || jsonb_build_object('operation', operation, 'created', false, 'segment', memory_video_segments_private.as_json(segment_row));
  END IF;
  SELECT count(*) INTO row_count FROM public.memory_video_segments AS stored WHERE stored.item_id = target_item_id;
  IF row_count >= 100 THEN RETURN failure || jsonb_build_object('reason', 'limit_reached'); END IF;
  INSERT INTO public.memory_video_segment_operations (id, memory_id, item_id, owner_id, asset_id)
    VALUES (segment_id, target_memory_id, target_item_id, actor_id, asset_row.id);
  INSERT INTO public.memory_video_segments (id, memory_id, item_id, owner_id, asset_id, asset_version, duration_ms, start_ms, end_ms, label)
    VALUES (segment_id, target_memory_id, target_item_id, actor_id, asset_row.id, asset_row.version, asset_row.duration_ms, first_ms, last_ms, segment_label)
    RETURNING * INTO segment_row;
  RETURN success || jsonb_build_object('operation', operation, 'created', true, 'segment', memory_video_segments_private.as_json(segment_row));
EXCEPTION
  WHEN lock_not_available THEN
    RETURN failure || jsonb_build_object('reason', 'unavailable');
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN failure || jsonb_build_object('reason', 'invalid_payload');
  WHEN unique_violation THEN
    RETURN failure || jsonb_build_object('reason', 'idempotency_conflict');
END
$fn$;
REVOKE ALL ON FUNCTION memory_video_segments_private.execute(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION memory_video_segments_private.execute(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.memory_video_segments_execute(p_command jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT memory_video_segments_private.execute(p_command);
$fn$;
REVOKE ALL ON FUNCTION public.memory_video_segments_execute(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.memory_video_segments_execute(jsonb) TO service_role;

DO $post$
DECLARE
  target_table text;
  target_role text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['memory_video_segments', 'memory_video_segment_operations'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || target_table)::regclass) THEN
      RAISE EXCEPTION '3991 requires RLS on %', target_table;
    END IF;
    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_table_privilege(target_role, 'public.' || target_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(target_role, 'public.' || target_table, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION '3991 permits no direct table privileges for % on %', target_role, target_table;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid IN (
    'public.memory_video_segments'::regclass, 'public.memory_video_segment_operations'::regclass
  ) AND contype = 'f' AND convalidated AND confdeltype = 'c') <> 9 THEN
    RAISE EXCEPTION '3991 requires all nine erasure cascades';
  END IF;
  IF has_function_privilege('anon', 'public.memory_video_segments_execute(jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.memory_video_segments_execute(jsonb)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.memory_video_segments_execute(jsonb)', 'EXECUTE')
    OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.memory_video_segments_execute(jsonb)'::regprocedure) THEN
    RAISE EXCEPTION '3991 requires a service-only invoker RPC';
  END IF;
END
$post$;

COMMIT;
