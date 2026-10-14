-- Rehearsal seed for 3808 (media_asset_renditions). Run BEFORE 3808 on a throwaway database built from the full chain
-- (scripts/local-db/up.sh with LOCAL_DB_TO=3808). See sql/rehearsals/README.md, section "3808". Never against
-- production or the CI project. An owner, a second user, and three canonical assets as /media/upload records them.
INSERT INTO auth.users (id) VALUES ('e8000000-0000-4000-8000-000000000001'), ('e8000000-0000-4000-8000-000000000002');
INSERT INTO public.media_assets (id, owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type, size_bytes, width, height, processing_status) VALUES
 ('a8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001', 'post-media', 'e8000000-0000-4000-8000-000000000001/1760000000001.jpg', 'image', 'image/jpeg', 1000, 2400, 1600, 'ready'),
 ('a8000000-0000-4000-8000-000000000002', 'e8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001', 'post-media', 'e8000000-0000-4000-8000-000000000001/1760000000002.mp4', 'video', 'video/mp4', 1000, NULL, NULL, 'processing'),
 ('a8000000-0000-4000-8000-000000000003', 'e8000000-0000-4000-8000-000000000002', 'e8000000-0000-4000-8000-000000000002', 'post-media', 'e8000000-0000-4000-8000-000000000002/1760000000003.jpg', 'image', 'image/jpeg', 1000, 800, 600, 'ready');
