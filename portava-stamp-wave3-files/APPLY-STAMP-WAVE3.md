# APPLY — Stamp Wave 3 (criteria engine)

Turns the dormant `stamp_definitions.criteria` column into a live, versioned
rule engine, so stamp unlock thresholds become DATA instead of ~30 hard-coded
award sites. Backend-only. Flag-gated OFF by default — applying changes nothing
until you enable it.

## What it does

- **Rule schema** (`lib/stamps/criteria/schema.ts`): versioned JSON —
  `{ "version": 1, "all": [ { "metric": "trips_completed", "gte": 5 } ] }`.
  Supports `all`/`any`/`not`, operators `gte|lte|gt|lt|eq`, and boolean `is`.
- **Metrics** (`metrics.ts`): DB-resolved (following_count, followers_count,
  trips_created, trips_completed, events_hosted, events_joined, posts_count,
  stamps_earned, cities_visited, countries_visited) + context metrics supplied
  by the trigger (trip_member_count, is_solo_trip, is_international,
  event_category_food/music/outdoor). Every query hits a verified column.
- **Evaluator** (`evaluator.ts`): resolves only referenced metrics, memoized;
  fails CLOSED on unknown metric / bad version / malformed shape (never throws,
  never awards on something it doesn't understand).
- **Integration** (`StampAwardEngine.ts`): a criteria gate added to
  `awardStamp` + `checkEligibility`. It is ADDITIVE — bites only when a
  definition has authored criteria AND `stamp_criteria_engine_enabled` is on.
  A definition with null criteria is untouched (all 30 hard-coded sites keep
  working). New `criteriaContext` field on AwardInput passes context metrics.
- **Award path**: `evaluateAndAwardCriteria()` grants every met automatic
  criteria stamp (idempotent — overlap with a hard-coded site is a no-op).
- **Admin** (`stampCatalog.ts`): `GET /admin/stamps/criteria/metrics`
  (vocabulary), `POST /admin/stamps/criteria/evaluate { userId, slug?, dryRun? }`
  (dry-run evaluation or evaluate+award).
- **Migration 0179**: the flag; parity criteria seeded onto community_connector,
  popular_traveler, travel_influencer, road_warrior, frequent_flyer (mirror
  the current thresholds exactly — enabling the engine does not change WHEN
  they unlock); and 4 new event-category definitions (foodie_explorer,
  music_lover, outdoor_adventurer, event_regular) as inactive automatic stamps.

## Steps (workspace root)

1. Unzip `portava-stamp-wave3.zip`, then:

       git apply -p1 portava-stamp-wave3.patch

   (Fallback: copy `portava-stamp-wave3-files/*` over the workspace root.)

2. Run **0179_stamp_criteria_engine.sql** in the Supabase SQL editor.

3. Verify: `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → all green
   (19 new criteria tests + the award-engine suites re-verified).

## Turning it on (optional, when you want data-driven unlocks)

    UPDATE feature_flags SET enabled = TRUE WHERE flag = 'stamp_criteria_engine_enabled';

Because the seeded criteria mirror the existing hard-coded thresholds, this is
safe: nothing changes about existing stamps. What it BUYS you: you can now
author a brand-new stamp entirely as data — insert a definition row with a
`criteria` rule and `criteria_type='automatic'`, then call
`POST /admin/stamps/criteria/evaluate` (or wire `evaluateAndAwardCriteria` into
a trigger) — no code deploy.

To light up the event-category stamps: set them active
(`UPDATE stamp_definitions SET is_active = TRUE WHERE slug IN
('foodie_explorer','music_lover','outdoor_adventurer','event_regular')`) and
pass `criteriaContext: { event_category_food: true, … }` from the RSVP site,
or evaluate on a schedule.

## Next / still open

Wire `evaluateAndAwardCriteria` into the event RSVP trigger with category
context (small follow-up); OG share rebuild on composition layers; mobile
thumbnail-aware rendering; v1→v2 legacy unification; STYLE_VERSION bump for
catalog-wide premium regen.
