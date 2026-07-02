# QA Follow-Up Tracker — July 2026

**Task:** #1183 — Follow-up audit & repair pass  
**Date:** 2026-07-02  
**Baseline docs:** `docs/qa-audit-2026-07.md`, `docs/qa-report-final.md`, `artifacts/travel-buddy/docs/BETA_READINESS_CHECKLIST.md`

---

## Legend
- ✅ **Fixed** — issue is resolved, code changed
- ✅ **Verified** — prior fix re-confirmed clean; no code change needed
- ⚠️ **Partial** — issue is mitigated but not fully resolved
- 🔵 **Deferred** — intentionally left for post-beta; honestly labeled in UI
- ❌ **New** — newly discovered in this follow-up pass, not in prior audit

---

## Prior Audit Items (Task #1054)

| # | System | Prior Status | Follow-up Status | Notes |
|---|--------|-------------|-----------------|-------|
| 1 | **Notifications** | No issues | ✅ Verified | SSE + REST fully wired; `useNotifications` hook clean |
| 2 | **Messages / Telegraph** | Deferred P3 | ✅ Verified | Long-press Reply/Translate/Save show Alert("Coming Soon") — explicitly labeled; P3 design intent |
| 3 | **Trips tab** | Clean | ✅ Verified | Unauthenticated fixture fallback path correct; live path uses `useMyTrips` |
| 4 | **Trip detail** | ✅ Fixed (prior) | ✅ Verified | 6 fixture sections gated behind `live` boolean; sub-sections show honest empty state |
| 5 | **Trip creation** | ✅ Fixed (prior) | ✅ Verified | Unauthenticated path now shows honest error; no mock redirect |
| 6 | **Passport / Profile** | ✅ Fixed (prior) | ✅ Verified | Error path shows retry; unauthenticated path shows sign-in CTA; no fixture masking |
| 7 | **Stamps** | Clean | ✅ Verified | `usePassport()` → `getMyStamps()` → real API |
| 8 | **Discovery nav** | ✅ Fixed (prior) | ✅ Verified | Profile taps use `handle` for `/u/:handle` routing |
| 9 | **Events nav** | ✅ Fixed (prior) | ✅ Verified | Host profile taps use `handle` not UUID |
| 10 | **Rent-a-Buddy** | ✅ Fixed (prior) | ✅ Verified | Buddy module CTA wired; no hardcoded names |
| 11 | **Pulse / Feed** | ✅ Fixed (prior) | ✅ Verified | Editorial fixture gated to `__DEV__`; buddy module replaced with real CTA |
| 12 | **Privacy / Safety** | ✅ Fixed (prior) | ✅ Verified | TripSafety shows honest description; buttons navigate to real screens |

---

## Checklist Items (BETA_READINESS_CHECKLIST.md)

| Item | Prior Status | Follow-up Status | Notes |
|------|-------------|-----------------|-------|
| `post/[id].tsx` body | FIXTURE-BACKED | ✅ Fixed (this pass) | Wired to `GET /api/posts/:postId` via new `getPostById()`; removed cebu fixture import |
| `post/[id].tsx` comments | STUB | ✅ Verified honest | Label changed from "wire to backend later" → "Comments coming soon." |
| Pulse feed editorial posts | FIXTURE mixed | ✅ Verified | `editorialPosts` from cebu gated to `__DEV__` — not visible in production |
| Compass opening text | FIXTURE seed | 🔵 Deferred | Opening text uses a seeded fixture; no API yet for personalized context; P2 per checklist |
| Safe Return setup / emergency contacts | STUB | 🔵 Deferred | Alert stubs explicitly labeled "Coming Soon"; correct per checklist ("do not ship as if functional") |
| Edit Trip button | STUB (opacity 0.35) | 🔵 Deferred | Disabled with reduced opacity; no onPress — honest; P3 per checklist |
| Pulse card Report / Hide | Alert("Coming Soon") | 🔵 Deferred | Explicitly labeled in alert; no silent no-op; P3 per checklist |
| Pulse card Bookmark | Alert("Coming Soon") | 🔵 Deferred | Explicitly labeled; P3 per checklist |
| Telegraph Reply / Translate / Save | Alert("Coming Soon") | 🔵 Deferred | P3 design intent from prior audit; long-press menu items are explicitly labeled |
| `saved.tsx` | Explorer flagged as fixture | ✅ Verified clean | Screen uses `collections` service (real API); no fixture import; explorer flag was false positive |

