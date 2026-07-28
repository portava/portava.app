-- Migration 0113: place_contributor stamps
--
-- Adds three stamp_definitions rows for the place_contributor stamp type.
-- Tiers are Bronze (10 posts), Silver (50 posts), Gold (100 posts).
-- metadata.threshold drives the award logic in the collections worker.
-- metadata.placeId is set at award-time per user; these seed rows carry
-- only the tier template.  ON CONFLICT DO NOTHING is idempotent.

INSERT INTO stamp_definitions (slug, name, description, category, stamp_type, metadata, is_active)
VALUES
  (
    'place_contributor_bronze',
    'Local Contributor — Bronze',
    'Posted 10 pieces of content at this destination.',
    'location',
    'place_contributor',
    '{"tier": "bronze", "threshold": 10}',
    true
  ),
  (
    'place_contributor_silver',
    'Local Contributor — Silver',
    'Posted 50 pieces of content at this destination.',
    'location',
    'place_contributor',
    '{"tier": "silver", "threshold": 50}',
    true
  ),
  (
    'place_contributor_gold',
    'Local Contributor — Gold',
    'Posted 100 pieces of content at this destination.',
    'location',
    'place_contributor',
    '{"tier": "gold", "threshold": 100}',
    true
  )
ON CONFLICT (slug) DO NOTHING;
