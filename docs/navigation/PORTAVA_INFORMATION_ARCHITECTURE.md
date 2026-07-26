# Portava — Target Information Architecture

> **Status:** Target state after all navigation-upgrade tasks complete.
> **Gate:** `NEW_INFORMATION_ARCHITECTURE_ENABLED` feature flag covers the full upgrade.
> **Last updated:** 2026-07-26

---

## 1. Five-Tab Structure

The app moves from four visible tabs (+ optional Media centre) to a **stable five-tab structure**. The centre floating button is replaced by a **global create sheet** (flag: `GLOBAL_CREATE_MENU_ENABLED`).

| Tab # | Label | Icon | Responsibility |
|-------|-------|------|----------------|
| 1 | **Pulse** | Activity | Social feed, highlights, stories, circle updates |
| 2 | **Explore** | Compass | Discovery: places, people, events, destinations, gems, Portava directory |
| 3 | **Watch** | Film | Media: video travel content, hidden gems nearby, community clips |
| 4 | **Trips** | Plane | Itinerary planning, trip invites, layovers, routes |
| 5 | **Passport** | Passport | Own passport, stamps, memories, peer passports |

> **Note:** Events and Telegraph (Messages) are promoted out of hidden-tab status. Events becomes a major surface under **Explore**. Telegraph is reachable from the Pulse tab header and as a persistent shortcut — not a separate tab.

---

## 2. Per-Tab Responsibilities

### 2.1 Pulse

Primary surface for the authenticated user's social graph.

- Main feed: posts, highlights, stories from people in circles and followed users
- Highlights strip at the top (new highlights badge drives tab badge)
- Entry point to Telegraph (DM inbox) via header icon
- Entry point to Notifications via header bell (badge shows unread count)
- Entry point to the Compass AI feed via overflow or dedicated chip
- Circle activity section (close-friends presence, geofence arrivals)

### 2.2 Explore

Discovery across all content types.

- **Search** (unified, `UNIFIED_SEARCH_ENABLED`): people, places, events, trips, gems
- **Events** feed and creation — promoted from hidden tab
- **Places** directory: destinations, city pages, gems
- **Portava Directory** (flag: `EXPLORE_PORTAVA_DIRECTORY_ENABLED`): browse and find other travellers
- **Map** entry point (flag: `map_search_enabled`)
- Compass feed / recommendations surface

### 2.3 Watch (Media)

All video and media content.

- Travel clips feed
- Hidden gems nearby (flag: `MEDIA_HIDDEN_GEMS_NEARBY_ENABLED`)
- Community gem submissions
- Add Gem creation flow

### 2.4 Trips

Everything related to travel planning.

- My trips list
- Trip invites (badge on tab)
- Layovers and routes
- Availability calendar
- Meetups

### 2.5 Passport

The user's travel identity and credentials.

- Own passport (stamps, countries, memories)
- Passport layout customisation
- Access to peer passports via deep-link or profile tap
- Stamp detail and collection management
- Highlights and memories associated with locations

---

## 3. Screen Hierarchy Rules

Every screen in the app follows this layer order from outermost to innermost:

```
SafeAreaProvider
  └── AccountStatusGate / AgeGate   [global: root _layout.tsx]
        └── Tab or Stack navigator
              └── Safe-area-aware screen root View
                    ├── Header (collapsible, flag: COLLAPSIBLE_HEADERS_ENABLED)
                    │     ├── Back / dismiss control
                    │     ├── Screen title
                    │     └── Trailing actions (overflow menu, share, edit)
                    ├── Primary content area (ScrollView / FlatList / MapView)
                    ├── Secondary content (sidebar, filters, chips)
                    ├── Floating action (FAB, sticky CTA)
                    └── Bottom navigation (tab bar or back-gesture target)
```

Rules:
1. **Headers are collapsible on scroll by default** when `COLLAPSIBLE_HEADERS_ENABLED` is on — screens opt out by passing `collapsible={false}`.
2. **No screen hardcodes bottom padding** for the tab bar; instead, `useBottomInset()` computes the correct clearance tier.
3. **Stack screens** pushed from a tab do not show the tab bar and require no bottom inset for the pill.
4. **Modal screens** (`presentation: 'modal'`) always show a dismiss handle and use `accessibilityViewIsModal`.
5. **Owner-only sections** within a shared screen (e.g. edit controls on a profile) are shown/hidden in-place — they do not require a separate route.

---

## 4. Card Hierarchy

Cards are the primary unit of content. Three tiers:

