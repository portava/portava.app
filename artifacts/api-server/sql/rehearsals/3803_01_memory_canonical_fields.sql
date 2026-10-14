-- Behavioural rehearsal for 3803 (memories.memory_type) and 3804 (memories.place_display_name_at_occurrence and its
-- trigger), after 3803_00_seed.sql, 3803 and 3804. Each DO block RAISES on a failed expectation.
-- See sql/rehearsals/README.md, section "3803-3804". Never against production or the CI project.
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.nm(mem uuid) RETURNS text LANGUAGE sql AS $$ SELECT place_display_name_at_occurrence FROM public.memories WHERE id = mem $$;

-- T1 rows that existed before 3803/3804 are unknown: no type, no name, nothing rewritten.
DO $$ BEGIN
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memories WHERE id::text LIKE 'c3000000-%' AND memory_type IS NULL) = 3, 'T1 legacy rows read memory_type NULL');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memories WHERE id::text LIKE 'c3000000-%' AND place_display_name_at_occurrence IS NULL) = 3, 'T1 legacy rows read no occurrence name (never backfilled)');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.memories WHERE id::text LIKE 'c3000000-%' AND updated_at = '2026-01-01T00:00:00Z') = 3, 'T1 no legacy row was rewritten');
END $$;

-- T2 a new Memory nobody typed is a MOMENT (Q-H40); a chosen type is kept; a type off the §4 list is refused.
DO $$ BEGIN
  INSERT INTO public.memories (id, owner_id, title) VALUES ('c3000000-0000-4000-8000-000000000011', 'e0000000-0000-4000-8000-000000000001', 'untyped');
  PERFORM pg_temp.ck((SELECT memory_type FROM public.memories WHERE id = 'c3000000-0000-4000-8000-000000000011') = 'MOMENT', 'T2 DEFAULT MOMENT');
  INSERT INTO public.memories (id, owner_id, title, memory_type) VALUES ('c3000000-0000-4000-8000-000000000012', 'e0000000-0000-4000-8000-000000000001', 'reunion', 'REUNION');
  PERFORM pg_temp.ck((SELECT memory_type FROM public.memories WHERE id = 'c3000000-0000-4000-8000-000000000012') = 'REUNION', 'T2 chosen type kept');
  BEGIN
    INSERT INTO public.memories (id, owner_id, title, memory_type) VALUES ('c3000000-0000-4000-8000-000000000013', 'e0000000-0000-4000-8000-000000000001', 'bad', 'VACATION');
    RAISE EXCEPTION 'EXPECTATION FAILED: T2 an off-vocabulary type was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.memories SET memory_type = NULL WHERE id = 'c3000000-0000-4000-8000-000000000012';
  PERFORM pg_temp.ck((SELECT memory_type FROM public.memories WHERE id = 'c3000000-0000-4000-8000-000000000012') IS NULL, 'T2 an owner may clear the type');
END $$;

-- T3 a catalog place records the catalog's name AT THAT MOMENT; a later rename or merge does not touch the Memory.
DO $$ BEGIN
  INSERT INTO public.memories (id, owner_id, title, place_id) VALUES ('c3000000-0000-4000-8000-000000000021', 'e0000000-0000-4000-8000-000000000001', 'at A', 'f0000000-0000-4000-8000-000000000001');
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000021') = 'Cafe A', 'T3 catalog name recorded at write');
  UPDATE public.places SET name = 'Cafe A (closed)', merged_into_place_id = 'f0000000-0000-4000-8000-000000000002' WHERE id = 'f0000000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000021') = 'Cafe A', 'T3 the rename/merge did not rewrite the occurrence text');
END $$;

-- T4 a provider pick records the writer's text (trimmed); without text it is NULL — never a guess.
DO $$ BEGIN
  INSERT INTO public.memories (id, owner_id, title, place_id, place_display_name_at_occurrence) VALUES ('c3000000-0000-4000-8000-000000000031', 'e0000000-0000-4000-8000-000000000001', 'pick', 'fsq:pho', '  Pho 10  ');
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000031') = 'Pho 10', 'T4 pick text trimmed');
  INSERT INTO public.memories (id, owner_id, title, place_id) VALUES ('c3000000-0000-4000-8000-000000000032', 'e0000000-0000-4000-8000-000000000001', 'bare pick', 'fsq:bare');
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000032') IS NULL, 'T4 a pick without text is NULL');
  INSERT INTO public.memories (id, owner_id, title, place_id, place_display_name_at_occurrence) VALUES ('c3000000-0000-4000-8000-000000000033', 'e0000000-0000-4000-8000-000000000001', 'no place', '   ', 'Somewhere');
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000033') IS NULL, 'T4 no place, no place name');
END $$;

-- T5 a writer's text on INSERT wins over the catalog (3676's split copies the source row's text: never re-read).
DO $$ BEGIN
  INSERT INTO public.memories (id, owner_id, title, place_id, place_display_name_at_occurrence) VALUES ('c3000000-0000-4000-8000-000000000041', 'e0000000-0000-4000-8000-000000000001', 'split copy', 'f0000000-0000-4000-8000-000000000001', 'Cafe A');
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000041') = 'Cafe A', 'T5 copied text kept, not today''s catalog name');
END $$;

