-- Behavioural rehearsal for 3809 (memory_media_segments: logical segments of a Memory's video item, no copy of the
-- original), after 3809_00_seed.sql and 3809. Each DO block RAISES on a failed expectation.
-- See sql/rehearsals/README.md, section "3809". Never against production or the CI project.
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.n(item uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.memory_media_segments WHERE item_id = item $$;

-- T1 3809 wrote no row and rewrote nothing that existed before it.
DO $$ BEGIN
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_media_segments) = 0, 'T1 no segment was written by the migration');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_items WHERE id::text LIKE 'd9000000-%') = 4, 'T1 the items are all there');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memories WHERE id::text LIKE 'c9000000-%' AND updated_at = '2026-01-01T00:00:00Z') = 2, 'T1 no Memory was rewritten');
END $$;

-- T2 a segment is a window and a label: the window CHECK, the label CHECK and the UNIQUE window; no column for a path.
DO $$ BEGIN
  SET LOCAL ROLE service_role;
  INSERT INTO public.memory_media_segments (id, memory_id, item_id, owner_id, start_ms, end_ms, label) VALUES
   ('a9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 0, 4000, 'Lanterns'),
   ('a9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 4000, 9000, NULL);
  RESET ROLE;
  PERFORM pg_temp.ck(pg_temp.n('d9000000-0000-4000-8000-000000000001') = 2, 'T2 two windows on one video');
  PERFORM pg_temp.ck((SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memory_media_segments')
                     = 'id,memory_id,item_id,owner_id,start_ms,end_ms,label,created_at', 'T2 no column can hold a path, URL or bucket');
  BEGIN
    INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 0, 4000);
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 the same window was stored twice';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', -1, 10);
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 a negative start was stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 10, 10);
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 an empty window was stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 11, 10);
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 a reversed window was stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms, label) VALUES ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 20000, 21000, '');
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 an empty label was stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms, label) VALUES ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 20000, 21000, repeat('x', 121));
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 a 121-character label was stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM pg_temp.ck(pg_temp.n('d9000000-0000-4000-8000-000000000001') = 2, 'T2 nothing refused was stored');
END $$;

-- T3 the integrity trigger: the item must be on the Memory and owner_id must be its owner — on INSERT and on UPDATE.
DO $$ BEGIN
  BEGIN
    INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000004', 'e9000000-0000-4000-8000-000000000001', 0, 10);
    RAISE EXCEPTION 'EXPECTATION FAILED: T3 another Memory''s video was segmented through this one';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002', 30000, 31000);
    RAISE EXCEPTION 'EXPECTATION FAILED: T3 a segment was stored under someone other than the Memory''s owner';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.memory_media_segments SET item_id = 'd9000000-0000-4000-8000-000000000004' WHERE id = 'a9000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'EXPECTATION FAILED: T3 an UPDATE moved a segment onto another Memory''s video';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public.memory_media_segments SET owner_id = 'e9000000-0000-4000-8000-000000000002' WHERE id = 'a9000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'EXPECTATION FAILED: T3 an UPDATE re-owned a segment';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM pg_temp.ck(pg_temp.n('d9000000-0000-4000-8000-000000000004') = 0, 'T3 nothing landed on the other Memory''s video');
END $$;

