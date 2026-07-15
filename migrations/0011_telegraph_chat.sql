-- ============================================================================
-- Travel Buddy — Migration 0011
-- Telegraph Smart Suggestions in Chat
--
-- Adds:
--   * telegraph_chat_suggestions — per-user, per-thread suggestion tracking
--   * Profile columns for per-context Telegraph on/off toggles
--   * RLS: users can only read/write their own suggestion rows
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Profile columns: Telegraph settings
-- ----------------------------------------------------------------------------
alter table profiles
  add column if not exists show_telegraph_dm     boolean not null default true,
  add column if not exists show_telegraph_trip   boolean not null default true,
  add column if not exists show_telegraph_circle boolean not null default true;

-- ----------------------------------------------------------------------------
-- 2. telegraph_chat_suggestions
-- ----------------------------------------------------------------------------
create table if not exists telegraph_chat_suggestions (
  id                uuid primary key default gen_random_uuid(),
  thread_id         uuid not null references message_threads(id) on delete cascade,
  user_id           uuid not null references profiles(id) on delete cascade,
  trip_id           uuid references trips(id) on delete set null,
  circle_id         uuid references profiles(id) on delete set null,
  source_message_id uuid references messages(id) on delete set null,
  intent_type       text not null,
  recommendation_id text,
  title             text not null,
  reason            text not null,
  category          text not null default 'activity',
  action_type       text not null default 'view_place'
                    check (action_type in (
                      'add_to_plan', 'create_meetup', 'start_time_poll',
                      'view_place', 'dismiss'
                    )),
  status            text not null default 'shown'
                    check (status in ('shown', 'dismissed', 'acted')),
  location_context  text,
  time_context      text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '4 hours'),
  acted_on_at       timestamptz,
  dismissed_at      timestamptz
);

create index if not exists idx_tcs_thread_user
  on telegraph_chat_suggestions(thread_id, user_id);
create index if not exists idx_tcs_user_status
  on telegraph_chat_suggestions(user_id, status);
create index if not exists idx_tcs_expires
  on telegraph_chat_suggestions(expires_at);

alter table telegraph_chat_suggestions enable row level security;

drop policy if exists tcs_select_own on telegraph_chat_suggestions;
create policy tcs_select_own on telegraph_chat_suggestions for select
  using (auth.uid() = user_id);

drop policy if exists tcs_insert on telegraph_chat_suggestions;
create policy tcs_insert on telegraph_chat_suggestions for insert
  with check (false);

drop policy if exists tcs_update_own on telegraph_chat_suggestions;
create policy tcs_update_own on telegraph_chat_suggestions for update
  using (false);
