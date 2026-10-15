-- Rehearsal seed for 3811 (memory_snapshots). Run BEFORE 3811 on a throwaway database built from the full chain
-- (scripts/local-db/up.sh with LOCAL_DB_TO=3811) or the PGlite fixture. See sql/rehearsals/README.md, section "3811".
-- Never against production or the CI project. These Memories EXIST before 3811, so they must have no version afterwards
-- (3811 writes no backfill: open owner question Q-H35).
INSERT INTO auth.users (id) VALUES ('e1100000-0000-4000-8000-000000000001'), ('e1100000-0000-4000-8000-000000000002');
INSERT INTO public.memories (id, owner_id, title, visibility, state, place_id, updated_at) VALUES
 ('c3811000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001', 'legacy at a place', 'public', 'published', 'fsq:legacy', '2026-01-01T00:00:00Z'),
 ('c3811000-0000-4000-8000-000000000002', 'e1100000-0000-4000-8000-000000000001', 'legacy without a place', 'only_me', 'published', NULL, '2026-01-01T00:00:00Z');
