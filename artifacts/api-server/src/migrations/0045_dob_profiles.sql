-- Migration: 0045_dob_profiles.sql
-- Adds date_of_birth (date, nullable) and dob_verified (boolean, default false)
-- to the profiles table.
--
-- RLS: users may read/write their own DOB row; other users never see these columns
-- because public profile queries explicitly list columns (no SELECT * in public routes).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS dob_verified  boolean NOT NULL DEFAULT false;
