-- ============================================================================
-- Travel Buddy — Backend migration 0007
-- Friend requests + friendships + circle/trip invite bridges.
--
-- HARD RULES (enforced here + in API):
--   * Friendship is SOCIAL DISCOVERY only.
--   * A friendship grants NOTHING sensitive: no circle_memberships,
--     no trip_members, no live location, no private posts, no trip_only posts,
--     no exact GPS, no private Passport access.
--   * circle_memberships is written ONLY when a circle_invite is explicitly
--     accepted. Friendship alone NEVER creates a circle_memberships row.
--   * trip_members with role='invited' is written ONLY via an explicit trip
--     invite from the trip owner. Friendship alone NEVER creates trip_members.
-- ============================================================================

-- ============================================================================
-- friend_requests
-- unique(requester_id, recipient_id) — one row per ordered pair, any status.
-- To re-request after decline, the requester's row is updated to 'pending'.
-- ============================================================================
create table if not exists friend_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references profiles(id) on delete cascade,
  recipient_id  uuid not null references profiles(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  updated_at    timestamptz not null default now(),

  constraint no_self_request   check (requester_id <> recipient_id),
  constraint unique_request_pair unique (requester_id, recipient_id)
);

create index if not exists idx_fr_requester on friend_requests(requester_id);
create index if not exists idx_fr_recipient on friend_requests(recipient_id);
create index if not exists idx_fr_status    on friend_requests(status);

alter table friend_requests enable row level security;

drop policy if exists fr_select on friend_requests;
create policy fr_select on friend_requests for select
  using (auth.uid() = requester_id or auth.uid() = recipient_id);

drop policy if exists fr_insert on friend_requests;
create policy fr_insert on friend_requests for insert
  with check (auth.uid() = requester_id);

drop policy if exists fr_update on friend_requests;
create policy fr_update on friend_requests for update
  using (auth.uid() = requester_id or auth.uid() = recipient_id);

-- ============================================================================
-- user_friendships
-- Normalized pair: user_a < user_b always (enforced by constraint).
-- This makes friendship lookup a single indexed key regardless of direction.
-- ============================================================================
create table if not exists user_friendships (
  user_a              uuid not null references profiles(id) on delete cascade,
  user_b              uuid not null references profiles(id) on delete cascade,
  accepted_request_id uuid references friend_requests(id) on delete set null,
  created_at          timestamptz not null default now(),

  primary key (user_a, user_b),
  constraint normalized_pair check (user_a < user_b)
);

create index if not exists idx_uf_user_a on user_friendships(user_a);
create index if not exists idx_uf_user_b on user_friendships(user_b);

alter table user_friendships enable row level security;

drop policy if exists uf_select on user_friendships;
create policy uf_select on user_friendships for select using (true);

-- ============================================================================
-- circle_invites
-- Accepting this invite is the ONLY mechanism that creates a circle_memberships
-- row. Friendship alone never writes to circle_memberships.
-- ============================================================================
create table if not exists circle_invites (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references profiles(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,

  constraint no_self_circle_invite check (owner_id <> recipient_id),
  constraint unique_circle_invite  unique (owner_id, recipient_id)
);

create index if not exists idx_ci_owner     on circle_invites(owner_id);
create index if not exists idx_ci_recipient on circle_invites(recipient_id);

alter table circle_invites enable row level security;

drop policy if exists ci_select on circle_invites;
create policy ci_select on circle_invites for select
  using (auth.uid() = owner_id or auth.uid() = recipient_id);

drop policy if exists ci_insert on circle_invites;
create policy ci_insert on circle_invites for insert
  with check (auth.uid() = owner_id);

-- ============================================================================
-- circle_memberships  (create if not exists — may already exist in the DB)
-- ============================================================================
create table if not exists circle_memberships (
  owner_id   uuid not null references profiles(id) on delete cascade,
  member_id  uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (owner_id, member_id),
  constraint no_self_member check (owner_id <> member_id)
);

create index if not exists idx_cm_owner  on circle_memberships(owner_id);
create index if not exists idx_cm_member on circle_memberships(member_id);

alter table circle_memberships enable row level security;

drop policy if exists cm_select on circle_memberships;
create policy cm_select on circle_memberships for select
  using (auth.uid() = owner_id or auth.uid() = member_id);

drop policy if exists cm_insert on circle_memberships;
create policy cm_insert on circle_memberships for insert
  with check (false);  -- only API server (service role) may insert
