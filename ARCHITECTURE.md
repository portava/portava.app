# Travel Buddy — Architecture & Feature Map

> **SOURCE OF TRUTH (updated 2026-08-14):** `travel-buddy-standalone/` is the only app tree. `artifacts/travel-buddy` was **archived on 2026-08-14** and no longer exists on disk — its last state is at commit `bc1bef404`. The artifacts→standalone sync retired with it. References to it below (system map, workflows, sync/mirror notes) are historical and describe a two-tree world that no longer exists. The API server remains canonical at `artifacts/api-server`.

_Generated for beta-readiness testing. This is a snapshot as of 2026-07-28. Where a feature's status could not be confirmed by direct testing (only by reading code), that is called out explicitly — treat those as "needs manual verification," not "confirmed working."_

---

## 1. System Map

```
┌─────────────────────────┐      ┌──────────────────────────┐      ┌───────────────────┐
│ travel-buddy-standalone  │      │ artifacts/api-server      │      │ Supabase (Postgres)│
│ (canonical Expo/RN app)  │─────▶│ Express API                │─────▶│ + Storage + Auth   │
│ EXPO_PUBLIC_API_BASE_URL │ HTTP │ src/routes/*.ts            │ SQL  │                    │
└─────────────────────────┘      │ getServiceClient() (service│      └───────────────────┘
            │  auto-synced         role key, bypasses RLS)    │
            ▼  post-merge          getOptionalViewerId(req)   │
┌─────────────────────────┐      │ (reads Authorization header│
│ [historical: the mirror  │      │  → resolves viewer identity)│
│  arrangement is retired; │      └──────────────────────────┘
│  standalone is canonical │
│  as of 2026-08-04]       │
└─────────────────────────┘
```

- **Client → API**: every authenticated call must attach `Authorization: Bearer <supabase JWT>`. A handful of "public" reads (e.g. passport, profile lookups) work anonymously too, but silently degrade to anonymous-viewer behavior if the token is missing — this exact bug (missing header in `getPublicPassport`) was just fixed. **When testing, watch for any screen that seems to ignore your relationship to another user/entity — a missing auth header is a plausible root cause pattern, not a one-off.**
- **API → DB**: the API server almost always uses the **service-role client** (bypasses RLS) and enforces authorization itself in route code, not via RLS. Bugs here look like "wrong data returned to the wrong viewer," not DB errors.
- **App tree**: `travel-buddy-standalone` is the only app tree. It used to be a mirror of `artifacts/travel-buddy`, auto-synced after every merge except for files in the `STANDALONE_OWNED_FILES` ledger — that tree was archived at `bc1bef404` and the sync, the ledger and the two-tree bug-hunting rule all retired with it. A bug is now fixed in exactly one place.
- **Dev servers** (for reference while testing): API server workflow `artifacts/api-server: API Server`; app workflow `travel-buddy-standalone: dev`.

---

## 2. Screens, by Tab

Main tabs live in `app/(tabs)/`: **index** (Pulse), **discovery**, **media** (Roam), **trips**, **passport**, plus **ai** and **messages** which may be tab-bar or header-triggered depending on layout — confirm the current tab bar order in `app/(tabs)/_layout.tsx` when testing.

### Pulse (feed/home)
| Screen | File | How you get there |
|---|---|---|
| Feed | `app/(tabs)/index.tsx` | Tab bar |
| Notifications | `app/notifications.tsx` | Pulse header bell icon |
| Create hub | `app/create.tsx` | Pulse header “+” |
| Post detail | `app/post/[id].tsx` | Tap any post card |
| Edit post | `app/post/edit/[id].tsx` | Post detail → Edit |
| Hashtag feed | `app/hashtag/[slug].tsx` | Tap a hashtag in a caption |
| Featured | `app/featured.tsx` | Pulse “Featured” → View all |
| Pending posts | `app/pending-posts.tsx` | Pulse “Pending” banner (video posts awaiting creator approval — see §3 Content moderation) |

