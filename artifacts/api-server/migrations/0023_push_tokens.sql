-- 0023_push_tokens.sql
--
-- Adds expo_push_token to profiles so the API server can send push
-- notifications via the Expo Push Notification service.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
