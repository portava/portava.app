-- Migration: 0046_meetup_age_limits.sql
-- Adds optional age-limit columns to the meetups table.
-- Existing rows default to age_limit_enabled = false with null ages → unchanged behaviour.

ALTER TABLE meetups
  ADD COLUMN IF NOT EXISTS age_limit_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS min_age           integer,
  ADD COLUMN IF NOT EXISTS max_age           integer;
