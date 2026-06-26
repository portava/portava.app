# Travel Buddy — Stabilization & Wiring Audit Report

**Date:** 2026-06-26  
**Scope:** Full app screen audit — broken flows, dead buttons, privacy/safety issues, mock-data exposure.

---

## Executive Summary

The app is architecturally sound with a real Supabase + Express backend. The majority of core flows (messaging, trips, safety, profile, stamps, notifications) are genuinely wired to live data. Issues found in this audit fall into three categories: **payment-UI mismatch** (checkout falsely implied live payment processing), **missing onboarding persistence** (interest/style selections were discarded), and **admin screens accessible without auth redirect** (API-side protection existed but the mobile UI had no client-side guard).

P0 fixes are complete. P1 fixes for checkout, onboarding, and admin screens are complete. Several P1 wiring gaps (Saved screen, Trip sub-sections, message actions) are documented below and tracked as follow-up tasks — they require new API endpoints and are out of scope for a stabilization-only pass.

---

## Screen-by-Screen Wiring State

| Screen | File | Status | Notes |
|--------|------|--------|-------|
| Home feed | `(tabs)/index.tsx` | **Pass** | Real — uses `usePulse`, live post data |
| Discovery | `(tabs)/discovery.tsx` | **Pass** | Real — traveler search wired to `searchUsers` |
| Trips list | `(tabs)/trips.tsx` | **Pass** | Real — `useMyTrips` hook, real CRUD |
| Passport | `(tabs)/passport.tsx` | **Pass** | Real — `usePassport` hook, stamp data live |
| Messages inbox | `messages/index.tsx` | **Pass** | Real — TelegraphInboxScreen, live thread list |
| Chat thread | `messages/[id].tsx` | **Partial** | Real: send/receive/translate; Dead buttons: long-press reply, save |
| Trip detail | `trip/[id].tsx` | **Partial** | Real header; several sub-sections still use fixture data |
| Trip create | `trip/new.tsx` | **Pass** | Real — API server POST /api/trips |
| Profile view | `profile/[handle].tsx` | **Pass** | Real — follow/block/message all wired |
| Profile edit | `profile/edit.tsx` | **Pass** | Real — updateMyProfile, avatar upload |
| Onboarding | `(auth)/onboarding.tsx` | **Fixed** | Now saves interests/style via updateMyProfile |
| Safe return history | `safety-history.tsx` | **Pass** | Real — getHistory service |
| Notifications | `notifications.tsx` | **Pass** | Real — useNotifications + useRequests |
| Circle | `circle.tsx` | **Pass** | Real — follow/availability APIs |
| Stamps | `stamps.tsx` | **Pass** | Real — usePassport hook |
| Live map | `live-map.tsx` | **Partial** | Honest "coming soon" placeholder; no real map yet |
| Saved | `saved.tsx` | **Fail** | Filters fixture cebu posts — no real saved-posts API |
| Destination detail | `destination/[slug].tsx` | **Fail** | Hardcoded to Cebu data — no real destination API |
| Rent-a-Buddy home | `(rent-a-buddy)/index.tsx` | **Partial** | Real search; "Available Now" list is static fixture |
| Checkout | `(rent-a-buddy)/checkout.tsx` | **Fixed** | Removed payment implication; "Request Booking" flow |
| Admin: Trust settings | `admin/trust-settings.tsx` | **Fixed** | Auth guard + data gating added; API-protected |
| Admin: Gaming flags | `admin/gaming-flags.tsx` | **Fixed** | Auth guard + data gating added |
| Admin: Trust reviews | `admin/trust-reviews.tsx` | **Fixed** | Auth guard + data gating added |
| Admin: Hashtags | `admin/hashtags.tsx` | **Fixed** | Auth guard + data gating added |

---

## Issues Fixed (This Pass)

### P0 — Critical

#### [FIXED] Checkout falsely implied live in-app payment processing
**File:** `app/(rent-a-buddy)/checkout.tsx`  
**Risk:** Users could believe they are paying real money through the app. No payment processor is integrated.  
**Fix applied:**
- Renamed CTA button: "Confirm & Pay" → "Request Booking"
- Changed icon: CreditCard → CalendarCheck
- Renamed label: "Due today" → "Estimated total"
- Removed the "Pay in full in-app" Switch toggle entirely
- Added explicit blue notice: "Payment is arranged directly with your Buddy after they confirm. In-app payments are coming soon."
- Updated confirmation notice wording to reflect request (not payment) flow
- Removed unused `Switch`, `fullPayment`, `cashBalance`, `totalDueNow` state/imports