-- T4 NEGATIVE CONTROL for T3: with the trigger disabled, the same foreign insert LANDS — the trigger is what refuses it.
DO $$ BEGIN
  ALTER TABLE public.memory_media_segments DISABLE TRIGGER memory_media_segments_integrity;
  INSERT INTO public.memory_media_segments (id, memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('a9000000-0000-4000-8000-0000000000ff', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000004', 'e9000000-0000-4000-8000-000000000001', 0, 10);
  PERFORM pg_temp.ck(pg_temp.n('d9000000-0000-4000-8000-000000000004') = 1, 'T4 without the trigger the foreign row lands');
  DELETE FROM public.memory_media_segments WHERE id = 'a9000000-0000-4000-8000-0000000000ff';
  ALTER TABLE public.memory_media_segments ENABLE TRIGGER memory_media_segments_integrity;
END $$;

-- T5 erasure: a segment goes with its item, its Memory and its owner's account.
DO $$ BEGIN
  INSERT INTO public.memory_media_segments (memory_id, item_id, owner_id, start_ms, end_ms) VALUES
   ('c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000001', 0, 10),
   ('c9000000-0000-4000-8000-000000000002', 'd9000000-0000-4000-8000-000000000004', 'e9000000-0000-4000-8000-000000000002', 0, 10);
  DELETE FROM public.memory_items WHERE id = 'd9000000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck(pg_temp.n('d9000000-0000-4000-8000-000000000002') = 0, 'T5 removing the video removed its segment');
  PERFORM pg_temp.ck(pg_temp.n('d9000000-0000-4000-8000-000000000001') = 2, 'T5 and only its own');
  DELETE FROM auth.users WHERE id = 'e9000000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_media_segments WHERE owner_id = 'e9000000-0000-4000-8000-000000000002') = 0, 'T5 the account deletion took its segments');
END $$;

-- T6 no client role reaches the table: no privilege at table or column level, and a read as either is refused.
DO $$
DECLARE r text; p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      PERFORM pg_temp.ck(NOT has_table_privilege(r, 'public.memory_media_segments', p), format('T6 %s holds %s', r, p));
    END LOOP;
    PERFORM pg_temp.ck(NOT has_any_column_privilege(r, 'public.memory_media_segments', 'SELECT'), format('T6 %s holds a column SELECT', r));
  END LOOP;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM count(*) FROM public.memory_media_segments;
    RAISE EXCEPTION 'EXPECTATION FAILED: T6 authenticated read memory_media_segments';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
END $$;

-- T7 the API's role reads, marks and removes; it can neither rewrite nor truncate. RLS on, no policy.
DO $$ BEGIN
  PERFORM pg_temp.ck((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_media_segments'::regclass), 'T7 RLS on');
  PERFORM pg_temp.ck((SELECT count(*) FROM pg_policy WHERE polrelid = 'public.memory_media_segments'::regclass) = 0, 'T7 no policy');
  SET LOCAL ROLE service_role;
  INSERT INTO public.memory_media_segments (id, memory_id, item_id, owner_id, start_ms, end_ms) VALUES ('a9000000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 9000, 9500);
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_media_segments WHERE id = 'a9000000-0000-4000-8000-000000000003') = 1, 'T7 service_role reads what it marked');
  DELETE FROM public.memory_media_segments WHERE id = 'a9000000-0000-4000-8000-000000000003';
  BEGIN
    UPDATE public.memory_media_segments SET end_ms = 9999 WHERE id = 'a9000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'EXPECTATION FAILED: T7 service_role rewrote a segment';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    TRUNCATE public.memory_media_segments;
    RAISE EXCEPTION 'EXPECTATION FAILED: T7 service_role truncated the table';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
  PERFORM pg_temp.ck(pg_temp.n('d9000000-0000-4000-8000-000000000001') = 2, 'T7 the two segments stand');
END $$;

-- T8 the trigger runs as its caller and no client role may call its function.
DO $$ BEGIN
  PERFORM pg_temp.ck(NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.memory_media_segments_integrity()'::regprocedure), 'T8 SECURITY INVOKER');
  PERFORM pg_temp.ck(NOT has_function_privilege('anon', 'public.memory_media_segments_integrity()', 'EXECUTE'), 'T8 anon cannot execute it');
  PERFORM pg_temp.ck(NOT has_function_privilege('authenticated', 'public.memory_media_segments_integrity()', 'EXECUTE'), 'T8 authenticated cannot execute it');
END $$;

-- T9 two segments remain on the first video, for the rollback to refuse.
DO $$ BEGIN
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memory_media_segments) = 2, 'T9 two segments left standing');
END $$;
