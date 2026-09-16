# Build backlog

Non-blocking defects found while building. Append; do not reorder or delete.
Format: `- [lane] file:line — what is wrong, and what the user sees.`


- [discovery] `travel-buddy-standalone/src/components/discovery/PlaceCard.tsx` — "Not interested" has no UNDO. A dismissal is permanent and viewer-scoped with no in-product way to reverse one, so a mis-tap removes a place from that person's Discovery results for good. The server side would support it directly (delete the `rank_events` row, or add a `dismiss_cleared` outcome), but WHICH of those is right is an owner decision about whether a reversal should erase the negative signal that migration 2297's RPC already counted, or leave it. Not built for that reason, not because it is hard. Stated in `lib/discoveryDismissed.ts`'s header as the cost of choosing a filter over a penalty.
- [discovery] `artifacts/api-server/src/lib/protectedLocations.ts` — census B04. Still consulted by nothing in `routes/discovery*.ts` or `lib/discovery*.ts`, and this lane owns both. NOT built deliberately: `protected_zones` (migration 2217) holds zero rows and `to_regclass` reads it as absent in production, so a Discovery protection pass would be a filter over an empty policy table — computed, surfaced nowhere, and indistinguishable from a no-op. It also needs a MapObject adapter, because `applyProtection` is typed against MapObject kinds while Discovery serves `SearchResult`/`DiscoveryPlace`. Both are real work; neither produces user-visible behaviour until the policy table has rows, which is an owner/deployment matter.
- [discovery] `artifacts/api-server/src/routes/discoverySearch.ts` — `dispatchSearch` (the bare-array form) is still what the input-assistance gateway and the `/discovery/suggest` fan-out call, so a `saved` partial reaching a person through the gateway is silent even though the coverage now exists. `dispatchSearchWithCoverage` is the form that carries it and `GET /discovery/search` uses it; moving the other callers over is per-caller work on surfaces this lane does not own end to end. Pinned as a known limitation in `dispatchSearch`'s own doc-comment rather than left to be discovered.
- [discovery] `artifacts/api-server/src/routes/rankEvents.ts` — `04` §4 names six negative feedback types; `rank_events.outcome` admits exactly one (`dismiss`, migration 2297). The client now sends that one and Discovery suppresses on it, so the leg is exercised rather than absent, but it is one of six. Widening the vocabulary is a migration plus a CHECK change on a table this lane does not own, and WHICH five to add is a product question (`04` §4 names them; nothing says which Discovery should surface).
- [discovery] `artifacts/api-server/src/migrations/2995_rank_events_discovery_dismissed_index.sql` — WRITTEN, NOT APPLIED (the lead owns every apply). The suppression it indexes works without it — the read is correct, just unindexed — so this is a performance dependency, not a correctness one. It carries a PRECONDITION that fails loudly if 2297 has not been applied to the target database, because a partial index naming a value the outcome CHECK forbids succeeds and silently indexes nothing.
- [layover] artifacts/api-server/src/migrations/2860_layover_airport_truth_and_events.sql:155 — `airport_fact_observations` is written and NOT applied (absent from `src/lib/capability/production-applied-migrations.json`). The §10 traveller-observation surface built this pass (routes `GET`/`POST /api/airport/sessions/:id/observations`, `services/layover/LayoverObservationService.ts`, `src/components/layover/AirportConditionsCard.tsx`) is complete in code and **dark until 2860, then 2982, then 2983 are applied**. What the user sees today: the card loads, the read fails because the relation does not exist, and it renders "Reports for this airport could not be loaded" with a retry — i.e. it fails visibly and closed, not silently. Apply order is 2860 → 2982 (hard precondition, raises by name if 2860 is missing) → 2983 (independent of both).
- [layover] artifacts/api-server/src/services/airport/LayoverAirportTruth.ts:660 — `liveConditionsFrom` still has no producer, so no traveller report moves a return deadline. Wiring the new observation corpus into it is L81 and was deliberately NOT done here: it changes a SAFETY number (the buffer), and `liveConditionsFrom` can only make a deadline earlier, so the failure mode is over-conservatism rather than danger — but it is still an owner decision about whether a corroborated community queue reading may move a certified deadline, not a side effect of giving travellers somewhere to report.
- [layover] artifacts/api-server/src/routes/airport.ts — the traveller observation surface has no dedicated kill switch; it is gated only by `airport_mode_enabled`, which gates the entire layover router. Turning the report channel off in an incident therefore means turning all of Layover off. A dedicated `layover_crowd_reports_enabled` flag was considered and not added: seeding a brand-new write surface TRUE is an owner decision, and seeding it FALSE would have shipped the feature dark, which this build phase counts as not built. Owner decision either way.
- [layover] travel-buddy-standalone/src/components/layover/LayoverRecommendationScreen.tsx:1 — still imported by nothing (census headline defect 4, re-verified this pass by grep over `app/` and `src/`). Because it is the only caller of `getSessionSafety`, `GET /api/airport/sessions/:id/safety` remains dark from the app. NOT fixed here on purpose: the screen re-derives its own view of feasibility, and mounting it beside the dashboard's certified posture would reintroduce exactly the duplicate time-budget derivation censured by L2/L6 (`LayoverReturnPanel.tsx`, deleted at `a718beb5`). The fix is to decide which surface owns the safety read, not to import the orphan.
- [layover] artifacts/api-server/src/services/airport/LayoverSessionService.ts — `emitEvent` logs a rejected `layover_events` insert as a non-fatal warning. That is right for an audit row, but it means any event type missing from the `event_type` CHECK produces a feature that looks built and audits nothing, and `check:enum-literals` cannot see it because the literal is passed as an ARGUMENT to `emitLayoverEvent` rather than written into an `.insert({ event_type: … })` object (verified: the check reports clean with an unregistered literal in the tree). Migration 2983 adds the one value this pass needed; the blind spot in the guard remains.
- [layover] artifacts/api-server/src/migrations/2984_layover_crews.sql:1 — `layover_crews` and `layover_crew_members` are new in this pass and NOT applied. The §14 crew surface (`GET`/`POST /api/airport/sessions/:id/crew`, `…/crew/:crewId/join`, `…/crew/leave`, `services/layover/LayoverCrewStore.ts`, `src/components/layover/LayoverCrewSection.tsx`) is complete in code and dark until 2984 and 2985 are applied. Both are independent of each other and of 2860/2982/2983. What the user sees before they are applied: the crew card renders "Your crew could not be loaded" with a retry — visible and closed, not a silent empty crew.
- [layover] artifacts/api-server/src/migrations/2984_layover_crews.sql — L196 ("presence/crew tables with restrictive policies and EXPIRATION JOBS") is only half closed by this pass. The tables and the restrictive policies exist (RLS on, no policy, no client grant), the expiration JOB does not: `layover_crews.expires_at` is a read FILTER, so an unswept crew is invisible rather than stale-but-live, but nothing deletes the row. There is no scheduler anywhere in this tree — L196 already records that `expireOldSessions` is called inline from two GET handlers. L196 stays N.
- [layover] artifacts/api-server/src/routes/airport.ts — a crew has no ITINERARY of its own, so `certifyCrewPlan` is called with the empty unsplit plan (one branch, everybody, no stops). That answers "can this group be together, and when must they all be back", which is `sharedReturnBy`, and it is the honest thing to publish before anyone has proposed a stop — but it means §14.1's per-branch feasibility and the explicit SPLIT plan are built, reachable and never exercised by a real plan. A crew itinerary (propose stops, assign branches) is the next build on this row; L131's "shared chat" half belongs to Telegraph's threads and should not become a second message store here.
- [layover] artifacts/api-server/src/services/airport/LayoverCrewService.ts:331 — the location-precision ladder (`LOCATION_PRECISIONS`, `evaluateCrewLocationShare`, `locationPrecisionFor`) is fully built and has no grant store, so L124 ("Crew member map element — only with explicit temporary location permission") and L132 stay N. 2984 deliberately ships NO coordinate column and asserts their absence in a postcondition: a place to put a position must not exist before the thing that decides whether it may be shown. Building the grant store is the prerequisite, not the map pin.
- [layover] docs/architecture/census-layover.md + census-highlights-memories.md — BLOCKING, LEAD ACTION REQUIRED, NOT FIXED HERE. This lane's commits shifted line numbers in `routes/airport.ts`, `LayoverSessionService.ts` and `app/layover/[id].tsx`, so 58 `path:line#anchor` citations in those two census docs no longer resolve and `src/test/docCitations.test.ts` is RED. Every one of them resolved at base `c8862df2c` — this is rot this lane caused, not pre-existing rot. It is NOT repaired here for one reason: the census docs are lead-owned AND all four build lanes are shifting lines in the same shared files, so four independent repointings would collide in the lead's files. Repointing must happen ONCE, after integration. The deterministic procedure: build a `difflib` opcode line-map from the base blob to the integrated tree per source file, map each cited line through it, and VERIFY the anchor is present at the mapped line before accepting. Do NOT repoint by occurrence-index of the anchor — generic anchors (`#const`, `#async`, `#function`, `#if`, `#}`) make that wrong, and it was measured doing so: two anchors sharing base line 1753 of `routes/airport.ts` were sent to two different new lines. Verified end to end on this tree before being reverted: the 42-entry map repointed 58 citations and took `docCitations.test.ts` to 43/43, 0 failures.
- [layover] docs/architecture/telegraph-phase0-inventory.md — TOUCHED OUTSIDE THIS LANE, deliberately and disclosed. This machine-generated inventory records "31 of N migration files" and a per-route-file declaration count; this lane's 4 migrations and 6 routes moved N from 553 to 557 and `src/routes/airport.ts` from 37 to 43 route declarations. `check:telegraph-inventory` runs the generator with `--check` and FAILS when the committed report no longer matches the tree, so leaving it stale would have shipped a red required check. Regenerated and committed; the check passes ("194 inventory lines re-derived and identical"). The telegraph lane will regenerate it again when its own routes land — the conflict, if any, is resolved by re-running `pnpm --filter @workspace/api-server run telegraph:inventory`, not by hand.
- [layover] artifacts/api-server/src/test/guardReachability.test.ts:69 — went red in a full-suite run with `duration_ms: 180149` and `actual: null` against `expected: 0`, which is a subprocess killed at the 180s timeout reading as an assertion failure — the exact load-trap signature `docs/handoff-background-work-determinism.md` records. RE-RUN ALONE IT PASSES: 25 tests, 25 pass, 0 fail, 0 `not ok` at any depth, 106s. Not a defect in this lane's changes and not a defect in that guard; recorded so the next lane that sees it does not spend the afternoon this one nearly did.
- [layover] SHIFT TABLE for the lead, superseding the "compute it yourself" half of this lane's earlier citation entry. Base `c8862df2c` -> head. Per file: base lines, head lines, net, then each moved region as `@<base line>:<delta>` (a citation at or after that base line moves by the cumulative delta at that point). `artifacts/api-server/src/routes/airport.ts` 3422->4108 net +686: @15:+2, @79:+5, @82:+17, @83:+12, @2561:+650. `artifacts/api-server/src/services/airport/LayoverSessionService.ts` 527->570 net +43: @396:+43. `travel-buddy-standalone/app/layover/[id].tsx` 734->759 net +25: @53:+1, @59:+1, @78:+5, @148:+1, @502:+6, @584:+11. `artifacts/api-server/src/test/layoverFeasibilityRecord.test.ts` 622->636 net +14: @416:+14. No layout was contorted to protect a pointer: the observation routes and the crew routes sit together at the natural seam before `PATCH /sessions/:id/share`, and `readSessionsByIds` sits beside `listSessions`, which is where a session reader belongs. 58 citations in `census-layover.md` and `census-highlights-memories.md` are affected; repointing them took `docCitations.test.ts` from RED to 43/43 on this tree before being reverted.
- [layover] artifacts/api-server/src/services/layover/LayoverObservationService.ts:49 — a comment citing the anonymous sensing store by name broke `src/test/sensingAnonStore.test.ts` ("the files that mention the store are EXACTLY the two allowlists"). The guard matches the BARE IDENTIFIER, so naming that module inside a comment is enough to join the set it contains — a reference-surface guard cannot tell a comment from an import. FIXED BY REWORDING, NOT BY ALLOWLISTING: adding this file to `PERMITTED_MENTIONS` would have widened a privacy-containment allowlist to keep a citation, which is the trade the build contract forbids. The argument the comment makes (why the observation handle does NOT rotate on an epoch) survives without the name. Worth knowing for any lane that cites a contained module as precedent — and note the first repair still failed, because the replacement paragraph named the guard's own test file, which contains the same identifier.
- [layover] artifacts/api-server/src/test/wallPerformance.test.ts:549 — SECOND load-trap casualty, and a far more deceptive one than the guardReachability timeout. In a full-suite run under contention it fails with `the first page now waits on ~140 serialized database round trips, over the recorded ratchet of 110. Something new is awaited in a loop.` That message reads as a STRUCTURAL finding — it names a cause, points at a loop, and invites a hunt for the await someone just added. It is not structural: run alone the same test passes 6/6 with **~92** and **~88** round trips (two independent runs) against the same ratchet of 110, with 0 `not ok` at any depth. The counter observes real await ordering, so work that normally overlaps gets serialized under load and inflates the count by ~50%. Nothing in this lane touches the Wall first page. Recorded because the failure text is actively misleading: a lane that trusts it will go looking for a loop that does not exist, and the honest check is to re-run the file alone and read the round-trip number rather than the sentence.
- [hm] `artifacts/api-server/src/routes/highlights.ts:1081` — a §11 control that
  suppresses `public_projection` (KEEP_PRIVATE_FOREVER) evicts only the SETTER's
  Compass cache. Another viewer holding a cached page still sees the Highlight
  until their own entry expires. The user sets the control, gets a 200, and the
  person they were hiding it from can still see it for the life of that cache.
  Not fixed here: evicting every follower's cache is a fan-out design, not a
  one-line change.
