# Portava / Travel Buddy — Full App Audit
*Generated: July 2026 | Scope: mobile app + API server*

---

## 1. Executive Summary

The app has a **solid, well-structured foundation**. Auth, Passport, Stamps, Trips, Events, Telegraph/Messaging, Rent-a-Buddy bookings, and the Discover feed are all meaningfully implemented with real backend data. The API server has ~250 routes across 143 migrations and handles authentication, validation, and most write paths correctly.

**Key concerns before beta:**
- MapTab is a confirmed placeholder (no real map rendered).
- Payment provider (Stripe/PayPal) is not integrated — bookings track status locally only.
- RLS covers only ~20% of tables; the rest rely entirely on application-level middleware.
- Several routes exist as legacy duplicates.
- The Pulse and Telegraph tabs are not in `app/(tabs)/` — they route through components embedded in other screens.
- Rent-a-Buddy pricing returns a static hardcoded mock.
- Video transcoding and thumbnail generation are not implemented.

**Overall readiness: ~65% — core flows work; payments, map, and some privacy/RLS gaps are beta blockers.**

---

## 2. Master Feature Matrix

| Feature | Status | Notes |
|---|---|---|
| Auth / Sign-in | ✅ Fully Complete | Supabase auth, onboarding, session guard |
| Onboarding | ✅ Fully Complete | `(auth)/onboarding.tsx` wired |
| Profile / Edit Profile | ✅ Fully Complete | Multi-screen edit, all fields persisted |
| Passport (owner) | ✅ Fully Complete | 5 tabs, section reorder, tab reorder, identity card |
| Passport (public) | ✅ Fully Complete | Tab order from owner preference, no edit controls |
| Passport Customization | ✅ Fully Complete | Section + tab reorder sheets, server-persisted |
| Postcards | ✅ Fully Complete | Create, upload, view, delete; real backend |
| Memories | ✅ Fully Complete | Create/edit/delete modal; real backend |
| Plans / Trips | ✅ Fully Complete | Create, join, manage; real backend |
| Trip Crew Location | ⚠️ Partially Complete | Location sharing wired; GPS privacy layer active |
| Events | ⚠️ Partially Complete | List/RSVP works; category stamp award is a TODO |
| Pulse | ⚠️ Partially Complete | Feed components exist; no dedicated tab route |
| Discovery / Explore | ✅ Fully Complete | Trending hashtags, category counts, real data |
| Search | ✅ Fully Complete | `/search.tsx` exists and is wired |
| Telegraph / Messaging | ✅ Fully Complete | `TelegraphInboxScreen` wired; realtime messaging |
| Circles | ⚠️ Partially Complete | Tables exist; `circle-chat` route exists; some UI is placeholder |
| Find Your Circle | ⚠️ Partially Complete | Component exists; GPS/matching depth unclear |
| Rent a Buddy | ⚠️ Partially Complete | Listings, booking, safety check-in wired; **payments not wired to provider** |
| Follows / Followers | ✅ Fully Complete | Follow/unfollow, counts, feed filtering |
| Notifications | ✅ Fully Complete | `/notifications.tsx` exists; push retry worker active |
| Map / GPS | 🔴 Broken / Placeholder | MapTab is static icon + text — no real map rendered |
| Safety / Safe Return / SOS | ⚠️ Partially Complete | `safeReturnScheduler` exists; UI in profile/edit/safety |
| Verification | ✅ Fully Complete | ID, selfie, home-country verification tracked |
| Trust Score | ✅ Fully Complete | Displayed in passport; `trustScore` from backend |
| Stamps | ✅ Fully Complete | Earn, display, full-view modal, admin queue |
| Highlights / Stories | ⚠️ Partially Complete | `HighlightRing` component wired; `/highlights` is virtual (no file) |
| Uploads / Media | ⚠️ Partially Complete | Photo upload works; **video transcoding not implemented** |
| Settings / Privacy | ✅ Fully Complete | Multi-screen settings; all fields persisted |
| Admin — Stamps | ✅ Fully Complete | Queue, failed, catalog, regenerate all wired |
| Admin — Content Reports | ✅ Fully Complete | Reports, flags, trust settings wired |
| Admin — Compass | ✅ Fully Complete | Cache management wired |
| Payments / Bookings | ⚠️ Partially Complete | Booking lifecycle works; no external payment provider |
| Saved Places | ✅ Fully Complete | `/saved.tsx` exists; `saved_places` table wired |
| Pending Posts | ✅ Fully Complete | `/pending-posts.tsx` exists |
| Destination / Hashtag pages | ✅ Fully Complete | Dynamic routes wired |

---

