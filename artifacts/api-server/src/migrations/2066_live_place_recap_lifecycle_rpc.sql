-- Phase 3 lifecycle writes are transactions. Routes prepare a visibility-safe,
-- deterministic source set; these functions atomically persist its evidence.
CREATE OR REPLACE FUNCTION recap_write_evidence(
  p_version_id UUID, p_place_id UUID, p_place_snapshot JSONB, p_sources JSONB, p_chapters JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO live_place_recap_sources (version_id, source_type, source_id, post_id, contributor_id, ordinal, provenance)
  SELECT p_version_id, item->>'type', (item->>'id')::uuid, NULLIF(item->>'postId','')::uuid,
    NULLIF(item->>'contributorId','')::uuid, ordinality - 1, jsonb_build_object('createdAt', item->'createdAt')
  FROM jsonb_array_elements(p_sources) WITH ORDINALITY AS source(item, ordinality);
  INSERT INTO live_place_recap_snapshots (version_id, source_id, snapshot_kind, payload)
  VALUES (p_version_id, p_place_id, 'place', p_place_snapshot);
  INSERT INTO live_place_recap_snapshots (version_id, source_id, snapshot_kind, payload)
  SELECT p_version_id, (item->>'id')::uuid, 'post', item
  FROM jsonb_array_elements(p_sources) AS source(item);
  INSERT INTO live_place_recap_chapters (version_id, ordinal, title, body, source_ids, origin)
  SELECT p_version_id, (item->>'ordinal')::int, item->>'title', item->>'body',
    ARRAY(SELECT jsonb_array_elements_text(item->'sourceIds')::uuid), item->>'origin'
  FROM jsonb_array_elements(p_chapters) AS chapter(item);
END $$;

CREATE OR REPLACE FUNCTION create_live_place_recap(
  p_owner_id UUID, p_place_day_id UUID, p_moment_id UUID, p_place_id UUID, p_title TEXT,
  p_source_hash TEXT, p_place_snapshot JSONB, p_sources JSONB DEFAULT '[]', p_chapters JSONB DEFAULT '[]'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recap live_place_recaps; v_version live_place_recap_versions;
BEGIN
  IF ((p_place_day_id IS NULL)::int + (p_moment_id IS NULL)::int) <> 1 THEN RAISE EXCEPTION 'exactly one recap parent is required'; END IF;
  IF p_place_day_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM place_days WHERE id = p_place_day_id AND place_id = p_place_id AND status IN ('closing','archived')) THEN RAISE EXCEPTION 'eligible place day required'; END IF;
  IF p_moment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shared_moments WHERE id = p_moment_id AND owner_id = p_owner_id AND status = 'archived') THEN RAISE EXCEPTION 'eligible archived moment required'; END IF;
  INSERT INTO live_place_recaps (owner_id, place_day_id, moment_id, place_id) VALUES (p_owner_id,p_place_day_id,p_moment_id,p_place_id) RETURNING * INTO v_recap;
  INSERT INTO live_place_recap_versions (recap_id,version_number,title,source_hash,place_snapshot)
    VALUES (v_recap.id,1,COALESCE(p_title,''),p_source_hash,p_place_snapshot) RETURNING * INTO v_version;
  PERFORM recap_write_evidence(v_version.id,p_place_id,p_place_snapshot,p_sources,p_chapters);
  UPDATE live_place_recaps SET current_version_id=v_version.id, updated_at=now() WHERE id=v_recap.id RETURNING * INTO v_recap;
  RETURN jsonb_build_object('recap',to_jsonb(v_recap),'version',to_jsonb(v_version));
END $$;

