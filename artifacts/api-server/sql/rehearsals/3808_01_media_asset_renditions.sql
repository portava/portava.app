-- Behavioural rehearsal for 3808 (media_asset_renditions), after 3808_00_seed.sql and 3808. Each DO block RAISES on a
-- failed expectation; T<n> NOTICEs are assertions that held. Negative controls (N<n>) run inside a savepoint that is
-- rolled back, and REQUIRE the opposite outcome once the guard under test is removed — so the positive case is
-- evidence about the guard, not about the fixture. See sql/rehearsals/README.md, section "3808".
-- Never against production or the CI project.
CREATE OR REPLACE FUNCTION pg_temp.ck(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPECTATION FAILED: %', msg; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refused(stmt text, constraint_name text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RETURN false;
EXCEPTION WHEN check_violation THEN
  RETURN SQLERRM LIKE '%' || constraint_name || '%';
END $$;

-- T1 a sound image ladder and a video ladder (viewer = original, no size) are accepted.
DO $$ BEGIN
  INSERT INTO public.media_asset_renditions (asset_id, rendition, storage_path, width, height, mime) VALUES
   ('a8000000-0000-4000-8000-000000000001', 'original', 'e8000000-0000-4000-8000-000000000001/1760000000001.jpg', 2400, 1600, 'image/jpeg'),
   ('a8000000-0000-4000-8000-000000000001', 'viewer', 'e8000000-0000-4000-8000-000000000001/1760000000001.feed.jpg', 1500, 1000, 'image/jpeg'),
   ('a8000000-0000-4000-8000-000000000001', 'card', 'e8000000-0000-4000-8000-000000000001/1760000000001.thumb.jpg', 400, 267, 'image/jpeg'),
   ('a8000000-0000-4000-8000-000000000001', 'tiny', 'e8000000-0000-4000-8000-000000000001/1760000000001.tiny.jpg', 64, 43, 'image/jpeg'),
   ('a8000000-0000-4000-8000-000000000002', 'original', 'e8000000-0000-4000-8000-000000000001/1760000000002.mp4', NULL, NULL, 'video/mp4'),
   ('a8000000-0000-4000-8000-000000000002', 'viewer', 'e8000000-0000-4000-8000-000000000001/1760000000002.mp4', NULL, NULL, 'video/mp4');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.media_asset_renditions) = 6, 'T1 six rows');
  RAISE NOTICE 'T1 pass';
END $$;

-- T2 each rung is held to its size, mime and path.
DO $$
DECLARE a text := 'a8000000-0000-4000-8000-000000000003'; p text := 'e8000000-0000-4000-8000-000000000002/1760000000003';
BEGIN
  PERFORM pg_temp.ck(pg_temp.refused(format($s$INSERT INTO public.media_asset_renditions VALUES (%L, 'tiny', %L, 65, 40, 'image/jpeg')$s$, a, p || '.tiny.jpg'), 'ladder_check'), 'T2 a 65 px tiny');
  PERFORM pg_temp.ck(pg_temp.refused(format($s$INSERT INTO public.media_asset_renditions VALUES (%L, 'card', %L, 401, 300, 'image/jpeg')$s$, a, p || '.thumb.jpg'), 'ladder_check'), 'T2 a 401 px card');
  PERFORM pg_temp.ck(pg_temp.refused(format($s$INSERT INTO public.media_asset_renditions VALUES (%L, 'viewer', %L, 1501, 1000, 'image/jpeg')$s$, a, p || '.feed.jpg'), 'ladder_check'), 'T2 a 1501 px image viewer');
  PERFORM pg_temp.ck(pg_temp.refused(format($s$INSERT INTO public.media_asset_renditions VALUES (%L, 'original', %L, 10, 10, 'image/gif')$s$, a, p || '.gif'), 'mime_check'), 'T2 an unknown mime');
  PERFORM pg_temp.ck(pg_temp.refused(format($s$INSERT INTO public.media_asset_renditions VALUES (%L, 'original', %L, 10, NULL, 'image/jpeg')$s$, a, p || '.jpg'), 'dims_check'), 'T2 half a size');
  PERFORM pg_temp.ck(pg_temp.refused(format($s$INSERT INTO public.media_asset_renditions VALUES (%L, 'original', %L, 10, 10, 'image/jpeg')$s$, a, 'memories/' || p || '.jpg'), 'path_check'), 'T2 a client-writable prefix');
  PERFORM pg_temp.ck(pg_temp.refused(format($s$INSERT INTO public.media_asset_renditions VALUES (%L, 'original', %L, 10, 10, 'image/jpeg')$s$, a, 'e8/../x.jpg'), 'path_check'), 'T2 a traversal');
  PERFORM pg_temp.ck((SELECT count(*) FROM public.media_asset_renditions WHERE asset_id = a::uuid) = 0, 'T2 nothing stored');
  RAISE NOTICE 'T2 pass';
END $$;

