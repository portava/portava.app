-- Rehearsal for 3812 (place split + Memory re-resolution proposals), run AFTER 3812_00_seed.sql and 3812 itself, in ONE
-- session (pg_temp helpers). See sql/rehearsals/README.md, section "3812". Every `T<n> pass` NOTICE is an assertion that
-- held; a failure raises. Never against production or the CI project. It leaves both flags OFF and no proposal behind
-- except the ones T14's rollback rehearsal expects to find.

CREATE TEMP TABLE IF NOT EXISTS r3812 (k text PRIMARY KEY, v uuid);
GRANT SELECT ON r3812 TO service_role, authenticated; -- read by the steps that run AS those roles

-- Run `sql`; it must be REFUSED with an error whose text matches `pattern`.
CREATE OR REPLACE FUNCTION pg_temp.refused(label text, sql text, pattern text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~ pattern THEN
      RAISE EXCEPTION '% FAILED: refused for the wrong reason: %', label, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION '% FAILED: was not refused: %', label, sql;
END $f$;

-- A well-formed evidence object for two candidates.
CREATE OR REPLACE FUNCTION pg_temp.ev(reason text, a uuid, b uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('rule', 'h72-v1', 'bound_m', 75, 'reason', reason, 'candidates',
    jsonb_build_array(jsonb_build_object('place_id', a, 'within_bound', true, 'name_match', true),
                      jsonb_build_object('place_id', b, 'within_bound', false, 'name_match', false)))
$f$;

-- T1 the merge/unmerge history survives and the widened CHECK admits split, nothing else.
DO $t$
BEGIN
  IF (SELECT count(*) FROM public.place_merge_log WHERE id IN ('a3812000-0000-4000-8000-000000000001', 'a3812000-0000-4000-8000-000000000002')) <> 2 THEN
    RAISE EXCEPTION 'T1 FAILED: the merge/unmerge history did not survive';
  END IF;
  PERFORM pg_temp.refused('T1', $$INSERT INTO public.place_merge_log (action, survivor_place_id, affected_place_id) VALUES ('rename', gen_random_uuid(), gen_random_uuid())$$, 'place_merge_log_action_check');
  RAISE NOTICE 'T1 pass: history kept; split admitted by name, rename refused';
END $t$;

-- T2 flags OFF: place_split refuses (its own check), writes nothing. As the API's service role.
SET ROLE service_role;
DO $t$
DECLARE r jsonb;
BEGIN
  r := public.place_split('f3812000-0000-4000-8000-000000000001', '{"name":"Bar B","normalized_name":"bar b","latitude":10,"longitude":106.000912}', '{}', 'e3812000-0000-4000-8000-0000000000ad');
  IF r->>'outcome' <> 'disabled' THEN RAISE EXCEPTION 'T2 FAILED: %', r; END IF;
  IF (SELECT count(*) FROM public.places) <> 3 OR EXISTS (SELECT 1 FROM public.place_merge_log WHERE action = 'split') THEN
    RAISE EXCEPTION 'T2 FAILED: something was written while the flags were off';
  END IF;
  RAISE NOTICE 'T2 pass: flags off -> disabled, nothing written';
END $t$;
RESET ROLE;

UPDATE public.feature_flags SET enabled = true WHERE flag IN ('memory_place_split_reresolution_enabled', 'external_places_enabled');
-- T2b ONE flag on is not enough.
UPDATE public.feature_flags SET enabled = false WHERE flag = 'external_places_enabled';
DO $t$
BEGIN
  IF public.place_split('f3812000-0000-4000-8000-000000000001', '{"name":"Bar B","latitude":10,"longitude":106.000912}', '{}', NULL)->>'outcome' <> 'disabled' THEN
    RAISE EXCEPTION 'T2b FAILED: split ran with external_places_enabled off';
  END IF;
  RAISE NOTICE 'T2b pass: external_places_enabled off -> disabled';
END $t$;
UPDATE public.feature_flags SET enabled = true WHERE flag = 'external_places_enabled';

-- T3 the split: P kept, P2 created from the admin's name and position, descriptive fields copied, ONE named reference
--    moved, ONE log row; refusals write nothing.
SET ROLE service_role;
DO $t$
DECLARE r jsonb; v_new uuid; v_split uuid;
BEGIN
  IF public.place_split('f3812000-0000-4000-8000-0000000000ff', '{"name":"X","latitude":10,"longitude":106}', '{}', NULL)->>'outcome' <> 'not_found'
     OR public.place_split('f3812000-0000-4000-8000-0000000000d1', '{"name":"X","latitude":10,"longitude":106}', '{}', NULL)->>'outcome' <> 'merged'
     OR public.place_split('f3812000-0000-4000-8000-000000000001', '{"name":"X","latitude":10,"longitude":106}', '{e3812000-0000-4000-8000-0000000000c1}', NULL)->>'outcome' <> 'reference_not_on_place'
     OR public.place_split('f3812000-0000-4000-8000-000000000001', '{"name":"X","latitude":"10","longitude":106}', '{}', NULL)->>'outcome' <> 'invalid'
     OR public.place_split('f3812000-0000-4000-8000-000000000001', '{"name":"  ","latitude":10,"longitude":106}', '{}', NULL)->>'outcome' <> 'invalid'
     OR public.place_split('f3812000-0000-4000-8000-000000000001', '{"name":"X","latitude":91,"longitude":106}', '{}', NULL)->>'outcome' <> 'invalid' THEN
    RAISE EXCEPTION 'T3 FAILED: a refusal answered the wrong outcome';
  END IF;
  IF (SELECT count(*) FROM public.places) <> 3 OR EXISTS (SELECT 1 FROM public.place_merge_log WHERE action = 'split') THEN
    RAISE EXCEPTION 'T3 FAILED: a refused split wrote something';
  END IF;
  r := public.place_split('f3812000-0000-4000-8000-000000000001',
         '{"name":" Bar B ","normalized_name":"bar b","latitude":10,"longitude":106.000912,"primary_category":"bar"}',
         '{e3812000-0000-4000-8000-0000000000b1}', 'e3812000-0000-4000-8000-0000000000ad');
  IF r->>'outcome' <> 'split' OR (r->>'references_moved')::int <> 1 THEN RAISE EXCEPTION 'T3 FAILED: %', r; END IF;
  v_new := (r->>'new_place_id')::uuid; v_split := (r->>'split_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.places WHERE id = v_new AND name = 'Bar B' AND normalized_name = 'bar b' AND primary_category = 'bar'
                   AND latitude = 10 AND longitude = 106.000912 AND city = 'Da Nang' AND country_code = 'VN' AND address = '1 Street'
                   AND status = 'active' AND merged_into_place_id IS NULL) THEN
    RAISE EXCEPTION 'T3 FAILED: the new place is not the admin''s name and position with P''s descriptive fields';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.places WHERE id = 'f3812000-0000-4000-8000-000000000001' AND name = 'Cafe A' AND longitude = 106) THEN
    RAISE EXCEPTION 'T3 FAILED: P changed';
  END IF;
  IF (SELECT place_id FROM public.external_place_references WHERE id = 'e3812000-0000-4000-8000-0000000000b1') <> v_new
     OR (SELECT place_id FROM public.external_place_references WHERE id = 'e3812000-0000-4000-8000-0000000000a1') <> 'f3812000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'T3 FAILED: the references did not move exactly as named';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.place_merge_log WHERE id = v_split AND action = 'split' AND survivor_place_id = 'f3812000-0000-4000-8000-000000000001'
                   AND affected_place_id = v_new AND admin_id = 'e3812000-0000-4000-8000-0000000000ad' AND ref_count = 1) THEN
    RAISE EXCEPTION 'T3 FAILED: the split was not logged';
  END IF;
  RAISE NOTICE 'T3 pass: refusals write nothing; the split creates P2, moves the named reference, logs split';
