# Portava App Audit — Pass 2 (Fresh Verification)
*July 16 2026 — all findings verified against live code and production DB*

---

## 1. Remaining P0 Items

### P0-1 · MapTab has no geographic map — CONFIRMED, UNRESOLVED
**Evidence:** `artifacts/travel-buddy/src/components/MapTab.tsx`
- Imports: `getPassportMap`, `listNearbyUsers` — real API calls, real data
- Renders: city-level stats, nearby-traveler avatar chips, postcard thumbnails
- Does NOT import or render any map engine (no Mapbox, no MapTiler, no react-native-maps)
- `EXPO_PUBLIC_MAPTILER_KEY` secret exists in the workspace but is never consumed by this component
- **Status: PARTIAL — meaningful data, zero geographic rendering**
- **Fix scope:** Integrate MapTiler/Mapbox MapView; overlay the existing markers/postcards on it

### P0-2 · Migration 0143 (passport_tab_order) — ✅ RESOLVED
- Applied to production 2026-07-16; verified via `information_schema.columns`

### P0-3 · RLS gap on core tables — CONFIRMED, UNRESOLVED
**Evidence:** grep of all 143 migrations for `ENABLE ROW LEVEL SECURITY`
- **Tables WITH RLS:** appeals, event_attendees, event_saves, event_invites, event_cohosts, event_posts, event_media, event_reports, event_activity_log, layover_sessions, layover_recommendations, layover_plan_stops, layover_events, universal_stamp_catalog, stamp_artwork_versions, stamp_generation_queue, stamp_admin_audit_log, stamp_reconciliation_log, rent_buddy_availability, buddy_availability_exceptions
- **Tables WITHOUT RLS (confirmed):** profiles, trips, trip_members, posts/postcards, messages, user_follows, notifications, circles, circle_members, saved_places, highlights, memories
- **Production trigger check:** only trigger on `profiles` is `trg_profiles_updated` (sets `updated_at`). No row-security triggers.
- **Status: UNRESOLVED — application middleware (`requireUser`) is the sole guard on most user data**

---

## 2. Remaining P1 Items

### P1-1 · Payments not wired to provider — CONFIRMED, INTENTIONAL
**Evidence:** `artifacts/api-server/src/routes/rentABuddy.ts` lines 1373, 1383
```
"In-app payment is not yet available. Payment arrangements are agreed
directly with your Buddy after booking confirmation — no charge is made
through the app."
```
- No Stripe, PayPal, or any external payment SDK referenced anywhere in the codebase
- **Status: NOT STARTED (by design for now) — blocks any real booking transaction**

### P1-2 · Video upload without transcoding — CONFIRMED, PARTIAL
**Evidence:** `artifacts/api-server/src/routes/postcards.ts`
- MIME types accepted: `video/mp4`, `video/quicktime`, `video/webm` (lines 36-38)
- Thumbnail: client-supplied frame path; no server generation (TODO line 15)
- No ffmpeg, no HLS, no transcoding step exists
- Raw video uploads to storage and URL is returned as-is
- **Status: PARTIAL — upload path works; playback quality/compatibility unverified; no processing**

### P1-3 · Event stamps — PARTIALLY RESOLVED
**Evidence:** `artifacts/api-server/src/routes/events.ts`
- `first_event_joined` stamp: fires fire-and-forget on first Going RSVP (line ~2024)
- `first_event_hosted` stamp: fires fire-and-forget on first published event (line ~3686)
- Category variant stamps (food/music/outdoor/cultural): **TODO at lines 3713-3716**, task #1041, not implemented
- **Status: PARTIALLY COMPLETE — milestone stamps work; category variants not started**

### P1-4 · Followers/Following count — UNVERIFIED, RISK CONFIRMED
**Evidence:** Production DB query
- `followers_count` and `following_count` columns do NOT appear in `information_schema.columns` for `profiles` table
- No trigger on `user_follows` table (only trigger on profiles is `set_updated_at`)
- No route writes to `followers_count` (grep of all routes returns 0 hits)
- `PassportStatsRow` reads `profile.followersCount` — must come from somewhere
- **Status: BLOCKED — need to trace where the count comes from (RPC? computed column? view?)**
- **Action:** Query production for how followersCount is served; suspect it's a Supabase view or computed in a join inside the profile fetch route

---

## 3. Items Newly Confirmed Complete

| Item | Evidence |
|---|---|
| P0-2 Migration 0143 | ✅ Column confirmed in production `information_schema.columns` |
| P2-1 Pulse tab | ✅ `app/(tabs)/index.tsx` IS Pulse; it is tab 1 in `_layout.tsx` |
| P2-2 Telegraph accessibility | ✅ Intentionally hidden from tab bar (href: null) but reached via profile → message, trip chat, event chat, circle chat, booking chat, AI screen |
| P2-5 Rent-a-Buddy pricing | ✅ Uses buddy-defined `price_usd` from DB; not hardcoded |

---

## 4. Items Still Partially Complete

