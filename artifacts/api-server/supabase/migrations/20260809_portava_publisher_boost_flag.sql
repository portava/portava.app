-- Migration: add PORTAVA_PUBLISHER_BOOST_ENABLED feature flag
-- Controls the trusted-publisher boost in Pulse, Roam, and Discovery feeds.
-- When enabled: @Portava posts receive a 1.2× score multiplier and are exempt
-- from per-creator frequency caps, ensuring the account is never buried.
-- Default: disabled (safe rollout; enable via the feature_flags table).

INSERT INTO feature_flags (flag, enabled, description)
VALUES (
  'PORTAVA_PUBLISHER_BOOST_ENABLED',
  false,
  'Applies a 1.2× score multiplier to posts authored by the @Portava official publisher account and exempts them from per-creator frequency caps in Pulse and Roam (media) feeds.'
)
ON CONFLICT (flag) DO NOTHING;
