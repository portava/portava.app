-- MediaFeedRankingService boost and fatigue feature flags.
-- Each flag controls a distinct ranking signal; all default false so the
-- service runs in base-score-only mode until operators enable boosts.
-- Gated independently so individual boosts can be A/B tested.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('MEDIA_ACTIVE_CREATOR_BOOST_ENABLED', false,
   'Apply an active-creator boost to posts from creators who post regularly. Diminishing-returns curve; configurable ceiling.'),
  ('MEDIA_NEW_CREATOR_BOOST_ENABLED', false,
   'Grant new creators an evaluation window where their first posts receive a fair-test boost, making them discoverable.'),
  ('MEDIA_RETURNING_CREATOR_BOOST_ENABLED', false,
   'Give a temporary recovery boost to creators returning after ≥N days of inactivity.'),
  ('MEDIA_UNDEREXPOSED_BOOST_ENABLED', false,
   'Surface items with low view-count relative to their age so quality posts get a fair test before being buried.'),
  ('MEDIA_CREATOR_FATIGUE_ENABLED', false,
   'Deprioritise creators the viewer has already seen many times in the current session (per-session fatigue layer).')

ON CONFLICT (flag) DO NOTHING;