END $t$;
RESET ROLE;
INSERT INTO r3812 (k, v) SELECT 'p2', affected_place_id FROM public.place_merge_log WHERE action = 'split';
INSERT INTO r3812 (k, v) SELECT 'split', id FROM public.place_merge_log WHERE action = 'split';

-- T4 a proposal for a live Memory at the split place, as the service role; ON CONFLICT DO NOTHING is idempotent.
SET ROLE service_role;
DO $t$
DECLARE p2 uuid := (SELECT v FROM r3812 WHERE k = 'p2'); s uuid := (SELECT v FROM r3812 WHERE k = 'split'); n int;
BEGIN
  INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence)
  VALUES ('c3812000-0000-4000-8000-000000000001', 'e3812000-0000-4000-8000-000000000001', s, 'f3812000-0000-4000-8000-000000000001',
          ARRAY['f3812000-0000-4000-8000-000000000001'::uuid, p2], 'f3812000-0000-4000-8000-000000000001',
          pg_temp.ev('unique_within_bound_name_match', 'f3812000-0000-4000-8000-000000000001', p2));
  INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence)
  VALUES ('c3812000-0000-4000-8000-000000000001', 'e3812000-0000-4000-8000-000000000001', s, 'f3812000-0000-4000-8000-000000000001',
          ARRAY['f3812000-0000-4000-8000-000000000001'::uuid, p2], NULL, pg_temp.ev('several_within_bound', 'f3812000-0000-4000-8000-000000000001', p2))
  ON CONFLICT (memory_id, split_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 OR (SELECT count(*) FROM public.memory_place_reresolution_proposals) <> 1 THEN RAISE EXCEPTION 'T4 FAILED: a second proposal for the same Memory and split'; END IF;
  IF (SELECT state FROM public.memory_place_reresolution_proposals) <> 'pending' THEN RAISE EXCEPTION 'T4 FAILED: not born pending'; END IF;
  RAISE NOTICE 'T4 pass: written pending; a re-run inserts nothing';
END $t$;
RESET ROLE;

-- T5 the guard: only a live Memory, its owner, at the split place, of a real split into a candidate, born pending.
DO $t$
DECLARE p2 text := (SELECT v FROM r3812 WHERE k = 'p2'); s text := (SELECT v FROM r3812 WHERE k = 'split');
  ins text := 'INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence, state, decided_at) VALUES (%L, %L, %L, %L, %L::uuid[], NULL, pg_temp.ev(''several_within_bound'', %L, %L), %L, %L)';
  P text := 'f3812000-0000-4000-8000-000000000001'; A text := 'e3812000-0000-4000-8000-000000000001'; B text := 'e3812000-0000-4000-8000-000000000002';
  cands text;
BEGIN
  cands := format('{%s,%s}', P, p2);
  PERFORM pg_temp.refused('T5 owner', format(ins, 'c3812000-0000-4000-8000-000000000004', A, s, P, cands, P, p2, 'pending', NULL), 'not the Memory''s owner');
  PERFORM pg_temp.refused('T5 deleted', format(ins, 'c3812000-0000-4000-8000-000000000003', A, s, P, cands, P, p2, 'pending', NULL), 'the Memory is deleted');
  PERFORM pg_temp.refused('T5 elsewhere', format(ins, 'c3812000-0000-4000-8000-000000000005', A, s, P, cands, P, p2, 'pending', NULL), 'no longer stores the split place');
  PERFORM pg_temp.refused('T5 not a split', format(ins, 'c3812000-0000-4000-8000-000000000002', A, 'a3812000-0000-4000-8000-000000000001', P, cands, P, p2, 'pending', NULL), 'is not a split');
  -- a MERGE row naming exactly these two places is still not a split
  INSERT INTO public.place_merge_log (id, action, survivor_place_id, affected_place_id) VALUES ('a3812000-0000-4000-8000-000000000003', 'merge', P::uuid, p2::uuid);
  PERFORM pg_temp.refused('T5 merge of the same places', format(ins, 'c3812000-0000-4000-8000-000000000002', A, 'a3812000-0000-4000-8000-000000000003', P, cands, P, p2, 'pending', NULL), 'is not a split');
  DELETE FROM public.place_merge_log WHERE id = 'a3812000-0000-4000-8000-000000000003';
  PERFORM pg_temp.refused('T5 candidate', format(ins, 'c3812000-0000-4000-8000-000000000002', A, s, P, format('{%s,%s}', P, 'f3812000-0000-4000-8000-000000000009'), P, 'f3812000-0000-4000-8000-000000000009', 'pending', NULL), 'is not a split');
  PERFORM pg_temp.refused('T5 born decided', format(ins, 'c3812000-0000-4000-8000-000000000002', A, s, P, cands, P, p2, 'dismissed', now()), 'written pending');
  PERFORM pg_temp.refused('T5 no memory', format(ins, 'c3812000-0000-4000-8000-0000000000ff', A, s, P, cands, P, p2, 'pending', NULL), 'does not exist');
  RAISE NOTICE 'T5 pass: owner, deleted, elsewhere, not-a-split, wrong candidate, born decided, no Memory: all refused';
END $t$;

-- T6 the CHECKs: no coordinate, distance or name can be stored; a suggestion exists exactly when resolved.
DO $t$
DECLARE p2 text := (SELECT v FROM r3812 WHERE k = 'p2'); s text := (SELECT v FROM r3812 WHERE k = 'split');
  P text := 'f3812000-0000-4000-8000-000000000001'; A text := 'e3812000-0000-4000-8000-000000000001';
  ins text := 'INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence) VALUES (''c3812000-0000-4000-8000-000000000002'', %L, %L, %L, %L::uuid[], %L, %L::jsonb)';
  cands text; good jsonb;
BEGIN
  cands := format('{%s,%s}', P, p2);
  good := pg_temp.ev('several_within_bound', P::uuid, p2::uuid);
  PERFORM pg_temp.refused('T6 top-level lat', format(ins, A, s, P, cands, NULL, good || '{"lat":10}'), 'evidence_shape');
  PERFORM pg_temp.refused('T6 distance', format(ins, A, s, P, cands, NULL, jsonb_set(good, '{candidates,0,within_bound}', '42.5')), 'evidence_shape');
  PERFORM pg_temp.refused('T6 candidate name', format(ins, A, s, P, cands, NULL, jsonb_set(good, '{candidates,0,name}', '"Cafe A"')), 'evidence_shape');
  PERFORM pg_temp.refused('T6 candidate object', format(ins, A, s, P, cands, NULL, jsonb_set(good, '{candidates,0,within_bound}', '{"m":3}')), 'evidence_shape');
  PERFORM pg_temp.refused('T6 candidate scalar', format(ins, A, s, P, cands, NULL, jsonb_set(good, '{candidates,0}', '"x"')), 'evidence_shape');
  PERFORM pg_temp.refused('T6 unknown reason', format(ins, A, s, P, cands, NULL, jsonb_set(good, '{reason}', '"guess"')), 'evidence_shape');
  PERFORM pg_temp.refused('T6 no reason', format(ins, A, s, P, cands, NULL, good - 'reason'), 'evidence_shape');
  PERFORM pg_temp.refused('T6 no candidates', format(ins, A, s, P, cands, NULL, good - 'candidates'), 'evidence_shape');
  PERFORM pg_temp.refused('T6 bound as text', format(ins, A, s, P, cands, NULL, jsonb_set(good, '{bound_m}', '"75"')), 'evidence_shape');
  PERFORM pg_temp.refused('T6 suggestion unresolved', format(ins, A, s, P, cands, P, good), 'suggested_iff_resolved');
  PERFORM pg_temp.refused('T6 resolved without suggestion', format(ins, A, s, P, cands, NULL, jsonb_set(good, '{reason}', '"unique_within_bound_name_match"')), 'suggested_iff_resolved');
  PERFORM pg_temp.refused('T6 suggestion not a candidate', format(ins, A, s, P, cands, 'f3812000-0000-4000-8000-000000000009', jsonb_set(good, '{reason}', '"unique_within_bound_name_match"')), 'proposals_suggestion');
  PERFORM pg_temp.refused('T6 eleven candidates', format(ins, A, s, P, format('{%s,%s,%s}', P, p2, (SELECT string_agg(gen_random_uuid()::text, ',') FROM generate_series(1, 9))), NULL, good), 'proposals_candidates');
  PERFORM pg_temp.refused('T6 null candidate', format(ins, A, s, P, format('{%s,%s,NULL}', P, p2), NULL, good), 'proposals_candidates');
  RAISE NOTICE 'T6 pass: coordinates, distances, names, unknown reasons and unbacked suggestions are refused by CHECK';
END $t$;

-- T7 decisions: the owner's choice once; accepted only when the Memory stores it; nothing else changes.
DO $t$
DECLARE p2 uuid := (SELECT v FROM r3812 WHERE k = 'p2'); s uuid := (SELECT v FROM r3812 WHERE k = 'split'); pid uuid; pid2 uuid;
BEGIN
  SELECT id INTO pid FROM public.memory_place_reresolution_proposals WHERE memory_id = 'c3812000-0000-4000-8000-000000000001';
  INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence)
  VALUES ('c3812000-0000-4000-8000-000000000002', 'e3812000-0000-4000-8000-000000000001', s, 'f3812000-0000-4000-8000-000000000001',
          ARRAY['f3812000-0000-4000-8000-000000000001'::uuid, p2], p2, pg_temp.ev('unique_within_bound_name_match', p2, 'f3812000-0000-4000-8000-000000000001'))
  RETURNING id INTO pid2;
  PERFORM pg_temp.refused('T7 accept unchanged', format('UPDATE public.memory_place_reresolution_proposals SET state = ''accepted'', accepted_place_id = %L, decided_at = now() WHERE id = %L', p2, pid2), 'does not store the accepted place');
  PERFORM pg_temp.refused('T7 rewrite', format('UPDATE public.memory_place_reresolution_proposals SET suggested_place_id = NULL WHERE id = %L', pid2), 'only be accepted or dismissed|only the decision may change');
  PERFORM pg_temp.refused('T7 rewrite with a decision', format('UPDATE public.memory_place_reresolution_proposals SET state = ''dismissed'', decided_at = now(), evidence = pg_temp.ev(''none_within_bound'', %L, %L), suggested_place_id = NULL WHERE id = %L', p2, 'f3812000-0000-4000-8000-000000000001', pid2), 'only the decision may change');
  PERFORM pg_temp.refused('T7 decided without a time', format('UPDATE public.memory_place_reresolution_proposals SET state = ''dismissed'' WHERE id = %L', pid2), 'proposals_decided');
  -- The owner's PATCH /memories/:id is the one writer of the place: modelled by its committed effect.
  UPDATE public.memories SET place_id = p2::text WHERE id = 'c3812000-0000-4000-8000-000000000002';
  UPDATE public.memory_place_reresolution_proposals SET state = 'accepted', accepted_place_id = p2, decided_at = now() WHERE id = pid2;
  PERFORM pg_temp.refused('T7 final', format('UPDATE public.memory_place_reresolution_proposals SET state = ''dismissed'', accepted_place_id = NULL WHERE id = %L', pid2), 'decided proposal is final');
  UPDATE public.memory_place_reresolution_proposals SET state = 'dismissed', decided_at = now() WHERE id = pid;
  PERFORM pg_temp.refused('T7 back to pending', format('UPDATE public.memory_place_reresolution_proposals SET state = ''pending'', decided_at = NULL WHERE id = %L', pid), 'decided proposal is final');
  RAISE NOTICE 'T7 pass: accept only after the Memory stores the place; dismiss; a decision is final; nothing else may change';
