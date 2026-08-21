# Passport Settings and city persistence verification

Verified on 2026-08-21 against the canonical `travel-buddy-standalone` tree.

## Behaviors verified

- Passport owner **Account → Settings** completes its sheet exit and navigates exactly once to `/profile/edit`, including rapid repeated presses.
- The consolidated settings hub exposes the existing **Privacy & Visibility** and **Location & Availability** destinations.
- Home Base consumes the canonical picker `Place` shape and saves through `homeCity`, `homeCountry`, and `currentCity`.
- Empty initial state, picker cancellation, non-empty selection, failed-save retry, save/reload, city replacement, and explicit clearing are covered.
- Explicit clears serialize as `null`, rather than disappearing from the JSON patch as `undefined`.
- Location controls and async GPS/picker callbacks are locked while a save is in flight, preventing a response from overwriting a newer edit.

## Automated evidence

- `pnpm run check:all`: **passed** in the configured `standalone-checks` workflow (`✔ ALL CHECKS PASSED`).
- Focused regression run: **6 suites, 11 tests passed**.
- `pnpm typecheck`: passed.
- `pnpm lint:close-then-navigate`: passed.
- `pnpm check:route-registry`: passed; all registered screens and layouts accounted for.
- Independent post-change review: passed with no blocking correctness or security findings after the dismissal and in-flight-save race fixes.

## Runtime smoke evidence

- The Expo mobile-web preview bundled successfully and rendered the Portava signed-out screen in a mobile viewport without a fatal page crash.
- The browser session had no authenticated user. Per task constraints, no login, profile mutation, account seeding, or direct QA-user edit was attempted, so authenticated owner-menu navigation was not repeated against live profile data.
- The authenticated flow and persistence transitions are instead pinned by focused component tests that exercise the real screen boundary and exact profile patches.

## Scope containment

- No Journey source, capability flag, Compass, Discovery, recommendation, notification, Autopilot, or inference file was changed.
- No Journey consent/session was created and no feature flag was enabled.
- No backend schema or duplicate settings/location state system was introduced.