| Item | Status | Gap |
|---|---|---|
| MapTab | PARTIAL | Real data; no map engine |
| Video uploads | PARTIAL | Upload works; no transcoding |
| Event stamps | PARTIAL | Milestone stamps fire; category variants not started |
| Find Your Circle | PARTIAL | Settings toggle exists (`/profile/edit/location.tsx`); no dedicated discovery flow or matching screen |
| Highlights deep-link | PARTIAL | Notification `actionUrl` handles it; no `/highlights` route file (direct deep-link would 404) |
| Circles | PARTIAL | Tables + routes exist; some UI renders as placeholder for non-members |
| Safe Return / SOS | PARTIAL | `safeReturnScheduler` worker exists; UI in `/profile/edit/safety`; end-to-end journey unclear |
| Admin stubs | PARTIAL | Schema-drift and geocode-cache management screens are UI stubs |

---

## 5. Broken Buttons / Dead Paths

| Element | Location | Status | Issue |
|---|---|---|---|
| Followers stat tap | PassportStatsRow | 🔴 Dead end | `onStatPress('Followers')` registered in card; handler in passport.tsx does nothing with it |
| Following stat tap | PassportStatsRow | 🔴 Dead end | Same — no destination |
| Countries stat tap | PassportStatsRow | 🔴 Dead end | Same — no destination |
| Pay deposit | `booking/[id].tsx` | 🔴 Dead end | Returns 200 with "not yet available" message; no charge made |
| Events tab | Tab bar | ⚠️ Hidden | `href: null` — accessible only via router.push from other screens |
| Post (create) tab | Tab bar | ⚠️ Hidden | `href: null` — redirects to `/create` |
| AI tab | Tab bar | ⚠️ Hidden | `href: null` — navigated from AI screen only |
| Find Your Circle (discovery) | Discovery tab | ⚠️ Partial | Settings toggle exists; no matching/discovery screen |
| Category event stamps | Event RSVP | ⚠️ Not wired | TODO #1041; only milestone stamps fire |

---

## 6. Backend / Database Wiring Gaps

| Gap | Tables / Routes | Risk |
|---|---|---|
| followers_count source unknown | `profiles`, `user_follows` | High — if it drifts silently, stats are wrong |
| No RLS on profiles | `profiles` | High — service-role client bypasses; only middleware guards it |
| No RLS on trips / messages | `trips`, `trip_members`, messages | High |
| No payment provider | `rent_buddy_bookings` | Blocks real transactions |
| Video transcoding missing | `passport_postcards` (storage) | Medium — raw video served |
| Event category stamps | `user_stamps`, `stamp_definitions` | Low — milestone stamps work |
| `/highlights` route | (no file) | Low — notifications use actionUrl |

---

## 7. Missing Production Migrations / Infrastructure

| Item | Local File | Production | Action |
|---|---|---|---|
| passport_tab_order | 0143 ✅ | ✅ Applied | Done |
| Stripe/payment integration | ❌ None | ❌ None | Not started |
| Video transcoding worker | ❌ None | ❌ None | Not started |
| RLS policies on core tables | Partial (events, stamps, rent_buddy) | Partial | Need new migration per table |
| Event category stamp definitions | ❌ Pending #1041 | ❌ | Requires stamp definitions + award rules |
| `/highlights` route | ❌ No file | N/A | Low priority |

---

## 8. Source-of-Truth Conflicts

| Data | Canonical | Risk |
|---|---|---|
| followers_count | **Unknown** — not in profiles columns, no trigger, no route write | 🔴 Must trace |
| Username vs handle | `primaryIdentityText()` resolves correctly | ✅ Clean |
| Display name privacy | `resolveDisplayName()` enforced | ✅ Clean |
| Verification | `isTravelBuddyVerified()` single source | ✅ Clean |
| Trust Score | `profiles.trust_score`, single source | ✅ Clean |
| Stamp count | `getPassportStats()` live RPC | ✅ Clean |
| Passport tab/section order | `resolveTabOrder()` / `resolveSectionOrder()` with DB fallback | ✅ Clean |
| Session count (Rent-a-Buddy) | Canonical counter; fixed in recent task merges | ✅ Clean |
| Current city vs home city | `currentCity ?? homeCity` priority rule in PassportIdentityCard | ✅ Clean |

---

## 9. Regression Risks

| If you change… | Risk |
|---|---|
| `profiles` schema | Passport, Discover feed, search, Rent-a-Buddy cards, Telegraph sender info |
| MapTab | Only passport Map tab and [username] Map tab — low blast radius |
| Stats row `onStatPress` | Only passport.tsx handler — safe to extend |
| `requireUser` middleware | Every auth-gated route — do not touch |
| Followers count source (once found) | Anywhere followersCount is displayed |
| Event RSVP handler | Stamp award fire-and-forget, booking creation, realtime notification |

---

## 10. Single Next Safest Task

**Fix the Followers / Following / Countries stat taps** (P2-3).

- **Scope:** `artifacts/travel-buddy/app/(tabs)/passport.tsx` — the `onStatPress` handler (~line 498)
- **Change:** Followers → navigate to `/followers/${profile.username}`; Following → `/following/${profile.username}`; Countries → switch to Map tab
- **Blast radius:** Zero — only affects `onStatPress` in owner passport and the public passport stats row
- **Prerequisite check:** Confirm `/followers/[username]` and `/following/[username]` route files exist before wiring; if not, wire Countries → Map tab first as a no-route-needed win

**Before that:** Trace `followers_count` source — run one production query to understand how `followersCount` reaches the frontend, since wiring a followers tap assumes there's a real destination with real data.
