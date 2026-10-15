-- Rehearsal seed for 3806 (memory_convergence_proposals). Run AFTER 3806 on a throwaway database (a fixture of the
-- touched objects, or the full chain from scripts/local-db/up.sh). See sql/rehearsals/README.md, section "3806".
-- Never against production or the CI project.
--
--   A  e6000000-…01  the owner: Memories MA (published) and MA2 (published); photos PA1, PA2, PA3
--   B  e6000000-…02  someone else: Memory MB; photo PB1
--   G  e6000000-…03  an account that will be deleted: Memory MG; photo PG1
INSERT INTO auth.users (id) VALUES
 ('e6000000-0000-4000-8000-000000000001'), ('e6000000-0000-4000-8000-000000000002'), ('e6000000-0000-4000-8000-000000000003');
INSERT INTO public.memories (id, owner_id, title, visibility, state, starts_at, ends_at) VALUES
 ('c6000000-0000-4000-8000-0000000000a1', 'e6000000-0000-4000-8000-000000000001', 'MA Fado night', 'only_me', 'published', '2026-03-02T19:00:00Z', '2026-03-02T22:00:00Z'),
 ('c6000000-0000-4000-8000-0000000000a2', 'e6000000-0000-4000-8000-000000000001', 'MA2 Walk home', 'public', 'published', '2026-03-02T20:00:00Z', '2026-03-02T23:00:00Z'),
 ('c6000000-0000-4000-8000-0000000000b1', 'e6000000-0000-4000-8000-000000000002', 'MB theirs', 'public', 'published', '2026-03-02T19:00:00Z', '2026-03-02T22:00:00Z'),
 ('c6000000-0000-4000-8000-0000000000c1', 'e6000000-0000-4000-8000-000000000003', 'MG going', 'only_me', 'published', '2026-03-02T19:00:00Z', '2026-03-02T22:00:00Z');
INSERT INTO public.media_assets (id, owner_user_id, uploader_user_id, storage_bucket, storage_path, media_type, mime_type) VALUES
 ('f6000000-0000-4000-8000-0000000000a1', 'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'post-media', 'e6000000-0000-4000-8000-000000000001/a1.jpg', 'image', 'image/jpeg'),
 ('f6000000-0000-4000-8000-0000000000a2', 'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'post-media', 'e6000000-0000-4000-8000-000000000001/a2.jpg', 'image', 'image/jpeg'),
 ('f6000000-0000-4000-8000-0000000000a3', 'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'post-media', 'e6000000-0000-4000-8000-000000000001/a3.jpg', 'image', 'image/jpeg'),
 ('f6000000-0000-4000-8000-0000000000b1', 'e6000000-0000-4000-8000-000000000002', 'e6000000-0000-4000-8000-000000000002', 'post-media', 'e6000000-0000-4000-8000-000000000002/b1.jpg', 'image', 'image/jpeg'),
 ('f6000000-0000-4000-8000-0000000000c1', 'e6000000-0000-4000-8000-000000000003', 'e6000000-0000-4000-8000-000000000003', 'post-media', 'e6000000-0000-4000-8000-000000000003/c1.jpg', 'image', 'image/jpeg');