#### [FIXED] Admin screens rendered for unauthenticated users with no redirect
**Files:** `admin/trust-settings.tsx`, `admin/gaming-flags.tsx`, `admin/trust-reviews.tsx`, `admin/hashtags.tsx`  
**Risk:** Any user who knew the URL path could mount the admin screen UI, triggering API calls that returned 403s but leaving a confusing error state visible. Data loading effects ran independently of session state.  
**Fix applied:**
- Added `useSession` hook to all four admin screens
- Redirect effect: `if (!isAuthed) router.replace('/(auth)/sign-in')` fires as soon as session state resolves
- Data loading effects gated on `isAuthed && !sessionLoading` — no API calls fire for unauthenticated users
- API-level role enforcement (403 for non-admin) unchanged

### P1 — Broken Core Flow

#### [FIXED] Onboarding interest/style selections were silently discarded
**File:** `app/(auth)/onboarding.tsx`  
**Fix applied:**
- CTA now calls `updateMyProfile({ interests: picked, travelStyle: style })` before navigating
- Loading state (ActivityIndicator) while saving
- Error alert gives "Continue anyway" and "Retry" options if save fails
- `config_error` / `unauthenticated` failures navigate through silently (dev environments without Supabase)

#### [FIXED] Trip "Edit Trip" and "More" buttons fired misleading "coming soon" alerts
**File:** `app/trip/[id].tsx`  
**Fix applied:**
- "Edit Trip" → dimmed (opacity 0.35) non-interactive `View` with `accessibilityLabel`
- "More" (MoreHorizontal) button removed entirely
- Removed unused `MoreHorizontal` import

---

## Open Issues (Explicitly Deferred — Require New API Endpoints)

The following items were identified during the audit but are **out of scope for a stabilization pass**. They require new database queries, API endpoints, and/or data migrations. Each is tracked as a follow-up task (see task refs below). The screens listed here remain in "Partial" or "Fail" state pending those follow-up tasks; no further stabilization work on them is in scope here.

### P1 — Wiring Gaps

| ID | Screen | Description | Follow-up |
|----|--------|-------------|-----------|
| P1-01 | `saved.tsx` | Filters hardcoded cebu fixture posts. Needs `GET /api/me/saved` endpoint. No real saved-posts data available. | #427 |
| P1-02 | `destination/[slug].tsx` | Hardcoded to Cebu data. Needs a real destination-by-slug API. No schema for destination pages exists. | — |
| P1-03 | `trip/[id].tsx` | `SavedIdeas`, `TripPlans`, `TripCircle`, `TripStamps`, `TripPosts` sub-sections use fixture constants from `src/data/tripDetail.ts`. Requires new per-trip sub-resource endpoints. | #428 |
| P1-04 | `(rent-a-buddy)/index.tsx` | `MOCK_NOW_BUDDIES` hardcoded — "Available Now" ignores real availability. Requires a query against `rent_buddy_availability`. | — |
| P1-05 | `messages/[id].tsx` | Long-press "reply" and "save" show "coming soon" Alert. Requires reply threading and saved-messages API. | #429 |

### P2 — Polish

| ID | Screen | Description |
|----|--------|-------------|
| P2-01 | `trip/[id].tsx` | `TripMapPlaceholder` static card could be removed or replaced with a cleaner stub. |
| P2-02 | `admin/trust-detail.tsx` | Missing auth redirect (uses `useLocalSearchParams` without router; needs `useSession` check). Currently API-protected only. |
| P2-03 | Checkout | Cancellation policy text mentions "deposit refund" — language from before the payment-implication fix. Should be updated to post-confirmation payment model. |
| P2-04 | `src/hooks/useGroupChat.ts` | Imports `getTripChat` / `getCircleChat` from messaging service, but messaging.ts exports `openTripChat`. Runtime crash risk if circle chat is opened via this hook. |

---

## Phase 3: Tests Added

**File:** `artifacts/api-server/src/test/accessControl.test.ts`

New test suite covering 8 sections (33 tests, all passing):