---

## Uncovered Screen Sweep (Step 2)

Screens audited in this pass that were not in prior audit:

| Screen | Fixture Leak | Coming Soon Stubs | Wired | Status |
|--------|-------------|------------------|-------|--------|
| `post/[id].tsx` | ~~YES~~ → fixed | Comments (labeled) | ✅ | ✅ Fixed |
| `memory/[id].tsx` | NO | NO | ✅ memories service | ✅ Clean |
| `memory/create.tsx` | NO | NO | ✅ memories service | ✅ Clean |
| `gems/index.tsx` | NO | NO | ✅ hiddenGems service | ✅ Clean |
| `gems/[id].tsx` | NO | NO | ✅ hiddenGems service | ✅ Clean |
| `gems/submit.tsx` | NO | NO | ✅ hiddenGems service | ✅ Clean |
| `hashtag/[slug].tsx` | NO | NO | ✅ posts service | ✅ Clean |
| `route/[id].tsx` | NO | Rideshare/tips alerts (labeled) | ✅ routes service | 🔵 Deferred (labeled) |
| `appeals.tsx` | NO | NO | ✅ appeals service | ✅ Clean |
| `close-friends.tsx` | NO | NO | ✅ social service | ✅ Clean |
| `saved.tsx` | NO (false positive) | NO | ✅ collections service | ✅ Clean |
| `saved-profiles.tsx` | NO | NO | ✅ savedProfiles service | ✅ Clean |
| `restricted-users.tsx` | NO | NO | ✅ restrict service | ✅ Clean |
| `muted-users.tsx` | NO | NO | ✅ mutes service | ✅ Clean |
| `pending-posts.tsx` | NO | NO | ✅ admin service | ✅ Clean |
| `compass-preferences.tsx` | NO | Buddy profile alert (labeled) | ✅ compass service | 🔵 Deferred (labeled) |
| `settings/safety.tsx` | NO | NO | ✅ SocialSafetyControls | ✅ Clean |
| `settings/location.tsx` | NO | Trusted circle (text label) | ✅ supabase | 🔵 Deferred (labeled) |
| `settings/notifications.tsx` | NO | NO | ✅ supabase | ✅ Clean |
| `settings/emergency-contacts.tsx` | NO | NO | ✅ emergencyContacts service | ✅ Clean |
| `admin/feature-flags.tsx` | NO | NO | ✅ `/api/admin/feature-flags` | ✅ Clean |

---

## Source-of-Truth Audit (Step 5)

| Data domain | Canonical store | Duplicate stores found | Status |
|-------------|----------------|----------------------|--------|
| Auth session | `SessionContext` (`src/context/SessionContext.tsx`) | None | ✅ Single source |
| Current city | `LocationContext` / `useActiveLocation` | None | ✅ Single source |
| GPS coords | `LocationContext` via `expo-location` | None | ✅ Single source |
| Profile data | `usePassport()` (own) + `getPublicProfile()` (others) | None | ✅ Single source |
| Save state | `src/services/saves.ts` + `src/services/collections.ts` | None | ✅ Consistent |
| Notification unread | `useUnreadCounts()` from `src/hooks/useMessaging` | None | ✅ Single source |
| Message unread | `useUnreadCounts()` from `src/hooks/useMessaging` | None | ✅ Single source |
| Privacy settings | `PassportSettingsSheet` → `supabase.profiles` | None | ✅ Single source |

No duplicate stores or stale cross-invalidation issues found.

---

## Regression Sweep (Step 6)

Post-merge systems checked:

