# Wave 5: what the owner must know and decide (2026-10-18)

Branch `claude/wave4-build-20261017` (PR #764, stacked on #763 and #762). Every item below was found or built in waves 4–5. Each one either changes behaviour on merge, needs a ruling only the owner can give, or needs the owner's press on production. Detail for each item is in the census section or file named.

## 1. Behaviour that changes when #764 merges and deploys

| Area | What changes | How to switch it off |
| --- | --- | --- |
| Telegraph T256 | **New-message notifications are unflagged.** Every person-sent message notifies the other members ("New message" plus the sender's shown name; never the body). Bursts coalesce per thread per 5 minutes. Archived conversations still notify; the `message_previews` preference is ignored, because no push carries a preview. | No flag exists yet; adding a flag check at the top of `notifyNewMessage` (services/telegraph/messageNotifications.ts) would be the single switch. |
| Telegraph T395 | **Coordination notifications are unflagged** and push on merge. | No flag exists yet; a flag check at the top of `notifyCoordinationAct` would be the switch. |
| Telegraph safety | **A help request (SOS / NEED_HELP) now notifies the conversation.** It overrides mutes and MENTIONS-only, never crosses a block, and yields to quiet hours only under the recipient's own safety_override. It is re-driven for 15 minutes if the roster or blocks can't be read, or a create fails. Members who archived the conversation are skipped (owner ruling). An ALL CLEAR the notification layer coalesces is settled only when the member already holds an equivalent one; otherwise it is written about 60 seconds later (logged at WARN) instead of being lost. | — (safety) |
| Telegraph T254 | `circle.need_help_host_alert` now reaches a host in quiet hours under their safety_override. | — |
| First deploy | The re-drive's first pass may deliver help requests from the previous 15 minutes that the old code never notified. | — |
| Stamps H4 | **Trip completion stamps now require a check-in on that trip.** A trip really taken with no check-in earns none. Readers show a stamp's place only with presence evidence. Admin and internal presence awards need evidence. | — |
| Reviews | Reviews by a non-active reviewer (deactivated, deleted, anonymous or with no profile) are left out of the trip, place, user and event review lists. A failed reviewer read is a 503. | — |
| Trips | A route's own 4xx is shown as a refusal with the server's words, not "couldn't reach the trip". A 429 stays "try again later". | — |
| Place sweep | Owner ruling: oldest first, paged batches, busy places prioritised without starving quiet ones, backlog continued, capacity scales. It now reports at /healthz/schedulers. | — |
| Inbox | Archived conversations move to an "Archived" section with Unarchive (owner ruling). | — |
| Moderation | Reports use one vocabulary (open, in_review, resolved, dismissed), so reports filed by users now reach the trip and event queues and can be resolved. `GET /admin/reports?status=all` answers 400; the admin client never sends it. A media report that another moderator closed first answers 409 (was 404). The moderation dossier and the user detail refuse the record when a moderation count can't be counted, instead of showing 0. | — |
| Event moderation | Event state changes only through the lifecycle authority. A moderator cancel of a completed or archived event is a 409, and a moderator cancel now notifies going/maybe attendees. Restore returns exactly to the recorded prior state and visibility (never public from nothing); a legacy hide with no record is refused (409) or, for an appeal, deferred to a person. While a moderation holds, the host's visibility, link-circle and archive writes answer 409 `event_under_moderation`. A failed event read is 503 where it was 404/403. Note: a "hide" (invite_only) still serves the event to invitees and to anyone holding a share link; "remove" is the strong action. | — |
| Admin screens | Moderation screens refuse with the name of what could not be read instead of showing 0 or an empty list; report close claims, then audits, then undoes on an audit failure (409 on a race); the reported-venue queue cannot drop a venue; the Compass dashboard refuses a section it cannot count whole. | — |
| Events reads | A failed database read in the events routes is never "not found", "not allowed", a default or a write from nothing: access gates answer 503; facts the response states refuse; best-effort details degrade and log. Fixed in passing: an unread join request at waitlist accept deleted the user's queue place and offered their seat to the next person. The feed's `isSaved` is `null` (unknown) when it can't be read; no app screen reads it from the feed. About 74 event routes now answer 503 `degraded_unavailable` (retryable) where they answered 404, 403, an empty list or a defaulted body. The 11 list routes' own primary reads answer 500 `db_error`, like their sibling reads. Outside production these bodies carry the database's error text; in production they say "An unexpected error occurred." The feed (`GET /events`) now refuses the whole page when the viewer's own RSVP or queue place can't be read (it used to show them as none). Removing an attendee answers `{ ok: true, chatRemoved: false }` when the chat lookup fails, and logs an error. No app screen calls that route today. | — |
| Event restore | Restoring a moderator-hidden event the host cancelled afterwards now reverses the hide (visibility back to the recorded prior value) and keeps the host's cancellation (`stateKept`). It used to answer 409 and leave the event hidden for good. A moderator's own recorded cancel or remove is still reversed exactly. Each record of such a restore now says the state was kept (`state_kept` on the activity row and the moderation audit row). An approved appeal closes as `event_visibility_restored_state_kept`, not `event_restored`, and the host is told "your event is visible again. Its status was not changed." | Owner to confirm (see §2). |

## 2. Rulings only the owner can give

**Safety and Telegraph**
- When the roster or blocks table can't be read, should a help request tell nobody (current) or everyone? (Q1)
- Should `heads_up` interrupt quiet hours as P0? (Q2) Should P0 pushes use high priority? (Q10) Today they use Expo's default, which Android Doze can delay. T254 is graded C on the existing rule and returns to W if "interruptive" means high priority.
- Should there be a per-sender cap on safety signals that override mutes? (Q11)
- Should the ALL CLEAR also skip archived members? Should the re-drive cover the ALL CLEAR at all (today it does, and a coalesced ALL CLEAR is settled only against an equivalent one the member already holds, else written ~60 s late)? Confirm that an SOS already answered by a later ALL CLEAR is not sent late.
- T397: six Trip pushes stay outside the notification ledger, each with a single producer. If "deduplicate by underlying causal event" means every push path goes through the ledger, T397 returns to W.
- Signals that still tell someone they are blocked: the send refusal text ("You cannot message this user" versus "Not a member of this thread"), the messages page's shape, response timing, and the /capabilities thread-existence signal.
- Rent-a-Buddy: calls are refused after a completion without mutual "stay connected", but messages never were. Should messages be refused too? (That would need a send check on the booking's state.)

**Data and product**
- Confirm the event restore rule in §1 (host-cancelled, moderator-hidden events: the hide is reversed, the host's cancellation kept).
- Events: every production hide made before this branch recorded no prior visibility, so it now holds the host off and cannot be restored by any route — those events stay invite_only until someone acts. What should a moderator "release" restore to? Should a host be able to cancel an event a moderator has hidden (it then cannot be restored)? Legacy hide-content hides wrote no record, so they do not hold. The event state-machine registry does not list the moderator-only arrows (registry shape decision).
- Events waitlist (built 2026-10-18): a freed seat now goes to the queue before walk-ins on every path. When the waitlist flag can't be read, the seat is held. Things to know or decide:
  - `events_waitlist_enabled` is seeded FALSE in the canonical migrations, but production and beta read TRUE. The background sweep now obeys the flag: on a fresh replay (CI, local) it promotes nobody, while production and beta behave as before, plus an in-app notice.
  - DELETE /waitlist and changing an event's capacity now re-check its full/open state. With the flag off they reopen a full event that has a free seat, and a lowered capacity closes an open one.
  - Not yet fixed, buildable:
    - two simultaneous passes can offer one seat to two people. Waitlist accept's "spot filled" branch then re-offers, usually to the same person (who keeps their queue position), with a fresh notice each time. A one-line fix is ready;
    - the accept route's three re-offer paths ignore the flag;
    - host approvals and a host setting someone to going don't check a seat held for the queue.
  - Your call: should the sweep also push (today it sends only the in-app notice)? Should a reconciling sweep release a seat held on an event that never changes again?
  - Built since (follow-up B3): the accept route's re-offers respect the flag, the "spot filled" re-offer loop is gone, and host approvals no longer give away a seat held for the queue. Still open: two simultaneous passes can each offer one seat (a database function would close it, needing a migration).
  - **Your call (Q-B3-1):** may a host seat someone as "going" past capacity or ahead of the queue? Today PATCH attendee status has no capacity check.
  - App gap: after an accept error the event screen does not refresh, so a withdrawn offer stays visible until the user refreshes (travel-buddy-standalone/src/hooks/useEventRsvp.ts).
- Stamps: should an admin be able to award a presence stamp with no place and no evidence? What should repair the historical completion stamps of trips nobody took (OD-1012-STAMP-4, production data)?
- MD385: should a Memory copied from a post be withdrawn when the post is soft-deleted or held for moderation?
- 3999 × 3676 (both unapplied): merging two Memories that each hold a copy of the same post photo collides with 3999's one-copy index. Either de-duplicate in 3676's merge or relax the index.
- Trips: (b) transport, subgroups and plan_scope need a new unflagged read, but the operational flag gates that batch by design. TR123/TR126: is a field row graded C when it is populated and served unflagged? TR122: a `public.places` picker.
- Input: share and invite person search — add a wider input context, or rule it graph-only? Moving MapSearchSheet onto the shared hook changes the core hook. Retiring the outage fallback changes outage behaviour. Google/place hooks fall under OD-INPUT-6. Mounting `event.description` adds opt-in AI drafts.
- Profile impressions: `post_impressions.viewed_at` is declared by no pending migration. Either drop the card or define what an impression is.
- Event-post discovery Path B: nothing writes an OSM key to `posts.location_place_id`. Keep it or remove it?
- Layover grading: Rule A.2 versus census-layover's WAVE-1 ruling (pending since wave 4). L294's last four reads change client-visible meaning.
- Place living page: the refresh hook is wired to nothing. Wiring it would make a paid AI-summary call for pages nobody views.

**Design (accessibility)**
- Trips cards: 25 components now meet WCAG AA contrast with the existing strong tokens. Two kinds of colour still need a design choice:
  - **Warning text:** `color.warn` text measures 3.08:1 on the raised card colour, in eight places across six cards. There is no AA-strength warning colour, and the contrast guard forbids adding one without a design decision.
  - **Amber in TripPlanSection:** it uses fixed amber colours, not tokens. The amber link on pale amber is 2.07:1 (line 778), and white on amber is 2.15:1 (lines 826/828).
- The guard catches a reverted fix, but not a brand-new low-contrast line in these cards. About 70 spinners, icons and outlines are graded decor and unmeasured. Measuring them all would make it a full ratchet.

**Migrations**
- **Correction (2026-10-18): new migrations do not need a band ruling.** Wave 5 claimed 3999 was the last usable number. In fact `check:migration-prefixes` accepts any unused number in 2100–2999 or 3000–3999, and apply order is plain filename order. Free ranges sit above almost every existing migration: 3826–3899, 3901–3929 and 3934–3969. A new migration may use one **only if it is order-independent of every file numbered above it**: it depends on nothing above it, AND nothing above it alters or drops what it creates or touches. A gap number is applied at its numeric position on a fresh replay (local-db, beta) but after 3999 on portava-ci and production. The production packet records what getting this wrong costs once (its README §3, "Order inversion: 2973 is re-applied"). CI exercises both orders (api-server-local-db replays the chain; live-db applies only the pending file), so the proof is a green run of both, not the number. The fixes that waited on a number are therefore buildable:
  - the SOS cross-instance double-tell index;
  - the `place_best_of.updated_at` index;
  - the SQL layer's inline block checks (`project_user_memory`, `memory_public_feed`, the `post_media_public_select` policy);
  - Map M65.
  Every new migration still needs your production press.

## 3. Production actions (the owner's press)

- **Production migration packet:** `/Users/areyouok/portava-sandbox/prod-apply-packet-20261017/` (296 migrations) plus `addendum-3996-3999/`. On a replica, the result matched a fresh canonical replay with 0 catalog differences. Run the main packet first: its 3813/3814 remove client grants on memories and memory_items.
- **What the press fixes:** of 64 production reads that fail today because their schema was never applied, the press clears 61. The table is in `docs/ops/production-unapplied-schema-reads-20261017.md`. The press also switches some paths on with no flag change: crowd live labels and the Trails surface.
- **Five new migrations, 3901–3905 (2026-10-18), to apply AFTER the packet and its 3996–3999 addendum:**
  - **3905 closes a live privacy hole.** Someone a person has blocked can today still read that person's public post photos through the direct API (PostgREST): `post_media_public_select` checks a block only in one direction. 3905 checks both directions.
  - **3901:** one help-request (SOS) notification per member per event, even with two server instances.
  - **3902:** an index for the place sweep.
  - **3903, 3904:** the memory functions use the shared block check. Their output is unchanged.
  - **Locks:** 3901 and 3902 lock their table against writes while the index builds.
  - **Order:** each is order-independent of everything numbered above it (grep evidence in the lane handback). CI's local-db and live-db jobs are their first run on a real Postgres. In-process PostgreSQL 16 (PGlite) was the proof here.
  - **Packet:** `/Users/areyouok/portava-sandbox/prod-apply-packet-20261017/addendum-3901-3905/` (guard 300g, steps 301–305, a dry run first). The guard refuses unless the main packet and the 3996–3999 addendum are applied. Rollbacks are in `db/rollback/2026-10-18-390*-rollback.sql`. Each is proven to restore the exact previous state on the replicas: PGlite 16.4, and the packet's PGlite 0.5.8 replica (PostgreSQL 18.3 compiled to WASM, in-process; no server, nothing hosted). On production, 3904's rollback restores 2338's spelling of the block predicate, not the drifted body's, so capture the definition first (README §6 (d)). **3905's rollback re-opens the block hole.**
  - **Run the dry run first.** Production's `memory_public_feed` has drifted from the repo's 2338 (packet fingerprint 91b5d7c40a75 versus e5f33a8b55cb), so 304 may refuse cleanly (nothing applied); may apply and then fail its postcondition (applied and recorded); or may apply cleanly, if the drift lies outside the predicate and the fragments 3904 checks. The feed is unaffected in all three cases: it is service-role only and its flag is off. README §6 (d) says which before anything persists. If 304 stops, dry-run 305 alone (`dry-run-305-alone.sql`), then run it alone, because 3905 is the privacy fix. The combined dry run stops at the first error, so it never reaches 305 once 304 refuses. 3905 also refuses, changing nothing, if production's policy text is not exactly 2337's; that text was never sampled.
  - **Locks:** 3901 holds a SHARE lock on `notifications` while its index builds, so every notification write waits. 3902 does the same on `place_best_of`. 3905 briefly locks `post_media`. README §6 (c) reads the table sizes before you choose a window.
- **3906 (2026-10-18), to apply after 3901–3905:** two locked functions that make the events waitlist safe under concurrency. Two passes at the same moment can no longer offer one seat to two people, and two accepts can no longer both take the last seat. Until it is applied, the routes behave exactly as today. After applying, reload PostgREST's schema cache. Once applied, a promotion with no free seat offers nobody. The docs, rollback and packet addendum for 3906 follow after its independent verification. Until it is applied, each API process sends at most one probe per function every 30 s; it fails PGRST202 (logged at info) and today's statements run. Within 30 s of applying it (no restart needed; reload PostgREST's schema cache), the next probe answers and the locked functions are used. After that, one successful probe per function per 5 min per process.
- **Not cleared by the press:** two reads of held 3601's column. They now return a stated 503.
- **Deployment:** `EXPO_PUBLIC_SUPABASE_URL` and the API's `SUPABASE_URL` must name the same project, or message images are withheld (T446, fail-closed).
- **Production defects fixed in #764 and failing today until it deploys:**
  - reviews (3 lists)
  - the admin appeals queue
  - route-plan members (silently empty)
  - event-post discovery
  - Place Day
  - the Shared Moment feed
  - the recap list
  - recap create and regenerate
  - Foursquare places
  - booking reviews
  - the place stale sweep
  - the admin Compass abuse window
  - tag suggestions

## 4. Already ruled (2026-10-17)

- Help requests are not routed to archived conversations; history is preserved; unarchive exists. Built in 6ee12e36a and bbcb7f06b.
- The place-collection refresh follows the ruling above. Built in 2495bd22f.
