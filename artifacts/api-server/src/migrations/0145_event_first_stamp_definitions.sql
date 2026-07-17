-- Migration: 0145_event_first_stamp_definitions.sql
-- Adds the stamp definitions for a user's first event join and first hosted event.
-- These slugs are awarded by POST /api/events/:id/rsvp (going) and
-- POST /api/events/:id/publish respectively.  They coexist with the existing
-- event_host / event_participant completion stamps.
--
-- Safe to re-run: INSERTs use ON CONFLICT (slug) DO NOTHING.

INSERT INTO stamp_definitions
  (slug, name, description, stamp_type, category, rarity, is_active, is_repeatable,
   max_awards_per_user, criteria_type, visibility_default, source_system)
VALUES
  ('first_event_joined',
   'First Event',
   'Joined your first event on Travel Buddy',
   'event', 'event', 'common', true, false, 1, 'automatic', 'public', 'events'),

  ('first_event_hosted',
   'Event Host',
   'Hosted your first event on Travel Buddy',
   'event', 'event', 'common', true, false, 1, 'automatic', 'public', 'events')
ON CONFLICT (slug) DO NOTHING;
