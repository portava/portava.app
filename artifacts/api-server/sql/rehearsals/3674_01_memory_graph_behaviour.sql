-- Behavioural rehearsal for 3674-3676 (memory graph model), after 3674, 3675 and 3676. Each DO block RAISES on a failed expectation.
-- See sql/rehearsals/README.md, section "3674-3676". Never against production or the CI project.
-- Behavioural probes after 3674/3675/3676. Each DO block RAISES on a failed expectation.
CREATE OR REPLACE FUNCTION pg_temp.k(t text, mem uuid, key text, payload jsonb, actor uuid DEFAULT 'a0000000-0000-4000-8000-000000000001') RETURNS jsonb
LANGUAGE sql AS $$ SELECT public.memory_graph_kernel_execute(jsonb_build_object('command_id', gen_random_uuid(), 'actor_user_id', actor,
  'idempotency_key', key, 'type', t, 'memory_id', mem, 'payload', payload)) $$;
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.edges(mem uuid) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(target_type || ':' || target_id, ',' ORDER BY target_type, target_id), '') FROM public.memory_relations WHERE source_type='MEMORY' AND source_id = mem AND source_mode='LEGACY_IMPORTED' $$;

-- S1 a new Memory is USER_CREATED and mirrored
DO $$ BEGIN
  INSERT INTO public.memories (id, owner_id, title, visibility, state, trip_id) VALUES
   ('c0000000-0000-4000-8000-000000000009','a0000000-0000-4000-8000-000000000001','M9','friends_only','published','b0000000-0000-4000-8000-000000000002');
  PERFORM pg_temp.ck((SELECT source_mode FROM memories WHERE id='c0000000-0000-4000-8000-000000000009') = 'USER_CREATED', 'S1 new row USER_CREATED');
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000009') = 'TRIP:b0000000-0000-4000-8000-000000000002', 'S1 trip mirrored');
END $$;
-- S2 consent: approve -> edge; withdraw -> gone; delete -> gone
DO $$ BEGIN
  INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES ('c0000000-0000-4000-8000-000000000009','a0000000-0000-4000-8000-000000000003','pending');
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000009') NOT LIKE '%PERSON%', 'S2 pending tag is no edge');
  UPDATE public.memory_tags SET status='approved' WHERE memory_id='c0000000-0000-4000-8000-000000000009';
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000009') LIKE '%PERSON:a0000000-0000-4000-8000-000000000003%', 'S2 approved -> edge');
  UPDATE public.memory_tags SET status='removed' WHERE memory_id='c0000000-0000-4000-8000-000000000009';
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000009') NOT LIKE '%PERSON%', 'S2 withdrawn -> edge gone');
  UPDATE public.memory_tags SET status='approved' WHERE memory_id='c0000000-0000-4000-8000-000000000009';
  DELETE FROM public.memory_tags WHERE memory_id='c0000000-0000-4000-8000-000000000009';
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000009') NOT LIKE '%PERSON%', 'S2 deleted tag -> edge gone');
END $$;
-- S3 a PATCH of trip/place re-mirrors; S4 soft delete drops legacy edges
DO $$ BEGIN
  UPDATE public.memories SET trip_id='b0000000-0000-4000-8000-000000000001', place_id='osm:9' WHERE id='c0000000-0000-4000-8000-000000000009';
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000009') = 'PLACE:osm:9,TRIP:b0000000-0000-4000-8000-000000000001', 'S3 re-mirrored: ' || pg_temp.edges('c0000000-0000-4000-8000-000000000009'));
  UPDATE public.memories SET state='deleted' WHERE id='c0000000-0000-4000-8000-000000000009';
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000009') = '', 'S4 soft delete drops edges');
END $$;
-- S5 merge refusals
DO $$ DECLARE v jsonb; BEGIN
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000001','r1', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000003')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_MERGE_AUDIENCE_MISMATCH', 'S5 public+only_me refused: ' || v::text);
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000003','r1b', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000001')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_MERGE_AUDIENCE_MISMATCH', 'S5 only_me+public refused (other direction)');
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000001','r2', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000006')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_AUTH_NOT_OWNER', 'S5 foreign memory refused: ' || v::text);
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000007','r3', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000008')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_MERGE_AUDIENCE_MISMATCH', 'S5 trip_crew of two trips refused');
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000001','r4', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000005')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_MERGE_AUDIENCE_MISMATCH', 'S5 draft into published refused');
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000001','r5', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000001')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_MERGE_INVALID', 'S5 survivor among absorbed');
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000001','r6', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000004')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_NOT_FOUND', 'S5 deleted absorbed');
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000001','r7', '{}'::jsonb);
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_COMMAND_MALFORMED', 'S5 no list');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_command_audit WHERE outcome='rejected' AND idempotency_key LIKE 'r%') = 8, 'S5 every refusal audited');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_domain_events), 'S5 no refusal wrote an event');
  PERFORM pg_temp.ck((SELECT count(*) FROM memories WHERE state='deleted') = 2, 'S5 nothing deleted by a refusal');
