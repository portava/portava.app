-- All MEDIA_* feature flags for the Media destination.
-- Conservative defaults: mode flags start true, everything else false.
-- Already-present flags from 2037 are guarded with ON CONFLICT DO NOTHING.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  -- ── Tab shell (already seeded in 2037, kept here for completeness) ──────
  ('MEDIA_TAB_ENABLED', false,
   'Replace the centre Plus/create button with a persistent Media tab (Watch · Grid · Gems). false restores the original create button.'),

  -- ── View modes ────────────────────────────────────────────────────────────
  ('MEDIA_VIEW_MODE_FULLSCREEN_ENABLED', true,
   'Enable the Watch (full-screen vertical video) mode inside the Media tab.'),
  ('MEDIA_VIEW_MODE_GRID_ENABLED', true,
   'Enable the Grid (photo/reel mosaic) mode inside the Media tab.'),
  ('MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED', true,
   'Enable the Gems (place-linked hidden gems) mode inside the Media tab.'),

  -- ── Feed & ranking ────────────────────────────────────────────────────────
  ('MEDIA_FOR_YOU_ENABLED', false,
   'Enable the For You personalised feed in Watch mode.'),
  ('MEDIA_FOLLOWING_ENABLED', false,
   'Enable the Following feed tab in Watch mode.'),
  ('MEDIA_RANKING_ENABLED', false,
   'Enable server-side Compass ranking for the media feed (falls back to recency when disabled).'),
  ('MEDIA_GRID_RANKING_ENABLED', false,
   'Enable Compass ranking for the Grid (mosaic) view. Falls back to recency when disabled.'),
  ('MEDIA_GEMS_RANKING_ENABLED', false,
   'Enable place-proximity + quality ranking for the Gems view.'),

  -- ── Upload & processing ───────────────────────────────────────────────────
  ('MEDIA_UPLOAD_ENABLED', false,
   'Allow users to upload video/photo to the Media destination. false shows an upload-unavailable state.'),
  ('MEDIA_PROCESSING_PIPELINE_ENABLED', false,
   'Enable the async media-processing pipeline (transcode, thumbnail, HLS). Disable to pause processing.'),
  ('MEDIA_UPLOAD_VIDEO_ENABLED', false,
   'Allow video uploads specifically (requires MEDIA_UPLOAD_ENABLED).'),
  ('MEDIA_UPLOAD_PHOTO_ENABLED', false,
   'Allow photo uploads specifically (requires MEDIA_UPLOAD_ENABLED).'),

  -- ── Interactions ──────────────────────────────────────────────────────────
  ('MEDIA_LIKES_ENABLED', false,
   'Enable like interactions on media items.'),
  ('MEDIA_COMMENTS_ENABLED', false,
   'Enable comment interactions on media items.'),
  ('MEDIA_SAVES_ENABLED', false,
   'Enable save-to-collection interactions on media items.'),
  ('MEDIA_SHARES_ENABLED', false,
   'Enable share/export interactions on media items.'),

  -- ── Gems-specific ────────────────────────────────────────────────────────
  ('MEDIA_GEMS_SUBMIT_ENABLED', false,
   'Allow users to submit hidden-gem nominations. false shows submission as coming soon.'),
  ('MEDIA_GEMS_WRONG_PLACE_REPORT_ENABLED', false,
   'Enable wrong-place reporting for Gems items.'),
  ('MEDIA_GEMS_ADD_TO_TRIP_ENABLED', false,
   'Enable Add to Trip CTA on Gems items.'),
  ('MEDIA_GEMS_DIRECTIONS_ENABLED', false,
   'Enable Directions CTA on Gems items (taps into maps deep-link).'),

  -- ── AI provenance labels ──────────────────────────────────────────────────
  ('MEDIA_AI_PROVENANCE_LABELS_ENABLED', false,
   'Show AI-provenance badges (illustrative / AI-generated) on media items and Gems.'),

  -- ── Analytics ────────────────────────────────────────────────────────────
  ('MEDIA_ANALYTICS_ENABLED', false,
   'Enable server-side recording of media analytics events (impressions, views, interactions).'),

  -- ── Admin tooling ─────────────────────────────────────────────────────────
  ('MEDIA_ADMIN_REVIEW_ENABLED', false,
   'Enable the /admin/media review queue in the app and API.'),

  -- ── Default view mode (25th flag) ────────────────────────────────────────
  -- metadata.mode holds the actual value (watch | grid | gems);
  -- the enabled boolean is unused for this flag — mode lives in metadata.
  ('MEDIA_DEFAULT_VIEW_MODE', false,
   'Server-configured default mode when the Media tab opens (metadata.mode: watch | grid | gems). enabled field unused; mode lives in metadata.')

ON CONFLICT (flag) DO NOTHING;
