# Portava — System Paths Reference

> One entry per major system. Format: **System → Primary path → Secondary paths → Owner actions → Deep link → Access**.
> **Last updated:** 2026-07-26

---

## Pulse

**System:** Main social feed — posts, highlights, stories, circle updates.  
**Primary path:** `/(tabs)/index`  
**Secondary paths:** `/post/[id]` (detail), `/hashtag/[slug]` (topic feed), `/post/edit/[id]` (edit)  
**Owner actions:** Create post (`/create`), edit own post, delete own post, archive  
**Deep link:** — (no direct deep-link; posts linked individually via `/post/[id]`)  
**Access:** Public read; `requiresAuth: false` for feed; `requiresAuth: true` to post or interact

---

## Discovery

**System:** Place, event, and people discovery — the Explore tab.  
**Primary path:** `/(tabs)/discovery`  
**Secondary paths:** `/search`, `/map/index`, `/destination/[slug]`, `/destinations/[city]`, `/place/[id]`, `/events/list`  
**Owner actions:** Save a place, add to trip, share  
**Deep link:** —  
**Access:** `requiresAuth: false`; map gated by `map_search_enabled`; places gated by `external_places_enabled`

---

## Media (Watch)

**System:** Travel video content feed and hidden gems clips.  
**Primary path:** `/(tabs)/media`  
**Secondary paths:** `/media/add-gem`, `/gems/index`, `/gems/[id]`  
**Owner actions:** Upload clip, add gem  
**Deep link:** —  
**Access:** `requiresAuth: false` to browse; `requiresAuth: true` to upload; flag: `MEDIA_TAB_ENABLED`

---

## Watch

**System:** Community video content (same surface as Media; named "Watch" in IA target).  
**Primary path:** `/(tabs)/media`  
**Secondary paths:** See Media  
**Owner actions:** See Media  
**Deep link:** —  
**Access:** See Media

---

## Grid

**System:** Portava user directory (people grid).  
**Primary path:** `/(tabs)/discovery` (directory chip when flag on)  
**Secondary paths:** `/search` (People scope), `/u/[username]`  
**Owner actions:** —  
**Deep link:** —  
**Access:** `requiresAuth: false`; flag: `EXPLORE_PORTAVA_DIRECTORY_ENABLED`

---

## Gems

**System:** Hidden local gems — community-submitted location tips.  
**Primary path:** `/gems/index`  
**Secondary paths:** `/gems/[id]` (detail), `/gems/guide` (what are gems?), `/gems/submit` (submission), `/media/add-gem` (from media tab)  
**Owner actions:** Submit a gem, check in at a gem, edit own submission  
**Deep link:** `portava://gems`, `portava://gems/[id]`  
**Access:** Public browse; `requiresAuth: true` to submit or check in

---

## Search

**System:** Cross-entity search — people, places, events, trips, gems.  
**Primary path:** `/search`  
**Secondary paths:** Each scope resolves to its entity detail route  
**Owner actions:** Clear recent searches  
**Deep link:** —  
**Access:** `requiresAuth: false`; recent searches require auth; full unified search behind `UNIFIED_SEARCH_ENABLED`

---

## Compass

**System:** AI-powered travel recommendation feed (personalised via Compass Match score).  
**Primary path:** `/(tabs)/ai`  
**Secondary paths:** `/compass-preferences` (tuning), `/compass-memories` (history of shown items)  
**Owner actions:** Tune preferences, dismiss items, view "Why this?" explanations  
**Deep link:** —  
**Access:** `requiresAuth: true`; tab has `href: null` (reached via in-app CTAs or settings)

---

## Map

**System:** Full-screen interactive map of places, events, and travellers.  
**Primary path:** `/map/index`  
**Secondary paths:** `/place/[id]` (from map pin), `/event/[id]` (from event pin)  
**Owner actions:** Filter map, save a pin, share map view  
**Deep link:** —  
**Access:** `requiresAuth: false`; flag: `map_search_enabled`

---

## Places

**System:** Venue and destination database.  
**Primary path:** `/place/[id]`  
**Secondary paths:** `/(tabs)/discovery` (browse), `/gems/index` (community layer), `/map/index` (spatial), `/destination/[slug]` (destination wrapper)  
**Owner actions:** Add photo, write review, save  
**Deep link:** `portava://place/[id]`  
**Access:** `requiresAuth: false` to view; `requiresAuth: true` to interact; flag: `external_places_enabled`

---

## Events

**System:** Traveller-created and community events.  
**Primary path:** `/(tabs)/events` (hidden tab), `/events/list`  
**Secondary paths:** `/event/[id]` (detail), `/events/create/index` (creation), `/events/invites` (pending invites)  
**Owner actions:** Create event, edit, cancel, manage attendees  
**Deep link:** `portava://event/[id]`  
**Access:** `requiresAuth: false` to browse; `requiresAuth: true` to RSVP or create