- [hm] `artifacts/api-server/src/services/highlights/highlightResurfacing.ts:229`
  — `HIDE_TRIP` is storable and UNENFORCEABLE. `public.highlights` carries no
  trip reference (22 columns, snapshot `20260915`), so the feed withholds the
  owner's WHOLE proactive surface rather than one trip. `GET
  /highlights/resurfacing-controls` now names it in `unenforceableOnFeed` and the
  client renders the warning, so nobody is misled — but a user who turns it on
  loses more than they asked for. Census H90. Fixing it needs a trip column on
  `highlights` or a join table; both are owner decisions.
- [hm] `artifacts/api-server/src/services/memory/memorySearchService.ts:110` —
  SHARED_CREW is unreachable from `POST /memories/search`. `TripMemoryProjection`
  and `PeopleMemoryProjection` are derived per OWNER, so a crew-wide search must
  union one derivative per member and decide what a revoked or departed member's
  derivative means. Product decision; census H113's remaining ceiling.
- [hm] `artifacts/api-server/src/routes/highlights.ts` — the SQL expiry
  predicate is defence in depth only. Mutation C (replace `NOT_EXPIRED` with a
  predicate that matches everything) SURVIVED all 26 assertions in
  `highlightLifetimeAndPin.test.ts`, because `isHighlightActive` filters expired
  rows app-side on all three surfaces. The SQL filter is kept and is worth
  keeping — it bounds the fetched set and is the only guard a future read that
  forgets the app-side check would have — but no test currently fails if it
  regresses.
- [hm] `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts:443`
  and `:457` — `SearchEmbedding` and `NarrativeDerivative` are `NOT_CONFIGURED`
  with honest reasons (no embedding backend, no narrator). `POST /memories/search`
  reports `semanticIndex: "none"` on every response so no client can imply
  otherwise. Census H171/H172; needs a backend decision, not code.
- [hm] `artifacts/api-server/src/routes/memories.ts:2599` — `GET
  /memories/:id`'s sibling reads in `routes/highlights.ts` still discard
  `viewedRows`, `avatar_url` and `profileRows` on the two proactive feeds
  (census §O.4's own "what this did NOT find"). Engagement and identity, not
  history, so they degrade rather than refuse — but the failure is still
  unlogged.
- [hm] §5 and §17 disagree about UNPIN. §5's lifecycle has no `PINNED → ACTIVE`
  edge, so a stored `lifecycle_state = 'PINNED'` could never be undone; §17's
  command list names `UNPIN_HIGHLIGHT`, which says it must be. `POST/DELETE
  /highlights/:id/pin` writes only `pinned_at` and derives PINNED from it, which
  sidesteps the contradiction without resolving it. An owner should say which
  half of the spec wins.
- [hm] `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` —
  `check:census-freshness` reports `census-highlights-memories.md` STALE. Four
  counted files this lane created or changed are unnamed in the acknowledgement:
  `lib/highlightPermissions.ts`, `services/highlights/highlightControlWrites.ts`,
  `services/highlights/highlightRanking.ts`,
  `services/memory/memorySearchService.ts`. LEAD DECISION, deliberately not
  silenced here: an acknowledgement must argue the change cannot have moved a
  verdict, and these changes move verdicts — that is what the lane was for. The
  census wants re-measuring, which the build phase pauses.
- [hm] `docs/architecture/trust-unproduced-vocabulary.md:145` — pre-existing and
  NOT this lane's: the citation `routes/events.ts:3473` resolves ambiguously
  across three copies of that file in the tree
  (`artifacts/…`, `files/artifacts/…`, `portava-stamp-wave2-files/artifacts/…`),
  so `check:doc-citations` exits 1 with `total findings 1` even at
  `broken anchors 0`. Neither file is in this lane's diff.

## telegraph lane — 2026-09-16

- [telegraph] `artifacts/api-server/src/lib/mediaProcessing.ts:62` — `sniffMedia`
  classifies ANY ISO-BMFF `ftyp` box that is not HEIC or QuickTime as
  `video/mp4`, including an audio-only `M4A `/`M4B ` file. Nothing reaches that
  today (the general allowlist admits no audio MIME, so an m4a can only be
  declared as `video/mp4`, and `verifyUploadedBytes` then agrees with the lie
  rather than catching it). The user-visible consequence if it is ever reached:
  an audio file stored as a post/memory/story VIDEO, rendering as a black frame.
  Not fixed here because narrowing `sniffMedia` touches every media surface and
  this lane owns none of them. The fix is now cheap and does not need inventing:
  `isoTrackHandlers` (same file, added for voice) returns every track's handler
  type, so `sniffMedia`'s MP4 branch can answer `image`/`video`/neither from the
  tracks instead of from the `ftyp` brand.
- [telegraph] `artifacts/api-server/src/domain/telegraph/projections/projectionRegistry.ts:119`
  — PRJ-06's note says the content drawer is "dead-coded behind a literal
  false". It is NOT, at HEAD: `travel-buddy-standalone/app/messages/[id].tsx:1964`
  mounts an unconditional `onPress={() => setShowContentDrawer(true)}` on the
  header, and `GET /threads/:id/drawer` serves it. The registry's `status:
  "absent"` and census-telegraph T294's evidence are both stale on that clause.
  NOT changed here: flipping PRJ-06 would move an absent-projection count that
  `scripts/TELEGRAPH_OBSERVABILITY_BASELINE.json:9` pins at 4, which is a
  ratchet the lead owns, and re-grading T294 is a census verdict this lane does
  not move.
- [telegraph] `travel-buddy-standalone/src/features/telegraph/voice/voiceApi.ts`
  — a voice upload that succeeds followed by a send that fails leaves the
  uploaded audio object in `post-media`, unreferenced by any message. This is
  the SAME behaviour the photo/video path has had since it was built
  (`POST /api/media/upload` then `POST /threads/:id/media`), so voice inherits a
  defect rather than introducing one; it is recorded rather than quietly
  matched. A fix needs an orphan sweep keyed on storage path, which no surface
  in this repository has.
- [telegraph] §6.3's "optional transcript/translation" for VOICE is NOT built,
  and the blocker is an owner/infrastructure decision, not code: there is no
  speech-to-text provider configured in or reachable from this tree. A nullable
  `transcript` field was deliberately NOT added to `VoicePayload`
  (`artifacts/api-server/src/services/telegraph/voice.ts`) because nothing would
  ever write it. Consequence today: a voice note is not findable by §6.4's
  object-aware search, and `searchableTextOf` returns null for it — which is
  correct, and is asserted, rather than indexing a URL.
- [telegraph] The VOICE upload endpoint's TRANSPORT has no test —
  `artifacts/api-server/src/routes/telegraphVoice.ts`'s bounded body reader, its
  `guardUploadRequest` call and its storage write. Its POLICY is fully tested in
  `src/test/telegraphVoice.test.ts`. Found by a mutation that survived: bypassing
  the upload route's `if (!guard.ok)` leaves the suite at 38/38.
- [telegraph] `artifacts/api-server/src/routes/telegraphKinds.ts#toDrawerRow` — a
  VOICE row reaches §6.4's VOICE drawer tab and is counted there, but its `title`
  is null, so the drawer draws the literal `voice` as the row's label. The cause
  is that `toDrawerRow` derives the DISPLAY title from `searchableTextOf`, which
  for a voice note is correctly null (no transcript; indexing its URL would make
  a search for "m4a" return conversations). Display text and search text are two
  different questions and one function is answering both. The fix is a display
  title for VOICE — its duration as `m:ss` — taken from `media_duration_seconds`
  rather than from the search predicate. Cosmetic: the tab, the counts and the
  asset all work.

