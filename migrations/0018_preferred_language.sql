-- ============================================================================
-- Travel Buddy — Migration 0018
-- User preferred language for translations
--
-- Adds preferred_language (BCP-47 code, nullable) to profiles.
-- Null means fall back to preferred_message_language or device locale.
-- The translation pipeline checks this field first when picking the
-- target language for each recipient.
--
-- Run in the Supabase SQL editor.
-- ============================================================================

alter table profiles
  add column if not exists preferred_language text;

comment on column profiles.preferred_language is
  'BCP-47 language code (e.g. en, zh-TW, ja) chosen by the user in Settings. '
  'Overrides preferred_message_language in the translation pipeline. '
  'Null = fall back to preferred_message_language / device locale.';