END $t$;

-- T8 the purge: a Memory's soft delete removes its proposals in the same statement; archiving does not; others stay.
DO $t$
DECLARE p2 uuid := (SELECT v FROM r3812 WHERE k = 'p2'); s uuid := (SELECT v FROM r3812 WHERE k = 'split');
BEGIN
  INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence)
  VALUES ('c3812000-0000-4000-8000-000000000004', 'e3812000-0000-4000-8000-000000000002', s, 'f3812000-0000-4000-8000-000000000001',
          ARRAY['f3812000-0000-4000-8000-000000000001'::uuid, p2], NULL, pg_temp.ev('none_within_bound', 'f3812000-0000-4000-8000-000000000001', p2));
  UPDATE public.memories SET state = 'archived' WHERE id = 'c3812000-0000-4000-8000-000000000004';
  IF NOT EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE memory_id = 'c3812000-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'T8 FAILED: archiving purged the proposal';
  END IF;
  UPDATE public.memories SET state = 'deleted' WHERE id = 'c3812000-0000-4000-8000-000000000004';
  IF EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE memory_id = 'c3812000-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'T8 FAILED: the soft delete left the proposal';
  END IF;
  IF (SELECT count(*) FROM public.memory_place_reresolution_proposals) <> 2 THEN
    RAISE EXCEPTION 'T8 FAILED: another Memory''s proposals were touched';
  END IF;
  RAISE NOTICE 'T8 pass: the soft delete purges, archiving does not, other Memories untouched';
