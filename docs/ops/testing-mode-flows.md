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
