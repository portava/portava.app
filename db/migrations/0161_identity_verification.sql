-- 0161_identity_verification.sql
-- Portava Verified Foundation: identity verification + moderation schema.
-- Renumber this file to match the repo's next migration number before running.
--
-- PRIVACY PRINCIPLES ENCODED HERE:
--   * We NEVER store raw government-ID images, document numbers, or selfies.
--     Only opaque provider references (session ids, verification tokens).
--   * We NEVER store date of birth. Age gating stores a derived boolean only.
--   * Verification rows are deletable independently of the user for GDPR
--     erasure without breaking moderation history.

-- ============================================================
-- 1. identity_verifications
-- ============================================================
create table if not exists identity_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- which adapter handled it: 'mock' | 'stripe' | 'persona'
  provider text not null,

  -- opaque references into the provider's system. NEVER document data.
  provider_session_id text,
  provider_verification_ref text,

  -- normalized lifecycle, identical across providers:
  -- created -> pending -> processing -> verified | failed | expired | canceled
  status text not null default 'created'
    check (status in ('created','pending','processing','verified','failed','expired','canceled')),

  -- normalized failure category when status = failed
  -- (document_invalid, selfie_mismatch, underage, abandoned, provider_error, other)
  failure_reason text,

  -- derived booleans only — no DOB, no document numbers
  is_over_18 boolean,
  selfie_match boolean,

  -- ISO country of the verified document (coarse; used for compliance stats)
  document_country text,

  verified_at timestamptz,
  expires_at timestamptz,          -- re-verification horizon if we adopt one
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_identity_verifications_user
  on identity_verifications(user_id);
create index if not exists idx_identity_verifications_status
  on identity_verifications(status);
-- one active (non-terminal) verification per user
create unique index if not exists uq_identity_verifications_active
  on identity_verifications(user_id)
  where status in ('created','pending','processing');

-- ============================================================
-- 2. profiles: verification surface fields
--    (adjust table name if the profile table differs)
-- ============================================================
alter table if exists profiles
  add column if not exists verification_level text not null default 'none'
    check (verification_level in ('none','id_verified','id_selfie_verified')),
  add column if not exists verified_at timestamptz;

-- ============================================================
-- 3. moderation_reports
--    NOTE: if a reports table already exists in this repo, reconcile
--    instead of duplicating — this create is guarded but check first.
-- ============================================================
create table if not exists moderation_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete set null,

  -- what is being reported
  subject_type text not null
    check (subject_type in ('user','post','comment','message','event','review','buddy_listing')),
  subject_id text not null,
  subject_user_id uuid references auth.users(id) on delete set null,

  category text not null
    check (category in (
      'impersonation','harassment','scam_fraud','inappropriate_content',
      'safety_concern','underage','spam','other'
    )),
  details text,

  status text not null default 'open'
    check (status in ('open','reviewing','actioned','dismissed')),

  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolver_id uuid references auth.users(id),
  resolver_note text
);

create index if not exists idx_moderation_reports_status
  on moderation_reports(status);
create index if not exists idx_moderation_reports_subject_user
  on moderation_reports(subject_user_id);

-- ============================================================
-- 4. moderation_actions — audit log of enforcement
-- ============================================================
create table if not exists moderation_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references moderation_reports(id) on delete set null,
  actor_id uuid references auth.users(id),
  target_user_id uuid not null references auth.users(id) on delete cascade,

  action text not null
    check (action in ('warning','content_removed','suspension','ban','verification_revoked','no_action')),
  reason text not null,
  expires_at timestamptz,          -- for time-boxed suspensions
  created_at timestamptz not null default now()
);

create index if not exists idx_moderation_actions_target
  on moderation_actions(target_user_id);

-- ============================================================
-- 5. RLS
-- ============================================================
alter table identity_verifications enable row level security;
alter table moderation_reports enable row level security;
alter table moderation_actions enable row level security;

-- users may read their own verification rows; all writes are server-only
drop policy if exists identity_verifications_select_own on identity_verifications;
create policy identity_verifications_select_own
  on identity_verifications for select
  using (auth.uid() = user_id);

-- reporters may read their own reports; creation via server route only
drop policy if exists moderation_reports_select_own on moderation_reports;
create policy moderation_reports_select_own
  on moderation_reports for select
  using (auth.uid() = reporter_id);

-- moderation_actions: no client access at all (admin/service only) —
-- RLS enabled with no permissive policies means service-role-only.

-- ============================================================
-- Down migration
-- ============================================================
-- drop table if exists moderation_actions;
-- drop table if exists moderation_reports;
-- alter table profiles drop column if exists verification_level;
-- alter table profiles drop column if exists verified_at;
-- drop table if exists identity_verifications;
