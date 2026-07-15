-- Migration 0017: job_health table
-- Tracks the last successful run time of background jobs (starting with the
-- daily_briefs cleanup job) so the health endpoint can report accurate
-- staleness across server restarts.

create table if not exists job_health (
  job        text        primary key,
  last_run_at timestamptz not null,
  updated_at  timestamptz not null default now()
);

-- RLS: table is server-side only; no client access needed.
alter table job_health enable row level security;

-- No RLS policies — only the service role key may read/write this table.
-- The API server uses the service role client for all job_health operations.

comment on table job_health is
  'Persistent last-run timestamps for background jobs. Written by the API server (service role). Used by /healthz/cleanup to detect stale jobs across restarts.';
