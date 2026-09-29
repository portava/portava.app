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

## Events and meetups — WP-05 (lane tm-events, 2026-09-29)

Flows: PLAT-F26, PLAT-F28, PLAT-F29, PLAT-F30, PLAT-F31 (flow catalogue ids).
Branch `lane-tm-events`. No migration was added. No feature flag was changed.

### What a tester can now do

| Flow | In the app |
|---|---|
| PLAT-F26 check-in and attendance | Event page → **Arrived? Check in** (Going attendees, from 1 h before the start to 2 h after the end). Host Dashboard → **Attendance**: everyone going, who checked in, **confirm attended** / **no-show** once the event has started. |
| PLAT-F28 cancel, complete, co-hosts | Host Dashboard → Controls → **Cancel event** (optional reason, confirm step) and **Mark as completed**. Host Dashboard → **Co-hosts**: list, add from people going, remove. |
| PLAT-F29 shared link | A private event opened from a shared link (`/event/<id>?share=<token>`) shows the shared event's details above the join request. |
| PLAT-F30 posts, photos, comments, memory | Event page (host, co-hosts, Going and Maybe): **Posts / Photos / Comments** tabs; Going and staff can post, comment and add photos. A completed event offers **Save as memory** (lands in the Passport). |
| PLAT-F31 meetups | Meetup page (organiser): **Invite more people**. Meetups header → **inbox icon** → Meetup Invites: answer Going / Maybe / Can't go; confirmed-time notices listed apart. |

### What was built

Server (`artifacts/api-server`):

- `src/routes/events.ts` — check-in window and state gate (`eventCheckInRefusal`), a failed check-in write is a 500; share-link preview refuses a viewer blocked with the host; co-host add checks its writes and refuses across a block; co-host list carries public identity; a failed co-host removal is a 500; Going attendees may save a completed event as a memory, and a second save returns the same memory; post authors follow the display-name rule; comments carry author identity; event photos accept the ref `POST /api/media/upload` returns (`post-media/<path>`) — `z.url()` refused it, so no event photo could ever be added. All edits in cited regions are line-neutral; helpers are at the file foot.
- `src/routes/meetups.ts` — `GET /me/meetup-invites`: an unreadable invites table is an error, never an empty inbox.

Client (`travel-buddy-standalone`):

