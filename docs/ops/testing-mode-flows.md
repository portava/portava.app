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
feed; `GET /api/compass/feed` stays as an API route with no screen. Census-compass §29.3.

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

- COMP-F03, COMP-F16, COMP-F17 — `docs/architecture/census-compass.md` §29.
- MED-F06, MED-F25 (and the hidden-gem writes) — `docs/architecture/census-media.md` §46.
- Stamp revoke/restore — `docs/architecture/census-passport.md` §24.
- Moderation report membership — `docs/architecture/census-telegraph.md` §40.
