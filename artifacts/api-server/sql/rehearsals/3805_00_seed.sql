-- Rehearsal seed for 3805 (the shared-experience anchor). Run AFTER 3805 on a throwaway database (a fixture of the
-- touched objects, or the full chain from scripts/local-db/up.sh). See sql/rehearsals/README.md, section "3805".
-- Never against production or the CI project.
--
--   H  e5000000-…01  the host: owns MH, on which B and C hold APPROVED tags, D a PENDING one, E a REMOVED one
--   B  e5000000-…02  owns MB (only_me)          C  e5000000-…03  owns MC (public)
--   D  e5000000-…04  pending tag on MH          E  e5000000-…05  removed tag on MH
--   X  e5000000-…06  owns MX; tagged APPROVED on MB (so B could try to invite from MB); B is tagged APPROVED on MX
INSERT INTO auth.users (id) VALUES
 ('e5000000-0000-4000-8000-000000000001'), ('e5000000-0000-4000-8000-000000000002'), ('e5000000-0000-4000-8000-000000000003'),
 ('e5000000-0000-4000-8000-000000000004'), ('e5000000-0000-4000-8000-000000000005'), ('e5000000-0000-4000-8000-000000000006');
INSERT INTO public.memories (id, owner_id, title, visibility, state) VALUES
 ('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000001', 'MH host''s night', 'friends_only', 'published'),
 ('c5000000-0000-4000-8000-0000000000b1', 'e5000000-0000-4000-8000-000000000002', 'MB B''s own', 'only_me', 'published'),
 ('c5000000-0000-4000-8000-0000000000c1', 'e5000000-0000-4000-8000-000000000003', 'MC C''s own', 'public', 'published'),
 ('c5000000-0000-4000-8000-0000000000c2', 'e5000000-0000-4000-8000-000000000003', 'MC2 C''s deleted', 'public', 'deleted'),
 ('c5000000-0000-4000-8000-0000000000d1', 'e5000000-0000-4000-8000-000000000006', 'MX X''s own', 'public', 'published'),
 ('c5000000-0000-4000-8000-0000000000a2', 'e5000000-0000-4000-8000-000000000001', 'MH2 host''s removed', 'public', 'removed');
INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES
 ('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000002', 'approved'),
 ('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000003', 'approved'),
 ('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000004', 'pending'),
 ('c5000000-0000-4000-8000-0000000000a1', 'e5000000-0000-4000-8000-000000000005', 'removed'),
 ('c5000000-0000-4000-8000-0000000000b1', 'e5000000-0000-4000-8000-000000000006', 'approved'),
 ('c5000000-0000-4000-8000-0000000000a2', 'e5000000-0000-4000-8000-000000000002', 'approved'),
 ('c5000000-0000-4000-8000-0000000000d1', 'e5000000-0000-4000-8000-000000000002', 'approved');