### Discovery / Compass
| Screen | File | How you get there |
|---|---|---|
| Discovery home | `app/(tabs)/discovery.tsx` | Tab bar |
| Compass AI assistant | `app/(tabs)/ai.tsx` | Tab bar / Discovery entry |
| Search | `app/search.tsx` | Discovery search bar (also entry for “Find People”) |
| Quick discovery | `app/discover.tsx` | Discovery “Explore More” |
| Map | `app/map/index.tsx` | Discovery “Map” button |
| Place detail | `app/place/[id].tsx` | Place card tap |
| Write review | `app/review/[entityType]/[entityId].tsx` | Place detail → Write Review |
| Destination (city) | `app/destinations/[city].tsx` | Discovery city result |
| Destination (region/slug) | `app/destination/[slug].tsx` | Discovery region/card tap |
| Hidden gems list | `app/gems/index.tsx` | Discovery “Gems” category |
| Gem detail | `app/gems/[id].tsx` | Gem list item |
| Submit gem | `app/gems/submit.tsx` | Gems list “Submit” |
| Gem contributor guide | `app/gems/guide.tsx` | Submit gem → Guide link |
| Explore Portava | `app/explore-portava.tsx` | Portava banner / Passport menu |
| Compass preferences | `app/compass-preferences.tsx` | Compass status card |
| Compass memory history | `app/compass-memories.tsx` | Compass preferences → History |

### Roam (media)
| Screen | File | How you get there |
|---|---|---|
| Roam feed | `app/(tabs)/media.tsx` | Tab bar |
| Media viewer | `app/media-viewer/[id].tsx` | Tap a media grid/feed item |
| Add gem (from Roam) | `app/media/add-gem.tsx` | Roam feed “Add Gem” |

### Trips
| Screen | File | How you get there |
|---|---|---|
| Trips list | `app/(tabs)/trips.tsx` | Tab bar |
| Trip detail | `app/trip/[id].tsx` | Trip card tap |
| New trip | `app/trip/new.tsx` | Trips “+ New Trip” |
| Edit trip | `app/trip/edit.tsx` | Trip detail → Settings |
| Trip chat | `app/trip/chat.tsx` | Trip detail → Telegraph icon |
| Layover assistant | `app/layover/[id].tsx` | Trip timeline flight-connection tap |
| Event detail | `app/event/[id].tsx` | Trip itinerary → event item |
| Memory detail | `app/memory/[id].tsx` | Trip detail → memory tile |
| Edit memory | `app/memory/edit.tsx` | Memory detail → edit icon |
| Memory location | `app/memory/location.tsx` | Memory edit → Change Location |
| Local meetups | `app/meetups/index.tsx` | Trips → Local Meetups |
| Meetup detail | `app/meetup/[id].tsx` | Meetups list item |
| Route/itinerary | `app/route/[id].tsx` | Discovery/trip route tap |

### Passport (profile)
| Screen | File | How you get there |
|---|---|---|
| My passport | `app/(tabs)/passport.tsx` | Tab bar |
| Public profile (native) | `app/u/[username].tsx` | Any avatar/username tap (search results, comments, posts, etc.) |
| Public passport (doc-style / web) | `app/passport/[username].tsx` | “View Full Passport” from `u/[username]`; also the delegate target on web |
| Country stamp collection | `app/passport/country/[country].tsx` | Passport stamps tab → country |
| All stamps | `app/stamps.tsx` | Passport “Trip Stamps” → View all |
| Stamp detail | `app/stamp/[stampId].tsx` | Stamp card tap |
| Followers | `app/followers.tsx` | Passport stats “Followers” |
| Following | `app/following.tsx` | Passport stats “Following” |
| Follow requests | `app/follow-requests.tsx` | Passport menu (private accounts) |
| Mutual connections | `app/mutual-connections/[userId].tsx` | Profile “Mutual” section |
| Saved / collections | `app/saved.tsx` | Passport “Saved Ideas” → View all |

### Telegraph (messaging) & Circle
| Screen | File | How you get there |
|---|---|---|
| Conversation list | `app/(tabs)/messages.tsx` | Tab bar / Passport header |
| Thread | `app/messages/[id].tsx` | Conversation list item |
| Circle | `app/circle.tsx` | Passport “Trip Circle” |
| Circle presence | `app/circle-presence.tsx` | Circle “Who's nearby” |
| Circle settings | `app/circle-context-settings.tsx` | Trip → Circle settings |
| Availability | `app/availability.tsx` | Passport menu / Circle avatar |

