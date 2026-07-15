-- Migration 0120: passport section order
-- Adds profiles.passport_section_order (TEXT[]) — the owner's preferred
-- ordering of their passport screen sections. NULL means canonical order
-- (identity, stamps, highlights, tabs, dossier). Only ever read for the
-- owner's own view; visitor/public views always use canonical order.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS passport_section_order TEXT[];