## integrating lane — 2026-09-16

- [integration] `artifacts/api-server/src/routes/telegraphKinds.ts:72` — the
  typed-message route ACCEPTS `replyToId` in its request schema and never writes
  it. A client that sends a typed kind as a reply gets a 201 and a message that
  is not a reply; the quote it drew in the composer is simply gone on reload.
  Silent acceptance of a field with no effect is the failure mode here, not the
  missing feature: either write `reply_to_id` (behind the same in-thread check
  the other two send paths now apply) or reject the field by name. Not fixed in
  this merge because writing it means deciding what a reply to a typed kind
  renders as in the drawer, which is a §6.4 question this lane did not own.

  SUPERSEDES an earlier entry here that claimed `routes/messaging.ts` accepted
  `reply_to_id` without checking the thread. IT DOES CHECK — `messaging.ts:2761`,
  fail-closed, 503 when the check cannot run and 400 when the reference is
  genuinely cross-thread — and has since it was built. The real gap was the
  voice route, which was added without it and is FIXED in this merge
  (`routes/telegraphVoice.ts`, red-first in `src/test/telegraphVoice.test.ts`),
  together with a defence-in-depth `thread_id` predicate on the quoted-context
  read in `messaging.ts`.

- [integration] `artifacts/api-server/src/domain/trips/projections/TripPulseCrewPresence.ts:45`
  — the Pulse's `crew_presence` source can NEVER produce an observation, on any
  trip, and reports `status: "ok"` while doing so. Found by the date-sweep lane,
  confirmed here by reading both halves rather than on report.

  The contradiction is structural, not a typo.
  `TripCrewLocationService.ts:127` builds `allUserIds` with
  `.filter((id) => id !== viewerId && ...)` and every subsequent query is
  `.in("user_id", allUserIds)`, so `map.members` CANNOT contain the viewer, by
  design — it is a map of other people. `readCrewPresenceForPulse` then does
  `map.members.find((m) => m.userId === viewerId)`, which is therefore always
  null, so `viewerPoint` is always null, so `if (... || !viewerPoint) continue`
  skips every member and `n` stays 0.

  Two details make it clear this is a misread contract rather than dead code the
  author knew about: the loop carries an `if (m.userId === viewerId) continue`
  guard, which only makes sense if the viewer were expected IN `members`; and
  the return already carries `detail: "the viewer has no position; distance to
  crew cannot be judged"` for a case the author evidently thought occasional.

  What a person sees: the Pulse's "friend nearby" signal never fires, for
  anyone, ever. Nothing is wrong on screen — the signal is simply absent, which
  is indistinguishable from "no crewmate is near you right now".

  NOT FIXED HERE, and the reason is that the cheap fix is the wrong one.
  Reporting `status: "no_source"` instead of `"ok"` would make the wire honest
  in one line, but it would also freeze the feature as permanently unavailable
  and retire a signal the Pulse is supposed to carry. The real fix is to source
  the viewer's own position — the same `trip_crew_location_sessions` read
  `getCrewMap` already performs for everybody else — and that is a Trips-lane
  decision about where a viewer's own point belongs, not an integration call to
  make inside a verification pass. Whoever takes it should note that
  `readCrewPresenceForPulse` is the ONLY caller that needs the viewer included;
  widening `getCrewMap` itself would hand every other caller a self-entry they
  currently rely on not having.
