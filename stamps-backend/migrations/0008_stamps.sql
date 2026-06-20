-- ============================================================================
-- Travel Buddy — Backend migration 0008
-- GPS-earned stamps: stamps table + upsert helper function.
--
-- RULES:
--   * A stamp is earned ONLY when location_verified=true on the postcard.
--   * The server decides verification (verifyLocation() in locationVerify.ts).
--   * No client-supplied flag is accepted for stamp_eligible or location_verified.
--   * Revisiting a city increments check_in_count; does NOT create a new stamp.
-- ============================================================================

-- ============================================================================
-- stamps
-- One row per (user, kind, location_city) — upsert increments check_in_count.
-- ============================================================================
create table if not exists stamps (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles(id) on delete cascade,
  kind             text not null
                   check (kind in ('city','plan','gem','safe','host','perk')),
  label            text not null,       -- "CEBU" (uppercase city label)
  sublabel         text,                -- "PH · 2026"
  location_city    text,                -- normalized lowercase, used for dedup
  location_country text,
  first_earned_at  timestamptz not null default now(),
  last_earned_at   timestamptz not null default now(),
  check_in_count   int not null default 1,
  locked           boolean not null default false,
  postcard_id      uuid references passport_postcards(id) on delete set null,

  constraint unique_user_kind_city unique (user_id, kind, location_city)
);

create index if not exists idx_stamps_user    on stamps(user_id);
create index if not exists idx_stamps_kind    on stamps(kind);
create index if not exists idx_stamps_city    on stamps(location_city);

alter table stamps enable row level security;

drop policy if exists stamps_select on stamps;
create policy stamps_select on stamps for select
  using (true);  -- stamps are public (label only, no GPS in this table)

drop policy if exists stamps_insert on stamps;
create policy stamps_insert on stamps for insert
  with check (false);  -- only API server (service role) writes stamps

drop policy if exists stamps_update on stamps;
create policy stamps_update on stamps for update
  using (false);  -- only API server (service role) updates stamps

-- ============================================================================
-- upsert_city_stamp — atomic increment, safe against concurrent check-ins
-- ============================================================================
create or replace function upsert_city_stamp(
  p_user_id         uuid,
  p_location_city   text,
  p_location_country text,
  p_label           text,
  p_sublabel        text,
  p_postcard_id     uuid
) returns uuid
language plpgsql
security definer  -- runs as superuser so it can bypass RLS on stamps
as $$
declare
  v_id uuid;
begin
  insert into stamps (
    user_id, kind, label, sublabel,
    location_city, location_country,
    first_earned_at, last_earned_at,
    check_in_count, locked, postcard_id
  )
  values (
    p_user_id, 'city', p_label, p_sublabel,
    lower(coalesce(p_location_city, '')), p_location_country,
    now(), now(),
    1, false, p_postcard_id
  )
  on conflict (user_id, kind, location_city) do update
    set last_earned_at  = now(),
        check_in_count  = stamps.check_in_count + 1,
        sublabel        = excluded.sublabel,
        postcard_id     = coalesce(excluded.postcard_id, stamps.postcard_id)
  returning id into v_id;

  return v_id;
end;
$$;
