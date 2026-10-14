-- Behavioural rehearsal for 3811 (memory_snapshots, its writer trigger on memories and its guard), after
-- 3811_00_seed.sql and 3811. Each DO block RAISES on a failed expectation; every passed block appends a line to
-- pg_temp.rehearsal_log, printed at the end. See sql/rehearsals/README.md, section "3811". Never against production
-- or the CI project.
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;
CREATE TEMP TABLE IF NOT EXISTS rehearsal_log (n serial, line text);
CREATE OR REPLACE FUNCTION pg_temp.pass(t text) RETURNS void LANGUAGE sql AS $$ INSERT INTO pg_temp.rehearsal_log (line) VALUES (t || ' pass') $$;
CREATE OR REPLACE FUNCTION pg_temp.versions(mem uuid) RETURNS int[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(version ORDER BY version), '{}') FROM public.memory_snapshots WHERE memory_id = mem $$;
CREATE OR REPLACE FUNCTION pg_temp.places(mem uuid) RETURNS text[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(coalesce(facts ->> 'place_id', '<null>') ORDER BY version), '{}') FROM public.memory_snapshots WHERE memory_id = mem $$;
CREATE OR REPLACE FUNCTION pg_temp.whitelist() RETURNS text[] LANGUAGE sql AS $$
  SELECT ARRAY['state', 'visibility', 'location_precision', 'place_id', 'canonical_location_id', 'place_display_name_at_occurrence',
               'starts_at', 'ends_at', 'source_mode', 'memory_type', 'item_count'] $$;

-- T1 Memories that existed before 3811 have no version: no backfill (Q-H35).
DO $$ BEGIN
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_snapshots WHERE memory_id::text LIKE 'c3811000-0000-4000-8000-00000000000%') = 0, 'T1 no backfill');
  PERFORM pg_temp.pass('T1');
END $$;

