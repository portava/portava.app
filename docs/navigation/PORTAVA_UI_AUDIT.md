# Portava UI Audit — Current Navigation State

> **Audience:** contributors, PMs, and designers working on Portava's navigation layer.
> **Last updated:** 2026-07-26
> **Based on:** `artifacts/travel-buddy/app/` file system as enumerated by `find artifacts/travel-buddy/app -name '*.tsx' | grep -v '__tests__'`

---

## 1. Bottom-Tab Structure (Current)

The floating pill tab bar contains **four or five items** depending on the `MEDIA_TAB_ENABLED` feature flag.

| Slot | Label | Icon | Flag gate | Registered but hidden (`href: null`) |
|------|-------|------|-----------|--------------------------------------|
| 1 | Pulse | Activity | — | — |
| 2 | Explore | Compass | — | — |
| **Center** | **Media** / **+** | Film / Plus | `MEDIA_TAB_ENABLED` | Media tab is registered; + button shows when flag off |
| 3 | Trips | Plane | — | — |
| 4 | Passport | PassportIcon | — | — |

Hidden tabs registered in the `<Tabs>` tree but with `href: null` — invisible in the pill but valid routes:

| Name | Title | Notes |
|------|-------|-------|
| `(tabs)/messages` | Telegraph | Full messaging inbox |
| `(tabs)/events` | Events | Events feed |
| `(tabs)/ai` | Compass AI | AI travel assistant |

### Desktop Sidebar
On wide viewports (`useIsDesktop()`) a left sidebar replaces the pill. It renders the same four (or five with Media) links, plus a **Notifications** button and a **New Post** compose button. There is no Trips badge or unread-messages count in the sidebar — those are mobile-only.

---

## 2. Center Button — Current Behaviour

| `MEDIA_TAB_ENABLED` | Center slot shows |
|---------------------|-------------------|
| false (default) | Plus button → navigates to `/create` |
| true | Media tab item (Film icon) |

The centre slot is not a dedicated modal trigger; it pushes to a stack screen (`/create`). When Media is enabled the create action is expected to move to a global create menu (`GLOBAL_CREATE_MENU_ENABLED`).

---

## 3. Route Hierarchy Tree

