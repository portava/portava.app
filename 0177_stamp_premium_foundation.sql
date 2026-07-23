-- Migration 0177: Stamp premium foundation (Stamp Wave 1)
--
-- Phase 1 of the Stamp System Master Upgrade (per the 2026-07-23 Phase 0
-- stamp audit): destination identity metadata, premium fields on the
-- canonical v2 tables, artwork QC/thumbnail/composition columns, and the
-- rollout flag. NO behavior changes until stamp_premium_rendering_enabled
-- is turned on — the generation worker keeps its legacy path when off.
--
-- Safe to re-run: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.

-- ── 1. destination_identities ────────────────────────────────────────────────
-- One deliberate palette + motif per destination. The composition engine
-- refuses to invent colors: catalog entries resolve to one of these rows,
-- or to a deterministic curated fallback palette in code.

CREATE TABLE IF NOT EXISTS destination_identities (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_key TEXT        NOT NULL UNIQUE,          -- e.g. 'tokyo-jp'
  city         TEXT,                                  -- display city (null for country-level identities)
  country      TEXT        NOT NULL,
  country_code TEXT        NOT NULL,                  -- ISO-3166 alpha-2, uppercase
  palette      JSONB       NOT NULL,                  -- {primary, secondary, accent, background, border, highlight, paper}
  motif        TEXT        NOT NULL DEFAULT 'generic',-- hero-scene / prompt motif key
  wide_focus   NUMERIC     NOT NULL DEFAULT 0.45,     -- vertical crop focus for wide (landscape) windows
  status       TEXT        NOT NULL DEFAULT 'active', -- active | draft | retired
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS di_country_city_idx ON destination_identities (country_code, city);

ALTER TABLE destination_identities ENABLE ROW LEVEL SECURITY;

-- Reference data: readable by any authenticated user; writes via service role only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'destination_identities' AND policyname = 'di_read') THEN
    CREATE POLICY di_read ON destination_identities FOR SELECT USING (auth.role() IN ('authenticated', 'service_role'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'destination_identities' AND policyname = 'di_svc') THEN
    CREATE POLICY di_svc ON destination_identities FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- Launch identity seeds (palettes match the approved composition prototype).
INSERT INTO destination_identities (identity_key, city, country, country_code, palette, motif, wide_focus) VALUES
  ('tokyo-jp', 'Tokyo', 'Japan', 'JP',
   '{"primary":"#2B3A67","secondary":"#C63D2F","accent":"#F5B7C5","background":"#1A2447","border":"#2B3A67","highlight":"#E8B04B","paper":"#F6F1E7"}',
   'tokyo', 0.48),
  ('cebu-ph', 'Cebu', 'Philippines', 'PH',
   '{"primary":"#0E7490","secondary":"#14B8A6","accent":"#F4A73B","background":"#0A5A73","border":"#0E7490","highlight":"#FCD34D","paper":"#F4FAF8"}',
   'cebu', 0.52),
  ('paris-fr', 'Paris', 'France', 'FR',
   '{"primary":"#1F2A50","secondary":"#7C2D3E","accent":"#C9A227","background":"#EFE7D5","border":"#1F2A50","highlight":"#C9A227","paper":"#F7F2E6"}',
   'paris', 0.66),
  ('bangkok-th', 'Bangkok', 'Thailand', 'TH',
   '{"primary":"#8C2F1B","secondary":"#D97706","accent":"#EBB434","background":"#5C1A10","border":"#8C2F1B","highlight":"#F3C969","paper":"#FBF4E4"}',
   'bangkok', 0.5),
  ('reykjavik-is', 'Reykjavík', 'Iceland', 'IS',
   '{"primary":"#0B3B5A","secondary":"#0FA3B1","accent":"#7CE577","background":"#071B2E","border":"#0B3B5A","highlight":"#B7F0EE","paper":"#EFF6F9"}',
   'iceland', 0.45)
ON CONFLICT (identity_key) DO NOTHING;

-- ── 2. universal_stamp_catalog: identity link ────────────────────────────────
-- Nullable override; when null the composition engine resolves by city/country
-- match, then falls back to the deterministic curated palette.

ALTER TABLE universal_stamp_catalog ADD COLUMN IF NOT EXISTS identity_key TEXT;

-- ── 3. stamp_definitions: premium fields + 5-tier rarity ─────────────────────

ALTER TABLE stamp_definitions ADD COLUMN IF NOT EXISTS template_family  TEXT;    -- seal|portrait|landscape|square|pennant (null → derived from stamp_type)
ALTER TABLE stamp_definitions ADD COLUMN IF NOT EXISTS edition_size     INTEGER; -- null → open edition
ALTER TABLE stamp_definitions ADD COLUMN IF NOT EXISTS is_limited       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stamp_definitions ADD COLUMN IF NOT EXISTS display_priority INTEGER NOT NULL DEFAULT 0;

-- Unify rarity to the 5-tier enum (adds 'epic' between rare and legendary).
-- Drops whatever CHECK currently constrains rarity (name unknown across
-- environments) and installs the canonical 5-tier check.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'stamp_definitions'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%rarity%'
  LOOP
    EXECUTE format('ALTER TABLE stamp_definitions DROP CONSTRAINT %I', c.conname);
  END LOOP;
  BEGIN
    ALTER TABLE stamp_definitions ADD CONSTRAINT stamp_definitions_rarity_check
      CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- ── 4. stamp_artwork_versions: QC / thumbnails / composition manifest ────────

ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS width          INTEGER;
ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS height         INTEGER;
ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS format         TEXT;
ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS thumbnail_path TEXT;
ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS thumbnail_url  TEXT;
ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS hero_path      TEXT;   -- raw AI hero art (pre-composition), kept for recomposition
ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS qc_status      TEXT NOT NULL DEFAULT 'unchecked'; -- unchecked | passed | failed
ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS qc_metadata    JSONB;
ALTER TABLE stamp_artwork_versions ADD COLUMN IF NOT EXISTS composition    JSONB;  -- layer manifest (engine version, shape, rarity, identity_key, layers)

-- ── 5. Rollout flag ──────────────────────────────────────────────────────────
-- feature_flags PK column is `flag` (NOT `key` — see 0166 / featureFlagColumnGuard).

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('stamp_premium_rendering_enabled', FALSE,
   'Stamp premium composition engine: AI hero art + server-composited borders/typography/rarity layers, QC, thumbnails')
ON CONFLICT (flag) DO NOTHING;
