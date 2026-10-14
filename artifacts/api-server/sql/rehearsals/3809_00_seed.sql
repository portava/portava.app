-- Rehearsal seed for 3809 (memory_media_segments). Run BEFORE 3809 on a throwaway database. See
-- sql/rehearsals/README.md, section "3809". Never against production or the CI project.
-- Two owners; a Memory with a video, a second video and a photo; the second owner's Memory with its own video.
-- These rows EXIST before the migration, so 3809 must leave every one of them exactly as it was.
INSERT INTO auth.users (id) VALUES ('e9000000-0000-4000-8000-000000000001'), ('e9000000-0000-4000-8000-000000000002');
INSERT INTO public.memories (id, owner_id, title, visibility, state, updated_at) VALUES
 ('c9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 'night market', 'public', 'published', '2026-01-01T00:00:00Z'),
 ('c9000000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000002', 'someone else''s', 'public', 'published', '2026-01-01T00:00:00Z');
INSERT INTO public.memory_items (id, memory_id, media_url, media_type, position) VALUES
 ('d9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'post-media/e9000000-0000-4000-8000-000000000001/1760000000000.mp4', 'video/mp4', 0),
 ('d9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001', 'post-media/e9000000-0000-4000-8000-000000000001/1760000000001.mp4', 'video/mp4', 1),
 ('d9000000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000001', 'post-media/e9000000-0000-4000-8000-000000000001/1760000000002.jpg', 'image/jpeg', 2),
 ('d9000000-0000-4000-8000-000000000004', 'c9000000-0000-4000-8000-000000000002', 'post-media/e9000000-0000-4000-8000-000000000002/1760000000003.mp4', 'video/mp4', 0);