```
app/
├── (auth)/
│   ├── sign-in          public — shows before session
│   └── onboarding       requires auth — profile completion gate
│
├── (tabs)/
│   ├── index            PULSE — main social feed (public read)
│   ├── discovery        EXPLORE — place/event discovery (public)
│   ├── trips            TRIPS — itinerary management (requires auth)
│   ├── passport         PASSPORT — own passport (requires auth, ownerOnly)
│   ├── media            MEDIA — watch/media tab [flag: MEDIA_TAB_ENABLED]
│   ├── messages         TELEGRAPH — DM inbox (href:null, requires auth)
│   ├── events           EVENTS (href:null, public)
│   └── ai               COMPASS AI (href:null, requires auth)
│
├── create               Global create — requires auth
├── notifications        Notification centre — modal, requires auth
├── search               Search — public
├── saved                Saved items — requires auth, ownerOnly
├── discover             Discover (legacy entry to discovery tab)
├── availability         Buddy availability — requires auth, ownerOnly
├── compass-preferences  Compass tune — requires auth, ownerOnly
├── compass-memories     Compass history — requires auth, ownerOnly
├── safety-number        Safety number — modal, requires auth
├── pending-posts        Pending posts — requires auth, ownerOnly
├── appeals              Account appeals — requires auth, ownerOnly
│
├── u/[username]         User profile — public, deepLink
├── profile/[handle]     Legacy redirect → u/[username]
├── profile/edit/
│   ├── index            Edit profile hub — ownerOnly
│   ├── about            About me
│   ├── account          Account settings
│   ├── calling          Calling settings
│   ├── connected        Connected accounts
│   ├── emergency-contacts Emergency contacts
│   ├── identity         Identity
│   ├── location         Location visibility
│   ├── notifications    Notification prefs
│   ├── passport-layout  Passport layout
│   ├── passports        My passports
│   ├── photos           Profile photos
│   ├── privacy          Privacy settings
│   ├── reports          My reports
│   ├── safety           Safety settings
│   ├── travel-profile   Travel preferences
│   └── who-can-see-me   Visibility settings
│
├── passport/
│   ├── [username]       Passport viewer — public [flag: stamp_showcase_enabled]
│   └── country/[country] Country stamps
│
├── stamps               My stamp collection — ownerOnly
├── stamp/[stampId]      Stamp detail — public view / auth to manage
│
├── event/[id]           Event detail — public
├── events/
│   ├── create/index     Create event — requires auth
│   ├── invites          Event invites — ownerOnly
│   └── list             Events list
│
├── trip/
│   ├── [id]             Trip detail — public preview / auth for full
│   ├── new              New trip — requires auth
│   ├── edit             Edit trip — ownerOnly
│   └── chat             Trip group chat — requires auth
│
├── place/[id]           Place detail [flag: external_places_enabled]
├── destination/[slug]   Destination — public
├── destinations/[city]  City page — public (legacy?)
│
├── gems/
│   ├── index            Gems directory — public
│   ├── [id]             Gem detail — public view / auth to check-in
│   ├── guide            Gems guide
│   └── submit           Submit a gem — requires auth
├── media/add-gem        Add gem from media [flag: MEDIA_TAB_ENABLED]
│
├── map/index            Full map [flag: map_search_enabled]
├── messages/[id]        Message thread — requires auth
├── post/[id]            Post detail — public
├── post/edit/[id]       Edit post — ownerOnly
├── hashtag/[slug]       Hashtag feed — public
├── invite/[token]       Invite link — public
├── meetups/index        Meetups list — public
├── meetup/[id]          Meetup detail — public
├── layover/[id]         Layover detail — public
├── route/[id]           Route detail — public
├── memory/[id]          Memory — public
├── memory/edit          Edit memory — ownerOnly
├── memory/location      Memory location — ownerOnly
├── review/[entityType]/[entityId]  Write a review — requires auth
│
├── circle               Circle — ownerOnly
├── circle-context-settings  Circle context — ownerOnly
├── circle-presence      Circle presence — ownerOnly
├── close-friends        Close friends list — ownerOnly
├── blocked-users        Blocked users — ownerOnly
├── muted-users          Muted users — ownerOnly
├── restricted-users     Restricted users — ownerOnly
├── safety-history       Safety check-in history — ownerOnly
│
├── (rent-a-buddy)/      [flag: rent_buddy_enabled]
│   ├── index            RAB marketplace home
│   ├── marketplace      Browse buddies
│   ├── buddy/[id]       Buddy profile
│   ├── booking/[id]     Booking detail — requires auth
│   ├── checkout         Checkout — requires auth
│   ├── request-buddy    Request — requires auth
│   ├── search           Find a buddy
│   ├── saved            Saved buddies — ownerOnly
│   ├── active           Active booking — requires auth
│   ├── match-quiz       Buddy match quiz — requires auth
│   ├── offers           Offers — requires auth
│   ├── waitlist         Waitlist — public
│   ├── review           Leave review — requires auth
│   ├── become/
│   │   ├── index        Become a buddy — requires auth
│   │   └── apply        Application — requires auth
│   ├── buddy-dashboard/ (ownerOnly)
│   │   ├── index, availability, availability-calendar
│   │   ├── requests, requests-inbox
│   │   ├── earnings, earnings-ledger
│   │   ├── packages, offer, offer-create, addons
│   │   ├── meetup-pin, safety
│   └── admin/           (adminOnly)
│       ├── index, analytics, applications, bookings
│       ├── buddies, fee-rules, flags, marketplace
│       ├── package-queue, rollout
│
├── admin/               (adminOnly)
│   ├── content-reports
│   ├── feature-flags
│   ├── gaming-flags
│   ├── geocode-cache
│   ├── hashtags
│   ├── media/index
│   ├── place-images/index
│   ├── schema-drift
│   ├── stamps/ (index, [catalogId], duplicates, failed, queue, reconciler-runs)
│   ├── trust-detail, trust-reviews, trust-settings
│   └── visuals/index
│
└── +not-found           404 catch-all
```