- `src/components/events/EventCheckInCard.tsx`, `src/lib/eventCheckIn.ts` — check-in card and the window rule it mirrors.
- `src/components/events/EventAttendancePanel.tsx` — Host Dashboard → Attendance.
- `src/components/events/EventCohostsPanel.tsx` — Host Dashboard → Co-hosts.
- `src/components/events/EventCancelControl.tsx` — cancel through `POST /events/:id/cancel`.
- `src/components/HostDashboardPanel.tsx` — the two new tabs; Mark as completed through `POST /complete`; the "Mark as started" button (which the server always refused) replaced by a note.
- `src/components/events/EventCommunitySection.tsx`, `src/lib/eventCommunity.ts` — posts / photos / comments.
- `src/components/events/EventMemoryCard.tsx` — save as memory.
- `src/components/events/SharedEventLinkPreview.tsx` — shared-link preview.
- `app/event/[id].tsx` — mounts the above (line-neutral edits).
- `src/components/meetups/MeetupInviteMoreCard.tsx`, `src/lib/meetupInvites.ts` — invite more; mounted in `app/meetup/[id].tsx`.
- `app/meetups/invites.tsx` — the meetup invites inbox; entry in `app/meetups/index.tsx`; registered in `src/navigation/portavaRoutes.ts` (on the array's closing line, line-neutral).
- `src/services/events.ts` — client calls for the routes above (appended at the file foot).

Every new read has a loading state, an error state with Retry, and an empty state
shown only when the read succeeded and held nothing (the DV-83 principle). Every
refused write is shown as the server's message, never as success.

### Decisions (routine; decided and implemented)

| ID | Decision |
|---|---|
| TM-EV-01 | **Check-in is a self-report**; no GPS proof is asked for. The window is 1 h before the start to 2 h after the end (8 h after the start when there is no end), in states open / full / waitlist / started. The trust-bearing signal is the host's confirmation, not the self check-in. The client mirrors the server rule so the button is offered only when the server will accept it. |
| TM-EV-02 | Attendance marking keys on the **stored** state (`started` / `completed`), because the server does. The page's "Happening now" badge is clock-derived and can read ahead of the stored state; the panel says why the buttons are not live yet. |
| TM-EV-03 | Lifecycle actions use their own routes: cancel → `POST /cancel` (records the reason, applies the host-cancel trust rule, notifies attendees); complete → `POST /complete` (attendance trust, stamps, review prompts). "Mark as started" is removed: PATCH refuses `started` by name, and only the scheduler behind `event_start_transition_enabled` starts an event. The note reads that flag and says either that the event starts at its start time or that events do not start automatically yet. |
| TM-EV-04 | Co-hosts are chosen from the event's Going list (people who committed). Only the host adds or removes; co-hosts see the list. |
| TM-EV-05 | The composer is offered to host, co-hosts and Going attendees. The host's `attendee_comments_enabled` is not in the event payload, so an attendee refused by it sees the server's message. Posts are text in the client; photos go through the Photos tab (`event_media`, storage-checked). |
| TM-EV-06 | `POST /events/:id/media` accepts the storage ref the upload route returns; `appStorageUrlInfo` remains the only gate (foreign URLs and other buckets are refused). |
| TM-EV-07 | Save as memory: stored state `completed`, host / co-host / Going attendee; one memory per person per event (a second save returns the first). The card links to the Passport. |
| TM-EV-08 | The share-link preview is read only when the viewer could not otherwise see the event (private sentinel). A visible event is shown as usual and the preview is not read, so opening it does not spend one of a limited link's uses. An expired or used-up link is said as such, with no Retry. |
| TM-EV-09 | Invite more: organiser only, not on a cancelled meetup. Candidates come from the scope the server accepts (trip members / circle members / friends), and every outcome the server reports (invited, already invited, out of scope, outside the age limit) is shown. |
| TM-EV-10 | The meetup invites inbox lives at `/meetups/invites`, reached from the Meetups header. Answers go through the meetup RSVP route; a declined invite leaves the inbox, Going / Maybe open the meetup. |

### Tests (red first → green) and mutations

Server — `artifacts/api-server/src/test/eventsTestingModeWiring.test.ts` (registered
on the `test` line): 27 tests. Seen red before each fix (check-in window and write,
preview block check, co-host writes / block / identity, memory authority and
idempotency, post and comment identity, meetup inbox read error; later co-host
removal and the media ref). Mutations S-M1 … S-M11 and S-M16 … S-M18 all KILLED,
each file restored byte-identically (sha256 checked).

Client:

- node:test — `src/lib/__tests__/eventCheckIn.test.ts`, `eventCommunity.test.ts`,
  `meetupInvites.test.ts` (the last two seen red on the missing module first).
- jest — `src/components/events/__tests__/EventCheckInCard`, `EventHostControls`,
  `EventCommunity`; `src/components/__tests__/HostDashboardPanel.lifecycleRoutes`;
  `src/components/meetups/__tests__/MeetupInviteMoreCard`;
  `app/event/__tests__/EventDetail.testingModeMounts`;
  `app/meetup/__tests__/MeetupDetail.inviteMore`;
  `app/meetups/__tests__/meetupInvites.inbox`, `meetups.invitesLink`
  (all `*.component.test.tsx`).
- The four wiring tests (event page, Host Dashboard, meetup page, meetups header)
  were run against the pre-change screen files and were RED, then GREEN with the
  working bytes restored (sha256 checked).
- Mutations C-M1 … C-M12 and C-M16 … C-M21 (window, snake_case attendance row,
  stored-state gate, read-failure honesty in attendance / posts / invite
  candidates / inbox, refusals shown, memory gate, composer gate, upload before
  add, ended-vs-error link, cancel reason, complete route, invite outcomes, trip
  scope) all KILLED and restored.

### Not done, and why

- **PLAT-F26:** no GPS proof at check-in (TM-EV-01). Attendance marking and
  completion need the event's stored state to reach `started`, which only the
  scheduler does, behind `event_start_transition_enabled` (testing target TRUE per
  the flow catalogue; if it is FALSE on the testing DB, those two steps are not
  reachable, and the Host Dashboard says so).
- **PLAT-F28:** co-host permission editing (`PATCH /cohosts/:userId/permissions`)
  is not surfaced; co-hosts get the server's default permissions.
- **PLAT-F29:** a shared link to a visible event does not read the preview
  (TM-EV-08), so its use count does not move.
- **PLAT-F30:** each tab shows the first page (20 items); there is no "load more".
  `POST /events/:id/posts` still accepts arbitrary external `mediaUrls` without the
  storage check the media route has; the client never sends any, but the server
  gap is open. A saved memory shows in the Passport only where
  `passport_memories_enabled` is on.
- **PLAT-F31:** complete as specified by the catalogue.

## TM-RAB lane (WP-01) — Rent-a-Buddy: run the booking, refused gates, admin moderation

Branch `lane-tm-rab`, cut from `main` at `18518e982`. Flows: PLAT-F43, PLAT-F45,
PLAT-F49, PLAT-F50, PLAT-F55, PLAT-F56. No other Rent-a-Buddy flow in
`flows.json` is marked "needs code" without being payment work (see Decisions).

**No payment code.** Nothing here takes, holds, refunds or pays out money. Where
a screen mentions money it keeps the existing honest copy: no payment goes
through the app; traveller and buddy settle directly.

**Every gate stays on the server.** `rent_buddy_enabled`, the KYC / identity
readiness gate (`rent_buddy_allow_bookings_without_kyc`), the kill switches
`disable_rab_bookings` / `disable_rent_buddy_booking`,
`rent_buddy_global_controls.all_bookings_paused`, city rollout, beta access,
launch controls and user limits decide exactly what they decided before. The
server now only *names* the gate in the refusal body (`gate`), and the app shows
a refused gate as its own state: which gate refused, and what unblocks it.

### Preconditions on the testing app (owner / admin, unchanged by this lane)

- `rent_buddy_enabled` ON (owner decision). Off, every Rent-a-Buddy screen shows
  the gate state "Rent a Buddy is switched off — REFUSED BY rent_buddy_enabled —
  an admin turns it on in Admin → Feature flags". If the flags cannot be read the
  app says so and offers "Try again"; it never shows "off" for a failed read.
- New bookings additionally need the KYC gate open (an operational identity
  provider, or the owner turning `rent_buddy_allow_bookings_without_kyc` on), no
  kill switch engaged, the city rolled out (and beta access for beta cities), and
  a launch control covering the location if any control exists (deny-by-default).
  Each of these, when it refuses, is shown by name with its unblock.

### PLAT-F43 — the buddy suggests another time; the traveller answers

- **Where:** buddy: Buddy dashboard → Booking requests → "Suggest" (existing
  sheet), or any accepted booking → Session → "Suggest another time". Traveller:
  the booking screen `(rent-a-buddy)/booking/[id]` → Session → Suggested changes.
- **Steps:** as the buddy, suggest a new date and/or start time. As the traveller,
  open the booking: the suggestion reads e.g. "Start time: 10:00 → 14:00" with the
  buddy's reason. Tap **Accept** (the booking's date/time is updated server-side)
  or **Decline**. The side that suggested sees "You suggested this — waiting for
  the other side".
