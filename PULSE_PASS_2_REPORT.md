# PULSE_PASS_2_REPORT.md

Pulse Wall Pass 2 — unified typed feed + filter sheet + floating create. Built on v3.
Pass 1 (header, status row, Fits your time, When you're flexible) unchanged above the wall.

## Feed contract (src/types/models.ts)
PulseFeedItem — one shape, rendered by type:
  post · question · plan · hidden_gem · itinerary · circle_activity ·
  compass_suggestion · city_note · safety
Common fields: id, type, city, neighborhood, author, createdAt, timeAgo, visibility,
tags, mediaUrl, source, isProvisional, isEditorial + type-specific optionals +
optional/null scoring (availabilityScore, recommendationReason) + relatedPlan/Gem/Trip.
PULSE_FILTERS + PulseFilter type added.

## Card types BUILT (6, interleaved in one mixed wall)
1. Traveler Post  — author, location, time, media, caption, tags, like/comment, save
2. Question       — author, question, category, reply count, Answer
3. Open Plan      — title, time, location, host, attendees, "Fits your time" badge, Join
4. Hidden Gem     — image, name, neighborhood, why-special, Add to Plan, save
5. Itinerary      — title, numbered steps, time estimate, vibe tags, Use this plan
6. Circle Activity— avatars, activity text, See Circle

## Card types STUBBED (render only with real/safe data — never faked)
7. Compass Suggestion — renders ONLY when item.reason present (explicit, no fake score)
8. City Note          — renders ONLY when isProvisional (labeled "Starter city note / provisional")
9. Safety             — renders ONLY when item.blurb (a real condition) present
   (renderer returns null otherwise — no empty fake cards)

## Renderer
src/components/PulseFeedCard.tsx — PulseFeedCard switches on item.type. One mixed feed.

## Ordering (src/lib/recommend.ts, deterministic, NO fake score)
orderPulseFeed: availability-match first → editorial/provisional sink lower → recency.
filterPulseFeed: All = mixed; type filters (Posts/Questions/Plans/Hidden Gems/Itineraries/
Circle) narrow by type; category filters (Food/Nightlife/Beach/Culture) narrow by tag;
Fits My Time / Open Now → availabilityMatch only. Empty state when no results.

## Mechanics
- Filter SHEET (src/components/PulseCreate.tsx → PulseFilterSheet): bottom-sheet Modal,
  full PULSE_FILTERS list, active count, Clear, "Show results". Quick chips on the wall
  mirror it. Header Filter button opens the sheet. No permanent giant filter bar.
- Floating CREATE (PulseFAB + PulseCreateMenu): + opens menu — Post Update / Ask Question /
  Create Plan / Share Hidden Gem / Share a Moment. Routes to existing /create and /trip/new
  (both exist). Header Create also opens the menu.

## Data truth
- pulseFeed (src/data/pulseFeed.ts) is MOCK, labeled by source (user/circle/compass/seed).
  Not real users, not presented as live. Compass item carries explicit reason + provisional.
  City note labeled provisional.
- Editorial PostCards kept but moved BELOW the wall under "INSPIRATION · EDITORIAL" label —
  not passed off as live activity.
- No fake ranking, no fake popularity, no fabricated Circle activity beyond the labeled mock.
- Scoring fields exist as optional/null.

## Routes / actions verified
- Filter button → sheet (was → discovery). Create → menu. FAB → menu.
- Join Plan → /(tabs)/trips. Answer/Compass → /(tabs)/ai. Add to Plan → /create.
  See Circle → /circle. Create menu → /create, /trip/new (both exist).

## Static checks (this env)
- Escaped-backtick scan: CLEAN
- Import/identifier audit (whole project): 0 missing
- Brace balance on new files: balanced
- Fixed: moved a mid-file import in recommend.ts to top.

## On-device (run on Mac)
    npx tsc --noEmit
    npx expo start --clear      # press w, open Pulse

## Files changed
- src/types/models.ts            (PulseFeedItem + PULSE_FILTERS appended)
- src/data/pulseFeed.ts          (NEW mock feed)
- src/components/PulseFeedCard.tsx (NEW 6 cards + 3 stubs + renderer)
- src/components/PulseCreate.tsx  (NEW filter sheet + create menu + FAB)
- src/lib/recommend.ts           (filterPulseFeed + orderPulseFeed appended)
- app/(tabs)/index.tsx           (typed feed + sheet + FAB; editorial moved below, labeled)
- PULSE_PASS_2_REPORT.md         (this file)

## Summary
Pulse is now one mixed, typed social wall: posts, questions, open plans, hidden gems,
itineraries, and Circle activity interleaved, availability-first. A bottom-sheet filter
narrows by type/category with an active count and Clear; a floating + opens the create
menu. Compass/City Note/Safety are wired as stubs that appear only with real/safe data.
Editorial cards remain as labeled inspiration below the wall. Pass 1 availability
sections untouched.
