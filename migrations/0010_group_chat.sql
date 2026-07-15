-- ============================================================================
-- Travel Buddy — Migration 0010
-- Group chat: trip threads + trusted circle threads
--
-- Adds group-chat context columns to message_threads, a left_at column to
-- message_thread_members for member-removal tracking, and tightens the RLS
-- policies so removed members can no longer read thread content.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend message_threads with group-chat context columns.
-- ---------------------------------------------------------------------------
alter table message_threads
  add column if not exists thread_type      text not null default 'direct'
    check (thread_type in ('direct', 'trip', 'circle')),
  add column if not exists trip_id          uuid references trips(id) on delete set null,
  add column if not exists circle_owner_id  uuid references profiles(id) on delete set null,
  add column if not exists title            text;

-- ---------------------------------------------------------------------------
-- 2. Enforce uniqueness: one group thread per trip / per circle-owner.
-- ---------------------------------------------------------------------------
create unique index if not exists uniq_thread_trip
  on message_threads(trip_id) where thread_type = 'trip';

create unique index if not exists uniq_thread_circle
  on message_threads(circle_owner_id) where thread_type = 'circle';

-- Integrity: trip threads must carry trip_id; circle threads must carry
-- circle_owner_id; direct threads must carry neither.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_thread_context'
      and conrelid = 'message_threads'::regclass
  ) then
    alter table message_threads
      add constraint chk_thread_context check (
        (thread_type = 'trip'   and trip_id is not null         and circle_owner_id is null) or
        (thread_type = 'circle' and circle_owner_id is not null and trip_id is null        ) or
        (thread_type = 'direct' and trip_id is null             and circle_owner_id is null)
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Add left_at to message_thread_members for removed-member tracking.
-- ---------------------------------------------------------------------------
alter table message_thread_members
  add column if not exists left_at timestamptz;

-- Index for fast "active members" queries (left_at IS NULL).
create index if not exists idx_mtm_active
  on message_thread_members(thread_id) where left_at is null;

-- ---------------------------------------------------------------------------
-- 4. Tighten RLS on message_threads: only active members see the thread.
-- ---------------------------------------------------------------------------
drop policy if exists mt_select on message_threads;
create policy mt_select on message_threads for select
  using (
    exists (
      select 1 from message_thread_members mtm
      where mtm.thread_id = id
        and mtm.user_id   = auth.uid()
        and mtm.left_at  is null
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Tighten RLS on messages: only active thread members see messages.
-- ---------------------------------------------------------------------------
drop policy if exists msg_select on messages;
create policy msg_select on messages for select
  using (
    exists (
      select 1 from message_thread_members mtm
      where mtm.thread_id = thread_id
        and mtm.user_id   = auth.uid()
        and mtm.left_at  is null
    )
  );
