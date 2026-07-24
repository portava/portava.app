-- Migration: 0188_globe_trotter_stamp_definitions.sql
-- Inserts the globe_trotter_5 and globe_trotter_10 stamp_definitions rows
-- required by the stamp smoke check (src/scripts/stamp-smoke-check.ts).
--
-- These are the versioned country-count milestones that replace the
-- unversioned 'globe_trotter' row for the criteria engine.
--
-- Safe to re-run: INSERTs use ON CONFLICT (slug) DO NOTHING.

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, visibility_default, source_system)
VALUES
  ('globe_trotter_5',
   'Globe Trotter',
   'Visit 5 different countries',
   'location', 'location', 'uncommon', true, false, 1, 'automatic', 'public', 'posts'),

  ('globe_trotter_10',
   'World Explorer',
   'Visit 10 different countries',
   'location', 'location', 'rare', true, false, 1, 'automatic', 'public', 'posts')

ON CONFLICT (slug) DO NOTHING;
