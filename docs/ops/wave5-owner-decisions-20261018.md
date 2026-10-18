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
- Stamps: should an admin be able to award a presence stamp with no place and no evidence? What should repair the historical completion stamps of trips nobody took (OD-1012-STAMP-4, production data)?
- MD385: should a Memory copied from a post be withdrawn when the post is soft-deleted or held for moderation?
- 3999 × 3676 (both unapplied): merging two Memories that each hold a copy of the same post photo collides with 3999's one-copy index. Either de-duplicate in 3676's merge or relax the index.
- Trips: (b) transport, subgroups and plan_scope need a new unflagged read, but the operational flag gates that batch by design. TR123/TR126: is a field row graded C when it is populated and served unflagged? TR122: a `public.places` picker.
- Input: share and invite person search — add a wider input context, or rule it graph-only? Moving MapSearchSheet onto the shared hook changes the core hook. Retiring the outage fallback changes outage behaviour. Google/place hooks fall under OD-INPUT-6. Mounting `event.description` adds opt-in AI drafts.
- Profile impressions: `post_impressions.viewed_at` is declared by no pending migration. Either drop the card or define what an impression is.
- Event-post discovery Path B: nothing writes an OSM key to `posts.location_place_id`. Keep it or remove it?
- Layover grading: Rule A.2 versus census-layover's WAVE-1 ruling (pending since wave 4). L294's last four reads change client-visible meaning.
- Place living page: the refresh hook is wired to nothing. Wiring it would make a paid AI-summary call for pages nobody views.

**Migrations**
- **3999 is the last number in the 3000–3999 band.** The next migration needs a band ruling. Several fixes wait on one: a unique index that closes the SOS cross-instance double-tell, an index on `place_best_of.updated_at`, the SQL layer's inline block checks (`project_user_memory`, `memory_public_feed`, the `post_media_public_select` policy), and Map M65.

## 3. Production actions (the owner's press)

- **Production migration packet:** `/Users/areyouok/portava-sandbox/prod-apply-packet-20261017/` (296 migrations) plus `addendum-3996-3999/`. On a replica, the result matched a fresh canonical replay with 0 catalog differences. Run the main packet first: its 3813/3814 remove client grants on memories and memory_items.
- **What the press fixes:** of 64 production reads that fail today because their schema was never applied, the press clears 61. The table is in `docs/ops/production-unapplied-schema-reads-20261017.md`. The press also switches some paths on with no flag change: crowd live labels and the Trails surface.
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