END $$;
-- S6 merge M2 into M1
DO $$ DECLARE v jsonb; BEGIN
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000001','m1', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000002')));
  PERFORM pg_temp.ck((v->>'ok')::boolean AND v->>'event_type' = 'memory.merged', 'S6 merged: ' || v::text);
  PERFORM pg_temp.ck((SELECT string_agg(id::text || '@' || position || coalesce(':' || visibility, ''), ',' ORDER BY position) FROM memory_items WHERE memory_id='c0000000-0000-4000-8000-000000000001')
    = 'e0000000-0000-4000-8000-000000000011@0,e0000000-0000-4000-8000-000000000012@1,e0000000-0000-4000-8000-000000000021@2,e0000000-0000-4000-8000-000000000022@3:only_me', 'S6 items appended, visibility kept');
  PERFORM pg_temp.ck((SELECT state FROM memories WHERE id='c0000000-0000-4000-8000-000000000002') = 'deleted', 'S6 absorbed soft-deleted');
  PERFORM pg_temp.ck((SELECT new_memory_id FROM memory_id_redirects WHERE old_memory_id='c0000000-0000-4000-8000-000000000002') = 'c0000000-0000-4000-8000-000000000001', 'S6 redirect');
  PERFORM pg_temp.ck((SELECT status FROM memory_tags WHERE memory_id='c0000000-0000-4000-8000-000000000001' AND tagged_user_id='a0000000-0000-4000-8000-000000000003') = 'removed', 'S6 least consent: removed wins over approved');
  PERFORM pg_temp.ck((SELECT status FROM memory_tags WHERE memory_id='c0000000-0000-4000-8000-000000000001' AND tagged_user_id='a0000000-0000-4000-8000-000000000004') = 'pending', 'S6 least consent: pending survives over approved');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_tags WHERE memory_id='c0000000-0000-4000-8000-000000000002'), 'S6 absorbed tags gone');
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000001') = 'PLACE:d0000000-0000-4000-8000-000000000001,TRIP:b0000000-0000-4000-8000-000000000001', 'S6 survivor edges: no person without approval: ' || pg_temp.edges('c0000000-0000-4000-8000-000000000001'));
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000002') = '', 'S6 absorbed edges gone');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_likes WHERE memory_id='c0000000-0000-4000-8000-000000000001') = 1, 'S6 likes deduplicated');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_saves WHERE memory_id='c0000000-0000-4000-8000-000000000001') = 1, 'S6 save moved');
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_resurfacing_preferences WHERE memory_id='c0000000-0000-4000-8000-000000000001' AND control='DO_NOT_RESURFACE'), 'S6 control carried (union)');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_domain_events WHERE memory_id='c0000000-0000-4000-8000-000000000001' AND type='memory.merged') = 1, 'S6 one event');
  PERFORM pg_temp.ck((SELECT string_agg(source_id, ',') FROM memory_evidence WHERE source_table='memories') = 'c0000000-0000-4000-8000-000000000001', 'S6 candidate link re-pointed to the survivor');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_evidence WHERE episode_id='f0000000-0000-4000-8000-000000000001') = 2, 'S6 captures untouched');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_event_outbox WHERE memory_id='c0000000-0000-4000-8000-000000000001') = 1, 'S6 outbox');
  PERFORM pg_temp.ck(NOT (SELECT payload_json::text FROM memory_domain_events WHERE memory_id='c0000000-0000-4000-8000-000000000001') ~ '(M1|M2|osm:|u2[12])', 'S6 event payload carries no content');
