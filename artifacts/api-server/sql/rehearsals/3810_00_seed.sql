-- Rehearsal seed for 3810 (memory_visibility_policies and memory_visibility_policy_effective). Run BEFORE 3810 on a
-- throwaway database: the full chain (scripts/local-db/up.sh) or the PGlite fixture of the touched objects. See
-- sql/rehearsals/README.md, section "3810". Never against production or the CI project. These Memories EXIST before
-- 3810, so the view must show them with no ceiling, and 3810 must not touch them.
INSERT INTO auth.users (id) VALUES ('e3810000-0000-4000-8000-000000000001'), ('e3810000-0000-4000-8000-000000000002');
INSERT INTO public.memories (id, owner_id, title, visibility, state, allowed_user_ids, hidden_user_ids, location_precision, updated_at) VALUES
 ('c3810000-0000-4000-8000-000000000001', 'e3810000-0000-4000-8000-000000000001', 'public, city rung', 'public', 'published', '{}', '{e3810000-0000-4000-8000-000000000002}', 'city', '2026-01-01T00:00:00Z'),
 ('c3810000-0000-4000-8000-000000000002', 'e3810000-0000-4000-8000-000000000001', 'crew',              'trip_crew', 'published', '{}', '{}', 'exact', '2026-01-01T00:00:00Z'),
 ('c3810000-0000-4000-8000-000000000003', 'e3810000-0000-4000-8000-000000000002', 'the other owner',   'public', 'published', '{}', '{}', 'exact', '2026-01-01T00:00:00Z');
