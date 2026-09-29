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

## Stories: react, reply, save to a highlight (PLAT-F33, lane tm-memories, 2026-09-29)

**Why here.** No `docs/architecture/census-*.md` grades stories. `census-highlights-memories.md` touches the stories domain only where a story becomes a Highlight. It records that note under its own testing-mode section, which points back here.

### What was wrong

- **Nothing mounted the story UI.** `StoriesStrip`, `StoryViewer` and `StoryComposer` existed, but nothing under `app/` mounted any of them. So no story could be opened, reacted to, replied to or saved. The Create hub listed "Story" as *Soon*.
- **The owner could not open their own stories.** `GET /stories/feed` never includes the viewer's own stories, and `GET /stories/archive` lists only expired and saved ones. So "save your own story to a highlight" (owner-only) was unreachable.
- **Replies reached nobody.** `POST /stories/:id/reply` writes `story_replies`, and nothing reads that table.
- **Save-to-highlight lost its answer.** `saveToHighlight(storyId, highlightId)` sent an id the route ignores, since the route *creates* a Highlight. It also answered `{ok}` only, which threw away the 409 that explains why a close-friends story cannot become a Highlight.
- **A failed viewer-list read looked empty.** The viewer list showed "No viewers yet" when the read had failed.

### What was built

- **Server: `GET /me/stories`** (`artifacts/api-server/src/routes/stories.ts`, at the foot).
  - It lists the caller's own live stories: state `active`, not expired, oldest first.
  - It takes no user id, so it can only ever be the caller's own.
  - An unreadable table is a 503, and `stories_enabled` off is `feature_disabled`, as on the feed.
- **Client: `/stories`** (`travel-buddy-standalone/app/stories.tsx`, registered in `src/navigation/portavaRoutes.ts`; the Create hub's Story entry now routes there).
  - "Your story" opens your live stories in the viewer, where Save to highlight is. With none, it opens the composer.
  - Below it are the people whose stories the feed says you may see.
  - An unreadable feed is an error with a retry, and stories switched off says so.
- **`StoryViewer`** (`src/components/StoryViewer.tsx`):
  - someone else's story: five quick reactions (`POST /stories/:id/react`) and a reply box;
  - your own story: Viewers, plus Save to highlight, or "In your highlights" once it is saved;
  - a viewer list that failed to load says so.
- **`sendStoryReply`** (`src/services/storyReply.ts`) delivers a reply in three steps:
  1. It runs the story route first. That route is the gate: it re-checks, at send time, that the story is active and visible to the replier.
  2. It opens the author's direct chat through `openDirectThread`, the funnel that carries DM permissions and new-thread E2EE negotiation.
  3. It sends the text through the ordinary `sendMessage` path.

  On an E2EE thread the server refuses plaintext and stores none, and the reply is resent **encrypted**; nothing is ever downgraded. No server-side DM write was added, because a second write path into threads would skip rules the send route owns.
- **`saveToHighlight(storyId)`** answers the new Highlight id, or the server's own sentence.

### Decisions

- **TM-MEM-D5.** A story reply is delivered as a direct message through the client's normal send path, after the story route's gate. `story_replies` is still written, because it is the server's record that the gate passed.
- **TM-MEM-D6.** `GET /me/stories` is a new owner-only read. `/stories` is the stories home, and the Create hub's Story entry is live. The existing `CreateHubSheet.routes` test was restated: it now expects Story to route to `/stories` instead of being *Soon*.

### Tests (all seen red first)

- `artifacts/api-server/src/test/storyOwnActive.test.ts`: 5 cases, registered on the api-server `test` line. All 5 were red (404) before the route existed.
- `travel-buddy-standalone/src/services/__tests__/storyInteractions.component.test.ts`: 10 cases. The three save-to-highlight cases were red against the old function.
- `travel-buddy-standalone/src/components/__tests__/StoryViewer.interactions.component.test.tsx`: 8 cases, all red before the controls existed.
- `travel-buddy-standalone/app/__tests__/stories.route.component.test.tsx`: 5 cases. Red, because the route was missing.
- `travel-buddy-standalone/src/components/create/__tests__/CreateHubSheet.routes.component.test.tsx`: restated. Red until the Story entry was routed.

Each fix was mutation-checked and restored by sha256. The results are in the lane report.

### How a tester runs it

1. As A, open Create, then Story, and post a story (public, or friends if A and B follow each other).
2. As B, open `/stories` and then A. React with an emoji and send a reply. The reply appears in the A–B chat as "Replied to your story: …".
3. As A, open `/stories` and then "Your story", and tap Save to highlight.
   - A public or friends story becomes a Highlight.
   - A close-friends story shows the server's reason instead.

### Still open

- Reactions are stored in `story_reactions`, and nothing shows them to the author yet: there is no reactions list on the author's side. The flow asks only that a viewer can react.
- `story_replies` has no reader. The author sees a reply in the chat, which is where the flow sends it.