- **Server:** `POST /api/rent-a-buddy/bookings/:id/suggest` writes
  `buddy_booking_change_requests`; the NEW read
  `GET /api/rent-a-buddy/bookings/:id/change-requests` (party-only, behind
  `rent_buddy_enabled`) returns them with `requestedByMe`;
  `POST /api/rent-a-buddy/bookings/:id/respond-change-request` answers.
- **Check:** `SELECT change_field, proposed_value, status FROM buddy_booking_change_requests WHERE booking_id = :id;`
  then `SELECT booking_date, start_time FROM rent_buddy_bookings WHERE id = :id;`

### PLAT-F45 — run the booking: start, check-ins, emergency phrase, complete, confirm

- **Buddy:** Buddy dashboard → **My sessions** lists accepted, in-progress and
  awaiting-confirmation bookings. **Start session** (only from scheduled /
  confirmed) → `in_progress`. **Complete session** (only from in_progress) →
  `completed_pending_traveler_confirmation` with a 24 h window. The same
  controls are on the booking screen's Session panel.
- **Traveller:** the booking screen → Session: **I've arrived** / **All good**
  (check-ins, `POST …/check-in` with `arrival` / `check_ok`); when the buddy has
  completed, **Confirm completion** → `completed` (or **Open a dispute**).
  In the live session (`(rent-a-buddy)/active`): **End session** now completes
  the booking on the server first and only then opens the review (it used to
  navigate without writing anything, so the booking stayed in progress and the
  review was refused). **I need to check my passport** is the discreet
  emergency phrase: it records the safety event and opens a private prompt only
  the traveller sees (I am okay → check-in; End booking now; Share location;
  Start Safe Return; Contact support; Use emergency button → dials 112).
- **Server:** `/start`, `/complete`, `/traveler-confirm`, `/check-in`,
  `/safety/emergency-phrase` (all existing).