-- T6 the same place never rewrites its text; a row whose text is NULL takes a FIRST capture only.
DO $$ BEGIN
  UPDATE public.memories SET place_display_name_at_occurrence = 'Rewritten' WHERE id = 'c3000000-0000-4000-8000-000000000031';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000031') = 'Pho 10', 'T6 text rewrite refused');
  UPDATE public.memories SET place_id = 'fsq:pho', place_display_name_at_occurrence = 'Rewritten' WHERE id = 'c3000000-0000-4000-8000-000000000031';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000031') = 'Pho 10', 'T6 same place + new text refused');
  UPDATE public.memories SET title = 'retitled' WHERE id = 'c3000000-0000-4000-8000-000000000031';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000031') = 'Pho 10', 'T6 an unrelated edit keeps the text');
  UPDATE public.memories SET place_display_name_at_occurrence = 'Bare Pick' WHERE id = 'c3000000-0000-4000-8000-000000000032';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000032') = 'Bare Pick', 'T6 a first capture is accepted');
  UPDATE public.memories SET place_display_name_at_occurrence = 'Second' WHERE id = 'c3000000-0000-4000-8000-000000000032';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000032') = 'Bare Pick', 'T6 a second capture is refused');
END $$;

-- T7 a NEW place gets its own text, never the old place's.
DO $$ BEGIN
  -- to a catalog place, echoing the old text (what a writer that does not know the column sends): the catalog's name
  UPDATE public.memories SET place_id = 'f0000000-0000-4000-8000-000000000003' WHERE id = 'c3000000-0000-4000-8000-000000000031';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000031') = 'Ramen R', 'T7 new catalog place -> its name, not the old text');
  -- to a provider pick without text: NULL, never the old place's name
  UPDATE public.memories SET place_id = 'fsq:banh-mi' WHERE id = 'c3000000-0000-4000-8000-000000000031';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000031') IS NULL, 'T7 new pick without text -> NULL');
  -- to a provider pick with new text: the new text
  UPDATE public.memories SET place_id = 'fsq:bun-cha', place_display_name_at_occurrence = 'Bun Cha 34' WHERE id = 'c3000000-0000-4000-8000-000000000031';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000031') = 'Bun Cha 34', 'T7 new pick with text -> the text');
  -- to a provider pick, writer echoing the SAME text the old place had: treated as not given -> NULL
  UPDATE public.memories SET place_id = 'fsq:other', place_display_name_at_occurrence = 'Bun Cha 34' WHERE id = 'c3000000-0000-4000-8000-000000000031';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000031') IS NULL, 'T7 the old text echoed for a new place is not kept');
END $$;

-- T8 clearing the place clears its name.
DO $$ BEGIN
  UPDATE public.memories SET place_id = NULL WHERE id = 'c3000000-0000-4000-8000-000000000021';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000021') IS NULL, 'T8 no place, no name');
END $$;

-- T9 a legacy row: an UPDATE naming place_id with the SAME value (2711's kernel UPDATE lists every column) never backfills.
DO $$ BEGIN
  UPDATE public.memories SET place_id = place_id, title = 'kernel edit' WHERE id = 'c3000000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000001') IS NULL, 'T9 legacy row not backfilled from the catalog');
END $$;

-- T10 the grants: no client role may execute the trigger function; the CHECK is the backstop for a disabled trigger.
DO $$ BEGIN
  PERFORM pg_temp.ck(NOT has_function_privilege('anon', 'public.memory_place_occurrence_name_fill()', 'EXECUTE'), 'T10 anon cannot execute');
  PERFORM pg_temp.ck(NOT has_function_privilege('authenticated', 'public.memory_place_occurrence_name_fill()', 'EXECUTE'), 'T10 authenticated cannot execute');
END $$;

-- T11 NEGATIVE CONTROL: with the trigger disabled the same-place rewrite DOES land, so T6 measured the trigger.
DO $$ BEGIN
  ALTER TABLE public.memories DISABLE TRIGGER memory_place_occurrence_name_fill;
  UPDATE public.memories SET place_display_name_at_occurrence = 'Rewritten' WHERE id = 'c3000000-0000-4000-8000-000000000032';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000032') = 'Rewritten', 'T11 control: without the trigger the text is rewritten');
  BEGIN
    UPDATE public.memories SET place_display_name_at_occurrence = '  untrimmed  ' WHERE id = 'c3000000-0000-4000-8000-000000000032';
    RAISE EXCEPTION 'EXPECTATION FAILED: T11 the CHECK let untrimmed text through';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ALTER TABLE public.memories ENABLE TRIGGER memory_place_occurrence_name_fill;
  UPDATE public.memories SET place_display_name_at_occurrence = 'Bare Pick' WHERE id = 'c3000000-0000-4000-8000-000000000032';
  PERFORM pg_temp.ck(pg_temp.nm('c3000000-0000-4000-8000-000000000032') = 'Rewritten', 'T11 re-enabled: the text holds again');
END $$;
