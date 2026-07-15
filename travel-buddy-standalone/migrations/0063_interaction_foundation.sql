-- ============================================================================
-- Travel Buddy — Migration 0063: Interaction Foundation
-- user_mutes, user_restrictions, user_saves, user_interaction_cooldowns,
-- reports, report_evidence, moderation_actions, user_account_states,
-- user_privacy_settings
-- Required by: POST /api/users/:id/mute, POST /api/users/:id/restrict,
--   POST /api/users/:id/save, POST /api/reports, and the interaction
--   permission engine (interactionPermissions.ts).
-- All statements use IF NOT EXISTS for idempotency.
-- Run in the Supabase SQL Editor AFTER 0015_blocks.sql.
-- ============================================================================

-- ---------- Enums ----------
do $$ begin
  create type report_target_type as enum (
    'user', 'message', 'thread', 'trip', 'post', 'place', 'event'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type report_reason_code as enum (
    'harassment', 'spam', 'hate_speech', 'violence',
    'impersonation', 'nudity', 'misinformation', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type report_severity as enum ('normal', 'high');
exception when duplicate_object then null; end $$;

do $$ begin
  create type report_status as enum ('open', 'under_review', 'resolved', 'dismissed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type account_state as enum (
    'deleted', 'deactivated', 'banned', 'suspended', 'limited', 'warned'
  );
exception when duplicate_object then null; end $$;

-- ============================================================================
-- user_mutes — viewer silences a user (posts, messages, etc.)
-- Privacy: muting is private; the muted user is never notified.
-- ============================================================================
create table if not exists user_mutes (
  id          uuid primary key default gen_random_uuid(),
  muter_id    uuid not null references profiles(id) on delete cascade,
  muted_id    uuid not null references profiles(id) on delete cascade,
  mute_types  text[] not null default array['all'],
  created_at  timestamptz not null default now(),
  unique (muter_id, muted_id),
  check (muter_id <> muted_id)
);

create index if not exists idx_user_mutes_muter  on user_mutes(muter_id);
create index if not exists idx_user_mutes_muted  on user_mutes(muted_id);

alter table user_mutes enable row level security;

drop policy if exists user_mutes_own on user_mutes;
create policy user_mutes_own on user_mutes
  using (muter_id = auth.uid())
  with check (muter_id = auth.uid());

-- ============================================================================
-- user_restrictions — soft visibility control (hides read receipts / online status)
-- The restricted user can still send message requests but cannot see receipts.
-- ============================================================================
create table if not exists user_restrictions (
  id              uuid primary key default gen_random_uuid(),
  restrictor_id   uuid not null references profiles(id) on delete cascade,
  restricted_id   uuid not null references profiles(id) on delete cascade,
  options         jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  unique (restrictor_id, restricted_id),
  check (restrictor_id <> restricted_id)
);

create index if not exists idx_user_restrictions_restrictor on user_restrictions(restrictor_id);
create index if not exists idx_user_restrictions_restricted on user_restrictions(restricted_id);

alter table user_restrictions enable row level security;

drop policy if exists user_restrictions_own on user_restrictions;
create policy user_restrictions_own on user_restrictions
  using (restrictor_id = auth.uid())
  with check (restrictor_id = auth.uid());

-- ============================================================================
-- user_saves — private profile bookmarks
-- The saved user is never notified; saves grant NO access to private content.
-- ============================================================================
create table if not exists user_saves (
  id          uuid primary key default gen_random_uuid(),
  saver_id    uuid not null references profiles(id) on delete cascade,
  saved_id    uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (saver_id, saved_id),
  check (saver_id <> saved_id)
);

create index if not exists idx_user_saves_saver on user_saves(saver_id);
create index if not exists idx_user_saves_saved on user_saves(saved_id);

alter table user_saves enable row level security;

drop policy if exists user_saves_own on user_saves;
create policy user_saves_own on user_saves
  using (saver_id = auth.uid())
  with check (saver_id = auth.uid());

-- ============================================================================
-- user_interaction_cooldowns — anti-retaliation gate
-- Prevents a user from contacting a specific target for a cooldown window.
-- Written by the high-severity report handler; enforced by the permission engine.
-- ============================================================================
create table if not exists user_interaction_cooldowns (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  target_user_id  uuid not null references profiles(id) on delete cascade,
  cooldown_type   text not null,
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, target_user_id, cooldown_type)
);

create index if not exists idx_interaction_cooldowns_user   on user_interaction_cooldowns(user_id);
create index if not exists idx_interaction_cooldowns_target on user_interaction_cooldowns(target_user_id);
create index if not exists idx_interaction_cooldowns_expiry on user_interaction_cooldowns(expires_at)
  where expires_at is not null;

alter table user_interaction_cooldowns enable row level security;

drop policy if exists interaction_cooldowns_own on user_interaction_cooldowns;
create policy interaction_cooldowns_own on user_interaction_cooldowns
  for select using (user_id = auth.uid() or target_user_id = auth.uid());

-- ============================================================================
-- reports — unified cross-domain report table
-- Reporter identity is never disclosed to the reported party.
-- Rows are never deleted; status transitions are the only mutations.
-- ============================================================================
create table if not exists reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references profiles(id) on delete cascade,
  target_type     report_target_type not null,
  target_id       uuid not null,
  reason_code     report_reason_code not null,
  reason_detail   text,
  context_type    text,
  context_id      uuid,
  severity        report_severity not null default 'normal',
  status          report_status not null default 'open',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists trg_reports_updated on reports;
create trigger trg_reports_updated before update on reports
  for each row execute function set_updated_at();

create index if not exists idx_reports_reporter on reports(reporter_id);
create index if not exists idx_reports_target   on reports(target_type, target_id);
create index if not exists idx_reports_status   on reports(status);

alter table reports enable row level security;

drop policy if exists reports_own_read on reports;
create policy reports_own_read on reports
  for select using (reporter_id = auth.uid());

-- ============================================================================
-- report_evidence — evidence attached to a report (fire-and-forget)
-- ============================================================================
create table if not exists report_evidence (
  id             uuid primary key default gen_random_uuid(),
  report_id      uuid not null references reports(id) on delete cascade,
  evidence_type  text not null,
  content_ref    uuid,
  metadata       jsonb not null default '{}',
  created_at     timestamptz not null default now()
);

create index if not exists idx_report_evidence_report on report_evidence(report_id);

alter table report_evidence enable row level security;

drop policy if exists report_evidence_own_read on report_evidence;
create policy report_evidence_own_read on report_evidence
  for select using (
    exists (
      select 1 from reports r
      where r.id = report_evidence.report_id
        and r.reporter_id = auth.uid()
    )
  );

-- ============================================================================
-- user_account_states — suspended / banned / limited / deactivated states
-- Queried by the permission engine (interactionPermissions.ts priority 1).
-- ============================================================================
create table if not exists user_account_states (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  state       account_state not null,
  reason      text,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, state)
);

