-- ============================================================================
-- Travel Buddy — Migration 0009
-- Message auto-translation pipeline
--
-- Adds:
--   * Language preferences to profiles table
--   * original_language + language_detection_source columns to messages
--   * message_translations table (one row per message × recipient × target language)
--
-- Run in the Supabase SQL editor AFTER 0008_messaging.sql.
-- ============================================================================

-- ---------- Language preference columns on profiles ----------
alter table profiles
  add column if not exists preferred_message_language text not null default 'en',
  add column if not exists auto_translate_messages     boolean not null default true,
  add column if not exists show_original_messages      boolean not null default false,
  add column if not exists translation_updated_at      timestamptz;

-- ---------- Language columns on messages ----------
alter table messages
  add column if not exists original_language           text,
  add column if not exists language_detection_source   text;   -- 'provider' | 'sender_preference' | 'default'

-- ---------- Translation status enum ----------
do $$ begin
  create type translation_status as enum ('pending', 'translated', 'failed', 'skipped');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- message_translations
-- One row per (message × recipient × target_language).
-- Populated by the API server translation pipeline after message delivery.
-- ============================================================================
create table if not exists message_translations (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid not null references messages(id) on delete cascade,
  recipient_id      uuid not null references profiles(id) on delete cascade,
  source_language   text not null,
  target_language   text not null,
  translated_body   text,
  provider          text,                          -- 'mock' | 'openai' | ...
  status            translation_status not null default 'pending',
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (message_id, recipient_id)               -- one translation per recipient per message
);

drop trigger if exists trg_message_translations_updated on message_translations;
create trigger trg_message_translations_updated
  before update on message_translations
  for each row execute function set_updated_at();

create index if not exists idx_mt_message    on message_translations(message_id);
create index if not exists idx_mt_recipient  on message_translations(recipient_id);
create index if not exists idx_mt_status     on message_translations(status);

-- ============================================================================
-- RLS — sender and recipient may read their own rows; no one else.
-- Only the API server (service role) may insert or update.
-- ============================================================================
alter table message_translations enable row level security;

drop policy if exists mtr_select on message_translations;
create policy mtr_select on message_translations for select
  using (
    auth.uid() = recipient_id
    or exists (
      select 1 from messages m where m.id = message_id and m.sender_id = auth.uid()
    )
  );

drop policy if exists mtr_insert on message_translations;
create policy mtr_insert on message_translations for insert
  with check (false);   -- API server (service role) only

drop policy if exists mtr_update on message_translations;
create policy mtr_update on message_translations for update
  using (false);        -- API server (service role) only

-- ============================================================================
-- Done.
-- ============================================================================