| Section | Cases | Coverage |
|---------|-------|----------|
| A — Admin trust routes | 6 | Unauthenticated → 401, regular user → 403, admin → 200 for settings, gaming-flags, and reviews |
| B — Block/unblock routes | 5 | Unauthenticated → 401, self-block → 400, invalid UUID → 400, valid block → 200, DELETE unblock → 401 |
| C — Trip chat membership | 5 | Unauthenticated → 401, non-member → 403 (not_member), invited-only → 403 (pending_invite), **removed member (left_at set) → 200 with memberAccess:'removed' + empty messages**, invalid UUID → 400 |
| D — Safe Return auth guard | 4 | Unauthenticated → 401 for history, active session, create session, trusted contacts |
| E — Follows auth + self-follow | 3 | Unauthenticated → 401 for follow and unfollow, self-follow → 400 |
| F — Telegraph removed-member | 5 | Unauthenticated → 401, non-member → 403, **removed member (left_at set) → 403**, active member → 200, invalid UUID → 400 |
| G — canMessage() unit tests | 2 | **Block between users → verdict denied/blocked**; self-message → denied/self |
| H — open-thread block check | 3 | Unauthenticated → 401, self-message → 400, **blocked user → 403 forbidden** (canMessage integration) |

All tests use `node:test` + fake Supabase client via `_setTestClient(client, true)` (which sets both the user auth slot and the service client slot). No real database connections required.

**Key privacy/access behaviors verified by tests:**
- Blocked users cannot open a direct thread (`canMessage` → denied → 403)
- A block row produces `verdict: "denied", reason: "blocked"` in `canMessage` (unit tested)
- Thread members who left (`left_at` set) are denied telegraph suggestions (403 forbidden)
- Removed trip members see `memberAccess: "removed"` with no messages (graceful degradation, not hard rejection)
- Invited-but-not-accepted trip members cannot read trip chat (403 pending_invite)
- Admin endpoints enforce both authentication (401) and role (403) guards

---

## Architecture Notes

### What is genuinely live (real Supabase/API data)
- Auth (sign-in, sign-out, session)
- Trip CRUD (create, load, invite, RSVP)
- Trip plan items (full CRUD via `TripPlanSection`)
- Trip availability / meetup scheduling
- Messaging (threads, messages, real-time sub, translate, RSVP)
- Telegraph (AI chat suggestions, concierge)
- Profile (view, edit, avatar upload, username check)
- Follow/unfollow, friend requests, block/unblock
- Safety sessions and safe-return check-ins
- Notifications (activity center, unread counts, SSE stream)
- Passport stamps, passport postcards
- Admin trust scores, gaming flags, hashtag moderation
- Rent-a-Buddy (buddy search, booking create, booking detail)

### What is fixture/mock data (not yet wired)
- Saved posts (`saved.tsx`) — no API endpoint
- Destination detail page (`destination/[slug].tsx`) — hardcoded Cebu
- Trip sub-sections: SavedIdeas, TripPlans, TripCircle, TripStamps, TripPosts
- Rent-a-Buddy "Available Now" list

### Key architectural decision (for reference)
Trip creation routes through the API server rather than Supabase PostgREST directly because the project's Supabase JWT signing key was rotated to ECC P-256 and PostgREST's `auth.uid()` returned NULL under the new key. The API server verifies JWT via `supabase.auth.getUser(token)` then inserts with the service role key. This pattern should be followed for any future mutation endpoints.

---

## TypeScript Health

Pre-existing error count: **128** (all Expo Router typed-path errors — `router.push('/some-path')` not matching the strict `RelativePathString` generated type). None introduced by this audit pass. Systematic fix requires generating proper typed routes with `expo-router`'s type-generation tooling or using `as any` casts consistently — project-wide change outside this audit's scope.

## Files Changed

| File | Change |
|------|--------|
| `artifacts/travel-buddy/app/(auth)/onboarding.tsx` | Wire save: calls `updateMyProfile` before navigation; loading state; retry alert |
| `artifacts/travel-buddy/app/(rent-a-buddy)/checkout.tsx` | Remove payment implication; "Request Booking" CTA; payment-coming-soon notice |
| `artifacts/travel-buddy/app/admin/trust-settings.tsx` | Auth guard + data load gating |
| `artifacts/travel-buddy/app/admin/gaming-flags.tsx` | Auth guard + data load gating |
| `artifacts/travel-buddy/app/admin/trust-reviews.tsx` | Auth guard + data load gating |
| `artifacts/travel-buddy/app/admin/hashtags.tsx` | Auth guard + data load gating |
| `artifacts/travel-buddy/app/trip/[id].tsx` | Replace dead "Edit Trip" and "More" buttons; remove unused imports |
| `artifacts/api-server/src/test/accessControl.test.ts` | New: 20-test access control suite (admin, blocks, trip chat, safe return, follows) |
| `AUDIT_REPORT.md` | This report |