CREATE OR REPLACE FUNCTION regenerate_live_place_recap(
  p_recap_id UUID, p_owner_id UUID, p_source_hash TEXT, p_place_snapshot JSONB, p_sources JSONB DEFAULT '[]', p_chapters JSONB DEFAULT '[]'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recap live_place_recaps; v_prior live_place_recap_versions; v_version live_place_recap_versions;
BEGIN
  SELECT * INTO v_recap FROM live_place_recaps WHERE id=p_recap_id AND owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND OR v_recap.status='removed' THEN RAISE EXCEPTION 'recap unavailable'; END IF;
  SELECT * INTO v_prior FROM live_place_recap_versions WHERE id=v_recap.current_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'current version unavailable'; END IF;
  INSERT INTO live_place_recap_versions (recap_id,version_number,title,summary,source_hash,place_snapshot,regenerates_version_id)
    SELECT v_recap.id, COALESCE(MAX(version_number),0)+1, v_prior.title, '', p_source_hash,p_place_snapshot,v_prior.id
    FROM live_place_recap_versions WHERE recap_id=v_recap.id RETURNING * INTO v_version;
  PERFORM recap_write_evidence(v_version.id,v_recap.place_id,p_place_snapshot,p_sources,p_chapters);
  UPDATE live_place_recaps SET current_version_id=v_version.id,status='draft',updated_at=now() WHERE id=v_recap.id RETURNING * INTO v_recap;
  RETURN jsonb_build_object('recap',to_jsonb(v_recap),'version',to_jsonb(v_version));
END $$;

CREATE OR REPLACE FUNCTION transition_live_place_recap(p_recap_id UUID, p_owner_id UUID, p_action TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recap live_place_recaps; v_version live_place_recap_versions; v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_recap FROM live_place_recaps WHERE id=p_recap_id AND owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recap unavailable'; END IF;
  SELECT * INTO v_version FROM live_place_recap_versions WHERE id=v_recap.current_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'current version unavailable'; END IF;
  IF p_action='review' AND v_version.status='draft' THEN
    UPDATE live_place_recap_versions SET status='reviewed',reviewed_at=v_now,reviewed_by=p_owner_id WHERE id=v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status='reviewed',updated_at=v_now WHERE id=v_recap.id RETURNING * INTO v_recap;
  ELSIF p_action='publish' AND v_version.status='reviewed' THEN
    UPDATE live_place_recap_versions SET status='published',published_at=v_now,published_by=p_owner_id WHERE id=v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status='published',updated_at=v_now WHERE id=v_recap.id RETURNING * INTO v_recap;
  ELSIF p_action='archive' AND v_recap.status IN ('draft','reviewed','published','restored') THEN
    UPDATE live_place_recap_versions SET status='archived' WHERE id=v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status='archived',archived_at=v_now,archived_by=p_owner_id,updated_at=v_now WHERE id=v_recap.id RETURNING * INTO v_recap;
  ELSIF p_action='restore' AND v_recap.status='archived' THEN
    UPDATE live_place_recap_versions SET status='published' WHERE id=v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status='restored',restored_at=v_now,restored_by=p_owner_id,updated_at=v_now WHERE id=v_recap.id RETURNING * INTO v_recap;
  ELSIF p_action='remove' AND v_recap.status IN ('draft','reviewed','published','archived','restored') THEN
    UPDATE live_place_recap_versions SET status='removed' WHERE id=v_version.id RETURNING * INTO v_version;
    UPDATE live_place_recaps SET status='removed',removed_at=v_now,removed_by=p_owner_id,updated_at=v_now WHERE id=v_recap.id RETURNING * INTO v_recap;
  ELSE RAISE EXCEPTION 'invalid recap transition'; END IF;
  RETURN jsonb_build_object('recap',to_jsonb(v_recap),'version',to_jsonb(v_version));
END $$;

REVOKE ALL ON FUNCTION recap_write_evidence(UUID,UUID,JSONB,JSONB,JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION create_live_place_recap(UUID,UUID,UUID,UUID,TEXT,TEXT,JSONB,JSONB,JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION regenerate_live_place_recap(UUID,UUID,TEXT,JSONB,JSONB,JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION transition_live_place_recap(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_live_place_recap(UUID,UUID,UUID,UUID,TEXT,TEXT,JSONB,JSONB,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION regenerate_live_place_recap(UUID,UUID,TEXT,JSONB,JSONB,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION transition_live_place_recap(UUID,UUID,TEXT) TO service_role;