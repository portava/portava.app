-- Feature flags for the Media tab navigation shell.
-- MEDIA_TAB_ENABLED gates the entire tab; individual MEDIA_VIEW_MODE_* flags
-- control which modes appear inside the tab. Default all to false/true per spec.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  (
    'MEDIA_TAB_ENABLED',
    false,
    'Replace the center Plus/create button with a persistent Media tab (Watch · Grid · Gems). false restores the original create button.'
  ),
  (
    'MEDIA_DEFAULT_VIEW_MODE',
    false,
    'Server-configured default mode when the Media tab opens (see metadata.mode: watch | grid | gems). enabled field unused; mode lives in metadata.'
  ),
  (
    'MEDIA_VIEW_MODE_FULLSCREEN_ENABLED',
    true,
    'Enable the Watch (full-screen vertical video) mode inside the Media tab.'
  ),
  (
    'MEDIA_VIEW_MODE_GRID_ENABLED',
    true,
    'Enable the Grid (photo/reel mosaic) mode inside the Media tab.'
  ),
  (
    'MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED',
    true,
    'Enable the Gems (place-linked hidden gems) mode inside the Media tab.'
  )
ON CONFLICT (flag) DO NOTHING;
