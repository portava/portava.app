-- Migration 2057: hidden_gems — Add-a-Gem creation flow columns
--
-- The "Add a Gem" submission form captures four additional fields beyond the
-- original hidden_gems schema:
--
--   accessibility     — how easy the gem is to reach:
--                       'easy' | 'moderate' | 'difficult' | NULL (unknown)
--   crowd_level       — typical busyness:
--                       'rarely_crowded' | 'sometimes_crowded' | 'often_crowded' | NULL
--   source_confirmation — how the submitter knows this gem is real:
--                       'been_there' | 'seen_online' | 'heard_from_friend' | NULL
--   visibility        — who can see this gem:
--                       'public' (default) | 'friends_only' | 'private'
--
-- All columns are nullable TEXT (accessibility, crowd_level,
-- source_confirmation) or TEXT NOT NULL DEFAULT 'public' (visibility) so
-- existing rows are unaffected.
--
-- These columns are written by HiddenGemService.ts and read by the gem detail
-- and moderation endpoints.  Without them, the service silently drops
-- submitted values (PGRST204 on insert if the column is absent).

ALTER TABLE hidden_gems
  ADD COLUMN IF NOT EXISTS accessibility       text,
  ADD COLUMN IF NOT EXISTS crowd_level         text,
  ADD COLUMN IF NOT EXISTS source_confirmation text,
  ADD COLUMN IF NOT EXISTS visibility          text NOT NULL DEFAULT 'public';