create index if not exists idx_account_states_user on user_account_states(user_id);

alter table user_account_states enable row level security;

-- Service role manages; users can read their own state
drop policy if exists account_states_own_read on user_account_states;
create policy account_states_own_read on user_account_states
  for select using (user_id = auth.uid());

-- ============================================================================
-- moderation_actions — admin/moderator action log
-- Queried by the permission engine (priority 3b) to signal safety warnings.
-- ============================================================================
create table if not exists moderation_actions (
  id              uuid primary key default gen_random_uuid(),
  moderator_id    uuid references profiles(id) on delete set null,
  target_user_id  uuid not null references profiles(id) on delete cascade,
  action_type     text not null,
  reason          text,
  metadata        jsonb not null default '{}',
  expires_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_moderation_actions_target on moderation_actions(target_user_id);

alter table moderation_actions enable row level security;
-- Service role manages; no user self-read policy (actions are admin-internal)

-- ============================================================================
-- user_privacy_settings — per-user privacy config
-- Queried by the permission engine (priority 4 — age restriction gate).
-- ============================================================================
create table if not exists user_privacy_settings (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references profiles(id) on delete cascade,
  age_restriction_enabled boolean not null default false,
  profile_visibility      text not null default 'public',
  who_can_tag             text not null default 'anyone',
  online_status           text not null default 'everyone',
  location_sharing        text not null default 'private',
  updated_at              timestamptz not null default now(),
  unique (user_id)
);

drop trigger if exists trg_privacy_settings_updated on user_privacy_settings;
create trigger trg_privacy_settings_updated before update on user_privacy_settings
  for each row execute function set_updated_at();

create index if not exists idx_privacy_settings_user on user_privacy_settings(user_id);

alter table user_privacy_settings enable row level security;

drop policy if exists privacy_settings_own on user_privacy_settings;
create policy privacy_settings_own on user_privacy_settings
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================================
-- Done. These tables are required by:
--   POST/DELETE /api/users/:id/mute         → user_mutes
--   POST/DELETE /api/users/:id/restrict     → user_restrictions
--   POST/DELETE /api/users/:id/save         → user_saves
--   POST        /api/reports                → reports, report_evidence,
--                                             user_restrictions (auto-restrict),
--                                             user_interaction_cooldowns (cooldown)
--   interactionPermissions engine           → user_account_states,
--                                             moderation_actions,
--                                             user_privacy_settings
-- ============================================================================