### Settings & Safety
`app/profile/edit/index.tsx` (root) fans out to: `about.tsx`, `account.tsx`, `travel-profile.tsx`, `identity.tsx`, `notifications.tsx`, `privacy.tsx`, `safety.tsx`, `connected.tsx`, `passports.tsx`, `calling.tsx`, `location.tsx`, `who-can-see-me.tsx`, `photos.tsx`, `content-language.tsx`, `emergency-contacts.tsx`, `reports.tsx` — all reached from the Settings root, one tap each.
Also: `app/safety-number.tsx`, `app/safety-history.tsx`, `app/blocked-users.tsx`, `app/muted-users.tsx`, `app/restricted-users.tsx`, `app/appeals.tsx` (surfaced via a notification banner for restricted accounts).

### Rent-a-Buddy (marketplace) — all under `app/(rent-a-buddy)/`
`index.tsx` (landing) → `marketplace.tsx` (browse) → `search.tsx` / `buddy/[id].tsx` (profile) → `request-buddy.tsx` → `checkout.tsx` → `booking/[id].tsx` / `active.tsx` (post-booking) → `review.tsx`. Becoming a buddy: `become/index.tsx` → `become/apply.tsx` → `buddy-dashboard/index.tsx` (+ `packages.tsx`, `availability.tsx`). Also `match-quiz.tsx` and `offers.tsx`.

### Admin & internal (not part of the beta user flow, but reachable if you have admin access)
`app/admin/stamps/{index,queue,failed,[catalogId]}.tsx`, `app/admin/content-reports.tsx`, `app/admin/feature-flags.tsx`, `app/admin/geocode-cache.tsx`, `app/admin/trust-reviews.tsx`, `app/admin/place-mismatch-reports.tsx`, `app/(rent-a-buddy)/admin/applications.tsx`.

### Auth & misc
`app/(auth)/sign-in.tsx`, `app/(auth)/onboarding.tsx` (post-signup), `app/invite/[token].tsx` (deep link), `app/+not-found.tsx` (fallback).

**Note on route inventory:** two independent scans produced overlapping but not identical lists (e.g. one found `app/gems/*`, the other didn't; one found `app/profile/edit/calling.tsx` and `who-can-see-me.tsx`, the other didn't). The table above merges both. Treat this as thorough, not necessarily 100% exhaustive — cross-check against `pnpm --dir travel-buddy-standalone run check:route-registry` (`check-route-registry.mjs`), which enforces every screen file is registered, as the authoritative count (152 screens + 9 layouts as of this writing).

---

## 3. Feature Systems

For each: what it does, key files, status. **Status labels reflect code-reading by an explorer, not click-through testing — verify each with the checklist in §5.**

