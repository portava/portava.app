-- LOCAL ONLY. Minimal schemas for the additional aggregate sources.
create table public.wall_telemetry_events(event_name text,occurred_at timestamptz,payload jsonb);
create table public.map_telemetry_events(event_name text,received_at timestamptz,payload jsonb);
create table public.trips(created_at timestamptz,start_date date,end_date date);
create table public.events(created_at timestamptz,starts_at timestamptz,ends_at timestamptz,going_count integer,waitlist_count integer);
create table public.highlights(created_at timestamptz,archived_at timestamptz,deleted_at timestamptz,expires_at timestamptz);
create table public.memories(created_at timestamptz,starts_at timestamptz,ends_at timestamptz);
create table public.user_stamps(created_at timestamptz,is_revoked boolean);
insert into public.wall_telemetry_events values('wall_feed_open',date_trunc('hour',now())-interval '1 hour','{"secret":"never-copy-me"}');
insert into public.map_telemetry_events values('map_opened',date_trunc('hour',now())-interval '1 hour','{"lat":1,"private":"never-copy-me"}');
insert into public.trips values(date_trunc('hour',now())-interval '1 hour','2026-11-13','2026-11-12');
