-- Migration: 0023_push_tokens.sql
-- Adds expo_push_token to profiles for Expo push notifications.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS expo_push_token text;
