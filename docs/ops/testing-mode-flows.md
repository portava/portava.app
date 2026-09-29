# Testing-mode flows — what a tester can now do, and how to check it

Portava is in testing mode: the hosted testing app (the Replit deployment on the
Supabase project `travel-buddy`, not publicly launched) must carry every intended
feature end to end. This file records, per platform flow, what a tester does in
the app, what they should see, and what the server writes, so a tester can walk
the flow and an engineer can check the result.

Each lane appends its own section. Flow ids are those of the flow catalogue
(`flows.json`, the testing-mode lane brief). Area flows are recorded in their
area's census (`docs/architecture/census-*.md`); only the platform flows
(`PLAT-*`) are recorded here.

**Everything below is controlled evidence** (unit, component and route tests
in this repository). None of it is production evidence. No flag was changed,
no migration was added, and nothing was applied to any database.

---

## TM-social lane (WP-20) — profile and social small gaps

Branch `lane-tm-social`, cut from `main` at `18518e982`.

The flag states below are the testing target's, as the flow catalogue records
them. Where a flag is off, the stated flag-off behaviour is what the app shows.

### PLAT-F11 — remove a member from my trusted circle (and invite one)

- **Where:** Circle screen (`app/circle.tsx`), the **Circle** tab, as the owner
  and not in the trip-invite mode. A **Trusted circle members** card is shown
  under the header.
- **Steps:**
  1. Tap **Invite**, then **Invite** next to a friend. The row shows **Invited**
     (`POST /api/circle-invites`).
  2. As the friend, accept the circle invite (Requests →
     `/api/me/requests/circle_invite/:id/accept`). Back as the owner, the friend
     is listed.
  3. Tap the remove icon beside them and confirm **Remove**.
- **Expected:** the row disappears only after the server answers
  `{ status: "removed" }` (`DELETE /api/circles/:owner/members/:member`). A
  refusal shows **Could not remove** and the row stays. If the membership was
  already gone (404), the list is re-read rather than reporting a removal.
- **Check:** no `circle_memberships` row for (owner, member) afterwards.
- **Rules held:** anyone in a block relation with the owner (either direction)
  is not listed, and not offered for invite. A failed member read shows
  **Couldn't load your circle members** with **Try again**, never "no members".
- **Not built:** the flow's "remove a friend" (`DELETE /api/me/friends/:id`) was
  already wired before this lane; it was not changed.

### PLAT-F14 — profile tabs: posts, trips, events, circles

- **Where:** another person's profile (`/u/<handle>`), the new **Activity** tab
  (grid icon, second in the tab row). Four segments: **Posts**, **Trips**,
  **Events**, **Circles**.
- **Expected:** each segment reads `GET /api/users/:username/{posts,trips,events,circles}`,
  20 rows a page, with **Show more** when there is another page.
- **Rules held (server):**
  - posts are served only at a tier the viewer may read — public to anyone;
    `followers_only` to followers; every tier to the owner. `trip_only` and
    `private` never appear on someone else's tab. Only active, undeleted,
    published posts appear. An unreadable follow edge is a 503 (**Couldn't
    load posts**), never a shorter tab;
  - circles honour the owner's **show friends** privacy setting, and drop a
    circle whose owner is in a block relation with the viewer;
  - a blocked pair or a deactivated account shows **This profile isn't
    available**; a private profile the viewer does not follow shows an empty
    segment ("No posts to show."), which does not claim the person has none.
- **Stamps:** not a segment here, by decision — the profile's existing
  **Stamps** tab already renders the v2 stamp inventory; the legacy
  `/users/:username/stamps` route reads a different table and would show a
  second, different inventory for the same person.
- **Check:** as a stranger, a `followers_only` post of the owner is absent; after
  following, it appears.

### PLAT-F16 — the saved-people list

- **Where:** Saved (`/saved`) → **Saved people** row at the top → `/saved-people`.
- **Steps:** on someone's profile open the menu and tap **Save profile**; open
  Saved → Saved people.
- **Expected:** the person is listed (`GET /api/me/saves`), newest first; tap to
  open their profile; the remove icon unsaves them (`DELETE /api/users/:id/save`)
  and the row goes only when the server confirms.
- **Also fixed:** the profile menu read `isSaved` while the route answers
  `saved`, so a saved profile always offered **Save profile** again and could
  not be unsaved from its own menu. It now shows **Saved** and toggles.
- **Rules held:** anyone in a block relation with me (either direction) is not
  listed; an unreadable block list or profile hydrate is **We couldn't load
  your saved people** with **Try again**, never an empty list.
- **Check:** `user_saves` row for (me, them) after Save; gone after unsave.

### PLAT-F20 — the push device is unregistered on sign-out

- **Where:** any signed-in session on a real device build (push does not work in
  Expo Go or the iOS simulator).
- **Steps:** sign in (the app registers the device: `POST /api/me/devices`),
  then sign out.
