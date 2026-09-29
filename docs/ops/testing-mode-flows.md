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

## TM-admin lane (WP-21) — the admin console

Branch `lane-tm-admin`, cut from `main` at `18518e982`. Controlled evidence only;
no flag was changed, no migration was added, nothing was applied to any database.

**Where:** sign in as an admin account (`profiles.role = 'admin'`), then
Settings → **Connected features** → admin section → **Testing Console**
(`/admin/console`). Every screen below is admin-only on the server (the existing
`requireAdmin` / `isAdmin` guards); the in-app gate only keeps other people from
landing on them. Every screen shows a failed read as **Couldn't load …** with
**Try again**, never as an empty queue, and removes a row only after the server
confirmed the decision.

### PLAT-F39 — review submitted and reported hidden gems

- **Where:** Testing Console → **Hidden gem review** (`/admin/hidden-gems`).
- **Steps:** as a tester, submit a gem (it is `pending` and not listed). As the
  admin, open **Pending**, optionally type a note, tap **Approve** (or **Reject**).
  **Reported** lists gems with open reports: **Uphold (hide gem)** or **Dismiss reports**.
- **Expected:** approve → the gem is `active` and appears in Hidden Gems; the
  submitter is awarded `hidden_gem_explorer` (server side). Reject → `hidden`.
  A refusal stays on the row as **Not recorded: …**.
- **Check:** `hidden_gems.status`; a `hidden_gem_verifications` row with
  `method = 'admin'` and the admin's id.
- **Changed on the server:** approving a gem id that matches nothing is now 404,
  and a refused status write is `db_error` (both used to answer `{ ok: true }`).
- **API-only:** mark sensitive and merge duplicates (their writes are still
  unchecked on the server, so no screen reports on them):

  ```sh
  curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"sensitivityLevel":"protected"}' "$API/api/admin/hidden-gems/$GEM_ID/sensitive"
  # sensitivityLevel: public | approximate | reveal_after_save | reveal_after_acceptance | protected
  curl -sS -H "Authorization: Bearer $TOKEN" "$API/api/admin/hidden-gems/duplicate-candidates"
  curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"canonicalGemId\":\"$CANONICAL_GEM_ID\"}" "$API/api/admin/hidden-gems/$DUPLICATE_GEM_ID/merge"
  ```

### PLAT-F38 — approve a local guide

- **Where:** Testing Console → **Local guides** (`/admin/local-guides`).
- **Steps:** as a tester, Gems → Guide → apply. As the admin, tap **Approve**
  (or **Decline**) on their application.
- **Expected:** approve → `local_guide_profiles.status = 'active'` with
  `verified_at` set, and the tester's guide profile shows
  (`GET /api/hidden-gems/guides/:userId`). Decline → `demoted`.
- **Changed on the server:** a user with no guide profile is now 404 and a
  refused write is `db_error` (both used to answer `{ ok: true }`). Each change
  writes the log line `local guide status set via admin surface` with the
  admin id, the user and the status.
- **API-only:** suspend or reinstate an active guide:

  ```sh
  curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"status":"suspended"}' "$API/api/admin/local-guides/$USER_ID/status"   # active | suspended | demoted
  ```

### SEN-F06 (admin half) — promote and withdraw a live-label scope

