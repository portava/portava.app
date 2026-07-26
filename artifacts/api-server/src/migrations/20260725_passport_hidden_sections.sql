-- 20260725_passport_hidden_sections.sql
-- Add passport_hidden_sections column to the profiles table.
-- Null means no sections are hidden (default).  Non-null values are a TEXT[]
-- of the hideable section keys ('stamps', 'highlights', 'tabs', 'dossier').
-- The 'identity' card is never stored here — it cannot be hidden.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS passport_hidden_sections TEXT[] DEFAULT NULL;