END $t$;

-- T9 the purge needs no privilege on the table: as the service role WITHOUT DELETE on it.
UPDATE public.memories SET state = 'published' WHERE id = 'c3812000-0000-4000-8000-000000000004';
INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence)
SELECT 'c3812000-0000-4000-8000-000000000004', 'e3812000-0000-4000-8000-000000000002', s.v, 'f3812000-0000-4000-8000-000000000001',
       ARRAY['f3812000-0000-4000-8000-000000000001'::uuid, p.v], NULL, pg_temp.ev('none_within_bound', 'f3812000-0000-4000-8000-000000000001', p.v)
  FROM r3812 s, r3812 p WHERE s.k = 'split' AND p.k = 'p2';
SET ROLE service_role;
DO $t$
BEGIN
  PERFORM pg_temp.refused('T9 direct delete', 'DELETE FROM public.memory_place_reresolution_proposals', 'permission denied');
  UPDATE public.memories SET state = 'deleted' WHERE id = 'c3812000-0000-4000-8000-000000000004';
  IF EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE memory_id = 'c3812000-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'T9 FAILED: the service role''s soft delete left the proposal';
  END IF;
  RAISE NOTICE 'T9 pass: no DELETE privilege, yet the soft delete purges (SECURITY DEFINER)';
