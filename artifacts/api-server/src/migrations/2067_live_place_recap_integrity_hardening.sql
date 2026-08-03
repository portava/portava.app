-- Phase 3 hardening: lifecycle RPCs must not trust route-supplied recap
-- evidence. Validate canonical parent/place/source identity inside the same
-- transaction that creates an immutable version.

CREATE OR REPLACE FUNCTION validate_live_place_recap_evidence(
  p_owner_id UUID,
  p_place_day_id UUID,
  p_moment_id UUID,
  p_place_id UUID,
  p_place_snapshot JSONB,
  p_sources JSONB,
  p_chapters JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_place_day place_days;
  v_moment shared_moments;
  v_moment_place_id UUID;
  v_source_count INT;
  v_creator_source_count INT;
  v_bad_sources INT;
  v_bad_chapters INT;
BEGIN
  IF jsonb_typeof(p_place_snapshot) <> 'object'
     OR p_place_snapshot->>'id' IS DISTINCT FROM p_place_id::text THEN
    RAISE EXCEPTION 'place snapshot must identify recap place';
  END IF;
  IF jsonb_typeof(p_sources) <> 'array' OR jsonb_typeof(p_chapters) <> 'array' THEN
    RAISE EXCEPTION 'recap evidence must use source and chapter arrays';
  END IF;
  SELECT count(*) INTO v_source_count FROM jsonb_array_elements(p_sources);
  IF v_source_count = 0 THEN RAISE EXCEPTION 'at least one eligible source is required'; END IF;

  IF p_place_day_id IS NOT NULL THEN
    SELECT * INTO v_place_day FROM place_days
      WHERE id = p_place_day_id AND place_id = p_place_id AND status IN ('closing', 'archived')
      FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'eligible place day required'; END IF;

    SELECT count(*) INTO v_bad_sources
    FROM jsonb_array_elements(p_sources) AS source(item)
    LEFT JOIN posts post ON post.id = NULLIF(source.item->>'id', '')::uuid
    WHERE source.item->>'type' <> 'place_day_post'
       OR NULLIF(source.item->>'postId', '')::uuid IS DISTINCT FROM post.id
       OR NULLIF(source.item->>'contributorId', '')::uuid IS DISTINCT FROM post.author_id
       OR post.canonical_place_id IS DISTINCT FROM p_place_id
       OR post.created_at < (v_place_day.local_date::timestamp AT TIME ZONE v_place_day.timezone)
       OR post.created_at >= ((v_place_day.local_date + 1)::timestamp AT TIME ZONE v_place_day.timezone)
       OR post.visibility <> 'public'
       OR post.status <> 'active'
       OR (post.post_status IS NOT NULL AND post.post_status <> 'published')
       OR (post.publish_at IS NOT NULL AND post.publish_at > now());
    IF v_bad_sources > 0 THEN RAISE EXCEPTION 'invalid place day recap source'; END IF;

    SELECT count(*) INTO v_creator_source_count
    FROM jsonb_array_elements(p_sources) AS source(item)
    JOIN posts post ON post.id = NULLIF(source.item->>'id', '')::uuid
    WHERE post.author_id = p_owner_id;
    IF v_creator_source_count = 0 THEN
      RAISE EXCEPTION 'recap owner needs eligible place day activity';
    END IF;
  ELSE
    SELECT * INTO v_moment FROM shared_moments
      WHERE id = p_moment_id AND owner_id = p_owner_id AND status = 'archived'
      FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'eligible archived moment required'; END IF;
    v_moment_place_id := v_moment.place_id;
    IF v_moment_place_id IS NULL AND v_moment.place_day_id IS NOT NULL THEN
      SELECT place_id INTO v_moment_place_id FROM place_days WHERE id = v_moment.place_day_id FOR SHARE;
    END IF;
    IF v_moment_place_id IS DISTINCT FROM p_place_id THEN
      RAISE EXCEPTION 'shared moment place does not match recap place';
    END IF;

    SELECT count(*) INTO v_bad_sources
    FROM jsonb_array_elements(p_sources) AS source(item)
    LEFT JOIN shared_moment_contributions contribution
      ON contribution.id = NULLIF(source.item->>'id', '')::uuid
    LEFT JOIN posts post ON post.id = contribution.post_id
    WHERE source.item->>'type' <> 'moment_contribution'
       OR contribution.moment_id IS DISTINCT FROM p_moment_id
       OR contribution.status <> 'approved'
       OR NULLIF(source.item->>'postId', '')::uuid IS DISTINCT FROM contribution.post_id
       OR NULLIF(source.item->>'contributorId', '')::uuid IS DISTINCT FROM contribution.contributor_id
       OR (post.id IS NOT NULL AND (
            post.visibility <> 'public'
            OR post.status <> 'active'
            OR (post.post_status IS NOT NULL AND post.post_status <> 'published')
            OR (post.publish_at IS NOT NULL AND post.publish_at > now())
          ));
    IF v_bad_sources > 0 THEN RAISE EXCEPTION 'invalid shared moment recap source'; END IF;
  END IF;

  SELECT count(*) INTO v_bad_chapters
  FROM jsonb_array_elements(p_chapters) AS chapter(item)
  WHERE jsonb_typeof(chapter.item->'sourceIds') <> 'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(chapter.item->'sourceIds') AS chapter_source(source_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_sources) AS source(item)
         WHERE source.item->>'id' = chapter_source.source_id
       )
     );
  IF v_bad_chapters > 0 THEN RAISE EXCEPTION 'chapter references an unknown source'; END IF;
