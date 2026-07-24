-- Migration 0180: activate the event-category criteria stamps
--
-- 0179 introduced foodie_explorer / music_lover / outdoor_adventurer /
-- event_regular as is_active=FALSE (double-safety while the wiring landed).
-- The RSVP-going trigger now evaluates them via the criteria engine with the
-- event's derived category context, so they can go active.
--
-- Still fully gated: evaluateAndAwardCriteria is a no-op unless
-- stamp_criteria_engine_enabled is TRUE, so activating here does NOT make them
-- earnable until you flip that flag. This migration only removes the second
-- (is_active) lock so the engine flag becomes the single switch.
--
-- Safe to re-run.

UPDATE stamp_definitions
SET is_active = TRUE, updated_at = now()
WHERE slug IN ('foodie_explorer', 'music_lover', 'outdoor_adventurer', 'event_regular')
  AND is_active = FALSE;