---

## Trips

**System:** Itinerary planning and shared travel plans.  
**Primary path:** `/(tabs)/trips`  
**Secondary paths:** `/trip/[id]` (detail), `/trip/new` (creation), `/trip/edit` (edit), `/trip/chat` (group chat)  
**Owner actions:** Create trip, invite members, edit itinerary, delete trip  
**Deep link:** `portava://trip/[id]`  
**Access:** `requiresAuth: true` for own trips; `requiresAuth: false` for public trip preview

---

## Passport

**System:** Travel passport — visual record of countries and stamps.  
**Primary path:** `/(tabs)/passport` (own), `/passport/[username]` (others)  
**Secondary paths:** `/passport/country/[country]` (country drill-down), `/stamps` (stamp collection), `/stamp/[stampId]` (stamp detail)  
**Owner actions:** Customise layout, manage stamps, add memory, share passport  
**Deep link:** `portava://passport/[username]`  
**Access:** `requiresAuth: false` to view others; `requiresAuth: true` + `ownerOnly` for own tab; stamp showcase gated by `stamp_showcase_enabled`

---

## Stamps

**System:** Location-triggered collectible stamps.  
**Primary path:** `/stamps` (own collection), `/stamp/[stampId]` (individual stamp)  
**Secondary paths:** `/(tabs)/passport`, `/passport/[username]` (passport view includes stamps)  
**Owner actions:** Earn stamp (location check-in), admire a stamp (flag: `stamp_admire_enabled`), manage display  
**Deep link:** `portava://stamp/[stampId]`  
**Access:** `requiresAuth: false` to view; `requiresAuth: true` + `ownerOnly` to manage

---

## Stories

**System:** Ephemeral 24-hour stories (within the Pulse feed).  
**Primary path:** `/(tabs)/index` (stories strip)  
**Secondary paths:** `/post/[id]` (individual story as post), `/create` (create story)  
**Owner actions:** Post story, archive, share  
**Deep link:** `portava://post/[id]`  
**Access:** `requiresAuth: true` to post; `requiresAuth: false` to view public stories

---

## Memories

**System:** Permanent memory records associated with locations or trips.  
**Primary path:** `/memory/[id]`  
**Secondary paths:** `/memory/edit` (edit), `/memory/location` (set/update location), `/(tabs)/passport` (memories shown on passport)  
**Owner actions:** Edit memory, update location, delete  
**Deep link:** `portava://memory/[id]`  
**Access:** `requiresAuth: false` to view public memories; `requiresAuth: true` + `ownerOnly` to edit

---

## Highlights

**System:** Curated selections from a user's posts and memories.  
**Primary path:** `/(tabs)/index` (highlights strip), `/(tabs)/passport` (profile highlights)  
**Secondary paths:** `/post/[id]` (individual highlight)  
**Owner actions:** Add to highlights, reorder, remove  
**Deep link:** —  
**Access:** `requiresAuth: false` to view; `requiresAuth: true` + `ownerOnly` to manage

---

## Telegraph

**System:** End-to-end encrypted direct messages.  
**Primary path:** `/(tabs)/messages` (inbox, hidden tab), `/messages/[id]` (thread)  
**Secondary paths:** Accessible via profile header, notification taps, and Pulse tab header shortcut  
**Owner actions:** Send message, delete thread, block sender  
**Deep link:** `portava://messages/[id]`  
**Access:** `requiresAuth: true`

---

## Calls

**System:** Encrypted voice/video calls via LiveKit.  
**Primary path:** Initiated from `/messages/[id]` or `/u/[username]` — `CallSurface` overlays any screen  
**Secondary paths:** Incoming call sheet (root-level overlay, `CallProvider`)  
**Owner actions:** Start call, end call, toggle mute/camera  
**Deep link:** —  
**Access:** `requiresAuth: true`

---

## Followers

**System:** Users who follow the viewer.  
**Primary path:** `/u/[username]` → Followers count chip  
**Secondary paths:** — (sheet or nested route from profile)  
**Owner actions:** Remove follower  
**Deep link:** —  
**Access:** `requiresAuth: false` to view count; privacy settings control list visibility

---

## Following

**System:** Users the viewer follows.  
**Primary path:** `/u/[username]` → Following count chip  
**Secondary paths:** —  
**Owner actions:** Unfollow  
**Deep link:** —  
**Access:** `requiresAuth: false` to view count; privacy settings control list visibility

---

## Requests

**System:** Pending follow requests and message requests.  
**Primary path:** `/(tabs)/passport` or Notifications (follow requests), `/(tabs)/messages` (message requests)  
**Secondary paths:** `events/invites` (event-specific invite requests)  
**Owner actions:** Accept, decline  
**Deep link:** —  
**Access:** `requiresAuth: true` + `ownerOnly`

