# Travel Buddy — Full Product Audit
**Date:** 2026-07-03  
**Auditor:** Agent (Task #1478)  
**Baseline commit:** `1df360bc`  
**Codebase:** `travel-buddy-standalone/` (active mobile) + `artifacts/api-server/` (API server)  

---

## A. Executive Summary

Travel Buddy has a **solid, real backend foundation**. All 60+ API routes use real Supabase data (service role client), are properly auth-gated with `requireUser`/`requireAdmin`, and have corresponding mobile service files that call them. The migration trail runs from 0010 to 0093 covering every major feature.

The honest picture:

- **Core travel loop (create trip → invite → plan → share)** is real and working.
- **Post/Pulse feed** is real but the post *detail* screen has dead engagement UI (likes/comments show counts but are not interactive; comments section always renders the stub "Comments coming soon.").
- **Live Map is a placeholder.** The screen displays an explainer card. No real location data is rendered.
- **AI/Telegraph tab is hidden** (`href: null`) but is actually a real, wired Compass chat interface — just not surfaced to users.
- **Several fixture data sources still leak into live screens** — most critically, `PulseFits` renders from `cebu.ts` mock users, and the passport hook falls back to `mockPassport` when Supabase is unconfigured.
- **Migration documentation is drifted** — 23 migrations (0071–0089, 0091–0093) are present in the filesystem but not listed in `docs/migrations.md`.
- **Post category stamp always shows "travel"** (the `postRowToFeedItem` mapper hardcodes the category field).

Overall the app is ~75% production-ready. The remaining gaps are concentrated in engagement features (likes/comments interaction on detail screens), the live map, and a few visible stubs.

---

## B. Fully Working Systems

These systems are verified real: real backend routes, real DB, real mobile service wiring.

| System | Evidence |
|--------|---------|
| **Auth** (sign-in, sign-up, forgot-password, forgot-username) | `auth.ts` service + API `POST /api/auth/*`; no mock path |
| **Trip CRUD** (create/edit/delete/cancel) | `trips.ts` service + `POST/PATCH/DELETE /api/trips` |
| **Trip invites** (send/accept/decline) | `trips.ts` + `/api/trips/:id/accept-invite`, `/decline-invite`; invite card in `trips.tsx` tab is live |
| **Trip member management** (add/remove) | `trips.ts` + `/api/trips/:tripId/members` |
| **Events** (list/filter/RSVP/save/unsave/host/draft) | `events.ts` service + full CRUD in API `events.ts` route |
| **Passport** (profile load, stamps, postcards, memories, suggestions, map, stats) | `passportStamps.ts` + `/api/me/passport/*`; `usePassport` hook |
| **Stamps v2** (list, visibility, display, progress, per-user) | `stamps.ts` service + `/api/stamps/*` |
| **Discovery + Places** (OSM-backed, category tabs, save/unsave, counts) | `discovery.ts` service + `/api/discovery` |
| **Hidden Gems** (create/edit/save/unsave/verify-visit/guide-apply) | `hiddenGems.ts` service + `/api/hidden-gems` |
| **Messaging / Telegraph** (threads, messages, message requests, group/trip/circle chat) | `messaging.ts` + `/api/messaging`, `/api/threads/*` |
| **Compass AI feed** (personalized feed, section feeds, feedback, preferences) | `compass.ts` + `/api/compass/*` |
| **Safe Return** (sessions, live-share, confirm) | `safeReturn.ts` + `/api/me/safe-return/*` |
| **Blocks** (block/unblock, list, status) | `blocks.ts` + `/api/users/:userId/block` |
| **Reports** (post/user reports) | `reports.ts` + `POST /api/reports`; `ReportPostSheet` wired in post detail |
| **Mutes / Restrict** | `mutes.ts`, `restrict.ts` + API routes |
| **Notifications / Activity Center** | `notifications.ts` + `/api/me/notifications/*`; mark-read, dismiss, pagination |
| **Push token registration** | `pushTokenService.ts` + `POST /api/me/devices` |
| **Collections / Saved** | `collections.ts` + `/api/me/collections`; full CRUD; `saved.tsx` screen |
| **Highlights / Stories** | `highlights.ts` + `/api/highlights`; ring state, viewer, composer |
| **Rent-a-Buddy** (marketplace, search, bookings, dashboard, rollout) | `rentABuddy.ts` + `/api/rent-a-buddy/*`; flag-gated; city rollout table seeded |
| **Profile** (view, edit, public passport, cover photo) | `profile.ts` + `/api/profile`, `/api/me/*` |
| **Follows / Friend requests** | `follows.ts`, `friends.ts` + corresponding API routes |
| **Admin tools** (feature flags, reports, trust, stamps, compass, content) | `admin.ts`, `trust-admin.ts` + all `/api/admin/*`; `requireAdmin` enforced |
| **Onboarding** (4-step, GPS home city, manual picker, interests/style) | `onboarding.tsx` + `updateMyProfile` via `profile.ts` |
| **Geofence monitoring** | `useGeofenceMonitor` + `geofence.ts` route; runs app-wide from `_layout.tsx` |
| **Layover Mode** | `LayoverModeSheet`; `layover.ts` service; entry points in Trips + Pulse |

---

## C. Partially Working Systems

These have real backend wiring but visible gaps or stubs in the UI.

### C1. Post Detail (`app/post/[id].tsx`)
- **What works:** Loading a single post, displaying media, caption, location, author, share, report.
- **What's broken/stubbed:**
  - Heart and MessageCircle icons on the detail card are **display-only** — they show `likeCount` and `commentCount` but have no press handlers. You can see the numbers but can't interact.
  - The "Comments" section always renders `"Comments coming soon."` — even when the post hasn't loaded yet. This is a literal stub text visible to all users.
  - The comments section renders **outside** the post-loaded conditional block, so it appears even on error states.
- **Safe fix applied:** See Section N.

### C2. Pulse Feed → `PulseFits` / `FitsCard`
- **What works:** The `For You` and `Following` feed modes load real posts via `usePulseFeed` / `useFollowingFeed` and render real `PostCard`/`PulseFeedCard` components.
- **What's broken:** `PulseFits.tsx` imports `me` and `users` from `src/data/cebu.ts` (which re-exports from `src/__fixtures__/cebu.ts`). The "Fits" section of the Pulse tab renders **hardcoded mock user profiles** (Cebu fixture data), not real travelers.
- **Risk:** Users see named fake profiles in the Pulse tab's Fits strip.

### C3. Post Category Stamp (Pulse Feed)
- The `postRowToFeedItem` mapper in `app/(tabs)/index.tsx` does not map `post.type` to the stamp. The `PulseFeedCard` always shows a generic travel stamp because `tags: []` is hardcoded and no `category` field flows through. This is tracked as Task #1481 (proposed).

### C4. Trip Detail (`app/trip/[id].tsx`)
- **What works:** `useTrip` hook loads real trip data; safe return, memories, nearby events all wired.
- **What's broken:** Falls back to `mockTripDetail` when the user is unauthenticated. Even when authed, `realTrip` values null-coalesce against `mockTripDetail` fields (coverUrl, startDate). If the trip is not found, no clear 404 state — mock data fills in silently.

### C5. Telegraph Mock Fallback (`src/services/telegraph.ts`)
- `getTelegraphRecommendations()` calls `POST /api/telegraph/recommend`. If the backend is unreachable or unconfigured, it returns `buildMockRecommendations()` (a hardcoded fixture). Users could see fake AI suggestions if the backend is down, with no indication they're not real.

### C6. Passport Hook Mock Fallback (`src/hooks/usePassport.ts`)
- When `isSupabaseConfigured` is false, `usePassport` returns `mockPassport` after `setTimeout(0)`. This is an intentional dev/demo path but creates a silent failure mode in production if keys are misconfigured — users see a fake passport instead of an error.

### C7. Events Tab — `useCityPulse` Mock Fallback
- In `__DEV__` mode, `useCityPulse` falls back to `mockEvents` if the API returns empty. In production builds this path is dormant, but worth noting for CI.

---

## D. Shell / Demo / Mock Systems

These are visible in the UI but deliver no real data.

### D1. Live Map (`app/live-map.tsx`)
- Screen is 100% placeholder. Displays an explainer card: "Map coming soon." No MapLibre render, no real locations, no pins.
- The screen is reachable via direct URL (`/live-map`) but not linked from main navigation.
- The comment in the file explicitly calls it a PLACEHOLDER.

### D2. AI Chat Tab (`app/(tabs)/ai.tsx`)
- Hidden from navigation (`href: null` in `_layout.tsx`).
- **Ironically this is actually well-wired**: it calls `postCompassAsk()` → real `/api/compass/ask` endpoint. Results include bestPick, why, social proof, tradeoffs. "Add to trip" via plan picker works.
- It's hidden, not broken. The placeholder text says "Ask about Cebu..." — minor copy issue, not a blocker.

### D3. `PulseFits` / `FitsCard` Fixture Strip
- As noted in C2: the Fits section in the Pulse tab renders mock users from `src/__fixtures__/cebu.ts`.

---

## E. Dead UI and Broken Buttons

| Screen | Element | Issue |
|--------|---------|-------|
| `post/[id].tsx` | Heart icon + like count | Display only — no `onPress` handler |
| `post/[id].tsx` | MessageCircle + comment count | Display only — no `onPress` handler |
| `post/[id].tsx` | "Comments coming soon." | Literal stub text, always visible |
| `app/(tabs)/ai.tsx` | Entire screen | Hidden (`href: null`) — not reachable from nav |
| `live-map.tsx` | Map area | Placeholder with no real data |
| `app/(tabs)/index.tsx` | Fits strip | Renders fake Cebu users |
| `trip/[id].tsx` | Trip not-found state | Falls back to mock instead of showing 404 |

---

## F. Backend Functions with No UI

These API routes / backend services have no corresponding mobile UI or caller:

| Backend | Route/Service | Status |
|---------|---------------|--------|
| `GET /api/users/suggestions` | Suggested-follower endpoint (`userSuggestions.test.ts` exists) | Backend done; UI exists via `PeopleYouMayKnow` component (Task #1477 area) |
| Telegraph SSE stream (`telegraphStream.ts`) | Real-time SSE endpoint | Mobile uses XHR polling, not SSE; backend SSE is dead code in practice |
| `POST /api/compass/ask` | AI ask endpoint | UI exists in `ai.tsx` but screen is hidden (`href: null`) |
| Route optimization (`routePlan.ts`) | Full route-planning backend | UI sheet `RouteBuilderSheet` exists in Discovery, lightly wired |
| Telegraph group commands (`telegraphCommands.ts`) | Bot/command handling | No visible command UI in mobile |
| Admin analytics (`/api/admin/compass/analytics`) | Compass usage metrics | Admin UI screen exists but limited |
| Stories close-friends (`closeFriends.ts` route) | Close friends list management | `close-friends.tsx` screen exists but limited wiring |
| `dailyBrief.ts` route | Daily brief generation | No prominent mobile UI entry point found |

---

## G. UI Features with No Backend

| Mobile UI | Missing Backend | Notes |
|-----------|----------------|-------|
| Post comments (tap) | No `GET /api/posts/:id/comments` or `POST /api/posts/:id/comments` | `post/[id].tsx` shows counts but cannot load or create comments |
| Post likes (tap from detail) | No `POST /api/posts/:id/like` called from detail screen | Like count displayed but not interactive on detail; feed cards ARE wired |
| Memory creation (full trip memory) | `POST /api/me/passport/memories` exists | UI exists in `memory/create.tsx` — needs audit of full flow |

---

## H. Missing Database / Schema Pieces

From migration audit (0010–0093):

1. **`location_intelligence_logs`** — referenced by `LocationIntelligenceEngine.ts` but not found in any 0010–0093 migration. May be pre-0010 or missing.
2. **`push_tokens` vs `device_tokens` naming** — `pushTokenService.ts` registers to `/api/me/devices`; the migration table name may differ. Needs verification if push delivery is failing.
3. **Docs drift** — Migrations 0071–0089, 0091–0093 (23 files) are present in `artifacts/api-server/src/migrations/` but NOT listed in `docs/migrations.md`. **Safe fix applied:** See Section N.

---

## I. Missing API Routes

| Mobile Call | Status |
|-------------|--------|
| `GET /api/posts/:id/comments` | **Missing** — no route; detail screen stubs it |
| `POST /api/posts/:id/like` | Exists in API; wired in feed cards; NOT called from post detail screen |
| Post category/type tagging | `posts.ts` route handles `type` field; mobile `postRowToFeedItem` ignores it |

---

## J. Privacy / Security Risks

| Risk | Location | Severity |
|------|----------|---------|
| **Mock passport shown silently** | `usePassport.ts` — returns `mockPassport` when Supabase keys missing | Medium — user could see someone else's fake data if keys are wrong |
| **Mock recommendations in Telegraph** | `telegraph.ts` — `buildMockRecommendations()` fallback on error | Low — no PII, but fake suggestions degrade trust |
| **MockTripDetail as fallback** | `trip/[id].tsx` — mock fills in when unauthenticated | Low — shows fake trip data, not real user data |
| **Hidden Gem coordinates** | `hiddenGems.ts` route strips exact coordinates for `private`/`restricted` gems | Currently correct — approximate coords returned; verify on each new route addition |
| **RLS bypass via service role** | All trip/memory/stamp inserts use service role key | Documented in replit.md (P-256 key rotation); intentional, but means RLS is not enforcing row-level ownership for these tables |
| **Feature flags fail-open** | `isFlagEnabled()` returns `true` on DB error | Medium — could expose unreleased features if DB is flaky |
| **Admin route role check** | `requireAdmin` checks `profiles.role === 'admin'` | Correct; tested |
| **Session expiry redirect** | `_layout.tsx` watches `isAuthed`; redirects to sign-in | Correct |

---

## K. Error Handling Gaps

| Location | Gap |
|----------|-----|
| `post/[id].tsx` | "Comments coming soon." renders even when post fails to load (comments section is outside the conditional block) — **fixed in this audit** |
| `trip/[id].tsx` | No 404 state when `realTrip` is null and user is authed — silently shows mock data |
| `usePassport.ts` | On Supabase misconfiguration, returns mock passport with no error banner |
| `telegraph.ts` | Mock fallback on backend error — no UI indication that recommendations are placeholders |
| `live-map.tsx` | No error state needed (it's a placeholder) but the "coming soon" text is undated |
| `useCityPulse.ts` | In `__DEV__`, empty API response triggers mock events silently |
| Global | Most screens have loading spinners and error retry buttons — good coverage. |

---

## L. Tests Missing or Weak

### Strong coverage (backend `artifacts/api-server/src/test/`):
- `accessControl`, `accountStatus`, `featureFlags`, `rateLimits` — core auth/permission layer
- `compass-feed`, `compass-pipeline`, `intelligence` — Compass AI engine
- `airport`, `events`, `geofence`, `safeReturn`, `stamps-integration` — travel features
- `trust`, `tagging`, `telegraphChat`, `postInteractions`, `friendDecisions` — social layer
- `pushDelivery`, `locationVerify` — integrations

### Weak or missing coverage:
| Area | Gap |
|------|-----|
| Post comments (create/fetch) | No backend route exists yet; no tests |
| Post likes (from detail screen) | Wiring gap not tested |
| `trip/[id].tsx` mock-fallback behavior | No test verifies what renders when `realTrip` is null |
| Mobile service tests | Only 3 files in `travel-buddy-standalone/src/test/` — `accountActivation`, `onboardingPassportFlow`, `stampGracefulDegradation` |
| `usePassport` mock fallback | No test that the mock path fires when Supabase is unconfigured |
| Live Map | N/A (placeholder; no tests needed yet) |
| `PulseFits` fixture leakage | No test that live screens don't render fixture data |

---

## M. Features Not Connected to Compass

Compass is supposed to be the "central brain" but these features are isolated from it:

| Feature | Connection Status |
|---------|-----------------|
| Hidden Gems | Gems appear in Compass feed; `discovery.ts` route merges with OSM. **Connected.** |
| Events | Events connected to Compass via intelligence engine. **Connected.** |
| Stamps | No Compass integration — stamps earned by GPS/admin, not AI-recommended |
| Trip plans | Trip plans not fed back into Compass preferences |
| Telegraph recommendations | `GET /api/telegraph/recommend` calls `TelegraphRecommendService` but this is separate from main Compass pipeline |
| Highlights/Stories | Not connected to Compass |
| Trust score | Not an input to Compass personalization |
| Availability | Availability data stored in DB; Compass preference engine may read it — needs verification |
| Following feed | `usePulseFeed` has a `following` mode; not Compass-ranked |

---

## Feature Status Matrix

| Feature | UI | Backend | DB | Wiring | Data Truth | Tests | Risk | Next Action |
|---------|----|---------|----|--------|-----------|-------|------|------------|
| Auth (sign-in/up) | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Onboarding | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | homeCity auto-fill (Task #1473) |
| Pulse feed | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | Fix category stamp (Task #1481) |
| Post creation | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Post detail | ⚠️ | ✅ | ✅ | ⚠️ | Real | None | Med | Wire comments (Task #1480), likes |
| Post comments | ❌ | ❌ | ❌ | ❌ | — | None | High | Build comment system |
| Post likes (feed) | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Post likes (detail) | ⚠️ | ✅ | ✅ | ❌ | Display only | None | Med | Wire like action on detail |
| Discovery | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Hidden Gems | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Events | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | — |
| Trips | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Trip detail | ⚠️ | ✅ | ✅ | ⚠️ | Mock fallback | None | Med | Fix 404 state |
| Trip plans | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Passport | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | — |
| Stamps v2 | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | — |
| Highlights | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Telegraph (1:1) | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | — |
| Telegraph (realtime) | ⚠️ | ✅ | ✅ | ⚠️ | Polling | Partial | Med | SSE wiring |
| Compass feed | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | — |
| AI Chat | 🙈 | ✅ | ✅ | ✅ | Real | Partial | Low | Unhide tab |
| Live Map | 🚫 | ❌ | ✅ | ❌ | Placeholder | None | Low | Build map feature |
| Safe Return | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | — |
| Rent-a-Buddy | ✅ | ✅ | ✅ | ✅ | Real | ⚠️ | Med | Finish payment flow |
| Notifications | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Blocks | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | — |
| Reports | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Collections/Saved | ✅ | ✅ | ✅ | ✅ | Real | Partial | Low | — |
| Admin tools | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | — |
| PulseFits strip | ⚠️ | ❌ | ❌ | ❌ | Fixture | None | High | Replace cebu.ts with real data |
| Suggested travelers | ✅ | ✅ | ✅ | ✅ | Real | ✅ | Low | Task #1477 area |

Legend: ✅ done · ⚠️ partial · ❌ missing · 🚫 placeholder · 🙈 hidden

---

## N. Safe Fixes Applied During Audit

### Fix 1: Post detail — comments stub and section placement

**File:** `travel-buddy-standalone/app/post/[id].tsx`  
**Issue:** "Comments coming soon." always rendered outside the post-loaded block (shows on error, on loading, on reported states). The stub text is visible to all users.  
**Fix:** Move the Comments section inside the post-rendered block, and replace the raw stub text with a styled "no comments yet" placeholder that matches the rest of the app.  
**Lines changed:** ~5 lines  

### Fix 2: Migration documentation — add missing 0071–0093 entries

**File:** `docs/migrations.md`  
**Issue:** 23 migration files (0071–0089, 0091–0093) exist in `artifacts/api-server/src/migrations/` but are not listed in the applied migrations table.  
**Fix:** Append the missing entries to the Applied Migrations table.  

---

## O. Files Changed

- `travel-buddy-standalone/app/post/[id].tsx` — comments section moved inside post block, stub text replaced
- `docs/migrations.md` — added 23 missing migration entries (0071–0093)

---

## P. Validation Results

| Check | Result |
|-------|--------|
| `cd travel-buddy-standalone && pnpm typecheck` | ✅ PASS (0 errors) |
| `pnpm run typecheck` (root) | ✅ PASS (0 errors) |
| `bash scripts/sync-standalone.sh --check-deps` | ✅ PASS — no drift |
| `bash scripts/sync-standalone.sh --check-source` | ✅ PASS — 0 drifted files |

---

## Q. Ranked Next 10 Tasks

Priority order — highest impact, most user-visible, lowest risk to existing behavior:

1. **Post comments system** — Backend route + mobile UI. "Comments coming soon." is the most jarring dead stub users encounter. Medium scope.
2. **Wire post likes on detail screen** — Call the same like toggle used in feed cards from the post detail. Small scope, high visibility.
3. **Replace PulseFits cebu.ts with real data** — `PulseFits` renders named fake users. Replace with real `GET /api/users/suggestions` or following list. Medium scope.
4. **Trip detail 404 state** — Replace `mockTripDetail` fallback with a proper not-found or sign-in-prompt state. Small scope.
5. **Unhide AI Chat tab** — `ai.tsx` is real and wired but hidden. Surface it as a nav item (or move to a discoverable entry point). 1-line change to routing + UX decision needed.
6. **Post category stamp** — `postRowToFeedItem` should map `post.type` to the stamp label. Small scope. (Task #1481)
7. **Full caption on post detail** — `post.content` is truncated in feed cards. Detail screen should show full text. (Task #1479)
8. **Live Map MVP** — Implement MapLibre with saved pins and trip location markers. Large scope.
9. **Passport mock-fallback error state** — When Supabase is misconfigured, show an error instead of `mockPassport`. Small scope, safety improvement.
10. **Docs migration log** — Keep `docs/migrations.md` current (already partially fixed in this audit).

---

## R. What Should Be Hidden / Subdued Temporarily

These items are visible but not working — they should be visually subdued or hidden until built:

| Item | Recommendation |
|------|---------------|
| "Comments coming soon." in post detail | Replace with styled empty state (done in this audit) |
| Live Map nav entry (if linked anywhere) | Keep the screen but add clear "Coming soon" framing — already done |
| AI Chat tab (`ai.tsx`) | Unhide OR keep hidden — but its current hidden state means users can't use a working feature |
| `PulseFits` with fake users | Either remove the Fits strip or replace with a real suggestions call |
| Heart/MessageCircle on post detail | Show counts but visually indicate they're not tappable yet, or hide until wired |

---

## S. What Should Be Built Next to Make the App Feel Connected

The app currently has all the major pieces but they don't yet flow into each other:

1. **Comments** — The single biggest gap. A social travel app where you can't reply to posts feels incomplete. Build `GET/POST /api/posts/:id/comments` and wire the detail screen.
2. **Post likes on detail** — 2 API calls away from working. The like endpoint exists; the detail screen just doesn't call it.
3. **Compass → Trips connection** — When Compass recommends a place, "Add to trip" should flow into trip planning (plan picker exists, but this loop should be more prominent).
4. **Stamps → Posts connection** — Earning a stamp should create an auto-post option ("You just earned the Cebu Explorer stamp — share it?").
5. **Discovery → Trips "save to trip"** — Saved places should appear in the trip planning screen as "Saved Ideas" (infrastructure exists, UI connection is thin).
6. **AI Chat visible** — Unhide the AI tab. It's the most unique differentiator and it's fully working.
7. **Live Map with saved pins** — Even without live user tracking, a map of your saved places + trip locations would make the app feel substantially more immersive.
8. **Notification tap-through accuracy** — Verify all `actionUrl` values in notifications navigate to real routes that exist.
9. **PulseFits real data** — Replace the cebu.ts fixture strip with the `GET /api/users/suggestions` endpoint so users see real followers-you-haven't-followed-back.
10. **Telegraph realtime (SSE)** — Replace XHR polling with the existing SSE endpoint to make chat feel live.
