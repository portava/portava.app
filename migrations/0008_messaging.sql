-- ============================================================================
-- Travel Buddy — Migration 0008
-- Messaging permissions + message requests + threads + messages
--
-- HARD RULES:
--   * Messaging access is INDEPENDENT of follows, friendship, circles, trips.
--   * No private posts, trip-only posts, live location, exact GPS, circle
--     memberships, or trip memberships are exposed through any messaging table.
--   * Thread access is gated ONLY by message_thread_members rows.
--   * A message request does NOT expose private content on either side.
--   * Friendship / follow / circle / trip membership can INFLUENCE the permission
--     verdict (via message_privacy settings), but a follow alone never creates a
--     thread or grants access to messages.
-- ============================================================================

-- ============================================================================
-- user_message_settings
-- One row per user; default = allow everyone to send message requests.
-- ============================================================================
create table if not exists user_message_settings (
  user_id                     uuid primary key references profiles(id) on delete cascade,
  message_privacy             text not null default 'everyone'
                              check (message_privacy in (
                                'everyone', 'followers', 'following', 'friends',
                                'trip_members', 'no_one'
                              )),
  allow_message_requests      boolean not null default true,
  allow_trip_member_messages  boolean not null default true,
  allow_circle_member_messages boolean not null default true,
  updated_at                  timestamptz not null default now()
);

alter table user_message_settings enable row level security;

drop policy if exists ums_select_own on user_message_settings;
create policy ums_select_own on user_message_settings for select
  using (auth.uid() = user_id);

drop policy if exists ums_upsert_own on user_message_settings;
create policy ums_upsert_own on user_message_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================================
-- message_requests
-- Non-friend users send a message request first. Unique per sender+recipient
-- while any row is in 'pending' state (handled by partial unique index).
-- ============================================================================
create table if not exists message_requests (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references profiles(id) on delete cascade,
  recipient_id  uuid not null references profiles(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  preview_text  text,
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,

  constraint no_self_message_request check (sender_id <> recipient_id)
);

create index if not exists idx_mr_sender    on message_requests(sender_id);
create index if not exists idx_mr_recipient on message_requests(recipient_id);
create index if not exists idx_mr_status    on message_requests(status);

-- Only one pending request per ordered pair at a time.
create unique index if not exists idx_mr_unique_pending
  on message_requests(sender_id, recipient_id)
  where status = 'pending';

alter table message_requests enable row level security;

drop policy if exists mr_select on message_requests;
create policy mr_select on message_requests for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists mr_insert on message_requests;
create policy mr_insert on message_requests for insert
  with check (false);  -- only API server (service role) may insert

drop policy if exists mr_update on message_requests;
create policy mr_update on message_requests for update
  using (false);       -- only API server (service role) may update

-- ============================================================================
-- message_threads
-- ============================================================================
create table if not exists message_threads (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz,
  status          text not null default 'active'
                  check (status in ('active', 'archived'))
);

alter table message_threads enable row level security;

drop policy if exists mt_select on message_threads;
create policy mt_select on message_threads for select
  using (
    exists (
      select 1 from message_thread_members mtm
      where mtm.thread_id = id and mtm.user_id = auth.uid()
    )
  );

-- ============================================================================
-- message_thread_members
-- ============================================================================
create table if not exists message_thread_members (
  thread_id   uuid not null references message_threads(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  role        text not null default 'member'
              check (role in ('member', 'admin')),
  joined_at   timestamptz not null default now(),
  muted_at    timestamptz,
  archived_at timestamptz,

  primary key (thread_id, user_id)
);

create index if not exists idx_mtm_thread on message_thread_members(thread_id);
create index if not exists idx_mtm_user   on message_thread_members(user_id);

alter table message_thread_members enable row level security;

drop policy if exists mtm_select on message_thread_members;
create policy mtm_select on message_thread_members for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from message_thread_members self
      where self.thread_id = thread_id and self.user_id = auth.uid()
    )
  );

drop policy if exists mtm_insert on message_thread_members;
create policy mtm_insert on message_thread_members for insert
  with check (false);  -- only API server (service role) may insert

-- ============================================================================
-- messages
-- ============================================================================
create table if not exists messages (
  id                        uuid primary key default gen_random_uuid(),
  thread_id                 uuid not null references message_threads(id) on delete cascade,
  sender_id                 uuid not null references profiles(id) on delete cascade,
  body                      text not null,
  sender_original_language  text,          -- stub for auto-translation pipeline
  translated_body_json      jsonb,         -- stub: { "es": "...", "fr": "..." }
  created_at                timestamptz not null default now(),
  edited_at                 timestamptz,
  deleted_at                timestamptz    -- soft-delete; render as tombstone
);

create index if not exists idx_msg_thread on messages(thread_id, created_at);
create index if not exists idx_msg_sender on messages(sender_id);

alter table messages enable row level security;

drop policy if exists msg_select on messages;
create policy msg_select on messages for select
  using (
    exists (
      select 1 from message_thread_members mtm
      where mtm.thread_id = thread_id and mtm.user_id = auth.uid()
    )
  );

drop policy if exists msg_insert on messages;
create policy msg_insert on messages for insert
  with check (false);  -- only API server (service role) may insert

drop policy if exists msg_update on messages;
create policy msg_update on messages for update
  using (false);       -- only API server (service role) may update (soft-delete/edit)