---

## Saved

**System:** Bookmarked posts, places, events, and gems.  
**Primary path:** `/saved`  
**Secondary paths:** Save action available on any card → reflected here; `/(rent-a-buddy)/saved` for saved buddies  
**Owner actions:** Remove saved item, organise by type  
**Deep link:** —  
**Access:** `requiresAuth: true` + `ownerOnly`

---

## Rent a Buddy

**System:** Marketplace for booking local travel companions.  
**Primary path:** `/(rent-a-buddy)/index`  
**Secondary paths:** `/marketplace` (browse), `/buddy/[id]` (profile), `/booking/[id]` (booking), `/checkout`, `/request-buddy`, `/search`, `/active`, `/match-quiz`, `/offers`, `/waitlist`, `/review`  
**Owner actions (buddy):** Manage dashboard, set availability, create packages, manage requests, track earnings  
**Owner actions (traveller):** Request a buddy, manage booking, leave review  
**Deep link:** `portava://rent-a-buddy`, `portava://rent-a-buddy/buddy/[id]`, `portava://rent-a-buddy/booking/[id]`  
**Access:** `requiresAuth: false` to browse; `requiresAuth: true` to book or apply; flag: `rent_buddy_enabled`

---

## Safety

**System:** User safety tools — safety number, check-in history, emergency contacts, safe return.  
**Primary path:** `/profile/edit/safety`  
**Secondary paths:** `/safety-number` (modal), `/safety-history`, `/profile/edit/emergency-contacts`  
**Owner actions:** Set emergency contacts, initiate safe-return, view safety number, manage check-in history  
**Deep link:** —  
**Access:** `requiresAuth: true` + `ownerOnly`

---

## Safe Return

**System:** Automated check-in and safe-return confirmation for solo travellers.  
**Primary path:** `/profile/edit/safety` → Safe Return section  
**Secondary paths:** `/safety-history`, geofence background tasks  
**Owner actions:** Enable/disable, set contacts, trigger manual check-in  
**Deep link:** —  
**Access:** `requiresAuth: true` + `ownerOnly`

---

## Notifications

**System:** In-app notification centre.  
**Primary path:** `/notifications` (modal presentation)  
**Secondary paths:** Header bell icon on any tab; `usePushToken` + `useNotificationStream` hooks drive the badge count  
**Owner actions:** Mark as read, clear all, tap to navigate to referenced entity  
**Deep link:** —  
**Access:** `requiresAuth: true` + `ownerOnly`

---

## Settings

**System:** User account and app configuration.  
**Primary path:** `/profile/edit/index`  
**Secondary paths:** Individual settings routes under `/profile/edit/*` (17 sub-routes)  
**Owner actions:** Edit all profile and account settings  
**Deep link:** —  
**Access:** `requiresAuth: true` + `ownerOnly`

Target groupings:
- **Profile:** about, photos, identity, travel-profile
- **Account:** account, connected, calling
- **Privacy & Safety:** privacy, who-can-see-me, safety, emergency-contacts, blocked-users, muted-users, restricted-users, reports
- **Notifications & Passport:** notifications, passports, passport-layout

---

## Privacy

**System:** Visibility and privacy controls.  
**Primary path:** `/profile/edit/privacy`  
**Secondary paths:** `/profile/edit/who-can-see-me`, `/blocked-users`, `/muted-users`, `/restricted-users`, `/circle-context-settings`  
**Owner actions:** Set content visibility, manage block/mute/restrict lists, configure circle context  
**Deep link:** —  
**Access:** `requiresAuth: true` + `ownerOnly`

---

## Verification

**System:** Identity and travel-credential verification.  
**Primary path:** `/profile/edit/identity`  
**Secondary paths:** Trust review flow (`/admin/trust-reviews` for admins)  
**Owner actions:** Submit verification documents, view verification status  
**Deep link:** —  
**Access:** `requiresAuth: true` + `ownerOnly`; review side is `adminOnly`

---

## Admin

**System:** Portava platform administration.  
**Primary path:** `/admin/feature-flags` (no hub — direct URL access)  
**Secondary paths:** `/admin/content-reports`, `/admin/gaming-flags`, `/admin/geocode-cache`, `/admin/hashtags`, `/admin/media/index`, `/admin/place-images/index`, `/admin/schema-drift`, `/admin/stamps/*`, `/admin/trust-detail`, `/admin/trust-reviews`, `/admin/trust-settings`, `/admin/visuals/index`  
**Owner actions:** Manage flags, review reported content, manage stamp catalog, review trust, inspect schema drift  
**Deep link:** —  
**Access:** `requiresAuth: true` + `adminOnly`
