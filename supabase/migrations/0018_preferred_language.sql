-- Migration 0018: Add preferred_language to profiles
--
-- preferred_language (nullable text, BCP-47) is the user-chosen translation
-- target language set in Edit Profile settings. When set it takes priority
-- over preferred_message_language in the translation pipeline.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_language TEXT;