- **Expected:** before the session is torn down, the app deletes this device's
  row (`DELETE /api/me/devices/:id`, authorised by the outgoing user's token).
  The call is bounded to 4 seconds and never blocks sign-out; if it fails, the
  row is kept in memory and the next sign-out retries.
- **Check:** `notification_devices` has no row for that device and the old user
  after sign-out; a push to the old user no longer reaches the device.
- **Not built:** `PUT /api/me/push-token` still has no client caller; the device
  registration path (`/me/devices`) is the one the app uses.

### PLAT-F37 — add a hidden gem to a trip plan

- **Where:** a gem (`/gems/<id>`), action bar → **Add to Plan**.
- **Expected:** a sheet lists my trips that are not completed or cancelled.
  Tapping one calls `POST /api/hidden-gems/:id/plan` and the row reports what
  the server did: **Added to plan**, **Already in plan** (409),
  **You can't edit this trip's plan** (403), **This trip or gem is no longer
  available** (404, or hidden gems off), or **Couldn't add — tap to try again**.
- **Changed:** **Add to Plan** used to open the trip *wishlist* picker (a saved-
  places list), not the plan. The wishlist is still one tap away: **Save to a
  trip wishlist instead** at the foot of the sheet.
- **Rules held:** the server decides which coordinates the plan row carries, so a
  protected gem's location is not revealed. An unreadable trips list is
  **Couldn't load your trips** with **Try again**, never "no trips".
- **Check:** a `trip_plan_items` row with `source_type = 'hidden_gem'`,
  `source_id` = the gem, for that trip.

### Where the area flows of this lane are recorded

- PASS-F09 (stamp collections and catalog) — `docs/architecture/census-passport.md` §22.
- TRUST-F13 (reviews lists and place votes) — `docs/architecture/census-trust.md` §27.
- MAP-F04 (Compass → Map commands) and MAP-F08 (circle need-help) —
  `docs/architecture/census-map.md` §46.

## TM-create lane — create a Memory, event-post media, circle need-help copy

Branch `lane-tm-create`. Controlled evidence only (tests with faked clients);
nothing here was run against the testing deployment.

### HM-F08 — create a Memory from the Create hub

- **Where:** the Create hub → **Memory** (now `/memory/new`; `/memory/edit`
  without an id redirects there instead of spinning forever).
- **Steps:** add a title, **Add** two photos, tap **Location** and pick a place,
  choose a precision (for example **City only**), leave **Only me** or pick
  another audience, then **Create memory**.
- **Expected:** one `POST /api/memories` (CREATE_MEMORY, with an
  `Idempotency-Key`), then each photo is uploaded and attached to the new id, and
  the screen is replaced by the new Memory. A refused or unreachable create shows
  the reason with **Try again** and stays on the form; Try again reuses the same
  key. If a photo fails after the Memory exists, an alert says how many did not
  upload and the Memory still opens.
- **Check:** a `memories` row with the title, place and visibility; with
  `memory_kernel_enabled` on, a `memory_command_receipts` and a
  `memory_event_outbox` row for the create; with
  `memory_location_precision_enabled` on, `location_precision = 'city'` (flag
  off, the server drops it and the column keeps its default); `memory_items`
  rows at positions 0 and 1.
- **Recorded:** `docs/architecture/census-highlights-memories.md` §AA.

### Event posts only store this app's media

- **Where:** `POST /api/events/:id/posts` (no client screen sends `mediaUrls`
  today).
- **Changed:** every entry of `mediaUrls` must be an uploaded app media URL — the
  same storage-ref check `POST /api/events/:id/media` already enforces. An
  external URL, or one external URL beside app ones, is refused **400
  invalid_payload** ("mediaUrls must be uploaded app media URLs (use
  /api/media/upload first)") and nothing is written. A text-only post is
  unchanged.
- **Check:** a post with `mediaUrls: ["https://example.com/x.jpg"]` is 400 and
  adds no `event_posts` row; one with a `/storage/v1/object/public/post-media/…`
  URL on this project's Supabase is 201.
- **Tests:** `artifacts/api-server/src/test/mediaUploadHardening.test.ts`,
  "POST /api/events/:id/posts — mediaUrls storage-origin validation": 2 red
  before the fix, 4/4 green after; 3 mutations red, restored by sha256.

### Circle need-help says who was alerted

- **Where:** a trip or event Circle → **I need help** → **Alert the host**
  (`POST /api/circle/contexts/:type/:id/need-help`).
- **Changed:** the server's success message was "Your circle has been
  notified. Stay safe." while it alerts the host only. It now reads "We're
  alerting your host. Only the host is notified, not the rest of your circle.
  Stay safe." The app never showed the server's message; its own copy already
  says **Alert sent to the host**, so nothing changes on screen.
- **Check:** the 200 body's `message` names the host; only the host receives a
  `circle.need_help_host_alert` push.
- **Tests:** `artifacts/api-server/src/test/circleNeedHelpAlertSilence.test.ts`,
  "the message is honest": red before, green after; 3 mutations red, restored by
  sha256. `circle.test.ts` (68) and `telegraphCoordination.test.ts` (105) stay
  green.
