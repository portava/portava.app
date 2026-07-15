-- 0030_message_reports
-- Stores user-submitted reports on individual messages.
-- RLS: reporters can read their own; service role writes.

create table if not exists message_reports (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null,
  reporter_id uuid not null references profiles(id) on delete cascade,
  reason      text not null check (char_length(reason) <= 200),
  created_at  timestamptz not null default now(),
  unique (message_id, reporter_id)
);

alter table message_reports enable row level security;

create policy "reporters read own" on message_reports
  for select using (reporter_id = auth.uid());