- **Where:** Testing Console → **Live-label scopes** (`/admin/live-scopes`).
  Needs `intel_live_scope_admin_surface_enabled` (to see the screen's data) and
  `intel_live_scope_promotion_enabled` (to write); when either is off the
  server's message is shown as it is.
- **Steps:** under **Promote a scope**, leave Zone id empty for the zone-less
  scope (or enter a zone id), enter the claim type, a review horizon (1–90
  days), why you are promoting it, and the density-gate assessment JSON
  (`npm run report:intel-funnel`; `{}` is accepted). **Promote**. To withdraw,
  type a reason on the scope's card and tap **Withdraw**.
- **Expected:** the notice names the scope key and what happened (`promoted`,
  `repromoted`, `renewed`, `already active`); the scope is listed as `active`
  until withdrawn or past its horizon. Recorded in the sensing census §28.

### PASS-F23 — award, revoke and restore a person's stamp

- **Where:** Testing Console → **User stamps** (`/admin/user-stamps`).
- **Steps:** enter `@handle` or a user id → **Find**. Type a reason (required
  for every action). Award by definition slug, or **Revoke** / **Restore** a
  listed stamp.
- **Expected:** the list is re-read after each action; a revoked stamp stays
  listed as "— revoked" with its reason, so it can be restored. An award the
  engine declines shows **Not awarded: <reason>**.
- **Check:** `stamp_award_events` rows with `status` `awarded` / `revoked` /
  `restored` and the admin id; `user_stamps.is_revoked`.
- **New route:** `GET /api/admin/stamps/users/:userId/stamps` (admin-only,
  logged to `admin_access_log`). Recorded in the passport census §23.
- **API-only:** campaigns:

  ```sh
  curl -sS -H "Authorization: Bearer $TOKEN" "$API/api/admin/stamps/campaigns"
  curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"slug":"tm-test-campaign","name":"TM test campaign","isActive":true,"startsAt":"2026-10-01T00:00:00Z","endsAt":"2026-10-31T00:00:00Z"}' \
    "$API/api/admin/stamps/campaigns"
  ```

### LAY-F16 — seed the test airport and its caution zones

- **Where:** Testing Console → **Airports** (`/admin/airports`).
- **Steps:** search for the test airport; if absent, fill **Add an airport**
  (IATA, name, city, country, country code, latitude, longitude, optional IANA
  timezone) → **Save airport** (an upsert on the IATA code, so saving an existing
  code edits it). **Select** it, then add a caution zone (name, type, centre,
  radius 50–50000 m).
- **Check:** an `airport_profiles` row for the code; a `geo_zones` row with
  `is_system = true` and `metadata.iata_code` = the code. Recorded in the
  layover census §47.
- **API-only:** verified landside places and curated dwell:

  ```sh
  curl -sS -H "Authorization: Bearer $TOKEN" "$API/api/admin/airport/verified-places?status=pending&city=Lisbon"
  curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"status":"approved","verified":true}' "$API/api/admin/airport/verified-places/$PLACE_ID"
  curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"activityMin":45,"sourceClass":"curator_measured","confidence":"MEDIUM","evidence":"timed visit 2026-09-29"}' \
    "$API/api/admin/airport/place-dwell/$PLACE_ID"
  # sourceClass: venue_stated | curator_measured; confidence: LOW | MEDIUM | HIGH; activityMin 5..720
  ```

### API-only (admin JWT) — the P3 admin surfaces

Decision: none of these closes an in-app test loop, and each has a working,
admin-gated server route, so they stay API-only for testing. They are listed on
the Testing Console so their absence reads as a decision. Set up once:

```sh
API=https://<the hosted testing app's API origin>
# An admin account's access token, from Supabase password sign-in (anon key, not the service key):
TOKEN=$(curl -sS "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $SUPABASE_ANON_KEY" \
  -H 'content-type: application/json' -d '{"email":"<admin email>","password":"<password>"}' | jq -r .access_token)
H=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')
```

- **COMP-F20 — Compass weights, version, rollback**

  ```sh
  curl -sS "${H[@]}" "$API/api/admin/compass/dashboard"
  curl -sS "${H[@]}" -X POST -d '{"name":"tm-test","weights":{"distance":0.3}}' "$API/api/admin/compass/weights"
  curl -sS "${H[@]}" -X POST -d "{\"weightSetId\":\"$WEIGHT_SET_ID\",\"versionTag\":\"tm-1\"}" "$API/api/admin/compass/version"
  curl -sS "${H[@]}" -X POST -d '{"reason":"testing rollback"}' "$API/api/admin/compass/rollback"
  curl -sS "${H[@]}" -X POST -d '{"userType":"traveler","city":"Lisbon"}' "$API/api/admin/compass/testing-sandbox/preview"
  ```

- **DISC-F22 — creator ledger hold / release / reverse** (needs `creator_attribution_enabled`)

  ```sh
  curl -sS "${H[@]}" "$API/api/admin/creator-ledger/attributions/$ATTRIBUTION_ID/audit"
  curl -sS "${H[@]}" -X POST -d '{"reason":"tm hold"}' "$API/api/admin/creator-ledger/attributions/$ATTRIBUTION_ID/hold"
  curl -sS "${H[@]}" -X POST -d '{"reason":"tm release"}' "$API/api/admin/creator-ledger/attributions/$ATTRIBUTION_ID/release"
  curl -sS "${H[@]}" -X POST -d "{\"transactionKey\":\"$TRANSACTION_KEY\",\"reason\":\"tm reverse\"}" "$API/api/admin/creator-ledger/transactions/reverse"
  ```

- **DISC-F23 — Trails curation, merge, archive; trend-integrity review**

  ```sh
  curl -sS "${H[@]}" -X POST -d '{"to":"archived","reason":"tm archive"}' "$API/api/admin/discovery/trails/$TRAIL_ID/lifecycle"
  curl -sS "${H[@]}" -X POST -d "{\"intoTrailId\":\"$OTHER_TRAIL_ID\",\"reason\":\"tm merge\"}" "$API/api/admin/discovery/trails/$TRAIL_ID/merge"
  curl -sS "${H[@]}" -X POST -d "{\"sourceType\":\"place\",\"sourceId\":\"$PLACE_ID\",\"relationship\":\"supporting\",\"reason\":\"tm curate\"}" "$API/api/admin/discovery/trails/$TRAIL_ID/curate"
  curl -sS "${H[@]}" "$API/api/admin/discovery/trails/$TRAIL_ID/audit"
  curl -sS "${H[@]}" -X POST -d "{\"subjectKind\":\"trail\",\"subjectId\":\"$TRAIL_ID\",\"verdict\":\"suspect\",\"reason\":\"tm review\"}" "$API/api/admin/discovery/trend-integrity/reviews"
  ```

- **DISC-F24 — ranking config and metrics**

  ```sh
  curl -sS "${H[@]}" "$API/api/admin/ranking/config"
  curl -sS "${H[@]}" -X PUT -d '{"key":"<config key from the GET>","value":0.5}' "$API/api/admin/ranking/config"   # writes ranking_config_audit_log
  curl -sS "${H[@]}" "$API/api/admin/ranking/metrics"
  curl -sS "${H[@]}" "$API/api/admin/ranking/suspicious"
  curl -sS "${H[@]}" "$API/api/admin/ranking/debug-samples"
  ```

- **MAP-F15 — circle reports, disable a context, kill switch.** The kill switch
  is also the flag `find_your_circle_disabled` on the existing **Feature Flags**
  admin screen, which writes it through the audited toggle.

  ```sh
  curl -sS "${H[@]}" "$API/api/admin/circle/reports"
  curl -sS "${H[@]}" -X POST -d "{\"contextType\":\"trip\",\"contextId\":\"$TRIP_ID\",\"reason\":\"tm\"}" "$API/api/admin/circle/disable-context"
  curl -sS "${H[@]}" -X POST -d '{"enabled":true}' "$API/api/admin/circle/kill-switch"    # true = circle OFF for users
  curl -sS "${H[@]}" -X POST -d '{"enabled":false}' "$API/api/admin/circle/kill-switch"
  ```

- **SEN-F10 — coverage missions.** These routes are admin-JWT (`requireAdmin`),
  not an internal secret. There is no contributor-facing mission UI; `accept`
  names the contributor as `actorId`.

  ```sh
  curl -sS "${H[@]}" "$API/api/v1/internal/intel/coverage?city=Lisbon"
  curl -sS "${H[@]}" "$API/api/v1/internal/intel/missions"
  curl -sS "${H[@]}" -X POST "$API/api/v1/internal/intel/missions" -d '{"specs":[{"ctx":{"qualifiedDemandEvents6h":5,"requiredLiveFamilyMissing":true,"pendingDecisionsAffectedByContradiction":0,"criticalClaimStale":false,"criticalClaimInActivePlan":false,"campaignHasExplicitBudget":false,"campaignHasAcceptanceContract":false},"mission":{"city":"Lisbon","claimFamily":"crowd","trigger":"demand_spike_missing_family","coverageScore":0.2,"question":"How busy is the square now?"}}]}'
  curl -sS "${H[@]}" -X POST "$API/api/v1/internal/intel/missions/$MISSION_ID/dispatch"
  curl -sS "${H[@]}" -X POST -d "{\"actorId\":\"$CONTRIBUTOR_USER_ID\"}" "$API/api/v1/internal/intel/missions/$MISSION_ID/accept"
  curl -sS "${H[@]}" -X POST -d '{"result":"positive"}' "$API/api/v1/internal/intel/missions/$MISSION_ID/complete"   # positive | negative | inconclusive
  ```

- **SEN-F12 — safety candidates** (needs `intel_safety_candidates_enabled`)

  ```sh
  curl -sS "${H[@]}" -X POST -d '{}' "$API/api/admin/intel/safety-candidates/scan"
  curl -sS "${H[@]}" "$API/api/admin/intel/safety-candidates"
  curl -sS "${H[@]}" -X POST -d "{\"claimId\":\"$CLAIM_ID\",\"action\":\"approve\",\"reason\":\"tm\"}" "$API/api/admin/intel/safety-review"
  # action: approve | reject | retract | reconfirm | supersede
  ```

- **PLAT-F21 — notification templates, account notices, delivery health**

  ```sh
  curl -sS "${H[@]}" "$API/api/admin/notification-templates"
  curl -sS "${H[@]}" -X POST -d "{\"userId\":\"$USER_ID\",\"subject\":\"TM notice\",\"body\":\"Testing an account notice.\"}" "$API/api/admin/notifications/account-notice"
  curl -sS "${H[@]}" "$API/api/admin/notification-delivery-attempts?limit=20"
  curl -sS "${H[@]}" "$API/api/admin/push-retry-health"
  curl -sS "${H[@]}" -X PUT -d '{"pushNotificationsEnabled":true}' "$API/api/admin/notification-defaults"
  ```

### Also in this lane: a report needs a reporter who can see the conversation

`POST /api/messages/:id/report`, `POST /api/threads/:id/report` and
`POST /api/reports` (message/thread targets) now refuse a reporter who is not an
active member of the conversation (404) instead of filing the report and, with
`telegraph_report_evidence_enabled` on, snapshotting another thread's messages.
An unreadable membership check is 503 and files nothing. **Check:** as a
non-member, reporting a message id from another thread answers 404 and writes no
`reports` / `telegraph_report_evidence` row. Recorded in the Telegraph census §39.

### Where the area flows of this lane are recorded

- PLAT-F39, PLAT-F38 — `docs/architecture/census-media.md` §45.
- PASS-F23 — `docs/architecture/census-passport.md` §23.
- SEN-F06 (admin half) — `docs/architecture/census-sensing.md` §28.
- LAY-F16 — `docs/architecture/census-layover.md` §47.
- Report-route membership — `docs/architecture/census-telegraph.md` §39.

## TM-followups lane — safety follow-ups, Compass memory surfaces (WP-12), media small gaps (WP-17)

Branch `lane-tm-followups`, cut from `main` at `978d886bf`. Controlled evidence only; no flag was
changed, no migration was added, nothing was applied to any database. The area flows are recorded
in their censuses (listed at the end); the checks below are what a tester can walk.

### Safety and honesty follow-ups (found by other lanes)

- **Moderation report of a message** (`POST /api/moderation/report`, `subjectType: "message"`):
  a reporter who is not an active member of the message's thread gets **404** and nothing is filed;
  a `threadId` the reporter is not in is refused the same way; if membership cannot be read the
  answer is **503** and nothing is filed. Check: no `moderation_reports` row for the refused cases.
  Same module and rule as PR #537 (`lib/reportTargetAccess.ts`). Recorded in census-telegraph §40.
- **Hidden-gem admin: mark sensitive / merge duplicate** (`POST /api/admin/hidden-gems/:id/sensitive`,
  `/merge`): an unknown gem (or unknown canonical gem) is **404**, a refused write is **db_error**,
  merging a gem into itself is **400**; success still answers `{ ok: true }` and the row changes
  (`sensitivity_level`, or `status = 'merged'` + `merged_into`). Census-media §46.3.
- **Stamp revoke / restore** (`POST /api/admin/stamps/:userStampId/revoke|restore`): a database
  failure or a failed audit write is **db_error**, not 404; a stamp not in the needed state is
  still 404. Census-passport §24.
- **Find Your Circle kill switch** (`POST /api/admin/circle/kill-switch`): every flip goes through
  `toggle_feature_flag_with_audit`, the path the Feature Flags admin uses. Check: a new
  `feature_flag_audit_log` row for `find_your_circle_disabled` with the admin as
  `changed_by_user_id`. A missing function is **503** naming migration 0119; a missing flag row
  (0108 seeds it) is **404**.
- **Rent-a-Buddy active session → Safe Return check-in switch**: turning it on records a check-in
  of type `check_ok` / response `ok`. It used to send `safe_return_enabled`, which the
  `rent_buddy_checkin_type` enum (0047 + 0113) does not have, and swallowed the refusal. Now a
  refused check-in turns the switch back off with **Safe Return check-in failed**; the route
  answers **400** for an unknown type and **db_error** (not `ok: true`) for a refused insert.
  `start_safe_return` was not used: the route counts it as a distress signal and opens a safety
  event against the other party. Check: a `rent_buddy_safety_checkins` row, and no
  `rent_buddy_safety_events` row.

### COMP-F16 — Compass remembers (view, forget, correct)

- **Where:** Passport tab → Explore your passport → **Compass remembers** (`/passport/remembers`).
- **Expected:** each group Portava keeps (About you, Your interests, What Portava figured out,
  Saved & created, …). **Forget** asks, then removes the item after the server confirms and shows
  its message. **Correct** (offered only on inferred items the server allows) takes the right
  value; the wrong one leaves the view. A group the server could not read says **Couldn't load
  this section** — never "Nothing here." — and if nothing could be read the screen is an error
  with **Try again**.
- **Check:** `memory_feedback` rows (`kind = 'forget'`, or `'incorrect'` with `corrected_value`).
  Without 2213 on the database, derived memory shows as unavailable and Correct is a stated error.

### COMP-F17 — Recaps and On this day

- **Where:** Passport tab → **Recaps & On this day** (`/passport/recaps`), or from Compass
  remembers.
- **Expected:** with `memory_recaps` off, both cards say the feature is **not turned on yet**.
  With it on: On this day lists earlier years' postcards, trips, stamps and shared moments from
  today's date; the recap shows This month / This year / last year. A source that could not be read
  is named ("Couldn't load Saved & created …"); a failed request is an error with Try again. If
  `memory_feedback` cannot be read the recap is refused rather than built without your forgets.

### COMP-F03 — the whole Compass feed

Decided: **retired from the client.** The Compass tab renders Compass Home and the per-section
feed; `GET /api/compass/feed` stays as an API route with no screen. Census-compass §31.3.

### MED-F06 — media like, Stamp It and comments

Decided (MD424): media **Like** and **"Stamp It"** are retired from the client; **Stamp** (the
viewer's stamp button) and **Comments** (the viewer's comment button → the post comment sheet) are
the reactions. Nothing new to walk: stamp and comment from the media viewer as before. Census-media §46.1.

### MED-F25 — retry a failed upload

- **Where:** Media → My World. When an upload's processing failed, a card lists it.
- **Expected:** **Retry** queues it again and the row leaves (the server answered 202); with the
  processing worker off (`media_processing_worker_enabled`) the card says retrying is not
  available and the uploads are kept. A failed check says **Couldn't check for failed uploads**.
- **Check:** the `media_assets` row goes `failed → queued` (`processing_terminal = false`).
  Attachments (`POST /api/media/:id/attachments`) are not wired. Census-media §46.2.

### Where the area flows of this lane are recorded

- COMP-F03, COMP-F16, COMP-F17 — `docs/architecture/census-compass.md` §31.
- MED-F06, MED-F25 (and the hidden-gem writes) — `docs/architecture/census-media.md` §46.
- Stamp revoke/restore — `docs/architecture/census-passport.md` §24.
- Moderation report membership — `docs/architecture/census-telegraph.md` §40.