-- N1 negative control: WITHOUT the ladder CHECK the 65 px tiny is accepted — so T2's refusal is the CHECK's.
DO $$ BEGIN
  BEGIN
    ALTER TABLE public.media_asset_renditions DROP CONSTRAINT media_asset_renditions_ladder_check;
    INSERT INTO public.media_asset_renditions VALUES ('a8000000-0000-4000-8000-000000000003', 'tiny', 'e8000000-0000-4000-8000-000000000002/1760000000003.tiny.jpg', 65, 40, 'image/jpeg');
    RAISE EXCEPTION 'N1 control reached';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'N1 control reached' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.ck(EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_asset_renditions_ladder_check'), 'N1 the control was rolled back');
  RAISE NOTICE 'N1 pass';
END $$;

-- T3 one rung per asset: a second 'tiny' for the same asset is a key violation, not a second row.
DO $$ BEGIN
  BEGIN
    INSERT INTO public.media_asset_renditions VALUES ('a8000000-0000-4000-8000-000000000001', 'tiny', 'e8000000-0000-4000-8000-000000000001/other.tiny.jpg', 10, 10, 'image/jpeg');
    RAISE EXCEPTION 'EXPECTATION FAILED: T3 a second tiny was stored';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO public.media_asset_renditions VALUES ('a8000000-0000-4000-8000-000000000001', 'tiny', 'e8000000-0000-4000-8000-000000000001/other.tiny.jpg', 10, 10, 'image/jpeg') ON CONFLICT (asset_id, rendition) DO NOTHING;
  PERFORM pg_temp.ck((SELECT storage_path FROM public.media_asset_renditions WHERE asset_id = 'a8000000-0000-4000-8000-000000000001' AND rendition = 'tiny') LIKE '%1760000000001.tiny.jpg', 'T3 DO NOTHING keeps the first registration');
  RAISE NOTICE 'T3 pass';
END $$;

-- T4 the client roles see nothing and write nothing; service_role reads, registers, purges, never rewrites.
DO $$ BEGIN
  PERFORM pg_temp.ck(NOT has_table_privilege('anon', 'public.media_asset_renditions', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.media_asset_renditions', 'SELECT'), 'T4 no client SELECT');
  PERFORM pg_temp.ck(NOT has_table_privilege('authenticated', 'public.media_asset_renditions', 'INSERT'), 'T4 no client INSERT');
  PERFORM pg_temp.ck(has_table_privilege('service_role', 'public.media_asset_renditions', 'SELECT') AND has_table_privilege('service_role', 'public.media_asset_renditions', 'INSERT') AND has_table_privilege('service_role', 'public.media_asset_renditions', 'DELETE'), 'T4 service_role SELECT/INSERT/DELETE');
  PERFORM pg_temp.ck(NOT has_table_privilege('service_role', 'public.media_asset_renditions', 'UPDATE'), 'T4 service_role never rewrites');
  RAISE NOTICE 'T4 pass';
END $$;

-- T5 the erasure cascade: deleting the asset takes its ladder; deleting the account takes the asset and the ladder.
DO $$ BEGIN
  DELETE FROM public.media_assets WHERE id = 'a8000000-0000-4000-8000-000000000002';
  PERFORM pg_temp.ck((SELECT count(*) FROM public.media_asset_renditions WHERE asset_id = 'a8000000-0000-4000-8000-000000000002') = 0, 'T5 asset delete cascades');
  DELETE FROM auth.users WHERE id = 'e8000000-0000-4000-8000-000000000001';
  PERFORM pg_temp.ck((SELECT count(*) FROM public.media_asset_renditions WHERE asset_id = 'a8000000-0000-4000-8000-000000000001') = 0, 'T5 account delete cascades through media_assets');
  RAISE NOTICE 'T5 pass';
END $$;

-- N2 negative control: with the cascade replaced by NO ACTION, the account delete is REFUSED — so T5's erasure is the FK's.
DO $$ BEGIN
  INSERT INTO auth.users (id) VALUES ('e8000000-0000-4000-8000-000000000009');
  INSERT INTO public.media_assets (id, owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, size_bytes, width, height, processing_status)
   VALUES ('a8000000-0000-4000-8000-000000000009', 'e8000000-0000-4000-8000-000000000009', 'e8000000-0000-4000-8000-000000000009', 'post-media', 'e8000000-0000-4000-8000-000000000009/9.jpg', 'image', 'image/jpeg', 1, 10, 10, 'ready');
  INSERT INTO public.media_asset_renditions VALUES ('a8000000-0000-4000-8000-000000000009', 'original', 'e8000000-0000-4000-8000-000000000009/9.jpg', 10, 10, 'image/jpeg');
  BEGIN
    ALTER TABLE public.media_asset_renditions DROP CONSTRAINT media_asset_renditions_asset_id_fkey;
    ALTER TABLE public.media_asset_renditions ADD CONSTRAINT media_asset_renditions_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets (id);
    DELETE FROM public.media_assets WHERE id = 'a8000000-0000-4000-8000-000000000009';
    RAISE EXCEPTION 'EXPECTATION FAILED: N2 the control did not block the delete';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  DELETE FROM public.media_assets WHERE id = 'a8000000-0000-4000-8000-000000000009';
  PERFORM pg_temp.ck((SELECT count(*) FROM public.media_asset_renditions WHERE asset_id = 'a8000000-0000-4000-8000-000000000009') = 0, 'N2 with the real cascade restored the delete takes the ladder');
  RAISE NOTICE 'N2 pass';
END $$;