| Feature | What it does | Key client files | Key server files | Reported status |
|---|---|---|---|---|
| **Stamp system** | Awards collectible "stamps" for travel milestones/content; rarity, motifs, showcase/display ordering | `StampsTab.tsx`, `StampGrid.tsx`, `UniversalStampArtwork.tsx` | `stamps.ts`, `ContentStampService.ts` | Reported working; seed via `seed-demo-social.ts` / `fix-demo-stamps.ts` / `reconcileStampCatalog.ts` |
| **Media/Roam** | Postcard & short-video upload, feed, video playback | `mediaStore.ts`, `WatchFeed.tsx`, `MediaCard.tsx` | `postcards.ts` | Reported working |
| **Personalization/Compass** | Ranked "For You" feed, AI travel assistant | `ForYouTab.tsx` (+ OSM fallback) | `compass.ts`, `compassAutopilot.ts`, `CompassHome.ts` | Reported working; **Task #3169 (open/merging) — search-query signals not yet feeding personalization**, so don't expect search behavior to influence the feed yet |
| **@Portava + Featured** | Official house account; curated/editorial content | — | `featured.ts`, `adminFeatured.ts`, `adminPortavaPosts.ts`, `seed-portava-account.ts` | Reported working; auto-seeding of the account was only just addressed (Task #3183, merging) — **on a brand-new environment, confirm @Portava actually exists before testing anything that depends on it** |
| **Living destination pages** | Real-time city pages with traveler activity | `LivingDestinationPage.tsx` (under `components/place/living`) | — | Reported working |
| **Comment translation** | On-demand translation of comments | `CommentsSheet.tsx`, `useContentTranslation` | `contentTranslation.ts` | Reported working; stale-translation-after-edit bug just fixed (Task #3186, merged) |
| **Telegraph + receipts** | Realtime messaging, read receipts | messaging UI + `TelegraphInboxScreen.tsx` | `messaging.ts`, `telegraph.ts`, `telegraphRealtimeService.ts`, `telegraphStream.ts` (SSE) | Reported working |
| **Follows/Circle/privacy** | Public/private accounts, friend requests, blocking, Circle | `PrivateRequestButton.tsx`, `PrivateProfileWall.tsx`, `usePublicPassport.ts`, `CircleSection.tsx` | `follows.ts`, `friends.ts` | **Just had a real, confirmed end-to-end bug** (missing auth header → friend-request pending state silently false on the profile screen). Fixed and verified live. This is a strong signal to test every "does the server know who I am" surface carefully, not just this one — see §4. |
| **Trips + Before-You-Go + layover** | Trip planning, pre-trip checklist, airport layover assistant | `BeforeYouGoSection.tsx`, `LayoverModeSheet.tsx` | `trips.ts`, `trips-expansion.ts`, `airport.ts` | **PARTIAL** — components exist but integration into the main trip flow was described as "thin"; needs hands-on verification of whether Before-You-Go actually surfaces during real trip flows and whether layover mode is reachable outside the sheet component itself |
| **Buddy marketplace/Rent-a-Buddy** | Book/be a local travel buddy | `(rent-a-buddy)/*` screens | `rentABuddy.ts`, `rentABuddyMarketplace.ts` | **PARTIAL / NEEDS SEED DATA** — gated behind a `rent_buddy_enabled` flag; marketplace listing likely empty without `seed-demo-buddies.ts` |
| **Collections/saves** | Bookmarking places/posts | `DiscoveryWall.tsx`, save buttons throughout | `saves.ts`, `collections.ts` | Reported working |
| **Verification/TrustScore** | Identity verification tiers, trust badges | `TrustScoreInfoSheet.tsx`, `PassportVerificationStamp.tsx` | `verification.ts`, `trust-admin.ts`, `TrustScoreService.ts` | Reported working |
| **Hidden gems** | User-submitted off-the-beaten-path places, verified-visit gamification | `HiddenGemsSection.tsx`, `GemLocationPreview.tsx` | `hiddenGems.ts`, `HiddenGemPrivacyGuard.ts` | Reported working |
| **Gems (currency, if distinct from Hidden Gems)** | Possible in-app reward currency | `GemsItemOverlay.tsx`, `GemsFeed.tsx` | — | **Ambiguous/likely stub** — one pass flagged these as largely stub/mock-render; confirm during testing whether "Gems" as a currency is a real, separate system from "Hidden Gems" (places) or just naming overlap in the codebase |
| **Events** | Local event discovery, RSVP, voice rooms | `EventVoiceRoomCard.tsx`, `EventRoomScreen.tsx` | `events.ts` | **PARTIAL** — seed data exists (`seed-demo-city-events.ts`) but integration into the map/discovery feed was described as thinner than places/gems |

---

## 4. Known Gaps & Risk Areas

1. **Auth-header omissions are a class of bug, not a one-off.** The `getPublicPassport` bug (this session) was exactly this: a read endpoint that works anonymously but silently drops viewer-specific fields when the client forgets the bearer token. Any screen showing a relationship-dependent value (following state, block state, saved state, trust/verification badges relative to viewer, buddy-booking status) is worth spot-checking the same way: does it match what an authenticated equivalent (e.g. search results, which are known to attach auth) shows for the same pair of users?
2. **@Portava auto-seed** (#3183) and **Portava avatar/login imagery** (#3191, #3192) were only just merged — if you're testing on a freshly reset environment, confirm these actually took effect before assuming Portava-dependent features (Featured content, Explore Portava) have real data.
3. **Search → personalization loop is not connected** (#3169, in progress) — searching for something should not be expected to influence the For You feed yet.
4. **Rent-a-Buddy marketplace likely needs seed data** — if it looks empty, that may be expected (missing `seed-demo-buddies.ts` run), not a bug, but worth confirming which is the case.
5. **Trips: Before-You-Go and layover mode** may exist as components without full flow integration — check whether they're reachable through normal navigation, not just present in the codebase.
6. **"Gems" currency vs "Hidden Gems" places** — naming may be overloaded; confirm in the UI whether there's supposed to be a separate reward-currency system, or if all "gems" UI refers to the places feature.
7. **Analytics screen** — three fresh open tasks (#3203, #3204, #3205) target the profile analytics screen: no error state on API failure, tapping the views count doesn't navigate, and zero-data states may render as broken empty cards instead of proper empty states. These are open/unfixed as of this doc.
8. **Standalone-tree drift** — RETIRED. This said: if a bug is fixed in `artifacts/travel-buddy` but you're testing against `travel-buddy-standalone`, check the file isn't in `STANDALONE_OWNED_FILES` before assuming both trees match. There is one tree since the 2026-08-14 archival (`bc1bef404`), so this class of confusion is structurally gone.
9. **Route inventory caveat** — the two independent screen scans used to build §2 disagreed slightly; treat the table as thorough but re-verify unusual/rare screens against the live route registry check if you hit a path that seems to not exist.

---

## 5. Test Checklist

Use real, distinct test accounts (at least one pair, e.g. the `bigdaddy`/`anrole` pair already used to fix the friend-request bug) so you can test both directions of every relationship (viewer A → target B and B → A).

### Auth & relationship-state correctness (highest priority given today's bug)
- [ ] Log in as A, send a friend/follow request to a private account B. Confirm: (a) Find-People/search shows "Pending" for B, (b) B's profile screen also shows "Request sent"/pending — both from A's session.
- [ ] As B, accept the request. Confirm A's profile view of B flips to full access without requiring app restart.
- [ ] Block B as A. Confirm A can no longer see B's postcard wall in either block direction (A blocks B, and B blocks A).
- [ ] Check a saved/collection item, a followed public account, and a verified/trust badge — do they render correctly on first load (not just after a manual retry)?

### Pulse
- [ ] Post creation (photo) goes live immediately.
- [ ] Post creation (video) requires creator permission before going live (per task #3051 — confirm this is actually enforced).
- [ ] Notifications bell shows real activity and opens the right item.
- [ ] Featured section populates (requires @Portava/curated content to exist).

### Discovery/Compass
- [ ] Search for a user and a place; confirm both result types render and navigate correctly.
- [ ] Compass "For You" feed loads with a ranked, non-empty list for a normal account.
- [ ] Compass AI assistant responds to a basic travel question.
- [ ] Hidden gems: submit a gem, confirm it enters a moderation/verification flow rather than going live unmoderated (if that's the intended design — confirm expected behavior first).

### Roam
- [ ] Upload a photo postcard and a video postcard; confirm both appear in the feed and (if applicable) earn stamps.
- [ ] Media viewer full-screen playback works for video.

### Trips
- [ ] Create a trip, add itinerary items, invite a collaborator.
- [ ] Confirm Before-You-Go checklist actually surfaces before/during a trip (not just as an isolated component).
- [ ] Trigger layover mode (may require a trip with a flight/connection) and confirm it's reachable through normal navigation.
- [ ] Trip chat (Telegraph) sends/receives messages tied to the trip.

### Passport
- [ ] View your own passport: stamps, countries, stats all populate.
- [ ] View another user's public passport and a private user's passport (should show the wall, not full data, unless friends).
- [ ] Followers/Following lists open and are accurate.
- [ ] Analytics screen: confirm it shows an error state on a forced API failure, that tapping the view count does something, and that a zero-stamp/zero-milestone account doesn't render broken-looking empty cards (tasks #3203–3205, currently open — expect these to still be broken until fixed).

### Telegraph / Circle
- [ ] Start a new conversation from a user profile.
- [ ] Read receipts update after the recipient opens the thread.
- [ ] Circle presence shows nearby members (requires location + trip context).

### Rent-a-Buddy
- [ ] Confirm the marketplace shows listings (if empty, check whether demo-buddy seed data was run before treating it as a bug).
- [ ] Full booking flow: request → checkout → active booking → review.
- [ ] Apply to become a buddy and confirm the buddy dashboard appears afterward.

### Settings/Safety
- [ ] Edit each profile-settings sub-page and confirm changes persist after navigating away and back.
- [ ] Block/mute/restrict a user from Settings and confirm the effect is visible from that user's side too.
- [ ] Emergency contacts and safety history pages load without crashing.

### Cross-cutting
- [ ] Deep-link into a screen (e.g. trip invite link, `/invite/[token]`) while logged out — confirm it routes through sign-in and lands back on the right screen.
- [ ] Switch tabs rapidly / mid-notification-dismiss and confirm no duplicate headers or stuck loading states (task #1576, #1597 relate to exactly this class of bug).
