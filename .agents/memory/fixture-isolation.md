---
name: Mock data fixture isolation
description: Pattern for moving mock/seed data to __fixtures__ and which live screens still use it.
---

# Mock Data Fixture Isolation

## Rule
`src/data/` files are thin re-export wrappers pointing to `src/__fixtures__/`. They exist for backward compat — do not add new imports there; import from `src/__fixtures__/` directly in tests/fixtures.

## Why
Fixture data was scattered in `src/data/` alongside type definitions, causing it to be imported in live authenticated screens. Moving to `src/__fixtures__/` clearly marks it as non-production data.

## Screens still importing fixture data (as of 2026-06-24)
- `app/(tabs)/index.tsx` — `pulseFeed`, `editorialPosts` mixed into live ForYou feed for all users
- `app/trip/[id].tsx` — `mockTripDetail`, `mockNextUp`, `tripPlans`, `tripCircle`, `tripStamps`, `tripPosts` as structural fallback
- `app/post/[id].tsx`, `app/destination/[slug].tsx`, `app/saved.tsx` — entirely fixture-backed
- `app/(tabs)/trips.tsx`, `app/(tabs)/passport.tsx`, `app/(tabs)/ai.tsx` — fixture used only when `!isAuthed` or on error (acceptable)

**How to apply:** When wiring a live API call to a screen, remove its corresponding `src/data/` or `src/__fixtures__/` import. Once all screens are clean, delete `src/data/` wrappers entirely.
