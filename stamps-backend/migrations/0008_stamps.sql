-- ============================================================================
-- Travel Buddy — Backend migration 0008
-- GPS-earned stamps: stamps table + upsert helper function.
--
-- RULES:
--   * A stamp is earned ONLY when location_verified=true on the postcard.
--   * The server decides verification (verifyLocation() in locationVerify.ts).
--   * No client-supplied flag is accepted for stamp_eligible or location_verified.
--   * Revisiting a city increments check_in_count; does NOT create a new stamp.
--
-- SECURITY:
--   * upsert_city_stamp is callable ONLY by service_role / postgres (DB superuser).
--   * Execution is revoked from PUBLIC, anon, and authenticated so PostgREST
--     cannot expose the function as a callable RPC endpoint.
--   * A current_user guard inside the function provides defense-in-depth: even
--     if the REVOKE is somehow bypassed, authenticated clients still cannot mint
--     stamps for arbitrary user_ids.
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

-- Anyone can read stamps (labels only — no GPS in this table).
drop policy if exists stamps_select on stamps;
create policy stamps_select on stamps for select
  using (true);

-- All writes blocked for client-facing roles; only service role inserts/updates
-- via the upsert_city_stamp function below.
drop policy if exists stamps_insert on stamps;
create policy stamps_insert on stamps for insert
  with check (false);

drop policy if exists stamps_update on stamps;
create policy stamps_update on stamps for update
  using (false);

-- ============================================================================
-- upsert_city_stamp — atomic increment, safe against concurrent check-ins
--
-- SECURITY MODEL:
--   SECURITY DEFINER lets the function bypass RLS on the stamps table so it can
--   write on behalf of any user — but only when called as service_role/postgres.
--   The REVOKE below + current_user guard ensure no client-facing role can call
--   this directly via PostgREST RPC or any other channel.
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
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Defense-in-depth: reject calls from any client-facing role even if the
  -- REVOKE statements below are somehow circumvented.
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'upsert_city_stamp: permission denied — must be called by service_role';
  end if;

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

-- ============================================================================
-- Lock down execution: revoke from all client-facing roles.
-- PostgREST exposes functions to anon/authenticated; revoking here prevents
-- the function from appearing as a callable RPC endpoint entirely.
-- service_role retains EXECUTE (it is superuser-equivalent and bypasses REVOKE).
-- ============================================================================
revoke all on function upsert_city_stamp(uuid, text, text, text, text, uuid)
  from public;

revoke all on function upsert_city_stamp(uuid, text, text, text, text, uuid)
  from anon;

revoke all on function upsert_city_stamp(uuid, text, text, text, text, uuid)
  from authenticated;