END $$;
-- S7 replay and S8 key reuse
DO $$ DECLARE v jsonb; BEGIN
  v := pg_temp.k('MERGE_MEMORY','c0000000-0000-4000-8000-000000000001','m1', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000002')));
  PERFORM pg_temp.ck((v->>'duplicate')::boolean AND v->'result'->'moved'->>'items' = '2', 'S7 replay returns the original: ' || v::text);
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_domain_events) = 1, 'S7 replay wrote no event');
  v := pg_temp.k('SPLIT_MEMORY','c0000000-0000-4000-8000-000000000001','m1', jsonb_build_object('item_ids', jsonb_build_array('e0000000-0000-4000-8000-000000000021')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_IDEMPOTENCY_KEY_REUSED', 'S8 key reuse refused');
END $$;
-- S9/S10 split
DO $$ DECLARE v jsonb; n uuid; BEGIN
  v := pg_temp.k('SPLIT_MEMORY','c0000000-0000-4000-8000-000000000001','s0', jsonb_build_object('item_ids', jsonb_build_array('e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000012','e0000000-0000-4000-8000-000000000021','e0000000-0000-4000-8000-000000000022')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_SPLIT_INVALID', 'S10 split of every item refused: ' || v::text);
  v := pg_temp.k('SPLIT_MEMORY','c0000000-0000-4000-8000-000000000001','s0b', jsonb_build_object('item_ids', jsonb_build_array('e0000000-0000-4000-8000-000000000031')));
  PERFORM pg_temp.ck(v->>'reason' = 'MEMORY_ITEM_NOT_FOUND', 'S10 another Memory''s item refused');
  v := pg_temp.k('SPLIT_MEMORY','c0000000-0000-4000-8000-000000000001','s1', jsonb_build_object('item_ids', jsonb_build_array('e0000000-0000-4000-8000-000000000021','e0000000-0000-4000-8000-000000000022'), 'title', 'Second half'));
  PERFORM pg_temp.ck((v->>'ok')::boolean, 'S9 split ok: ' || v::text);
  n := (v->'result'->>'new_memory_id')::uuid;
  PERFORM pg_temp.ck((SELECT row(owner_id, visibility, allowed_user_ids, hidden_user_ids, trip_id, place_id, canonical_location_id, state, location_precision)::text FROM memories WHERE id = n)
                   = (SELECT row(owner_id, visibility, allowed_user_ids, hidden_user_ids, trip_id, place_id, canonical_location_id, state, location_precision)::text FROM memories WHERE id = 'c0000000-0000-4000-8000-000000000001'), 'S9 new Memory has the source''s audience, place and precision');
  PERFORM pg_temp.ck((SELECT location_precision FROM memories WHERE id = n) = 'city', 'S9 precision NOT widened to the column default');
  PERFORM pg_temp.ck((SELECT title || '/' || source_mode FROM memories WHERE id = n) = 'Second half/USER_CREATED', 'S9 title + USER_CREATED');
  PERFORM pg_temp.ck((SELECT string_agg(id::text, ',' ORDER BY id) FROM memory_items WHERE memory_id = n) = 'e0000000-0000-4000-8000-000000000021,e0000000-0000-4000-8000-000000000022', 'S9 items moved');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_items WHERE memory_id = 'c0000000-0000-4000-8000-000000000001') = 2, 'S9 source keeps the rest');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_tags WHERE memory_id = n), 'S9 no person copied');
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_corrections WHERE memory_id = n AND kind='reject' AND place_id='osm:bad'), 'S9 negative constraint carried');
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_resurfacing_preferences WHERE memory_id = n AND control='DO_NOT_RESURFACE'), 'S9 control carried');
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_relations WHERE source_id = n AND target_type='MEMORY' AND target_id='c0000000-0000-4000-8000-000000000001' AND relation_type='DERIVED_FROM' AND source_mode='USER_CREATED'), 'S9 lineage edge');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_domain_events WHERE type='memory.split') = 2, 'S9 split event on both streams');
  PERFORM pg_temp.ck(pg_temp.edges(n) = 'PLACE:d0000000-0000-4000-8000-000000000001,TRIP:b0000000-0000-4000-8000-000000000001', 'S9 new Memory mirrored');
  -- S11 merge the source INTO the new one: the earlier redirect (M2 -> M1) is repointed to n.
  v := pg_temp.k('MERGE_MEMORY', n, 'm2', jsonb_build_object('absorbed_memory_ids', jsonb_build_array('c0000000-0000-4000-8000-000000000001')));
  PERFORM pg_temp.ck((v->>'ok')::boolean, 'S11 merge back: ' || v::text);
  PERFORM pg_temp.ck((SELECT new_memory_id FROM memory_id_redirects WHERE old_memory_id='c0000000-0000-4000-8000-000000000002') = n, 'S11 path compressed: one hop');
  PERFORM pg_temp.ck((SELECT new_memory_id FROM memory_id_redirects WHERE old_memory_id='c0000000-0000-4000-8000-000000000001') = n, 'S11 M1 redirects');
  PERFORM pg_temp.ck((SELECT count(*) FROM memory_items WHERE memory_id = n) = 4, 'S11 every item accounted for after merge/split/merge');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_relations WHERE target_type='MEMORY' AND target_id='c0000000-0000-4000-8000-000000000001' AND source_mode='LEGACY_IMPORTED'), 'S11 sanity');
END $$;
-- S13 an episode's relations go with it
DO $$ BEGIN
  INSERT INTO public.memory_relations (owner_id, source_type, source_id, target_type, target_id, relation_type)
    VALUES ('a0000000-0000-4000-8000-000000000001','EPISODE','f0000000-0000-4000-8000-000000000001','PLACE','osm:1','RELATED');
  DELETE FROM public.memory_evidence WHERE episode_id='f0000000-0000-4000-8000-000000000001';
  DELETE FROM public.memory_episodes WHERE id='f0000000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_relations WHERE source_type='EPISODE'), 'S13 episode relations erased');
