-- Migration 0169: passport-aware entry intelligence (curated corridors)
--
-- Tables:
--   traveler_passports       — a user's saved passports (issuing country ONLY;
--                              deliberately NO passport-number column — we never
--                              store passport numbers)
--   trip_traveler_passports  — which of their passports a traveler is using on
--                              a given trip (one selection per user per trip)
--   entry_requirements       — curated visa/entry corridors keyed on
--                              (passport_country, destination_country)
--
-- HONESTY CONTRACT: this migration seeds ZERO entry_requirements rows.
-- Corridor data enters the system ONLY through the admin upsert endpoint,
-- which requires an official_source_url. Unknown corridors are surfaced to
-- clients as explicit unknowns — never guessed.
--
-- Idempotent: IF NOT EXISTS + DO $$ policy guards throughout (style: 0167).
-- Safe to re-run.

-- ── traveler_passports ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS traveler_passports (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issuing_country  CHAR(2)     NOT NULL CHECK (issuing_country ~ '^[A-Z]{2}$'),
  label            TEXT        NOT NULL DEFAULT '' CHECK (char_length(label) <= 100),
  expiry_date      DATE,
  is_primary       BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NO passport_number column, by design. Do not add one.
  UNIQUE (user_id, issuing_country, label)
);

CREATE INDEX IF NOT EXISTS traveler_passports_user_idx ON traveler_passports (user_id);

ALTER TABLE traveler_passports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'traveler_passports' AND policyname = 'traveler_passports_own'
  ) THEN
    CREATE POLICY traveler_passports_own ON traveler_passports USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'traveler_passports' AND policyname = 'traveler_passports_svc'
  ) THEN
    CREATE POLICY traveler_passports_svc ON traveler_passports FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── trip_traveler_passports ───────────────────────────────────────────────────
-- One passport selection per (trip, user). Cascades away with the trip, the
-- user, or the underlying passport row.

CREATE TABLE IF NOT EXISTS trip_traveler_passports (
  trip_id      UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  passport_id  UUID        NOT NULL REFERENCES traveler_passports(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id)
);

ALTER TABLE trip_traveler_passports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_traveler_passports' AND policyname = 'trip_traveler_passports_own'
  ) THEN
    CREATE POLICY trip_traveler_passports_own ON trip_traveler_passports USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'trip_traveler_passports' AND policyname = 'trip_traveler_passports_svc'
  ) THEN
    CREATE POLICY trip_traveler_passports_svc ON trip_traveler_passports FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── entry_requirements ────────────────────────────────────────────────────────
-- Curated corridor data. Every row MUST carry an official_source_url; rows are
-- written exclusively via the admin upsert endpoint which stamps
-- last_verified_at and verified_by.

CREATE TABLE IF NOT EXISTS entry_requirements (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_country        CHAR(2)     NOT NULL CHECK (passport_country ~ '^[A-Z]{2}$'),
  destination_country     CHAR(2)     NOT NULL CHECK (destination_country ~ '^[A-Z]{2}$'),
  status                  TEXT        NOT NULL
    CHECK (status IN ('visa_free', 'visa_on_arrival', 'evisa', 'visa_required', 'special_authorization', 'entry_restricted')),
  allowed_stay_days       INT,
  passport_validity_rule  TEXT,
  fee_text                TEXT,
  processing_time_text    TEXT,
  official_source_url     TEXT        NOT NULL,
  notes                   TEXT,
  confidence              TEXT        NOT NULL DEFAULT 'curated'
    CHECK (confidence IN ('curated', 'provider')),
  last_verified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by             UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (passport_country, destination_country)
);

CREATE INDEX IF NOT EXISTS entry_requirements_destination_idx ON entry_requirements (destination_country);

ALTER TABLE entry_requirements ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'entry_requirements' AND policyname = 'entry_requirements_read'
  ) THEN
    CREATE POLICY entry_requirements_read ON entry_requirements FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'entry_requirements' AND policyname = 'entry_requirements_svc'
  ) THEN
    CREATE POLICY entry_requirements_svc ON entry_requirements FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── Feature flag ──────────────────────────────────────────────────────────────
-- feature_flags PK column is `flag` (0037 / 0166) — never `key`.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('passport_entry_intelligence_enabled', false, 'Passport-aware visa/entry intelligence (curated corridors)')
ON CONFLICT (flag) DO NOTHING;

-- ZERO entry_requirements data rows are seeded here, on purpose.
