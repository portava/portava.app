# Tree Consolidation — Legacy vs Standalone Diff Report

Durable record of the 2026-08-06 consolidation decision (artifacts/travel-buddy legacy-frozen tree → travel-buddy-standalone canonical tree). Written to the repo so it survives chat/session loss, not just chat scrollback.

## Rollback point

- Git tag: `backup/pre-consolidation-2026-08-06`
- SHA: `3ceea3e419592b21f7d33c06ea5406ad46e0b139`
- Branch at time of tagging: `bughunt-20260805`
- Local tag only — this repo has no `origin`/GitHub remote configured (only ephemeral Replit `subrepl-*` remotes), so the tag has not been pushed anywhere. Rollback relies on this local ref plus Replit's own checkpoint system.

## Source of divergence

Commit `fc359d377bb2d559b88203b37e054d9b2df3da07` ("Published your App", 2026-08-05 17:05:55) applied a patch bundle (via `qa2fix-r2/apply.py`) into `artifacts/travel-buddy` ONLY, after that tree was supposed to be frozen. It touched 18 files total: 16 that also exist in `travel-buddy-standalone` (diverged), and 2 entirely new files with no standalone counterpart.

## Verdicts — all GENUINELY MISSING from travel-buddy-standalone

No SUPERSEDED or IRRELEVANT verdicts — all 16 diverged files plus both new files contain real behavior fixes not present in standalone as of this report.

| # | File | What's missing from standalone | Depends on |
|---|---|---|---|
| 1 | `app/(tabs)/index.tsx` | Pulse category filter chips (`FILTER_TYPES`/`visibleFilters`); standalone can't filter feed by category | — |
| 2 | `app/(tabs)/passport.tsx` | Bypasses stale 5-min focus TTL after a profile write; fixes Privacy Settings routing (`'safety'` → `'passport'`) | #16 (`isProfileStaleSince`) |
| 3 | `app/events/create/index.tsx` | Required title/start/location validation with step-jump; preserves typed city/country on place pick; uses `formatEventLocation` | new file `formatEventLocation.ts` |
| 4 | `app/events/invites.tsx` | Uses `formatEventLocation` instead of raw `{locationName}, {city}` concat | new file `formatEventLocation.ts` |
| 5 | `app/layover/[id].tsx` | Replaces blocking `window.confirm` with in-app `ConfirmSheet` + loading/cancel state for ending a layover | new file `ConfirmSheet.tsx` |
| 6 | `app/profile/edit/identity.tsx` | Calls `markProfileStale()` after profile save | #16 |
| 7 | `app/trip/[id].tsx` | Hero progress/checklist reads from same readiness source as `TripReadinessCard` (was `realTrip.progress` + empty `progressSteps`) | #14 (`onSummary` callback) |
| 8 | `src/components/DailyBriefCard.tsx` | Suppresses `briefType === 'general'` brief on trip-scoped pages | — |
| 9 | `src/components/EventComposerSheet.tsx` | Preserves user-entered city/country on place pick; normalizes review location with `formatEventLocation` | new file `formatEventLocation.ts` |
| 10 | `src/components/EventDiscoveryCard.tsx` | RSVP CTA gates on computed `displayState`/`effectiveEventState`, hides RSVP after `endsAt`, not just stored `event.state` | — |
| 11 | `src/components/HighlightViewer.tsx` | Per-highlight video error state + "Video unavailable" overlay instead of indefinite spinner on playback error | — |
| 12 | `src/components/PulseFeedCard.tsx` | Falls back to original media URL when `thumbnail_url` is missing, for `VideoThumbnail` | — |
| 13 | `src/components/layover/LayoverModeSheet.tsx` | Clears airport search error immediately on selection; outlined (not filled) IATA badge styling | — |
| 14 | `src/components/trip/TripReadinessCard.tsx` | Adds optional `onSummary` callback reporting loaded/failure readiness summary to parent | feeds #7 |
| 15 | `src/components/ui/VideoThumbnail.tsx` | Tracks poster image load failure (`posterFailed`/`onError`), falls back to placeholder | — |
| 16 | `src/hooks/usePassport.ts` | Adds module-level `markProfileStale()` / `isProfileStaleSince(loadedAt)` staleness signal | feeds #2, #6 |

New files (no standalone equivalent, both genuinely missing):
- `src/components/ui/ConfirmSheet.tsx` (107 lines) — generic in-app confirm-dialog component. Used by #5.
- `src/lib/location/formatEventLocation.ts` (29 lines) — location string formatter/deduper. Used by #3, #4, #9.

## Decision (user, 2026-08-06)

Option A: port all 16 diverged files' changes + the 2 new files as one coherent batch, porting functionally as-is (no refactor/rename/restyle in the same pass). Grouped dependencies must land together: #7+#14, #2+#6+#16, #3/#4/#9 (+ both new files).