END $$;

CREATE OR REPLACE FUNCTION create_live_place_recap(
  p_owner_id UUID, p_place_day_id UUID, p_moment_id UUID, p_place_id UUID, p_title TEXT,
  p_source_hash TEXT, p_place_snapshot JSONB, p_sources JSONB DEFAULT '[]', p_chapters JSONB DEFAULT '[]'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recap live_place_recaps; v_version live_place_recap_versions;
BEGIN
  IF ((p_place_day_id IS NULL)::int + (p_moment_id IS NULL)::int) <> 1 THEN
    RAISE EXCEPTION 'exactly one recap parent is required';
  END IF;
  PERFORM validate_live_place_recap_evidence(
    p_owner_id, p_place_day_id, p_moment_id, p_place_id, p_place_snapshot, p_sources, p_chapters
  );
  INSERT INTO live_place_recaps (owner_id, place_day_id, moment_id, place_id)
    VALUES (p_owner_id, p_place_day_id, p_moment_id, p_place_id) RETURNING * INTO v_recap;
  INSERT INTO live_place_recap_versions (recap_id, version_number, title, source_hash, place_snapshot)
    VALUES (v_recap.id, 1, COALESCE(p_title, ''), p_source_hash, p_place_snapshot) RETURNING * INTO v_version;
  PERFORM recap_write_evidence(v_version.id, p_place_id, p_place_snapshot, p_sources, p_chapters);
  UPDATE live_place_recaps SET current_version_id = v_version.id, updated_at = now()
    WHERE id = v_recap.id RETURNING * INTO v_recap;
  RETURN jsonb_build_object('recap', to_jsonb(v_recap), 'version', to_jsonb(v_version));
END $$;

CREATE OR REPLACE FUNCTION regenerate_live_place_recap(
  p_recap_id UUID, p_owner_id UUID, p_source_hash TEXT, p_place_snapshot JSONB,
  p_sources JSONB DEFAULT '[]', p_chapters JSONB DEFAULT '[]'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recap live_place_recaps; v_prior live_place_recap_versions; v_version live_place_recap_versions;
BEGIN
  SELECT * INTO v_recap FROM live_place_recaps
    WHERE id = p_recap_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND OR v_recap.status = 'removed' THEN RAISE EXCEPTION 'recap unavailable'; END IF;
  SELECT * INTO v_prior FROM live_place_recap_versions
    WHERE id = v_recap.current_version_id AND recap_id = v_recap.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'current version unavailable'; END IF;
  PERFORM validate_live_place_recap_evidence(
    p_owner_id, v_recap.place_day_id, v_recap.moment_id, v_recap.place_id,
    p_place_snapshot, p_sources, p_chapters
  );
  INSERT INTO live_place_recap_versions
    (recap_id, version_number, title, summary, source_hash, place_snapshot, regenerates_version_id)
    SELECT v_recap.id, COALESCE(MAX(version_number), 0) + 1, v_prior.title, '',
      p_source_hash, p_place_snapshot, v_prior.id
    FROM live_place_recap_versions WHERE recap_id = v_recap.id RETURNING * INTO v_version;
  PERFORM recap_write_evidence(v_version.id, v_recap.place_id, p_place_snapshot, p_sources, p_chapters);
  UPDATE live_place_recaps SET current_version_id = v_version.id, status = 'draft', updated_at = now()
    WHERE id = v_recap.id RETURNING * INTO v_recap;
  RETURN jsonb_build_object('recap', to_jsonb(v_recap), 'version', to_jsonb(v_version));
END $$;

CREATE OR REPLACE FUNCTION transition_live_place_recap(p_recap_id UUID, p_owner_id UUID, p_action TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recap live_place_recaps; v_version live_place_recap_versions; v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_recap FROM live_place_recaps WHERE id = p_recap_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recap unavailable'; END IF;
  SELECT * INTO v_version FROM live_place_recap_versions
    WHERE id = v_recap.current_version_id AND recap_id = v_recap.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'current version unavailable'; END IF;
  IF p_action = 'review' AND v_version.status = 'draft' THEN
    UPDATE live_place_recap_versions SET status = 'reviewed', reviewed_at = v_now, reviewed_by = p_owner_id
      WHERE id = v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status = 'reviewed', updated_at = v_now
      WHERE id = v_recap.id RETURNING * INTO v_recap;
  ELSIF p_action = 'publish' AND v_version.status = 'reviewed' THEN
    UPDATE live_place_recap_versions SET status = 'published', published_at = v_now, published_by = p_owner_id
      WHERE id = v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status = 'published', updated_at = v_now
      WHERE id = v_recap.id RETURNING * INTO v_recap;
  ELSIF p_action = 'archive' AND v_recap.status IN ('draft', 'reviewed', 'published', 'restored') THEN
    UPDATE live_place_recap_versions SET status = 'archived' WHERE id = v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status = 'archived', archived_at = v_now, archived_by = p_owner_id, updated_at = v_now
      WHERE id = v_recap.id RETURNING * INTO v_recap;
  ELSIF p_action = 'restore' AND v_recap.status = 'archived'
    AND v_version.status = 'archived' AND v_version.published_at IS NOT NULL THEN
    UPDATE live_place_recap_versions SET status = 'published' WHERE id = v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status = 'restored', restored_at = v_now, restored_by = p_owner_id, updated_at = v_now
      WHERE id = v_recap.id RETURNING * INTO v_recap;
  ELSIF p_action = 'remove' AND v_recap.status IN ('draft', 'reviewed', 'published', 'archived', 'restored') THEN
    UPDATE live_place_recap_versions SET status = 'removed' WHERE id = v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status = 'removed', removed_at = v_now, removed_by = p_owner_id, updated_at = v_now
      WHERE id = v_recap.id RETURNING * INTO v_recap;
  ELSE
    RAISE EXCEPTION 'invalid recap transition';
  END IF;
  RETURN jsonb_build_object('recap', to_jsonb(v_recap), 'version', to_jsonb(v_version));
END $$;

REVOKE ALL ON FUNCTION validate_live_place_recap_evidence(UUID,UUID,UUID,UUID,JSONB,JSONB,JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION create_live_place_recap(UUID,UUID,UUID,UUID,TEXT,TEXT,JSONB,JSONB,JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION regenerate_live_place_recap(UUID,UUID,TEXT,JSONB,JSONB,JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION transition_live_place_recap(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_live_place_recap(UUID,UUID,UUID,UUID,TEXT,TEXT,JSONB,JSONB,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION regenerate_live_place_recap(UUID,UUID,TEXT,JSONB,JSONB,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION transition_live_place_recap(UUID,UUID,TEXT) TO service_role;