END $$;
-- S14 the mirror's INSERT half failing never fails the legacy write, and never keeps an edge it should remove
CREATE OR REPLACE FUNCTION public.zz_sabotage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sabotaged insert'; END $$;
CREATE TRIGGER zz_sabotage BEFORE INSERT ON public.memory_relations FOR EACH ROW EXECUTE FUNCTION public.zz_sabotage();
DO $$ BEGIN
  INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES ('c0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000004','approved');
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_tags WHERE memory_id='c0000000-0000-4000-8000-000000000007' AND tagged_user_id='a0000000-0000-4000-8000-000000000004'), 'S14 the legacy tag write succeeded although the mirror insert failed');
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000007') NOT LIKE '%PERSON%', 'S14 (the edge was not written: drift the shadow counts)');
END $$;
DROP TRIGGER zz_sabotage ON public.memory_relations;
DO $$ BEGIN
  PERFORM public.memory_graph_mirror_memory('c0000000-0000-4000-8000-000000000007');
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000007') LIKE '%PERSON:a0000000-0000-4000-8000-000000000004%', 'S14 setup: edge exists');
END $$;
CREATE TRIGGER zz_sabotage BEFORE INSERT ON public.memory_relations FOR EACH ROW EXECUTE FUNCTION public.zz_sabotage();
DO $$ BEGIN
  UPDATE public.memory_tags SET status = 'removed' WHERE memory_id='c0000000-0000-4000-8000-000000000007' AND tagged_user_id='a0000000-0000-4000-8000-000000000004';
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000007') NOT LIKE '%PERSON%', 'S14 consent withdrawn: the edge is removed even while the mirror cannot insert');
  UPDATE public.memories SET state = 'deleted' WHERE id = 'c0000000-0000-4000-8000-000000000007';
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000007') = '', 'S14 soft delete removes the edges even while the mirror cannot insert');
END $$;
DROP TRIGGER zz_sabotage ON public.memory_relations;
DROP FUNCTION public.zz_sabotage();
-- S15 the REMOVAL half is never swallowed: if an edge cannot be removed, the write that should remove it FAILS (fail closed)
CREATE OR REPLACE FUNCTION public.zz_sabotage_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sabotaged delete'; END $$;
CREATE TRIGGER zz_sabotage_delete BEFORE DELETE ON public.memory_relations FOR EACH ROW EXECUTE FUNCTION public.zz_sabotage_delete();
DO $$ DECLARE refused boolean := false; BEGIN
  BEGIN
    UPDATE public.memories SET state = 'deleted' WHERE id = 'c0000000-0000-4000-8000-000000000003' OR id = 'c0000000-0000-4000-8000-000000000008';
  EXCEPTION WHEN OTHERS THEN refused := true;
  END;
  PERFORM pg_temp.ck(refused, 'S15 a soft delete whose edges cannot be removed is refused, not silently left behind');
  PERFORM pg_temp.ck((SELECT state FROM memories WHERE id = 'c0000000-0000-4000-8000-000000000008') = 'published', 'S15 nothing half-applied');
END $$;
DROP TRIGGER zz_sabotage_delete ON public.memory_relations;
DROP FUNCTION public.zz_sabotage_delete();
-- S12 account deletion, as AccountDeletionService does it: tags by tagged_user_id, then the
-- owner's Memories by owner_id, with the profiles row KEPT (a tombstone: no profiles cascade fires).
DO $$ BEGIN
  INSERT INTO public.memory_tags (memory_id, tagged_user_id, status)
    SELECT id, 'a0000000-0000-4000-8000-000000000002', 'approved' FROM memories WHERE id='c0000000-0000-4000-8000-000000000008';
  PERFORM pg_temp.ck(pg_temp.edges('c0000000-0000-4000-8000-000000000008') LIKE '%PERSON:a0000000-0000-4000-8000-000000000002%', 'S12 setup');
  DELETE FROM public.memory_tags WHERE tagged_user_id = 'a0000000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_relations WHERE target_id='a0000000-0000-4000-8000-000000000002'), 'S12 a deleted person is named by no edge');
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM memory_relations WHERE owner_id='a0000000-0000-4000-8000-000000000001' AND source_mode='USER_CREATED'), 'S12 setup: lineage edge present');
  DELETE FROM public.memories WHERE owner_id = 'a0000000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM profiles WHERE id='a0000000-0000-4000-8000-000000000001'), 'S12 the profile tombstone is kept');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_relations WHERE owner_id='a0000000-0000-4000-8000-000000000001'), 'S12 owner deletion leaves no relation (no profiles cascade needed)');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM memory_id_redirects), 'S12 owner deletion leaves no redirect');
  DELETE FROM auth.users WHERE id IN ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002');
END $$;