## Status

- [x] Phase 1 — port batch, verify typecheck/tests/build (2026-08-06)
  - All 16 diverged files + 2 new files (`ConfirmSheet.tsx`, `formatEventLocation.ts`) ported into `travel-buddy-standalone`, functionally as-is, respecting the #7+#14 / #2+#6+#16 / #3+#4+#9 dependency groupings.
  - `pnpm run typecheck` (tsc + import-extension lint): clean.
  - `pnpm test` (node:test suite): 3541/3541 passed.
  - `pnpm run test:component` (Jest RNTL + webrender): 315/315 suites, 1634/1634 tests, plus 2/2 webrender suites — all passed.
  - Fixed 8 pre-existing test files with partial `jest.mock('.../usePassport')` factories that didn't export the new `isProfileStaleSince`/`markProfileStale` (see `stale-partial-jest-mocks` memory pattern) — added stub exports, no behavioral changes to the tests themselves.
- [x] Phase 2 — re-point deployment config to standalone only (2026-08-06)
  - `artifacts/travel-buddy/.replit-artifact/artifact.toml` edited via `verifyAndReplaceArtifactToml`:
    - `services.development.run`: `cd ../../travel-buddy-standalone && pnpm run dev` (was `pnpm --filter @workspace/travel-buddy run dev`). Note the cwd asymmetry: the dev service's cwd is the artifact's own directory (`artifacts/travel-buddy/`), so the standalone tree is reached with `../../`, not a root-relative path — see `artifact-toml-cwd-asymmetry` memory.
    - `services.production.build.args`: `["node", "travel-buddy-standalone/scripts/build.js"]` (was `artifacts/travel-buddy/scripts/build.js`) — production args resolve from the repo root, so this is a straight path swap.
    - `services.production.run.args`: `["node", "travel-buddy-standalone/server/serve.js"]` (was `artifacts/travel-buddy/server/serve.js`).
    - `travel-buddy-standalone/server/serve.js` and `scripts/build.js` are byte-identical to the legacy tree's copies (both `__dirname`-relative, no hardcoded legacy path), so no server/build code changes were needed.
  - The top-level `.replit` `[deployment]` block was left untouched — it is scoped only to `@workspace/api-server`'s build/run per an explicit comment in that file; mobile deployment is driven entirely by this artifact's `artifact.toml`.
  - `artifacts/travel-buddy: expo` workflow restarted and confirmed serving Metro/Expo from `travel-buddy-standalone` (Replit preview screenshot showed the Portava sign-in screen rendering correctly from the standalone bundle).
  - **Production (`portava.replit.app`) has NOT been republished yet** — this Phase only changed `artifact.toml`; the live deployment still serves the pre-consolidation build until the user clicks Publish. See Phase 3 findings below.
- [x] Phase 3 — verify canaries + check portava.replit.app routes (2026-08-06)
  - **Canary A (QA Test Trip dates/location):** PASS. Verified via testing subagent logged in as the trip owner (QA seed account) in the Replit preview: Trips list shows "QA Test Trip" — Manila, Philippines, Aug 10–Aug 14, 2026 — not "Dates TBD", not blank. Also cross-checked directly against the Supabase `trips` row (`destination_city="Manila"`, `destination_country="Philippines"`, `start_date="2026-08-10"`, `end_date="2026-08-14"`).
  - **Canary B (Trip Plan "Jump to first" crash):** PASS. Testing subagent opened the QA Test Trip's Trip Plan section and tapped "Jump to first →" — no red crash overlay, no `findNodeHandle` error, plan view stayed functional and scrollable afterward. Screenshots captured (sign-in, trips list, trip detail, post-tap plan state).
  - Non-blocking noise observed during the run (not related to the ported fixes): a CORS warning for an `exp.direct` origin, a 500 on `GET /api/trips/<id>/reviews`, and some 404/401s on auxiliary endpoints (`/memory`, `/media/sign`). Flagging for awareness, not part of this consolidation's scope.
  - **`portava.replit.app` (production) — confirmed STALE, not yet re-pointed:**
    - `GET /` → 200, serves the old build's static `index.html` (matches the user's report of an Expo-Go-style launcher page).
    - `GET /trips` → 404.
    - `GET /passport` → 404.
    - This is expected: publishing is user-initiated (the agent cannot trigger it) and the artifact.toml change in Phase 2 only takes effect on the *next* Publish. The user needs to click Publish for production to start serving the re-pointed build from `travel-buddy-standalone`.
- [ ] Phase 4 — archive (not delete) artifacts/travel-buddy — BLOCKED on user confirming production is fixed post-publish
