-- 0031_thread_reports
-- Stores user-submitted reports on threads (conversations).
-- RLS: reporters can read their own; service role writes.

create table if not exists thread_reports (
  id          uuid primary key default gen_random_uuid(),
  thread_id   text not null,
  reporter_id uuid not null references profiles(id) on delete cascade,
  reason      text not null check (char_length(reason) <= 200),
  created_at  timestamptz not null default now(),
  unique (thread_id, reporter_id)
);

alter table thread_reports enable row level security;

create policy "reporters read own" on thread_reports
  for select using (reporter_id = auth.uid());