---

## 4. Known Dead Routes / Duplicate Systems

### 4.1 Hidden tabs with no primary navigation path

These routes are registered as tabs but have `href: null`, meaning there is no visible entry point in the tab bar. Users can only reach them via:
- A push from another screen
- A deep-link (where documented)
- An admin/internal URL

| Route | Issue |
|-------|-------|
| `(tabs)/messages` | The Telegraph inbox is hidden from the main tab bar. Users must find it through profile actions or notification taps. |
| `(tabs)/events` | Events are browseable on the Explore tab but there is no dedicated tab entry. The `events/list` stack screen serves as a secondary entry. |
| `(tabs)/ai` | Compass AI has no tab entry. The primary entry is through the Explore/Discovery tab or compass-specific CTAs. |

### 4.2 Duplicate destination entry points

Two route patterns resolve to what appears to be the same concept:

| Path | Notes |
|------|-------|
| `destination/[slug]` | Canonical destination page (slug-based) |
| `destinations/[city]` | Legacy city-based path — may be a redirect or duplicate |

Recommendation: Verify whether `destinations/[city]` redirects to `destination/[slug]` or renders independently. If independent, audit for content overlap.

### 4.3 Profile path duplication

| Path | Notes |
|------|-------|
| `u/[username]` | Canonical profile URL |
| `profile/[handle]` | Legacy — the screen file comment confirms it redirects to `u/[username]` |

The legacy path should be kept for backwards deep-link compatibility only, and should not appear in any in-app navigation.

### 4.4 `discover.tsx` vs `(tabs)/discovery.tsx`

A standalone `app/discover.tsx` exists alongside the `(tabs)/discovery` tab. Without further inspection this is either:
- A redirect shim for an old deep-link
- Dead code

Recommendation: Confirm whether `discover` renders content or redirects. Remove if dead.

---

## 5. Accessibility Gaps

| Screen | Gap |
|--------|-----|
| Floating tab bar | Tab items use `accessibilityRole="button"` but not `"tab"`. Screen-reader users lose tab context. |
| Floating tab bar | Badge counts are not announced via `accessibilityLabel` — only shown visually. |
| Desktop sidebar | Nav items lack `accessibilityRole` (neither `"link"` nor `"menuitem"` is set). |
| Plus/create button | `accessibilityLabel="Create a post"` is hardcoded; will be stale if the button opens a create menu instead. |
| Tab collapse animation | Animated label/height changes are not announced. VoiceOver/TalkBack users would not know the label disappeared. |
| Modal screens (notifications, safety-number) | Modal presentation should set `accessibilityViewIsModal` on the backing view — not confirmed in current code. |

---

## 6. Screen Clutter

| Screen | Issue |
|--------|-------|
| `profile/edit/index` | Hub screen with 15+ sub-routes. No grouping or sectioning visible in the route tree — likely a very long scrollable list. |
| Admin screens | 10+ top-level admin routes with no parent hub — navigation relies entirely on knowing the URL. |
| RAB buddy-dashboard | 11 sub-routes with no documented grouping — appears linear. |

---

## 7. Feature Flag Coverage

Flags currently gating navigation entry points:

| Flag key | Gates |
|----------|-------|
| `MEDIA_TAB_ENABLED` | Media tab visibility; center Plus → Media slot toggle; `/media/add-gem` |
| `MEDIA_HIDDEN_GEMS_NEARBY_ENABLED` | Partial feature within the Media tab |
| `external_places_enabled` | Place detail screen (`/place/[id]`) and partial Explore features |
| `stamp_showcase_enabled` | Passport viewer (`/passport/[username]`) stamp section |
| `stamp_admire_enabled` | Admire action within stamp detail |
| `map_search_enabled` | Full-screen map (`/map`) |
| `rent_buddy_enabled` | Entire Rent a Buddy system |

