# APPLY — Wave 3 follow-up: event-category stamps earnable

Small backend follow-up on top of Wave 3. Wires the RSVP-going flow to the
criteria engine so foodie_explorer / music_lover / outdoor_adventurer /
event_regular actually become earnable. Apply AFTER Wave 3.

## What it does
- `lib/stamps/criteria/eventContext.ts` — maps an event's free-text `category`
  + `tags[]` onto the food/music/outdoor boolean context metrics (keyword
  match, case-insensitive, multi-bucket, null-safe).
- `routes/events.ts` — on a "going" RSVP, after first_event_joined, runs
  `evaluateAndAwardCriteria` scoped to the four event-category slugs with the
  derived context; sends a stamp-earned notification for each award. Threads
  the awarded userStampId through so the notification deep-links correctly.
- `migration 0180` — activates the four definitions (0179 left them inactive).
  Still gated by `stamp_criteria_engine_enabled` — the engine flag is now the
  single switch.

## Steps (workspace root)
1. Unzip, then `git apply -p1 portava-stamp-wave3-events.patch`
   (fallback: copy `files/*` over the workspace root).
2. Run `0180_activate_event_category_stamps.sql` in Supabase.
3. `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → green
   (7 new classifier tests + event suites re-verified).

## To make them live
Requires the Wave 3 engine flag on:

    UPDATE feature_flags SET enabled = TRUE WHERE flag = 'stamp_criteria_engine_enabled';

Then: RSVP "going" to a food event → foodie_explorer; 5 events → event_regular.
Nothing awards while the flag is off. Category detection is keyword-based on
whatever you put in an event's category/tags — tune KEYWORDS in
eventContext.ts if your taxonomy differs.