- **Check:** `SELECT status, started_at, completed_at FROM rent_buddy_bookings WHERE id = :id;`
  `SELECT checkin_type FROM rent_buddy_safety_checkins WHERE booking_id = :id;`
  `SELECT event_type FROM rent_buddy_safety_events WHERE booking_id = :id;`
- **Physical:** meeting in person is simulated; GPS is not read by these controls.

### PLAT-F49 — review moderation

- **Where:** Admin → Rent a Buddy → **Review Moderation** (`admin/reviews`).
- **Steps:** after a completed booking, the traveller reviews (existing
  `review.tsx`). As admin, the review is under Pending; **Approve** makes it
  public and recalculates the buddy's rating; **Reject** asks for a reason and
  keeps it hidden. Approved / Rejected tabs list moderated reviews.
- **Check:** `SELECT moderation_status, is_public FROM rent_buddy_reviews WHERE id = :id;`
  `SELECT average_rating, review_count FROM rent_buddy_profiles WHERE user_id = :buddy;`

### PLAT-F50 — the buddy lists and withdraws their own offers

- **Where:** Buddy dashboard → **My offers**.
- **Steps:** every offer the buddy sent, newest first, with its answer
  (waiting / accepted / declined / expired / withdrawn). **Withdraw offer** on a
  pending one. An offer the traveller already accepted cannot be withdrawn: the
  server refuses it (compare-and-set on `pending`) and the app says "Already
  answered"; an accepted offer links to its booking.
- **Check:** `SELECT status FROM rent_buddy_offers WHERE id = :id;`

### PLAT-F55 — launch-controls editor

- **Where:** Admin → Rent a Buddy → **Launch Controls** (`admin/launch-controls`).
- **Steps:** **New control** for a country code / city / category (blank = any)
  with bookings open, verified-ID and verified-phone requirements. Per control:
  switches for Bookings open / Waitlist only / Require verified ID / Require
  verified phone, and steppers for the minimum and nightlife minimum age. The
  screen states up front that controls are deny-by-default, and asks for
  confirmation before creating the first one. Payment fields on the row are not
  edited here.
- **Check:** `SELECT * FROM rent_buddy_launch_controls;` then, as a traveller, a
  booking in an uncovered location is refused with the gate state "No launch
  control covers this booking — REFUSED BY rent_buddy_launch_controls".

### PLAT-F56 — support reports, risk review, verification override

- **Where:** Admin → Rent a Buddy → **Support Reports**, **Risk Review**.
- **Support:** tabs Open / In review / Resolved / Closed; **Update status /
  notes**.
- **Risk:** tabs Watch / Limited / Under review / Suspended / Normal; **Set risk
  status** with a required note (Suspended also switches the user's Rent-a-Buddy
  access off server-side); **Verification…** records a manual ID / phone / age
  decision — each field is "No change" unless chosen, so saving never revokes a
  verification by accident.
- **Check:** `SELECT status, admin_notes FROM rent_buddy_support_reports WHERE id = :id;`
  `SELECT risk_review_status, verification_status, id_verified FROM rent_buddy_profiles WHERE user_id = :u;`
  `SELECT action FROM rent_buddy_admin_actions ORDER BY created_at DESC LIMIT 5;`

### What was built

- Server (`artifacts/api-server`):
  - refusals name the gate: `requireRentBuddyEnabled` → `gate: "rent_buddy_enabled"`;
    the five kill-switch refusals name the engaged switch via
    `engagedRabBookingKillSwitch` (`src/lib/featureFlags.ts`). Decisions unchanged.
  - `GET /rent-a-buddy/bookings/:id/change-requests` (new, appended to
    `src/routes/rentABuddy.ts`).
  - offer withdraw is compare-and-set on `pending` (`src/routes/rentABuddyMarketplace.ts`).
  - admin launch-controls / support / risk-review reads, and launch-control PATCH,
    risk-status, verification override, review approve / reject, now answer 5xx on
    a database error instead of an empty list or `ok`.
  - `check:rent-buddy-contract` lists the 17 routes the new screens depend on.