## 3. Every-Button / Path Matrix

| Element | Location | Status | Destination / Action |
|---|---|---|---|
| Edit profile (menu) | OwnerActionMenu | ✅ Working | `/profile/edit` |
| Arrange sections (menu) | OwnerActionMenu | ✅ Working | PassportSectionReorderSheet |
| Arrange tabs (menu) | OwnerActionMenu | ✅ Working | PassportTabReorderSheet |
| ⋯ menu button | PassportIdentityCard top-right | ✅ Working | Opens OwnerActionMenu |
| Add a bio (empty state) | PassportIdentityCard | ✅ Working | `onEditBio` → `/profile/edit` |
| Camera button (avatar) | PassportIdentityCard | ✅ Working | `onChangeCover` → photo picker |
| Highlight ring (avatar) | PassportIdentityCard | ✅ Working | Opens highlight viewer |
| Follow pill | PassportIdentityCard (public) | ✅ Working | `useFollow` → API |
| Stats row — Trips | PassportStatsRow | ✅ Working | Navigates to Plans tab |
| Stats row — Stamps | PassportStatsRow | ✅ Working | Navigates to Stamps tab |
| Stats row — Followers/Following | PassportStatsRow | ⚠️ Partially | Tap registered; no destination sheet yet |
| Stats row — Countries | PassportStatsRow | ⚠️ Partially | Tap registered; no destination |
| Postcards tab | passport.tsx | ✅ Working | PostcardsTab with real data |
| Memories tab | passport.tsx | ✅ Working | MemoriesTab with real data |
| Plans tab | passport.tsx | ✅ Working | TripsTab with real data |
| Stamps tab | passport.tsx | ✅ Working | StampsTab with real data |
| Map tab | passport.tsx / [username].tsx | 🔴 Placeholder | Static icon — no map |
| Save reorder (sections) | PassportSectionReorderSheet | ✅ Working | PATCH /me/profile |
| Save reorder (tabs) | PassportTabReorderSheet | ✅ Working | PATCH /me/profile |
| Create postcard | create.tsx | ✅ Working | Modal → upload flow |
| Create memory | MemoriesTab | ✅ Working | In-tab modal |
| Create trip | TripsTab | ✅ Working | `/trip/new` |
| Join event | event detail | ✅ Working | RSVP API |
| Send message (Telegraph) | TelegraphInboxScreen | ✅ Working | Realtime |
| Follow user (public passport) | PassportIdentityCard | ✅ Working | useFollow |
| Report user | `[username].tsx` alert | ✅ Working | Report API |
| Rent a Buddy — Book | booking flow | ⚠️ Partial | Status persisted; no payment charge |
| Rent a Buddy — Pay deposit | booking/[id].tsx | 🔴 Not Wired | Endpoint updates status only; no payment provider |
| Notifications → stamp | notification push | ✅ Working | `/stamp/[stampId]` |
| Notifications → passport | notification push | ✅ Working | `/passport?tab=stamps` |
| Admin — Stamp queue | admin/stamps | ✅ Working | Real queue data |
| Admin — Regenerate | admin/stamps/catalog | ✅ Working | Artwork worker triggered |
| MapTab (travel map) | Passport Map tab | 🔴 Placeholder | Static text / no map engine |
| Find Your Circle | discovery | ⚠️ Partial | Component exists; match depth unclear |
| Safe Return | profile/edit/safety | ⚠️ Partial | Scheduler exists; UI wired |

---

## 4. Database / Backend Dependency Map

### Confirmed Tables (migration-backed)
| Table | Managed By | API Routes |
|---|---|---|
| profiles | 0010, 0042… | /api/me/profile, /api/passport/:username |
| user_stamps | 0042, 0082 | /api/stamps, /api/me/passport/stamps |
| stamp_definitions | 0042 | /admin/stamps/catalog |
| passport_postcards | 0071 | /api/me/passport/postcards |
| memory_items | 0078 | /api/me/passport/memories |
| trips / trip_members | 0011, 0013 | /api/trips |
| events / event_attendees | 0021 | /api/events |
| circles / circle_members | 0055 | /api/circles |
| user_follows | 0014 | /api/me/following |
| notifications / push_tokens | 0032, 0033 | /api/notifications |
| compass_feed_cache | 0051 | /api/compass |
| rent_buddy_profiles / rent_buddy_bookings | 0095, 0098 | /api/rent-a-buddy |
| saved_places | 0062 | /api/me/saved |
| highlights | 0074 | /api/me/highlights |
| safety_checkins | 0099 | /api/rent-a-buddy/safety |
| passport_tab_order (column on profiles) | 0143 | /api/me/profile (PATCH) |

