-- ============================================================================
-- Travel Buddy — Migration 0002: Live Map foundation (DATA + PRIVACY ONLY)
-- map_pins, trip_pins, user_locations, user_location_privacy, circle_memberships.
-- Privacy is enforced in the DB via RLS. NO UI renders live locations this pass.
-- Defaults: location sharing OFF / private. Ghost mode hides always. Stale pings hidden.
-- Run in the Supabase SQL editor AFTER 0001_spine.sql.
-- ============================================================================

-- ---------- Enums ----------
do $$ begin
  create type location_sharing as enum ('private','circle','public');
exception when duplicate_object then null; end $$;

do $$ begin
  create type circle_status as enum ('pending','accepted','blocked');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- circle_memberships — accepted social connections (both directions stored)
-- ============================================================================
create table if not exists circle_memberships (
  user_id    uuid not null references profiles(id) on delete cascade,
  other_id   uuid not null references profiles(id) on delete cascade,
  status     circle_status not null default 'pending',
  created_at timestamptz not null default now(),
  primary key (user_id, other_id),
  check (user_id <> other_id)
);
create index if not exists idx_circle_user on circle_memberships(user_id);

-- are A and B mutually accepted circle members?
create or replace function in_accepted_circle(viewer uuid, target uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from circle_memberships a
    join circle_memberships b
      on a.user_id = b.other_id and a.other_id = b.user_id
    where a.user_id = viewer and a.other_id = target
      and a.status = 'accepted' and b.status = 'accepted'
  );
$$;

-- ============================================================================
-- user_location_privacy — one row per user. Defaults to PRIVATE + ghost off.
-- ============================================================================
create table if not exists user_location_privacy (
  user_id       uuid primary key references profiles(id) on delete cascade,
  sharing       location_sharing not null default 'private',  -- DEFAULT OFF/PRIVATE
  ghost_mode    boolean not null default false,                -- ghost always hides
  stale_minutes int not null default 30,                       -- pings older than this are hidden
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_locpriv_updated on user_location_privacy;
create trigger trg_locpriv_updated before update on user_location_privacy
  for each row execute function set_updated_at();

-- ============================================================================
-- user_locations — latest approximate location ping per user.
-- Stored coarse (approx lat/lng). Exposure is gated entirely by RLS below.
-- ============================================================================
create table if not exists user_locations (
  user_id     uuid primary key references profiles(id) on delete cascade,
  approx_lat  double precision,
  approx_lng  double precision,
  city        text,
  updated_at  timestamptz not null default now()
);

-- can `viewer` see `target`'s live location? (the core privacy gate)
create or replace function can_see_location(viewer uuid, target uuid)
returns boolean language sql security definer stable as $$
  select case
    when viewer = target then true                         -- always see yourself
    else exists (
      select 1
      from user_location_privacy p
      join user_locations l on l.user_id = p.user_id
      where p.user_id = target
        and p.ghost_mode = false                            -- ghost hides always
        and l.updated_at > now() - make_interval(mins => p.stale_minutes)  -- stale hidden
        and (
          p.sharing = 'public'
          or (p.sharing = 'circle' and in_accepted_circle(viewer, target))
        )
    )
  end;
$$;

-- ============================================================================
-- map_pins — user-created location pins (saved spots). May be trip-linked.
-- ============================================================================
create table if not exists map_pins (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  trip_id     uuid references trips(id) on delete set null,  -- optional trip link
  title       text not null,
  category    text,
  lat         double precision,
  lng         double precision,
  city        text,
  is_private  boolean not null default true,                 -- pins private by default
  created_at  timestamptz not null default now()
);
create index if not exists idx_map_pins_owner on map_pins(owner_id);
create index if not exists idx_map_pins_trip on map_pins(trip_id);

-- ============================================================================
-- RLS — the enforcement boundary. Frontend hiding is NOT trusted.
-- ============================================================================
alter table circle_memberships     enable row level security;
alter table user_location_privacy  enable row level security;
alter table user_locations         enable row level security;
alter table map_pins               enable row level security;

-- circle_memberships: you see/manage rows where you're the user_id
drop policy if exists circle_select on circle_memberships;
create policy circle_select on circle_memberships for select using (user_id = auth.uid() or other_id = auth.uid());
drop policy if exists circle_insert on circle_memberships;
create policy circle_insert on circle_memberships for insert with check (user_id = auth.uid());
drop policy if exists circle_update on circle_memberships;
create policy circle_update on circle_memberships for update using (user_id = auth.uid());
drop policy if exists circle_delete on circle_memberships;
create policy circle_delete on circle_memberships for delete using (user_id = auth.uid());

-- user_location_privacy: only your own row
drop policy if exists locpriv_all on user_location_privacy;
create policy locpriv_select on user_location_privacy for select using (user_id = auth.uid());
create policy locpriv_insert on user_location_privacy for insert with check (user_id = auth.uid());
create policy locpriv_update on user_location_privacy for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- user_locations: write only your own; READ gated by can_see_location()
drop policy if exists loc_select on user_locations;
create policy loc_select on user_locations for select using (can_see_location(auth.uid(), user_id));
drop policy if exists loc_insert on user_locations;
create policy loc_insert on user_locations for insert with check (user_id = auth.uid());
drop policy if exists loc_update on user_locations;
create policy loc_update on user_locations for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- map_pins: owner always; others only if pin not private AND they can see the trip (if linked)
drop policy if exists pins_select on map_pins;
create policy pins_select on map_pins for select using (
  owner_id = auth.uid()
  or (is_private = false and (trip_id is null or can_see_trip(trip_id)))
);
drop policy if exists pins_insert on map_pins;
create policy pins_insert on map_pins for insert with check (owner_id = auth.uid());
drop policy if exists pins_update on map_pins;
create policy pins_update on map_pins for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists pins_delete on map_pins;
create policy pins_delete on map_pins for delete using (owner_id = auth.uid());

-- ============================================================================
-- Default privacy row on signup-profile creation is handled app-side
-- (ensureProfile also upserts a private user_location_privacy row).
-- New users are PRIVATE until they explicitly opt in.
-- ============================================================================
