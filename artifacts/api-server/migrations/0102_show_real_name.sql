-- 0102_show_real_name.sql
-- Universal display-name rule: real/display names are OPT-IN.
-- Every user reference defaults to @handle; a user's name is only shown to
-- others when they explicitly enable show_real_name in privacy settings.
ALTER TABLE profile_privacy_settings
  ADD COLUMN IF NOT EXISTS show_real_name boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN profile_privacy_settings.show_real_name IS
  'Opt-in: when false (default), other users only ever see this user''s @handle; name/display_name are redacted from all public API surfaces.';
