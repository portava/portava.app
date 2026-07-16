-- Migration: add passport_tab_order to profiles
-- Stores the owner's preferred order of the five Passport content tabs.
-- NULL means "use canonical order" (postcards, memories, plans, stamps, map).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS passport_tab_order TEXT[];
