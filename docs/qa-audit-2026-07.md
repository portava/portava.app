# QA Audit — July 2026

**Scope:** Full cross-system audit of the Travel Buddy mobile app (Task #1054).  
**Goal:** Identify and fix broken wiring, fixture/fake data shown in live (authenticated) mode, privacy gaps, and broken UX flows. No new features, no fake data introduced.

---

## System Inventory & Audit Results

| # | System | Status Before | Issues Found | Fixed? |
|---|--------|--------------|--------------|--------|
| 1 | **Notifications** | ✅ Clean | None — SSE + REST fully wired via `useNotifications` | N/A |
| 2 | **Messages / Telegraph** | ✅ Clean | Long-press Reply/Translate/Save show "Coming Soon" (P3, UI-only) | Deferred |
| 3 | **Trips tab** | ✅ Clean | Fixture fallback only shown when unauthenticated (correct) | N/A |
| 4 | **Trip detail** | ❌ Fixture leak | 6 fixture sections shown when live (see P1 below) | ✅ Fixed |
| 5 | **Trip creation** | ❌ Mock redirect | Unauthenticated path silently routed to fixture trip `/trip/t_1` | ✅ Fixed |
| 6 | **Passport / Profile** | ❌ Fixture masking | Error path rendered `mockPassport` data instead of error state | ✅ Fixed |
| 7 | **Stamps** | ✅ Clean | `usePassport` → `getMyStamps()` → real API endpoint | N/A |
| 8 | **Discovery** | ⚠️ Broken nav | Profile taps on Hidden Gems / Traveler Picks used UUID (not handle) → broken route | ✅ Fixed |
| 9 | **Events** | ⚠️ Broken nav | Event host profile link used `host.id` (UUID) instead of `host.handle` | ✅ Fixed |
| 10 | **Rent-a-Buddy** | ✅ Clean | Core flows wired; Pulse buddy module showed 3 hardcoded fake names | ✅ Fixed |
| 11 | **Pulse / Feed** | ⚠️ Fake data | Buddy module: 3 hardcoded names + "12 locals ready to help" count | ✅ Fixed |
| 12 | **Privacy / Safety** | ⚠️ Misleading UI | TripSafety showed "All good!" + "Coming Soon" alerts (false positive) | ✅ Fixed |

---

## Issue Detail & Fix Log

### P1 — Trip Detail: Fixture Data Shown in Live Mode
**Files:** `app/trip/[id].tsx`  
**Root cause:** `TodayNextUp`, `SavedIdeas`, `TripPlans`, `TripCircle`, `TripStamps`, `TripPostsSection` all passed fixture arrays/objects regardless of auth state. The `live` guard existed but wasn't applied to these components.  
**Fix:** Gate all six components behind `live` boolean (`configured && isAuthed`). When live: pass `null`/`[]`; real sections (`TripPlanSection`, `TripCrewSection`, `TripMemorySection`) already load live data.  
**Verification:** `pnpm typecheck` passes; no fixture data imported at runtime when authenticated.

### P1 — Trip Creation: Mock Redirect When Unauthenticated
**File:** `app/trip/new.tsx` line 32  
**Root cause:** `if (!live) { router.replace('/trip/t_1'); return; }` silently routed to a fixture trip instead of showing an error.  
**Fix:** Replace with `setError('Sign in to create a trip.')` — honest, actionable message.  
**Verification:** Typecheck passes.

### P1 — Passport: Mock Data Masking Live Errors
**File:** `app/(tabs)/passport.tsx` lines 158–221 (before fix)  
**Root cause:** `if (error || !profile)` block constructed a full `OwnProfile` from `mockPassport` and rendered it as if it were real. Users would see "Leo Travels" profile with fixture stamps instead of an error/sign-in prompt.  
**Fix:** Replace with a context-aware error/sign-in screen: error path shows "Retry"; unauthenticated path shows "Sign in" CTA routing to `/sign-in`. Remove `mockPassport` import.  
**Verification:** Typecheck passes; `mockPassport` import removed.

### P2 — TripSafety: Misleading Status + "Coming Soon" Alerts
**File:** `src/components/TripPage.tsx` — `TripSafety` component  
**Root cause:** Green shield + "All good!" header implied active check-in with no real data backing. Both action buttons fired `Alert.alert('Coming Soon', ...)`.  
**Fix:** Changed header to "Trip safety tools", sub-text to an honest description. Buttons now navigate to `/safety-history` and `/settings`. Color changed from `color.success` to `color.deep`.  
**Verification:** Typecheck passes.

### P2 — Pulse Buddy Module: Hardcoded Fake Names
**File:** `app/(tabs)/index.tsx` lines 240–258 (before fix)  
**Root cause:** Three hardcoded cards with names "Marco T.", "Ana R.", "Jin S." and fabricated ratings were shown as real buddy previews.  
**Fix:** Replace the three cards with a single "Browse local buddies in {activeCity}" CTA button that routes to the real `/(rent-a-buddy)/search` screen with the city pre-filled. Also changed "12 locals ready to help" to "Local buddies available".  
**Verification:** Typecheck passes.

### P2 — Discovery Profile Navigation: UUID Routing
**Files:** `src/components/DiscoveryWall.tsx`, `src/services/discovery.ts`, `src/__fixtures__/discovery.ts`, `src/hooks/useCommunityDiscovery.ts`, `artifacts/api-server/src/routes/discovery.ts`  
**Root cause:** `submittedBy` and `pick.user` types lacked a `handle` field. All profile navigation used `id` (UUID) routed to `/profile/:uuid`, which the profile screen could not resolve.  
**Fix:**  
  - API route: add `username` to `profiles:submitted_by!left` Supabase join; map → `handle` in response  
  - Types: add `handle: string | null` to `CommunityPlaceItem.submittedBy`, `DiscoveryItem.submittedBy`, `TravelerPick.user`  
  - Mappers: propagate `handle` through `useCommunityDiscovery` `toDiscoveryItem` / `toTravelerPick`  
  - `DiscoveryUserAvatar`: navigate to `/u/:handle` when no highlight ring active and handle available  
  - `HiddenGemCard` "By name" + `TravelerPickCard` username: navigate to `/u/:handle` when handle available; `onPress=undefined` when null (graceful degradation, no dead link)  
**Verification:** Typecheck passes; source drift 0.

### P2 — Event Host Profile Navigation: UUID Routing
**File:** `app/event/[id].tsx` line 503  
**Root cause:** Host profile tapped routed to `/profile/${event.host!.id}` (UUID). The `host` object has a `handle` field.  
**Fix:** `event.host!.handle ? router.push('/u/:handle') : undefined` — navigates correctly when handle exists, non-tappable otherwise.  
**Verification:** Typecheck passes.

### P2 — Trip Hero "Invite Buddy": Missing Trip Context
**File:** `src/components/TripPage.tsx` — `TripHero` component  
**Root cause:** "Invite Buddy" routed to `/circle` without any trip context. Circle screen couldn't know which trip to associate with the invite.  
**Fix:** Route to `/circle?tripId=<id>` so the circle screen can read the param.  
**Verification:** Typecheck passes.

### P3 — NeedSomeoneLocalSection: Fixture Group Size
**File:** `app/trip/[id].tsx`  
**Root cause:** `groupSize` derived from `tripCircle.inCity.length` (fixture data) when live.  
**Fix:** `groupSize` defaults to `"1"` (solo) when live — honest fallback.

---

## Privacy & Security Review

| Gate | Mechanism | Status |
|------|-----------|--------|
| Blocked users | `BlockedIdsContext` + API `PrivacyGuard` classes | ✅ Enforced |
| Private profiles | Backend `PassportPrivacyGuard`; public endpoints return 403/404 | ✅ Enforced |
| RLS on trip writes | API server uses service role key (P-256 JWT compat) | ✅ Per architecture decision |
| Auth-gated routes | `useSession` configured+isAuthed checks throughout | ✅ Clean |

No P0 privacy/security issues found.

---

## Verification Summary

```
cd travel-buddy-standalone && pnpm typecheck   → PASS (0 errors)
pnpm run typecheck                            → PASS (all workspaces)
bash scripts/sync-standalone.sh --check-source → PASS (0 drifted files)
bash scripts/sync-standalone.sh --check-deps   → PASS
```

All 9 fixes pass typecheck. No new fixture data introduced. No existing tests broken.
