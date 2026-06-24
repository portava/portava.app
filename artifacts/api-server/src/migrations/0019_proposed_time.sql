-- Migration: 0019_proposed_time.sql
-- Adds proposed_time TIME column to meetup_time_options.

ALTER TABLE meetup_time_options
  ADD COLUMN IF NOT EXISTS proposed_time TIME;