| System | Tasks merged after prior audit | Regression found? |
|--------|-------------------------------|------------------|
| Telegraph (inbox, DM, SSE) | #15, #67, #79, #83 | ✅ No regression |
| Daily Brief | #41, #66, #72–#77, #84–#87, #91–#96 | ✅ No regression |
| Meetup planning | #12, #34–#60 | ✅ No regression |
| Plan builder | #13–#14, #100–#106 | ✅ No regression |
| Follow / passport | #1–#3, #18 | ✅ No regression |
| Notifications / push | #5, #23 | ✅ No regression |

---

## Broken-Path Zero-Tolerance Check (Step 7)

All visible interactive elements audited across core surfaces:

| Surface | Element | Status |
|---------|---------|--------|
| Trips tab | Trip cards → `/trip/:id` | ✅ Wired |
| Trips tab | New trip button → `/trip/new` | ✅ Wired |
| Trips tab | Invite accept / decline | ✅ Wired (real API) |
| Trips tab | Meetups shortcut → `/meetups` | ✅ Wired |
| Trips tab | Layover Mode sheet | ✅ Wired |
| Trip detail | TripPage components | ✅ Fixed in prior audit |
| Passport | Postcards, Stamps, Trips, Map tabs | ✅ Wired via `usePassport` |
| Passport | Share button | ✅ Wired |
| Passport | Settings sheet | ✅ Wired |
| Passport | Edit profile → `/profile/edit` | ✅ Wired |
| Passport | View as public → `/u/:username` | ✅ Wired |
| Discovery | Category tabs + filters | ✅ Wired |
| Discovery | Place taps → `PlaceDetailSheet` | ✅ Wired |
| Discovery | Profile taps → `/u/:handle` | ✅ Fixed in prior audit |
| Discovery | Map / List toggle | ✅ Wired |
| Events | Event cards → `/event/:id` | ✅ Wired |
| Events | Host profile → `/u/:handle` | ✅ Fixed in prior audit |
| Events | Create → `/events/create` | ✅ Wired |
| Events | Save toggle | ✅ Wired (real API) |
| Messages | Inbox / DM / group threads | ✅ Wired via Telegraph |
| Post detail | Body + author | ✅ Fixed this pass (was fixture) |
| Post detail | Share / Report overflow | ✅ Wired |
| Post detail | Comments section | 🔵 Labeled "coming soon" |
| Saved | Collections list / create / delete / rename | ✅ Wired |
| Saved | Collection items → entity routes | ✅ Wired |
| Pulse | Global feed | ✅ Wired (editorial posts `__DEV__` only) |
| Pulse | Card long-press Report / Hide | 🔵 Alert("Coming Soon") — explicitly labeled |
| Pulse | Card Bookmark | 🔵 Alert("Coming Soon") — explicitly labeled |
| Settings | Safety, Location, Notifications, Emergency contacts | ✅ Wired |
| Admin | Feature flags | ✅ Wired |

**Remaining deferred items**: 6 intentional stubs (see Deferred section above) — all explicitly labeled in UI.

---

## Changes Made in This Pass

| File | Change |
|------|--------|
| `artifacts/travel-buddy/src/services/posts.ts` | Added `getPostById(postId)` function wired to `GET /api/posts/:postId` |
| `artifacts/travel-buddy/app/post/[id].tsx` | Replaced cebu fixture + PostCard with real `getPostById` + async loading states + minimal `PostDetailCard` |
| `docs/qa-follow-up-tracker.md` | This document |
| `docs/qa-follow-up-final.md` | Final deliverable |

---

## Remaining Blockers (out of scope for this task)

Per task spec, these are documented but not fixed here:

- **EAS build setup** — no bundle identifier, no `eas.json`, no Expo account link (P0 for device beta)
- **Permission usage strings** — required for iOS App Store review  
- **Crash logging** — no Sentry or equivalent (P1 for beta feedback)
- **Compass opening text** — still uses seeded fixture; needs a real context API (P2)
- **Comments backend** — `GET/POST /posts/:postId/comments` route not yet built; screen honestly labels stub
- **MapLibre native map** — pre-existing native-only design constraint (P3)
- **Telegraph SSE multi-instance** — pre-existing architecture constraint (Redis needed for multi-pod)
