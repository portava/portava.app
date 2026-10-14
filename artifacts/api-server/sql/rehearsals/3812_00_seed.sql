-- Rehearsal seed for 3812 (place split + Memory re-resolution proposals). Run BEFORE 3812 on a throwaway database built
-- from the full chain (scripts/local-db/up.sh with LOCAL_DB_TO=3811). See sql/rehearsals/README.md, section "3812".
-- Never against production or the CI project. The merge/unmerge history EXISTS before 3812, so the widened CHECK must keep it.
INSERT INTO auth.users (id) VALUES
 ('e3812000-0000-4000-8000-000000000001'),  -- A: owns most Memories
 ('e3812000-0000-4000-8000-000000000002'),  -- B: owns one Memory at P
 ('e3812000-0000-4000-8000-0000000000ad');  -- the admin
INSERT INTO public.feature_flags (flag, enabled, description) VALUES ('external_places_enabled', false, '2028 (seeded by the chain)')
ON CONFLICT (flag) DO NOTHING;
INSERT INTO public.places (id, name, normalized_name, primary_category, latitude, longitude, address, city, country_code, status) VALUES
 ('f3812000-0000-4000-8000-000000000001', 'Cafe A', 'cafe a', 'cafe', 10, 106, '1 Street', 'Da Nang', 'VN', 'active'),       -- P: two venues recorded as one
 ('f3812000-0000-4000-8000-000000000009', 'Elsewhere', 'elsewhere', 'cafe', 10.05, 106, NULL, 'Da Nang', 'VN', 'active');
INSERT INTO public.places (id, name, normalized_name, latitude, longitude, status, merged_into_place_id) VALUES
 ('f3812000-0000-4000-8000-0000000000d1', 'Cafe A (dup)', 'cafe a dup', 10, 106, 'duplicate', 'f3812000-0000-4000-8000-000000000001');
INSERT INTO public.external_place_references (id, place_id, provider, provider_place_id) VALUES
 ('e3812000-0000-4000-8000-0000000000a1', 'f3812000-0000-4000-8000-000000000001', 'fsq', 'r3812-a'),
 ('e3812000-0000-4000-8000-0000000000b1', 'f3812000-0000-4000-8000-000000000001', 'fsq', 'r3812-b'),
 ('e3812000-0000-4000-8000-0000000000c1', 'f3812000-0000-4000-8000-000000000009', 'fsq', 'r3812-c');
INSERT INTO public.place_merge_log (id, action, survivor_place_id, affected_place_id, admin_id, ref_count) VALUES
 ('a3812000-0000-4000-8000-000000000001', 'merge', 'f3812000-0000-4000-8000-000000000001', 'f3812000-0000-4000-8000-0000000000d1', 'e3812000-0000-4000-8000-0000000000ad', 0),
 ('a3812000-0000-4000-8000-000000000002', 'unmerge', 'f3812000-0000-4000-8000-000000000001', 'f3812000-0000-4000-8000-0000000000d1', 'e3812000-0000-4000-8000-0000000000ad', 0);
INSERT INTO public.memories (id, owner_id, title, visibility, state, place_id, location_lat, location_lng) VALUES
 ('c3812000-0000-4000-8000-000000000001', 'e3812000-0000-4000-8000-000000000001', 'at P1', 'only_me', 'published', 'f3812000-0000-4000-8000-000000000001', 10, 106),
 ('c3812000-0000-4000-8000-000000000002', 'e3812000-0000-4000-8000-000000000001', 'at P2', 'only_me', 'published', 'f3812000-0000-4000-8000-000000000001', 10, 106.000912),
 ('c3812000-0000-4000-8000-000000000003', 'e3812000-0000-4000-8000-000000000001', 'deleted', 'only_me', 'deleted', 'f3812000-0000-4000-8000-000000000001', 10, 106),
 ('c3812000-0000-4000-8000-000000000004', 'e3812000-0000-4000-8000-000000000002', 'B at P1', 'only_me', 'published', 'f3812000-0000-4000-8000-000000000001', 10, 106),
 ('c3812000-0000-4000-8000-000000000005', 'e3812000-0000-4000-8000-000000000001', 'elsewhere', 'only_me', 'published', 'f3812000-0000-4000-8000-000000000009', 10.05, 106);
