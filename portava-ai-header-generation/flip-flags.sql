-- Enable the AI header generation flags when you're ready. Fail-closed by default.
-- Recommended first pass: provider + event headers ON; keep auto-suggest and place
-- headers OFF until you've watched cost/quality in beta.
UPDATE feature_flags SET enabled = true WHERE flag IN (
  'ai_visual_provider_enabled',
  'ai_event_headers_enabled',
  'ai_visual_regeneration_enabled'
);

-- Later, when ready for automatic suggestions + place representations + admin review:
-- UPDATE feature_flags SET enabled = true WHERE flag IN (
--   'ai_event_auto_suggest_enabled',
--   'ai_place_headers_enabled',
--   'ai_visual_admin_review_enabled'
-- );

-- Trip covers (Stage 5):
-- UPDATE feature_flags SET enabled = true WHERE flag = 'ai_trip_covers_enabled';

SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'ai_%' ORDER BY flag;
