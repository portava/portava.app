-- Migration 0178: Stamp Wave 2 — showcase + admire
--
-- Showcase (spec Part 11): a user curates up to 8 stamps to feature on their
-- passport, with explicit ordering — including the public passport page.
-- Admire (spec Part 13): lightweight appreciation on someone's stamp.
--
-- Both flag-gated (default FALSE). Safe to re-run.

-- ── user_stamp_showcase ──────────────────────────────────────────────────────
-- rank is 0-based display order. No UNIQUE(user_id, rank): the API replaces a
-- user's whole set atomically (delete + ranked insert), which a rank
-- constraint would fight during reorders. Cap (8) is enforced by the API.

CREATE TABLE IF NOT EXISTS user_stamp_showcase (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_stamp_id UUID        NOT NULL REFERENCES user_stamps(id) ON DELETE CASCADE,
  rank          INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, user_stamp_id)
);

CREATE INDEX IF NOT EXISTS uss_user_rank_idx ON user_stamp_showcase (user_id, rank);

ALTER TABLE user_stamp_showcase ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_stamp_showcase' AND policyname = 'uss_owner_all') THEN
    CREATE POLICY uss_owner_all ON user_stamp_showcase FOR ALL USING (user_id = auth.uid());
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_stamp_showcase' AND policyname = 'uss_svc') THEN
    CREATE POLICY uss_svc ON user_stamp_showcase FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── stamp_admires ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stamp_admires (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_stamp_id UUID        NOT NULL REFERENCES user_stamps(id) ON DELETE CASCADE,
  admirer_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_stamp_id, admirer_id)
);

CREATE INDEX IF NOT EXISTS sa_stamp_idx   ON stamp_admires (user_stamp_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sa_admirer_idx ON stamp_admires (admirer_id, created_at DESC);

ALTER TABLE stamp_admires ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'stamp_admires' AND policyname = 'sa_admirer_write') THEN
    CREATE POLICY sa_admirer_write ON stamp_admires FOR ALL USING (admirer_id = auth.uid());
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'stamp_admires' AND policyname = 'sa_svc') THEN
    CREATE POLICY sa_svc ON stamp_admires FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── Flags ────────────────────────────────────────────────────────────────────
-- feature_flags PK column is `flag` (NOT `key`).

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('stamp_showcase_enabled', FALSE, 'Stamp showcase: user-curated featured stamps (≤8, ordered) on own + public passport'),
  ('stamp_admire_enabled',   FALSE, 'Stamp admire: lightweight appreciation on visible stamps, with owner notification')
ON CONFLICT (flag) DO NOTHING;