### Flags reserved for the upcoming navigation upgrade

These flags are documented here for the upgrade rollout but are **not yet wired** to existing routes:

| Flag key | Intended gate |
|----------|---------------|
| `GLOBAL_CREATE_MENU_ENABLED` | Replace the Plus button with a multi-action create sheet |
| `CLEAN_APP_HEADER_ENABLED` | Simplified per-screen header replacing per-tab custom headers |
| `PASSPORT_OWNER_MENU_ENABLED` | Owner actions overflow menu on the passport screen |
| `EXPLORE_PORTAVA_DIRECTORY_ENABLED` | Portava user directory within Explore |
| `NEW_INFORMATION_ARCHITECTURE_ENABLED` | Master flag for the full IA upgrade |
| `COLLAPSIBLE_HEADERS_ENABLED` | Scroll-collapse header animation on supported screens |
| `UNIFIED_SEARCH_ENABLED` | Single search entry point covering people, places, events, and trips |

---

## 8. Proposed Target Architecture Changes

The target architecture is documented in full in [`PORTAVA_INFORMATION_ARCHITECTURE.md`](PORTAVA_INFORMATION_ARCHITECTURE.md). The following files are expected to change during the upgrade:

| File | Change |
|------|--------|
| `app/(tabs)/_layout.tsx` | Promote Events to a visible tab; add `GLOBAL_CREATE_MENU_ENABLED` path; implement `NEW_INFORMATION_ARCHITECTURE_ENABLED` guard |
| `app/(tabs)/events.tsx` | Make discoverable (remove `href: null`) |
| `app/(tabs)/messages.tsx` | Restore as visible tab or consolidate into Pulse notifications |
| `app/search.tsx` | Upgrade to unified search under `UNIFIED_SEARCH_ENABLED` |
| `app/create.tsx` | Replace with global create sheet when `GLOBAL_CREATE_MENU_ENABLED` is on |
| `app/destination/[slug].tsx` | Merge with `app/destinations/[city].tsx` and establish canonical path |
| `app/discover.tsx` | Audit and remove if dead; redirect shim if still used |
| `app/profile/edit/index.tsx` | Group settings into sections for legibility |
| `src/navigation/portavaRoutes.ts` | Update entries as routes change |

---

## 9. Route Registry Check

`src/navigation/portavaRoutes.ts` is the single authoritative registry of every primary and significant nested route in the app.

A lightweight CI script at `scripts/check-route-registry.mjs` keeps the registry in sync with the file system automatically. It:

1. Enumerates every `*.tsx` file under `app/` (excluding `__tests__/`, `_layout.tsx`, `+not-found.tsx`, and platform-specific siblings like `*.web.tsx`).
2. Normalises each file path to the Expo-Router path key used in `PORTAVA_ROUTES`.
3. Exits 1 — failing CI — for any screen file not represented in the registry.

**Run manually:**

```sh
pnpm --filter @workspace/travel-buddy run lint:routes
```

**Wired into CI** via the `check-route-registry` validation workflow.

### Conventions for new routes

When adding a screen file under `app/`, also add a `PortavaRouteDefinition` entry to `PORTAVA_ROUTES` with:

| Field | Guidance |
|-------|----------|
| `key` | Stable, hyphenated identifier — never re-use or rename (deep-links depend on it) |
| `path` | Exact Expo-Router path relative to `app/`, using `[param]` for dynamic segments and `(group)` for route groups |
| `title` | Human-readable screen title matching `options.title` in the layout |
| `parent` | Key of the enclosing tab or logical owner, or `null` for top-level routes |
| `icon` | Lucide icon name, or `null` |
| `requiresAuth` | `true` if a valid session is required |
| `featureFlag` | Key of any feature flag that gates the screen, or omit if ungated |
| `ownerOnly` / `adminOnly` | Set appropriately for ownership- or role-gated screens |
