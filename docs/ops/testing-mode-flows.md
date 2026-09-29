# Testing-mode flows — what was built so each flow works end to end

Portava is in testing mode: every intended feature has to be usable end to end in
the hosted testing app (Replit deployment on Supabase `travel-buddy`). This file
records flows that have **no census of their own**: what was built, the routine
decisions taken, the evidence, and what is still not done. Flows that belong to a
census are recorded there instead (for example Safe Return, TRUST-F10, in
`docs/architecture/census-trust.md` §27).

Each lane appends its own section. Evidence here is CONTROLLED (fake-client route
tests, component tests, pure-function tests). None of it is production evidence.

---

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
- `app/meetups/invites.tsx` — the meetup invites inbox; entry in `app/meetups/index.tsx`; registered in `src/navigation/portavaRoutes.ts` (appended at the array foot).
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
