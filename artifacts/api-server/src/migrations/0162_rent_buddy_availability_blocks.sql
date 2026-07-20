-- 0161: add availability_blocks to rent_buddy_profiles.
-- Defined in legacy migrations (0047, 0134 rebuild) but never applied live.
-- The buddy wizard writes it and BUDDY_PUBLIC_COLUMNS selects it, so its
-- absence fails every wizard submit AND every buddy read via PostgREST.
ALTER TABLE IF EXISTS rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS availability_blocks jsonb NOT NULL DEFAULT '[]'::jsonb;
