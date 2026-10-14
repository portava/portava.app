-- Rehearsal seed for 3803/3804 (MemoryType, occurrence-time place text). Run BEFORE 3803 on a throwaway database
-- built from the full chain (scripts/local-db/up.sh with LOCAL_DB_TO=3803). See sql/rehearsals/README.md, section "3803-3804".
-- Never against production or the CI project. These rows EXIST before the migrations, so they must read NULL afterwards.
INSERT INTO auth.users (id) VALUES ('e0000000-0000-4000-8000-000000000001'), ('e0000000-0000-4000-8000-000000000002');
INSERT INTO public.places (id, name, normalized_name) VALUES
 ('f0000000-0000-4000-8000-000000000001', 'Cafe A', 'cafe a'),
 ('f0000000-0000-4000-8000-000000000002', 'Cafe B', 'cafe b'),
 ('f0000000-0000-4000-8000-000000000003', 'Ramen R', 'ramen r');
INSERT INTO public.memories (id, owner_id, title, visibility, state, place_id, updated_at) VALUES
 ('c3000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'legacy at a catalog place', 'public', 'published', 'f0000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z'),
 ('c3000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'legacy at a provider pick', 'public', 'published', 'fsq:legacy', '2026-01-01T00:00:00Z'),
 ('c3000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001', 'legacy without a place', 'only_me', 'published', NULL, '2026-01-01T00:00:00Z');
