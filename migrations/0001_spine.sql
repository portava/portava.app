-- ============================================================================
-- Travel Buddy — Backend spine migration 0001
-- Profiles + Trips + trip_members, with RLS. Supabase / Postgres.
-- REST-first; designed so Realtime can be enabled later with no model change.
-- Run in the Supabase SQL editor.
-- ============================================================================

-- ---------- Enums ----------
do $$ begin
  create type trip_status as enum ('planning','upcoming','active','completed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type trip_visibility as enum ('public','buddies','private','invite');
exception when duplicate_object then null; end $$;

do $$ begin
  create type member_role as enum ('owner','member','invited');
exception when duplicate_object then null; end $$;

-- ---------- updated_at trigger ----------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ============================================================================
-- profiles  (1:1 with auth.users)
-- ============================================================================
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  handle        text unique not null,
  name          text not null,
  avatar_url    text,
  home_city     text,
  home_country  text,
  current_city  text,
  travel_style  text,
  interests     text[] not null default '{}',
  verified      boolean not null default false,
  open_to_meet  boolean not null default false,
  is_private    boolean not null default false,
  bio           text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_profiles_updated on profiles;
create trigger trg_profiles_updated before update on profiles
  for each row execute function set_updated_at();

-- auto-create a profile row when a user signs up
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, handle, name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'handle', split_part(new.email,'@',1)),
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================================
-- trips
-- ============================================================================
create table if not exists trips (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references profiles(id) on delete cascade,
  title               text not null,
  destination_city    text not null,
  destination_country text,
  neighborhoods       text[] not null default '{}',
  start_date          date,
  end_date            date,
  status              trip_status not null default 'planning',
  visibility          trip_visibility not null default 'private',
  travel_style        text,
  open_to_meet        boolean not null default false,
  cover_url           text,
  progress            int not null default 0 check (progress between 0 and 100),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists trg_trips_updated on trips;
create trigger trg_trips_updated before update on trips
  for each row execute function set_updated_at();

create index if not exists idx_trips_owner on trips(owner_id);

-- ============================================================================
-- trip_members
-- ============================================================================
create table if not exists trip_members (
  trip_id    uuid not null references trips(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  role       member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

create index if not exists idx_trip_members_user on trip_members(user_id);

-- owner is always a member (keep membership consistent)
create or replace function add_owner_as_member()
returns trigger language plpgsql security definer as $$
begin
  insert into trip_members (trip_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (trip_id, user_id) do update set role = 'owner';
  return new;
end $$;

drop trigger if exists trg_trip_owner_member on trips;
create trigger trg_trip_owner_member after insert on trips
  for each row execute function add_owner_as_member();

-- ============================================================================
-- Helper: can the current user see this trip?  (avoids RLS recursion)
-- ============================================================================
create or replace function can_see_trip(t_id uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from trips t where t.id = t_id and (
      t.owner_id = auth.uid()
      or t.visibility = 'public'
      or exists (select 1 from trip_members m where m.trip_id = t.id and m.user_id = auth.uid())
    )
  );
$$;

-- shared-trip check for profile visibility
create or replace function shares_trip_with(other uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1
    from trip_members me
    join trip_members them on them.trip_id = me.trip_id
    where me.user_id = auth.uid() and them.user_id = other
  );
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table profiles     enable row level security;
alter table trips        enable row level security;
alter table trip_members enable row level security;

-- profiles ---------------------------------------------------------------
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select using (
  id = auth.uid() or is_private = false or shares_trip_with(id)
);

drop policy if exists profiles_insert on profiles;
create policy profiles_insert on profiles for insert with check (id = auth.uid());

drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- trips ------------------------------------------------------------------
drop policy if exists trips_select on trips;
create policy trips_select on trips for select using (can_see_trip(id));

drop policy if exists trips_insert on trips;
create policy trips_insert on trips for insert with check (owner_id = auth.uid());

drop policy if exists trips_update on trips;
create policy trips_update on trips for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists trips_delete on trips;
create policy trips_delete on trips for delete using (owner_id = auth.uid());

-- trip_members -----------------------------------------------------------
drop policy if exists trip_members_select on trip_members;
create policy trip_members_select on trip_members for select using (can_see_trip(trip_id));

drop policy if exists trip_members_insert on trip_members;
create policy trip_members_insert on trip_members for insert with check (
  exists (select 1 from trips t where t.id = trip_id and t.owner_id = auth.uid())
);

drop policy if exists trip_members_delete on trip_members;
create policy trip_members_delete on trip_members for delete using (
  exists (select 1 from trips t where t.id = trip_id and t.owner_id = auth.uid())
);

-- ============================================================================
-- Done. Next migrations add: plans, attachments, availability, messaging.
-- ============================================================================