### Ambiguous / Needs Verification
| Name Used In Code | Likely Table | Status |
|---|---|---|
| `telegraph_messages` | `messages` or `direct_messages` | Verify name in DB |
| `bookings` | `rent_buddy_bookings` | Confirmed |
| `safety_events` | `trip_crew_location_events` or `rent_buddy_safety_checkins` | Verify which |
| `user_friendships` | Referenced in friends.ts | Verify migration exists |

---

## 5. Source-of-Truth Conflicts

| Data Point | Canonical Source | Conflicts / Risks |
|---|---|---|
| Username | `profiles.username` | `handle` field also exists — `primaryIdentityText()` resolves this but some places still read raw `username` |
| Display name | `profiles.display_name` (opt-in) or `profiles.name` | `resolveDisplayName()` + privacy rule enforced in most places; verify admin screens |
| Verification status | `profiles.verification_status` + `verified` boolean | `isTravelBuddyVerified()` abstracts this; confirmed consistent |
| Trust Score | `profiles.trust_score` | Single source; displayed via API, no local computation |
| Follower count | `profiles.followers_count` (denormalized) | Risk of drift from follow/unfollow events; verify trigger or recount |
| Stamp count | `user_stamps` (live) + `passport_stats` RPC | `getPassportStats()` fetches live — consistent |
| Location / current city | `profiles.current_city` vs GPS-derived city | Two write paths: manual edit + GPS fill; `currentCity` wins over `homeCity` in display |
| Trip membership | `trip_members` table | `getTripMembers()` is the canonical read; no local cache conflict found |
| Circle membership | `circle_members` table | Realtime subscription + fetch on mount — verify no double-subscription |
| Session count (Rent-a-Buddy) | Multiple routes fixed in recent tasks | Canonical session counter now used consistently post-task merges |
| Passport section/tab order | `profiles.passport_section_order` + `passport_tab_order` | `resolveSectionOrder()` / `resolveTabOrder()` sanitise on read — consistent |

---

## 6. Missing Migrations / Configuration

| Item | Risk | Action |
|---|---|---|
| `passport_tab_order` column | ✅ Migration 0143 written | **Must apply to production Supabase** |
| RLS on most tables | 🔴 High | Only ~20% of tables have explicit RLS; API uses service-role client which bypasses RLS — application middleware is the only guard |
| Payment provider credentials | 🔴 Blocks payments | No `STRIPE_SECRET_KEY` or equivalent found; bookings update status only |
| `MAPBOX_TOKEN` | ⚠️ Listed as required | No map rendered in app yet (MapTab is placeholder) |
| `TICKETMASTER_API_KEY` | ⚠️ Optional | Events enrichment; graceful fallback if absent |
| Video transcoding pipeline | 🔴 Not implemented | Postcards support video MIME types but no transcode step |
| `user_friendships` migration | ⚠️ Unconfirmed | `friends.ts` service references this table; verify it exists |
| Category event stamps | ⚠️ TODO in events.ts | Task #1041 referenced; stamps not awarded on event join |

---

## 7. Regression-Risk Map

| If you change… | It affects… |
|---|---|
| `profiles` schema / PATCH handler | Passport, Search, Telegraph sender info, Rent-a-Buddy profile card, Trip Crew cards, Circle member cards |
| `resolveDisplayName()` / `primaryIdentityText()` | Every screen that shows a user's name |
| `PassportIdentityCard` | Owner passport, public passport — both use same component |
| `usePassport` hook | Stamp display, memory display, postcard display, stats row |
| `passportTabs.ts` / `resolveSectionOrder` | Passport section order, tab order, reorder sheets |
| `requireUser` middleware | Every auth-gated API endpoint |
| `getServiceClient()` | All DB reads/writes — switching to user-scoped client would activate RLS |
| `generationWorker.ts` | Stamp artwork queue, admin catalog, stamp earn flow |
| `compass_feed_cache` | Discover feed, nearby content, hidden gems |
| Notification push payload shape | All deep-link destinations from push taps |
| Rent-a-Buddy booking state machine | Booking status UI, safety check-in, session count |

---

## 8. Beta Blockers (Must Fix Before Live Testing)

### P0 — Blocks Core App Function
| # | Issue |
|---|---|
| P0-1 | **MapTab is a placeholder** — the Map tab in Passport and Discovery shows a static icon. No map engine (Mapbox/MapTiler) is rendered. |
| P0-2 | **Migration 0143 (`passport_tab_order`) not applied to production** — tab order saves will fail with a schema-drift error on the deployed app. |
| P0-3 | **RLS not enforced on most tables** — data isolation relies entirely on application middleware. A bug in `requireUser` or a direct DB access path would expose all user data. |

