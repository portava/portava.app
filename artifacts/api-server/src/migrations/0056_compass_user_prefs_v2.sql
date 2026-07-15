-- Migration: 0056_compass_user_prefs_v2
--
-- Extends compass_user_preferences (created in 0051_compass_foundation) with the
-- columns needed by CompassFeedbackEngine (phase 5).
--
-- WHY: migration 0051 only defined the foundation columns (compass_enabled,
-- intent_mode_override, show_explanations, budget_filter, min_trust_level,
-- exclude_budget_styles).  Phase 5 adds feedback-driven personalisation that
-- reads/writes category_weights, ignored_item_ids, muted_hashtags, muted_topics,
-- and public_meetups_only.  Without these columns, upserts in processFeedback
-- silently fail and notification quiet-hours parsing has no data to read.

ALTER TABLE public.compass_user_preferences
  ADD COLUMN IF NOT EXISTS category_weights    JSONB    NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ignored_item_ids    TEXT[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS muted_hashtags      TEXT[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS muted_topics        TEXT[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS public_meetups_only BOOLEAN  NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.compass_user_preferences.category_weights IS
  'Map of category slug → score adjustment (-10..+10).  Updated by feedback actions.';

COMMENT ON COLUMN public.compass_user_preferences.ignored_item_ids IS
  'Opaque item IDs the user has dismissed.  Capped at 500 entries by the engine.';

COMMENT ON COLUMN public.compass_user_preferences.muted_hashtags IS
  'Hashtag slugs the user has muted via feedback.  Capped at 200.';

COMMENT ON COLUMN public.compass_user_preferences.muted_topics IS
  'Muted topic slugs AND quiet-hours entries (''quiet_start:HH:MM'', ''quiet_end:HH:MM'').  Capped at 200.';

COMMENT ON COLUMN public.compass_user_preferences.public_meetups_only IS
  'When true the feed deprioritises private/invite-only events.';
