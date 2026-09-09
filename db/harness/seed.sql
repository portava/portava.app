TRUNCATE public.trip_stages, public.trip_events, public.trip_outbox, public.trip_command_receipts, public.trip_members, public.trips, public.profiles CASCADE;
INSERT INTO public.profiles (id, handle) VALUES
  ('11111111-1111-1111-1111-111111111111','owner'),
  ('22222222-2222-2222-2222-222222222222','stranger');
INSERT INTO public.trips (id, owner_id, title, status, visibility, version)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','T','planning','private',0);
INSERT INTO public.trip_members (trip_id, user_id, role, status)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','owner','accepted');