- Client (`travel-buddy-standalone`): `src/services/rentABuddyGates.ts`,
  `src/services/rentABuddyLifecycle.ts`,
  `src/components/rentabuddy/{RabGateRefusalState,BookingLifecyclePanel,RabAdminScaffold}.tsx`,
  screens `buddy-dashboard/{sessions,my-offers}.tsx`,
  `admin/{reviews,support,risk,launch-controls}.tsx`; wiring in `_layout.tsx`,
  `booking/[id].tsx`, `active.tsx`, `buddy-dashboard/index.tsx`, `admin/index.tsx`;
  service fixes in `src/services/rentABuddy.ts` (refusals keep `gate`;
  `submitCheckIn` sent `{status, broadArea}` to a route that reads
  `{checkinType, response}`), `src/services/rentABuddyAdmin.ts` (reads return
  `ok:false` instead of `[]`; launch-control writes send the route's camelCase
  keys) and `src/hooks/useRentABuddyFlag.ts` (tri-state read). Six routes
  registered in `src/navigation/portavaRoutes.ts` (closing line).

### Decisions (routine; decided and implemented)

1. **Traveller "End session" completes the booking** through `POST /complete`
   (the server's traveller path goes straight to `completed`); the buddy's
   completion opens the traveller's 24 h confirmation. Mirrors the server.
2. **Name the gate, don't re-decide it.** Refusal bodies gain a `gate` field;
   `feature_disabled` without one is the master switch (its only other source).
3. **Admin screens stay behind the client's `rent_buddy_enabled` check**, as the
   existing admin screens are. The server exempts admin routes; the admin turns
   the flag on in Admin → Feature flags (outside the group) first, and city
   rollouts keep bookings closed until an admin opens a city.
4. **Verification override is per-field opt-in** ("No change" default): the risk
   list does not carry current verification columns.
5. **Launch-control editor leaves payment fields alone** (`full_payment_required`,
   `min_deposit_pct`): payment policy waits on the owner.
6. **PLAT-F51 (packages, add-ons, tips) is not built here**: it prices and
   records money (add-on totals, tips) and the catalogue files it under
   payments.md rows 4–6. PLAT-F44 (deposit / refund) and PLAT-F53 (payouts) are
   payment work. All wait on the owner's payment decision.

### Tests (red first → green) and mutations

- `artifacts/api-server/src/test/rentBuddyTestingModeWiring.test.ts` (registered
  on the `test` line): **RED 22 of 29 → GREEN 29/29**. Mutations M1–M19 (drop
  each gate name, blank the kill-switch name, drop the withdraw CAS predicate,
  unscope / un-guard / mis-attribute the change-request read, swallow each admin
  read and write error): **all 19 red**, each restored byte-identically (sha256).
  All 89 api-server suites that import or read the touched route files: 1760/1760.
- Client node:test: `rentABuddy.gates.test.ts` 32, `rentABuddy.lifecycle.test.ts`
  15, `useRentABuddyFlag.state.test.ts` 8 — red at HEAD (modules/functions
  absent: 0/1, 0/1, 0/8) → green.
- Client jest: `rentABuddy.testingModeWiring.component.test.ts` (16),
  `BookingLifecyclePanel.component.test.tsx` (9), `rabLayout.gate` (3),
  `buddySessionsOffers` (9), `rabAdminScreens` (10), `activeSession.lifecycle` (4).
  Against HEAD sources: 6 suites FAIL, 19 failed / 4 passed (the 4 are
  pass-through cases that were already true). All green on the branch; every
  RAB-touching jest suite 272/272.
- Client mutations CM1–CM15 (gate naming, traveller offered Start, `gate`
  dropped by `apiFetch`, old check-in body, partial sessions list, admin read back
  to `[]`, gate shown as a generic Alert, failed suggestions read shown empty,
  End session without completing, unreadable flag shown as off, verification
  sending untouched fields, failed sessions read shown empty, Withdraw on answered
  offers, snake_case launch-control keys): **all 15 red**, restored by sha256
  (CM15 first survived; its test was strengthened to toggle a field whose column
  and key differ).

### Not done, and why

- **Payments** (PLAT-F44, PLAT-F51, PLAT-F53): owner decision.
- **Owner/admin activation on the testing app**: `rent_buddy_enabled`, city
  rollouts, beta access and the KYC gate are unchanged here; with them closed,
  every flow above shows the named gate state rather than working end to end.
- **PLAT-F56 user limits and the sensitive-booking view** have routes and no
  screen; the brief's scope for this lane was support, risk and verification.
- **`rent_buddy_requests.country_code`** (PLAT-F50's backfill blocker, migration
  2212 unproven on travel-buddy) is untouched: posting a request can still fail
  on the testing database until that migration is applied.
- The existing Safe Return switch on `active.tsx` posts a check-in type
  (`safe_return_enabled`) that is not in the `rent_buddy_checkin_type` enum;
  left as found (out of this lane's flows), noted for the Safety lane.