-- T2 an INSERT writes version 1: exactly the whitelisted keys, the extractor version, an empty cause.
DO $$
DECLARE f jsonb;
BEGIN
  INSERT INTO public.memories (id, owner_id, title, caption, visibility, place_id, location_lat, location_lng, location_city, location_country, starts_at, location_precision)
  VALUES ('c3811000-0000-4000-8000-000000000011', 'e1100000-0000-4000-8000-000000000001', 'TITLE-MARK', 'CAPTION-MARK', 'friends_only', 'fsq:place-a',
          41.1496, -8.6109, 'CITY-MARK', 'COUNTRY-MARK', '2026-03-03T11:00:00.123456Z', 'neighborhood');
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{1}', 'T2 one version');
  SELECT facts INTO f FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000011' AND version = 1;
  PERFORM pg_temp.ck((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(f) k) = (SELECT array_agg(k ORDER BY k) FROM unnest(pg_temp.whitelist()) k), 'T2 exactly the whitelisted keys (every later column present here)');
  PERFORM pg_temp.ck(f ->> 'place_id' = 'fsq:place-a' AND f ->> 'visibility' = 'friends_only' AND f ->> 'state' = 'published'
                     AND f ->> 'location_precision' = 'neighborhood' AND f ->> 'memory_type' = 'MOMENT' AND f ->> 'source_mode' = 'USER_CREATED'
                     AND (f -> 'item_count')::int = 0 AND f ->> 'starts_at' = '2026-03-03T11:00:00.123Z' AND f -> 'ends_at' = 'null'::jsonb, 'T2 the fact values (UTC millisecond time)');
  PERFORM pg_temp.ck((SELECT engine_versions = '{"snapshot": "memory-snapshot@1"}'::jsonb AND cause = '{}'::jsonb AND owner_id = 'e1100000-0000-4000-8000-000000000001'
                        FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000011'), 'T2 engine version, empty cause, owner');
  PERFORM pg_temp.pass('T2');
END $$;

-- T3 the place changed twice: versions 1..3 carry the place history in order.
DO $$ BEGIN
  UPDATE public.memories SET place_id = 'fsq:place-b' WHERE id = 'c3811000-0000-4000-8000-000000000011';
  UPDATE public.memories SET place_id = 'fsq:place-c', place_display_name_at_occurrence = 'Cafe C' WHERE id = 'c3811000-0000-4000-8000-000000000011';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{1,2,3}', 'T3 versions 1..3');
  PERFORM pg_temp.ck(pg_temp.places('c3811000-0000-4000-8000-000000000011') = '{fsq:place-a,fsq:place-b,fsq:place-c}', 'T3 the place history');
  PERFORM pg_temp.ck((SELECT facts ->> 'place_display_name_at_occurrence' FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000011' AND version = 3) = 'Cafe C', 'T3 the occurrence name travels with its place');
  PERFORM pg_temp.pass('T3');
END $$;

-- T4 free text, coordinates and people are not facts: editing them writes no version, and no version carries them.
DO $$ BEGIN
  UPDATE public.memories SET title = 'TITLE-MARK-2', caption = 'CAPTION-MARK-2', location_lat = 10.5, location_lng = 20.5,
         location_city = 'CITY-MARK-2', location_country = 'COUNTRY-MARK-2', updated_at = now(),
         allowed_user_ids = ARRAY['e1100000-0000-4000-8000-000000000002'::uuid], hidden_user_ids = ARRAY['e1100000-0000-4000-8000-000000000002'::uuid]
   WHERE id = 'c3811000-0000-4000-8000-000000000011';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{1,2,3}', 'T4 no version for a non-fact edit');
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_snapshots
                                  WHERE facts::text ~ '(TITLE|CAPTION|CITY|COUNTRY)-MARK|41\.1496|8\.6109|10\.5|20\.5|e1100000-0000-4000-8000-000000000002'
                                     OR cause::text ~ 'MARK' OR engine_versions::text ~ 'MARK'), 'T4 no title, caption, coordinate, city, country or person in any version');
  PERFORM pg_temp.pass('T4');
END $$;

-- T5 the whitelist is a CHECK: nothing else can be stored, by any writer, the table owner included.
DO $$ BEGIN
  BEGIN
    INSERT INTO public.memory_snapshots (memory_id, owner_id, version, facts, engine_versions)
    VALUES ('c3811000-0000-4000-8000-000000000011', 'e1100000-0000-4000-8000-000000000001', 99, '{"caption": "x"}', '{"snapshot": "memory-snapshot@1"}');
    RAISE EXCEPTION 'EXPECTATION FAILED: T5 a caption key was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.memory_snapshots (memory_id, owner_id, version, facts, engine_versions, cause)
    VALUES ('c3811000-0000-4000-8000-000000000011', 'e1100000-0000-4000-8000-000000000001', 99, '{}', '{"snapshot": "memory-snapshot@1"}', '{"note": "free text"}');
    RAISE EXCEPTION 'EXPECTATION FAILED: T5 a free-text cause was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM pg_temp.pass('T5');
END $$;

-- T6 item_count is counted at the Memory write; a lifecycle change is a fact.
DO $$ BEGIN
  INSERT INTO public.memory_items (memory_id, media_url) VALUES ('c3811000-0000-4000-8000-000000000011', 'post-media/a.jpg'), ('c3811000-0000-4000-8000-000000000011', 'post-media/b.jpg');
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{1,2,3}', 'T6 an item alone writes no version (the trigger is on memories)');
  UPDATE public.memories SET state = 'archived' WHERE id = 'c3811000-0000-4000-8000-000000000011';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{1,2,3,4}', 'T6 archive is version 4');
  PERFORM pg_temp.ck((SELECT (facts ->> 'item_count')::int = 2 AND facts ->> 'state' = 'archived' FROM public.memory_snapshots
                       WHERE memory_id = 'c3811000-0000-4000-8000-000000000011' AND version = 4), 'T6 version 4 counts both items');
  PERFORM pg_temp.pass('T6');
END $$;

-- T7 the cap: 55 more changes keep exactly the newest 50 versions, and the newest is the Memory as it is.
DO $$
DECLARE i int;
BEGIN
  INSERT INTO public.memories (id, owner_id, title, place_id) VALUES ('c3811000-0000-4000-8000-000000000021', 'e1100000-0000-4000-8000-000000000001', 'busy', 'fsq:p0');
  FOR i IN 1..55 LOOP
    UPDATE public.memories SET place_id = 'fsq:p' || i WHERE id = 'c3811000-0000-4000-8000-000000000021';
  END LOOP;
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000021') = 50, 'T7 exactly 50 kept');
  PERFORM pg_temp.ck((SELECT min(version) = 7 AND max(version) = 56 FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000021'), 'T7 versions 7..56: the oldest went');
  PERFORM pg_temp.ck((SELECT facts ->> 'place_id' FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000021' ORDER BY version DESC LIMIT 1) = 'fsq:p55', 'T7 the newest is the Memory now');
  PERFORM pg_temp.pass('T7');
END $$;

-- T8 append-only: an UPDATE is refused; deleting a LIVE Memory's version is refused, the server's role included.
DO $$ BEGIN
  BEGIN
    UPDATE public.memory_snapshots SET facts = '{}' WHERE memory_id = 'c3811000-0000-4000-8000-000000000011' AND version = 1;
    RAISE EXCEPTION 'EXPECTATION FAILED: T8 a version was rewritten';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000011';
    RAISE EXCEPTION 'EXPECTATION FAILED: T8 a live Memory''s history was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM set_config('role', 'service_role', true);
    DELETE FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000021' AND version = 7;
    RAISE EXCEPTION 'EXPECTATION FAILED: T8 service_role deleted a live Memory''s oldest kept version';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{1,2,3,4}', 'T8 history intact');
  PERFORM pg_temp.pass('T8');
END $$;

-- T9 the privileges: no client role reads, writes or executes; the server reads and purges and can neither insert nor rewrite.
DO $$ BEGIN
  PERFORM pg_temp.ck(NOT has_table_privilege('anon', 'public.memory_snapshots', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.memory_snapshots', 'SELECT')
                     AND NOT has_table_privilege('authenticated', 'public.memory_snapshots', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.memory_snapshots', 'DELETE'), 'T9 no client privilege');
  PERFORM pg_temp.ck(has_table_privilege('service_role', 'public.memory_snapshots', 'SELECT') AND has_table_privilege('service_role', 'public.memory_snapshots', 'DELETE')
                     AND NOT has_table_privilege('service_role', 'public.memory_snapshots', 'INSERT') AND NOT has_table_privilege('service_role', 'public.memory_snapshots', 'UPDATE'), 'T9 service_role SELECT+DELETE only');
  PERFORM pg_temp.ck(NOT has_function_privilege('anon', 'public.memory_snapshot_record()', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.memory_snapshot_record()', 'EXECUTE')
                     AND NOT has_function_privilege('anon', 'public.memory_snapshots_guard()', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.memory_snapshots_guard()', 'EXECUTE'), 'T9 no client EXECUTE');
  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    PERFORM 1 FROM public.memory_snapshots LIMIT 1;
    RAISE EXCEPTION 'EXPECTATION FAILED: T9 authenticated read memory_snapshots';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM pg_temp.pass('T9');
END $$;

-- T10 a Memory write by the API's role (no INSERT on the table) is still versioned: the writer is SECURITY DEFINER.
DO $$ BEGIN
  PERFORM set_config('role', 'service_role', true);
  UPDATE public.memories SET visibility = 'public' WHERE id = 'c3811000-0000-4000-8000-000000000021';
  PERFORM set_config('role', 'none', true);
  PERFORM pg_temp.ck((SELECT facts ->> 'visibility' FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000021' ORDER BY version DESC LIMIT 1) = 'public', 'T10 versioned through service_role');
  PERFORM pg_temp.ck((SELECT min(version) = 8 AND max(version) = 57 AND count(*) = 50 FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000021'), 'T10 the cap pruned on that path too');
  PERFORM pg_temp.pass('T10');
END $$;

-- T11 cause: a writer's command / correction id is recorded when set; a value that is not a uuid is ignored.
DO $$ BEGIN
  PERFORM set_config('portava.memory_command_id', 'A0000000-0000-4000-8000-0000000000C1', true);
  PERFORM set_config('portava.memory_correction_id', 'not a uuid; DROP TABLE x', true);
  UPDATE public.memories SET ends_at = '2026-03-03T13:00:00Z' WHERE id = 'c3811000-0000-4000-8000-000000000011';
  PERFORM pg_temp.ck((SELECT cause FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000011' ORDER BY version DESC LIMIT 1)
                     = '{"command_id": "a0000000-0000-4000-8000-0000000000c1"}'::jsonb, 'T11 command id recorded, the bad correction id ignored');
  PERFORM set_config('portava.memory_command_id', '', true);
  PERFORM set_config('portava.memory_correction_id', '', true);
  PERFORM pg_temp.pass('T11');
END $$;

-- T12 a soft-deleted Memory gets no version, and the §21 purge (the API's DELETE) may then erase its history.
DO $$ BEGIN
  UPDATE public.memories SET state = 'deleted' WHERE id = 'c3811000-0000-4000-8000-000000000011';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{1,2,3,4,5}', 'T12 the soft delete wrote no version');
  PERFORM set_config('role', 'service_role', true);
  DELETE FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000011';
  PERFORM set_config('role', 'none', true);
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{}', 'T12 the purge erased every version');
  UPDATE public.memories SET title = 'edited after delete', place_id = 'fsq:after' WHERE id = 'c3811000-0000-4000-8000-000000000011';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000011') = '{}', 'T12 a deleted Memory never accrues history again');
  PERFORM pg_temp.pass('T12');
END $$;

-- T13 the cascades: a hard-deleted Memory takes its history; a deleted account takes its history.
DO $$ BEGIN
  DELETE FROM public.memories WHERE id = 'c3811000-0000-4000-8000-000000000021';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000021') = '{}', 'T13 memories cascade');
  INSERT INTO public.memories (id, owner_id, title) VALUES ('c3811000-0000-4000-8000-000000000031', 'e1100000-0000-4000-8000-000000000002', 'other account');
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000031') = '{1}', 'T13 setup');
  DELETE FROM auth.users WHERE id = 'e1100000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck(NOT EXISTS (SELECT 1 FROM public.memory_snapshots WHERE owner_id = 'e1100000-0000-4000-8000-000000000002'), 'T13 auth.users cascade');
  PERFORM pg_temp.pass('T13');
END $$;

-- T14 NEGATIVE CONTROL: with the writer disabled a place change records nothing, so T3 measured the trigger; with the
-- guard disabled a live Memory's version CAN be deleted, so T8 measured the guard.
DO $$ BEGIN
  INSERT INTO public.memories (id, owner_id, title, place_id) VALUES ('c3811000-0000-4000-8000-000000000041', 'e1100000-0000-4000-8000-000000000001', 'control', 'fsq:x');
  ALTER TABLE public.memories DISABLE TRIGGER memory_snapshot_record;
  UPDATE public.memories SET place_id = 'fsq:y' WHERE id = 'c3811000-0000-4000-8000-000000000041';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000041') = '{1}', 'T14 control: no trigger, no version');
  ALTER TABLE public.memories ENABLE TRIGGER memory_snapshot_record;
  ALTER TABLE public.memory_snapshots DISABLE TRIGGER memory_snapshots_guard;
  DELETE FROM public.memory_snapshots WHERE memory_id = 'c3811000-0000-4000-8000-000000000041';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000041') = '{}', 'T14 control: no guard, the live history goes');
  ALTER TABLE public.memory_snapshots ENABLE TRIGGER memory_snapshots_guard;
  UPDATE public.memories SET place_id = 'fsq:z' WHERE id = 'c3811000-0000-4000-8000-000000000041';
  PERFORM pg_temp.ck(pg_temp.versions('c3811000-0000-4000-8000-000000000041') = '{1}', 'T14 re-enabled: versioning resumes at 1 for an emptied history');
  PERFORM pg_temp.pass('T14');
END $$;

SELECT line FROM pg_temp.rehearsal_log ORDER BY n;
