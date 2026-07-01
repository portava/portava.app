-- Migration 0075: Stamp artwork definitions and per-stamp artwork overrides
-- Applied: 2026-07-01
--
-- Adds two structures:
--   stamp_artwork_definitions — per-type artwork templates (admin-configurable)
--   artwork_override JSONB    — per-row custom artwork on passport_stamps
--
-- The mobile resolver uses JavaScript constants as defaults; these tables
-- are consulted by the admin preview endpoint and future server-side rendering.

-- ── stamp_artwork_definitions ─────────────────────────────────────────────
-- One row per (stamp_type, rarity) pair. Admins can customize per-type art
-- without a deploy. All columns map 1:1 to StampArtworkDef fields.

CREATE TABLE IF NOT EXISTS stamp_artwork_definitions (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  stamp_type      text         NOT NULL,
  rarity          text         NOT NULL CHECK (rarity IN (
    'common', 'uncommon', 'rare', 'epic', 'legendary'
  )),

  -- Visual identity
  shape           text         NOT NULL DEFAULT 'oval' CHECK (shape IN (
    'oval', 'round', 'rect', 'hexagon'
  )),
  border_style    text         NOT NULL DEFAULT 'single' CHECK (border_style IN (
    'single', 'double', 'sawtooth', 'wave', 'dotted'
  )),
  border_weight   smallint     NOT NULL DEFAULT 1 CHECK (border_weight BETWEEN 1 AND 4),
  accent          text         NOT NULL,          -- HEX color, e.g. '#0A3D4A'
  background      text         NOT NULL,          -- HEX color
  pattern         text         NOT NULL DEFAULT 'solid' CHECK (pattern IN (
    'solid', 'radial', 'grid', 'dots', 'diagonal'
  )),
  texture         text         NOT NULL DEFAULT 'paper' CHECK (texture IN (
    'paper', 'ink', 'foil', 'worn'
  )),
  icon_key        text         NOT NULL,          -- lucide icon name
  category_label  text         NOT NULL,          -- e.g. 'CITY'
  caption_text    text,                           -- e.g. 'DIVING' (optional)

  -- Flags
  has_shimmer     boolean      NOT NULL DEFAULT false,
  has_glow        boolean      NOT NULL DEFAULT false,

  -- Admin metadata
  notes           text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),

  UNIQUE (stamp_type, rarity)
);

COMMENT ON TABLE stamp_artwork_definitions IS
  'Admin-configurable artwork template per (stamp_type, rarity) pair. '
  'The mobile resolver uses JS constants as fallback when no row exists.';

-- ── Per-stamp artwork override ────────────────────────────────────────────
-- Allows a specific stamp row to carry custom artwork (e.g. special-edition
-- city stamps, seasonal perks). Stored as JSONB matching StampArtworkDef.

ALTER TABLE passport_stamps
  ADD COLUMN IF NOT EXISTS artwork_override jsonb;

COMMENT ON COLUMN passport_stamps.artwork_override IS
  'Optional custom StampArtworkDef JSONB. When present, the mobile client '
  'uses this instead of the JS-resolved defaults.';

-- ── Seed default artwork definitions ──────────────────────────────────────
-- These mirror the stampArtworkResolver.ts constants so the admin preview
-- endpoint can return DB-backed definitions without a code lookup.

INSERT INTO stamp_artwork_definitions
  (stamp_type, rarity, shape, border_style, border_weight, accent, background, pattern, texture, icon_key, category_label, has_shimmer, has_glow)
VALUES
  -- city stamps (rare)
  ('city',        'rare',      'oval',    'sawtooth', 2, '#0A3D4A', '#EFF5F5', 'radial',   'worn',  'MapPin',      'CITY',         false, false),
  -- plan stamps (uncommon)
  ('plan',        'uncommon',  'rect',    'double',   2, '#FF4D2E', '#FFF0F3', 'diagonal', 'paper', 'Users',       'PLAN',         false, false),
  -- hidden_gem stamps (rare)
  ('hidden_gem',  'rare',      'hexagon', 'sawtooth', 2, '#7A4DBF', '#F5F0FF', 'dots',     'worn',  'Gem',         'GEM',          false, false),
  -- safe_return stamps (uncommon)
  ('safe_return', 'uncommon',  'round',   'double',   2, '#2E7D5B', '#F0F8F5', 'grid',     'paper', 'ShieldCheck', 'SAFE',         false, false),
  -- host stamps (epic)
  ('host',        'epic',      'rect',    'wave',     3, '#11110F', '#F0F0EE', 'solid',    'ink',   'Crown',       'HOST',         true,  false),
  -- perk stamps (common)
  ('perk',        'common',    'round',   'single',   1, '#C8851A', '#FFF8F0', 'diagonal', 'paper', 'Ticket',      'PERK',         false, false),
  -- trip_crew (uncommon, treated like plan)
  ('trip_crew',   'uncommon',  'rect',    'double',   2, '#FF4D2E', '#FFF0F3', 'diagonal', 'paper', 'Users',       'CREW',         false, false),
  -- activity (common)
  ('activity',    'common',    'round',   'single',   1, '#C8851A', '#FFF8F0', 'solid',    'paper', 'Ticket',      'ACTIVITY',     false, false),
  -- neighborhood (common)
  ('neighborhood','common',    'oval',    'single',   1, '#0A3D4A', '#EFF5F5', 'solid',    'paper', 'MapPin',      'AREA',         false, false),
  -- compass_ai (uncommon)
  ('compass_ai',  'uncommon',  'round',   'double',   2, '#3B82F6', '#EFF6FF', 'radial',   'paper', 'Sparkles',    'COMPASS',      false, false),
  -- qr_checkin (common)
  ('qr_checkin',  'common',    'round',   'dotted',   1, '#6B7280', '#F9FAFB', 'solid',    'paper', 'QrCode',      'CHECK-IN',     false, false)
ON CONFLICT (stamp_type, rarity) DO NOTHING;

-- ── Index for admin preview queries ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS stamp_artwork_def_type_idx
  ON stamp_artwork_definitions (stamp_type);

-- ── RLS: admin-only write, authenticated read ─────────────────────────────
ALTER TABLE stamp_artwork_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stamp_artwork_def_read" ON stamp_artwork_definitions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "stamp_artwork_def_admin_write" ON stamp_artwork_definitions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
