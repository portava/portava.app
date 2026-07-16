-- 0137: Quiet hours should be evaluated in the user's own timezone, not the
-- server clock. Adds a nullable IANA timezone column to notification_preferences.
-- NULL = unknown → fall back to server-local evaluation (previous behaviour).
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN notification_preferences.timezone IS
  'IANA timezone (e.g. Europe/Lisbon) used to evaluate quiet hours; NULL falls back to server time.';
