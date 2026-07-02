-- Migration 0076: profile_emergency_contacts
-- Profile-level emergency contacts. These are reusable across Safe Return
-- sessions and editable from Settings → Emergency Contacts.
-- Safe to re-run: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS profile_emergency_contacts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label           TEXT        NOT NULL DEFAULT '' CHECK (char_length(label) <= 100),
  name            TEXT        NOT NULL CHECK (char_length(name) <= 200),
  phone           TEXT        CHECK (char_length(phone) <= 30),
  email           TEXT        CHECK (char_length(email) <= 200),
  notify_method   TEXT        NOT NULL DEFAULT 'in_app'
    CHECK (notify_method IN ('in_app', 'sms', 'email')),
  sort_order      SMALLINT    NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pec_user_idx ON profile_emergency_contacts (user_id);

ALTER TABLE profile_emergency_contacts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profile_emergency_contacts' AND policyname = 'pec_own'
  ) THEN
    CREATE POLICY pec_own ON profile_emergency_contacts USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profile_emergency_contacts' AND policyname = 'pec_svc'
  ) THEN
    CREATE POLICY pec_svc ON profile_emergency_contacts FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