| Tier | Use case | Elevation | Image aspect |
|------|----------|-----------|--------------|
| **Hero card** | Full-bleed featured content (top of feed, destination hero) | 4dp shadow | 16:9 or 4:3 |
| **Standard card** | List items: trips, events, places, buddies | 2dp shadow or border | Square or 3:2 |
| **Compact card** | Inline results: search, chip filters, mini-map pins | No shadow / flat | Icon or thumbnail |

Cards must:
- Include an `accessibilityLabel` that reads the primary action ("View Rome trip").
- Show a skeleton placeholder while loading — never a blank box.
- Not duplicate actions already available in the screen's floating action or header overflow.

---

## 5. Global Create Menu

When `GLOBAL_CREATE_MENU_ENABLED` is on the centre Plus button opens a bottom sheet with contextual create options:

| Action | Navigates to | Auth required |
|--------|-------------|---------------|
| New Post | `/create` | Yes |
| New Trip | `/trip/new` | Yes |
| Create Event | `/events/create` | Yes |
| Submit a Gem | `/gems/submit` | Yes |
| Add to Passport | `/stamps` (own) | Yes |

The sheet respects the current tab context — e.g., on Trips the "New Trip" option is promoted to the top slot.

---

## 6. Search Architecture

When `UNIFIED_SEARCH_ENABLED` is on:

```
/search
  ├── Scope chips: All | People | Places | Events | Trips | Gems
  ├── Recent searches (ownerOnly, stored locally)
  ├── Trending searches (public)
  └── Results list (adaptive card tier based on scope)
```

- A single `GET /api/search?q=&scope=` endpoint backs all scopes.
- Each scope maps to the appropriate entity detail route on tap.
- The search bar is reachable from every tab's header via the Search icon — not only from the Explore tab.

When `UNIFIED_SEARCH_ENABLED` is off, per-tab search inputs remain as-is (Explore has its own search, Trips has its own filter, etc.).

---

## 7. Settings Structure

Settings are reachable from the Passport tab (own profile) via the Edit icon. The hub screen (`profile/edit/index`) groups settings into four sections:

| Section | Routes included |
|---------|----------------|
| **Profile** | about, photos, identity, travel-profile |
| **Account** | account, connected, calling |
| **Privacy & Safety** | privacy, who-can-see-me, safety, emergency-contacts, blocked-users, muted-users, restricted-users, reports |
| **Notifications & Passport** | notifications, passports, passport-layout |

Settings that affect only the current session (language, theme) are surfaced in an overflow menu on the Passport tab header, not in the full edit flow.

---

## 8. Overflow Menu Conventions

The trailing "…" or "⋮" button on screens follows these rules:

| Context | Items to include |
|---------|-----------------|
| Own profile | Edit Profile, Share Profile, QR code |
| Other user's profile | Follow/Unfollow, Message, Block, Report, Share |
| Own passport | Edit Passport, Layout, `PASSPORT_OWNER_MENU_ENABLED` actions |
| Event detail (host) | Edit Event, Cancel Event, Manage Attendees |
| Event detail (attendee) | Share, Save, Report |
| Trip detail (owner) | Edit Trip, Invite, Delete |
| Trip detail (member) | Leave Trip, Share |
| Post (own) | Edit, Delete, Archive, Pending Status |
| Post (other) | Save, Share, Report, Hide |

Overflow menus must:
- Use `accessibilityRole="menu"` on the container and `"menuitem"` on each item.
- Not exceed seven items — use sub-sheets for longer lists.
- Destructive actions (Delete, Block, Cancel) appear last and use a destructive colour.

---

## 9. Deep-Link Conventions

All deep-linkable routes use the pattern `portava://[path]` for universal links.

| Route | Universal link | Notes |
|-------|---------------|-------|
| User profile | `portava://u/[username]` | Also handles legacy `/profile/[handle]` |
| Passport | `portava://passport/[username]` | |
| Event | `portava://event/[id]` | |
| Trip | `portava://trip/[id]` | |
| Place | `portava://place/[id]` | |
| Stamp | `portava://stamp/[stampId]` | |
| Gem | `portava://gems/[id]` | |
| Message thread | `portava://messages/[id]` | Auth-gated; redirects to sign-in |
| Invite | `portava://invite/[token]` | Public; presents sign-up if unauthenticated |
| Hashtag | `portava://hashtag/[slug]` | |

Legacy paths (`/profile/[handle]`, `/destinations/[city]`) must redirect to their canonical equivalents and must not appear in any generated share links.