### P1 — Core Feature Broken
| # | Issue |
|---|---|
| P1-1 | **Payments not wired** — Rent-a-Buddy bookings track status in DB but no payment is charged. `pay-deposit` endpoint updates a field only. |
| P1-2 | **Video upload has no transcoding** — users can attempt video postcards but no processing pipeline exists; likely produces broken playback. |
| P1-3 | **Category event stamps not awarded** — joining an event does not award the corresponding stamp (TODO in events.ts #1041). |
| P1-4 | **Follower count may drift** — `profiles.followers_count` is a denormalized column; verify the DB trigger or recount RPC fires on every follow/unfollow. |

### P2 — Partial / UX
| # | Issue |
|---|---|
| P2-1 | Pulse has no dedicated tab route — it's rendered through components inside other screens; users may not discover it. |
| P2-2 | Telegraph is not in `app/(tabs)/` — routed through `TelegraphInboxScreen` component; verify tab bar entry exists. |
| P2-3 | Stats row — Followers, Following, Countries taps are registered but have no destination. |
| P2-4 | `/highlights` has no file — the route is virtual (HighlightRing component handles it inline); direct deep-link to `/highlights` would 404. |
| P2-5 | Rent-a-Buddy pricing suggestion returns a hardcoded mock response. |
| P2-6 | Legacy duplicate event routes (`/api/events/:id/requests` vs `/api/events/:id/join-request`) both active. |
| P2-7 | `SEED_CITIES` in rentABuddy.ts is hardcoded — city list is not DB-driven. |
| P2-8 | Find Your Circle matching depth unclear — component exists but GPS/algorithm wiring unconfirmed. |

### P3 — Polish
| # | Issue |
|---|---|
| P3-1 | `user_friendships` table existence unconfirmed (used in friends.ts service). |
| P3-2 | Safety events table name ambiguous (`trip_crew_location_events` vs `rent_buddy_safety_checkins`). |
| P3-3 | Admin screens: schema-drift and geocode-cache management are stubs. |
| P3-4 | `telegraph_messages` vs `messages` table name — verify actual table name in DB. |

---

## 9. Priority Fix Queue

```
P0-1  Implement real map in MapTab (Mapbox or MapTiler — key already in secrets)
P0-2  Apply migration 0143 to production Supabase
P0-3  Audit and enable RLS on core tables (profiles, user_stamps, postcards, memories, trips)

P1-1  Integrate payment provider (Stripe) for Rent-a-Buddy deposits
P1-2  Remove or gate video upload until transcoding pipeline exists
P1-3  Implement event category stamp award (events.ts TODO #1041)
P1-4  Verify / add DB trigger for followers_count denormalization

P2-1  Add Pulse to tab bar as a first-class tab route
P2-2  Confirm Telegraph tab bar entry exists and is reachable
P2-3  Wire Followers/Following/Countries stat taps to destination sheets
P2-4  Add /highlights route file or redirect
P2-5  Replace hardcoded pricing mock with real calculation
P2-6  Deprecate legacy event join-request route
P2-7  Make Rent-a-Buddy city list DB-driven

P3-1  Confirm user_friendships migration exists
P3-2  Clarify safety_events table name
P3-3  Implement admin schema-drift and geocode-cache management screens
P3-4  Confirm telegraph_messages table name
```

---

## 10. Do Not Touch List (Working — Do Not Refactor)

These systems are fully working end-to-end. Refactoring them risks introducing regressions with no benefit:

| System | Why |
|---|---|
| `PassportIdentityCard` + `PassportStatsRow` | Recently stabilized; extensively tested |
| `PassportSectionReorderSheet` + `PassportTabReorderSheet` | Just implemented; server-persisted; tests pass |
| `passportTabs.ts` + `passportSections.ts` | Canonical order resolution; both forks in sync |
| `generationWorker.ts` | Stamp artwork pipeline; currently under active test coverage |
| `requireUser` middleware | Auth guard for all user routes; do not change shape |
| `resolveDisplayName()` + `primaryIdentityText()` | Display name privacy; one source of truth |
| `isTravelBuddyVerified()` | Verification level logic; used everywhere |
| `usePassport` / `usePublicPassport` hooks | Stamp + memory + postcard data; working |
| `inviteSlotSweeper` + `tripReminderScheduler` | Cron workers with precise timing logic |
| Migration files 0001–0143 | Applied history — never modify; only append |
| `PROFILE_COLUMNS` / `PUBLIC_PROFILE_COLUMNS` select strings | Schema-drift guards depend on exact column lists |