END $t$;
RESET ROLE;

-- T10 client roles hold nothing and execute nothing.
DO $t$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.memory_place_reresolution_proposals', 'SELECT')
       OR has_table_privilege(r, 'public.memory_place_reresolution_proposals', 'INSERT')
       OR has_table_privilege(r, 'public.memory_place_reresolution_proposals', 'UPDATE')
       OR has_table_privilege(r, 'public.memory_place_reresolution_proposals', 'DELETE')
       OR has_function_privilege(r, 'public.place_split(uuid,jsonb,uuid[],uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'T10 FAILED: % holds a privilege', r;
    END IF;
  END LOOP;
  RAISE NOTICE 'T10 pass: anon and authenticated hold nothing';
END $t$;
SET ROLE authenticated;
DO $t$
BEGIN
  PERFORM pg_temp.refused('T10 read', 'SELECT count(*) FROM public.memory_place_reresolution_proposals', 'permission denied');
  PERFORM pg_temp.refused('T10 split', $$SELECT public.place_split('f3812000-0000-4000-8000-000000000001', '{"name":"X","latitude":1,"longitude":1}', '{}', NULL)$$, 'permission denied');
  RAISE NOTICE 'T10 pass: a signed-in client can neither read proposals nor split';
END $t$;
RESET ROLE;

-- T11 erasure cascades: the account, the Memory's hard delete.
DO $t$
BEGIN
  DELETE FROM public.memories WHERE id = 'c3812000-0000-4000-8000-000000000002';
  IF EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE memory_id = 'c3812000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'T11 FAILED: the Memory''s hard delete left its proposal';
  END IF;
  DELETE FROM public.memories WHERE owner_id = 'e3812000-0000-4000-8000-000000000002';
  RAISE NOTICE 'T11 pass: hard delete cascades';
END $t$;

-- T12 negative controls: with the guard disabled a proposal for a deleted Memory lands; with the purge disabled a soft
--     delete leaves one. So T5 and T8 are the triggers' doing, not the fixture's.
DO $t$
DECLARE p2 uuid := (SELECT v FROM r3812 WHERE k = 'p2'); s uuid := (SELECT v FROM r3812 WHERE k = 'split');
BEGIN
  ALTER TABLE public.memory_place_reresolution_proposals DISABLE TRIGGER memory_place_reresolution_proposals_guard;
  INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence)
  VALUES ('c3812000-0000-4000-8000-000000000003', 'e3812000-0000-4000-8000-000000000001', s, 'f3812000-0000-4000-8000-000000000001',
          ARRAY['f3812000-0000-4000-8000-000000000001'::uuid, p2], NULL, pg_temp.ev('none_within_bound', 'f3812000-0000-4000-8000-000000000001', p2));
  DELETE FROM public.memory_place_reresolution_proposals WHERE memory_id = 'c3812000-0000-4000-8000-000000000003';
  ALTER TABLE public.memory_place_reresolution_proposals ENABLE TRIGGER memory_place_reresolution_proposals_guard;
  ALTER TABLE public.memories DISABLE TRIGGER memory_place_reresolution_purge;
  UPDATE public.memories SET state = 'published' WHERE id = 'c3812000-0000-4000-8000-000000000003';
  INSERT INTO public.memory_place_reresolution_proposals (memory_id, owner_id, split_id, split_from_place_id, candidate_place_ids, suggested_place_id, evidence)
  VALUES ('c3812000-0000-4000-8000-000000000003', 'e3812000-0000-4000-8000-000000000001', s, 'f3812000-0000-4000-8000-000000000001',
          ARRAY['f3812000-0000-4000-8000-000000000001'::uuid, p2], NULL, pg_temp.ev('none_within_bound', 'f3812000-0000-4000-8000-000000000001', p2));
  UPDATE public.memories SET state = 'deleted' WHERE id = 'c3812000-0000-4000-8000-000000000003';
  IF NOT EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE memory_id = 'c3812000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'T12 FAILED: the control did not reach the case';
  END IF;
  ALTER TABLE public.memories ENABLE TRIGGER memory_place_reresolution_purge;
  DELETE FROM public.memory_place_reresolution_proposals WHERE memory_id = 'c3812000-0000-4000-8000-000000000003';
  RAISE NOTICE 'T12 pass: negative controls — without the guard / the purge, the refused cases land';
END $t$;

-- T13 the account's erasure (auth.users) leaves no proposal: owner_id and memory_id both cascade.
DO $t$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals WHERE owner_id = 'e3812000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'T13 FAILED: precondition — A has no proposal to erase';
  END IF;
  DELETE FROM auth.users WHERE id = 'e3812000-0000-4000-8000-000000000001';
  IF EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals) THEN
    RAISE EXCEPTION 'T13 FAILED: the account''s proposals survived its erasure';
  END IF;
  RAISE NOTICE 'T13 pass: account erasure leaves no proposal';
END $t$;

-- Leave the flags OFF for the rollback rehearsal.
UPDATE public.feature_flags SET enabled = false WHERE flag IN ('memory_place_split_reresolution_enabled', 'external_places_enabled');
