# Build backlog

Non-blocking defects found while building. Append; do not reorder or delete.
Format: `- [lane] file:line — what is wrong, and what the user sees.`


- [discovery] `travel-buddy-standalone/src/components/discovery/PlaceCard.tsx` — "Not interested" has no UNDO. A dismissal is permanent and viewer-scoped with no in-product way to reverse one, so a mis-tap removes a place from that person's Discovery results for good. The server side would support it directly (delete the `rank_events` row, or add a `dismiss_cleared` outcome), but WHICH of those is right is an owner decision about whether a reversal should erase the negative signal that migration 2297's RPC already counted, or leave it. Not built for that reason, not because it is hard. Stated in `lib/discoveryDismissed.ts`'s header as the cost of choosing a filter over a penalty. RE-VERIFIED 2026-10-03, and THE TWO OPTIONS THIS ENTRY OFFERED ARE NOT SYMMETRIC: one is destructive and the other is unbuildable. A dismiss is an UPDATE IN PLACE on the viewer's existing impression row (`routes/rankEvents.ts:229-232`; `upgradableOutcomesFor(DISMISS)` returns `["impression"]` at `:148`), so DELETING the row would destroy the exposure record the `content_distribution_stats` DENOMINATOR is built from — which is the exact defect migration 2297 was written to avoid (`migrations/2297_rank_events_dismiss_outcome.sql:36-44`, and `:148-149` keeps `eligible_impressions` deliberately out of the negative-signal RPC). And "erase the signal" cannot be built today: the cross-viewer counter is increment-only, there is no decrement anywhere, and `p_viewer_id` is accepted but DELIBERATELY UNUSED (`2297:115-117`), so a decrement could not be attributed to the viewer who earned it. A THIRD option, absent from this entry, is the one the data model actually supports: DOWNGRADE `outcome` back to `impression`, which keeps the exposure and withdraws the viewer-scoped suppression. It is cheaper than either recorded option because everything else a viewer would expect an undo to restore is derived at READ time and reverses for free (`lib/discoveryDismissed.ts:101`, `services/ranking/DiscoveryRankingService.ts:1544-1546` and `:1567-1570`, `migrations/3417_place_momentum_dismiss_excluded.sql:111`, `services/trails/TrailService.ts:699`). LOOP HAZARD for whoever builds it, already anticipated in the code: after an undo, a re-dismiss carries a FRESH `client_event_id`, so it is no replay at all — it passes the `!settled.duplicate` guard at `rankEvents.ts:262` and increments the cross-viewer counter a SECOND time. So the owner decision left is narrower than the entry says: not "erase or keep", but whether a downgrade may withdraw the per-viewer read while the cross-viewer numerator stands.
- [discovery] **MOOT AS A BUILD ITEM 2026-10-03 — BOTH FACTUAL CLAIMS BELOW ARE NOW FALSE.** (1) 2217 IS applied in production: `artifacts/api-server/src/lib/capability/production-applied-migrations.json:501-504` records `20260921110940` / `2217_protected_locations`, and `artifacts/api-server/src/scripts/checkProductionDrift.ts:315-318` strikes the old complaint by name. (2) Discovery DOES read it: the MapObject adapter this entry asked for exists — `artifacts/api-server/src/lib/discoverySearchProtection.ts` (`applySearchProtection` at `:156`) — and is imported by `routes/discoverySearch.ts:659`, `lib/inputAssistance/searchPage.ts:57` and `lib/inputAssistance/gateway.ts:1133`. The pass is gated by `discovery_search_protected_zones_enabled`, seeded FALSE by `migrations/3366_discovery_search_protected_zones_flag.sql:48-50`, whose own postcondition at `:67-69` REFUSES TO APPLY if the flag is already ON. Neither 3366 nor 3460 is in the applied record, so in production the flag ROW IS ABSENT and the gate fails closed — the pass does not run and search serves exactly what it served before. The empty table is not a defect either: `protected_zones` ships empty BY DESIGN and is registered as a human-curated allowlist at `artifacts/api-server/src/scripts/checkWriterlessReads.ts:180-187`; there is no writer surface and no seed anywhere in the tree. WHAT SURVIVES is narrower and is not this lane's to build: whether to seed the first `protected_zones` row, and step 1 of that is already drafted for owner approval at `docs/ops/discovery-owner-approval-request.md:280` row 5a. The original entry is preserved because its reasoning is what produced the adapter. ORIGINAL: `artifacts/api-server/src/lib/protectedLocations.ts` — census B04. Still consulted by nothing in `routes/discovery*.ts` or `lib/discovery*.ts`, and this lane owns both. NOT built deliberately: `protected_zones` (migration 2217) holds zero rows and `to_regclass` reads it as absent in production, so a Discovery protection pass would be a filter over an empty policy table — computed, surfaced nowhere, and indistinguishable from a no-op. It also needs a MapObject adapter, because `applyProtection` is typed against MapObject kinds while Discovery serves `SearchResult`/`DiscoveryPlace`. Both are real work; neither produces user-visible behaviour until the policy table has rows, which is an owner/deployment matter.
- [discovery] `artifacts/api-server/src/routes/discoverySearch.ts` — `dispatchSearch` (the bare-array form) is still what the input-assistance gateway and the `/discovery/suggest` fan-out call, so a `saved` partial reaching a person through the gateway is silent even though the coverage now exists. `dispatchSearchWithCoverage` is the form that carries it and `GET /discovery/search` uses it; moving the other callers over is per-caller work on surfaces this lane does not own end to end. Pinned as a known limitation in `dispatchSearch`'s own doc-comment rather than left to be discovered.
- [discovery] **MOOT 2026-10-03 — ANSWERED AND IMPLEMENTED; the product question this entry held open is decided.** The answer to "which five to add" is NONE OF THEM, as `rank_events.outcome` values, and each of the five has a recorded reason. `not_interested` ≡ `hide` on Discovery: one control, one token, one analytics event — `docs/architecture/discovery-decision-register.md:752-758` (D-W10-O-6). `immediate_skip` is not an outcome token at all but a figure DERIVED downstream from dwell, below `IMMEDIATE_SKIP_MAX_FOREGROUND_MS = 2000`: register `:760-766` (D-W10-O-7), implemented at `artifacts/api-server/src/lib/discoveryDwellSkip.ts:44`. `report`, `mute` and `block` must not enter the ranking vocabulary at all, per `04` §4's own safety clause, and that separation is enforced five ways in `artifacts/api-server/src/test/discoveryNegativeFeedbackSeparation.test.ts` (N1-N5); `report` is measured from `discovery_place_reports`, OUTSIDE `rank_events` (register `:807-815`, D-W10-O-11). The census records it at `docs/architecture/census-discovery.md:14716` (DV-78). THE LIVE RESIDUE IS A DIFFERENT ITEM: `immediate_skip` has no input until dwell is collected, which waits on D-W10-O-9, an owner CONSENT approval (register `:776-790`) — not on a vocabulary decision. Correct the premise too: the CHECK now admits NINE values, not eight — `artifacts/api-server/src/migrations/2894_rank_events_trip_add_outcome.sql:198-206` added `trip_add` — but `dismiss` is still the only NEGATIVE one, which is what this entry actually asserted. ORIGINAL: `artifacts/api-server/src/routes/rankEvents.ts` — `04` §4 names six negative feedback types; `rank_events.outcome` admits exactly one (`dismiss`, migration 2297). The client now sends that one and Discovery suppresses on it, so the leg is exercised rather than absent, but it is one of six. Widening the vocabulary is a migration plus a CHECK change on a table this lane does not own, and WHICH five to add is a product question (`04` §4 names them; nothing says which Discovery should surface).
- [discovery] `artifacts/api-server/src/migrations/2995_rank_events_discovery_dismissed_index.sql` — **APPLIED; THIS ENTRY'S PREMISE IS STALE, corrected 2026-10-03.** It is no longer "WRITTEN, NOT APPLIED": `production-applied-migrations.json:209-219` lists 2297, 2894 and 2995 all applied under `20260916`, in that order, so the PRECONDITION described below was satisfied rather than tripped. Nothing is owed here. ORIGINAL: WRITTEN, NOT APPLIED (the lead owns every apply). The suppression it indexes works without it — the read is correct, just unindexed — so this is a performance dependency, not a correctness one. It carries a PRECONDITION that fails loudly if 2297 has not been applied to the target database, because a partial index naming a value the outcome CHECK forbids succeeds and silently indexes nothing.
- [layover] artifacts/api-server/src/migrations/2860_layover_airport_truth_and_events.sql:155 — `airport_fact_observations` is written and NOT applied (absent from `src/lib/capability/production-applied-migrations.json`). The §10 traveller-observation surface built this pass (routes `GET`/`POST /api/airport/sessions/:id/observations`, `services/layover/LayoverObservationService.ts`, `src/components/layover/AirportConditionsCard.tsx`) is complete in code and **dark until 2860, then 2982, then 2983 are applied**. What the user sees today: the card loads, the read fails because the relation does not exist, and it renders "Reports for this airport could not be loaded" with a retry — i.e. it fails visibly and closed, not silently. Apply order is 2860 → 2982 (hard precondition, raises by name if 2860 is missing) → 2983 (independent of both).
- [layover] artifacts/api-server/src/services/airport/LayoverAirportTruth.ts:660 — `liveConditionsFrom` still has no producer, so no traveller report moves a return deadline. Wiring the new observation corpus into it is L81 and was deliberately NOT done here: it changes a SAFETY number (the buffer), and `liveConditionsFrom` can only make a deadline earlier, so the failure mode is over-conservatism rather than danger — but it is still an owner decision about whether a corroborated community queue reading may move a certified deadline, not a side effect of giving travellers somewhere to report.
- [layover] artifacts/api-server/src/routes/airport.ts — the traveller observation surface has no dedicated kill switch; it is gated only by `airport_mode_enabled`, which gates the entire layover router. Turning the report channel off in an incident therefore means turning all of Layover off. A dedicated `layover_crowd_reports_enabled` flag was considered and not added: seeding a brand-new write surface TRUE is an owner decision, and seeding it FALSE would have shipped the feature dark, which this build phase counts as not built. Owner decision either way. **CHANGED CHARACTER 2026-10-03 AND IS NOW MORE URGENT, NOT LESS — the "ships dark" half of this entry no longer exists.** 2860, 2982, 2983, 2984 and 2985 are all in `production-applied-migrations.json` now, so `airport_fact_observations` EXISTS in production and the traveller write path `POST /api/airport/sessions/:id/observations` (`routes/airport.ts:2846`) is REACHABLE THERE TODAY. Its only gate is `requireOwnedSession` (`:2362-2375`), which checks `airport_mode_enabled`, seeded TRUE by `migrations/0127_layover_system.sql:225`. So seeding a dedicated flag FALSE would now mean TURNING OFF something production can already reach, not withholding a launch — the two options this entry weighed are no longer the real ones. Being built in this branch on that reading: `migrations/3513_layover_crowd_reports_flag.sql` seeds `layover_crowd_reports_enabled` **TRUE**, with the constant at `services/layover/LayoverObservationService.ts:213` and a rollback at `db/rollback/2026-10-03-3513-layover-crowd-reports-rollback.sql` that REFUSES to delete the row while it reads TRUE. Record this item as being built on that default, not as untouched. (Before that work, the flag name appeared nowhere in the tree but this line.)
- [layover] **CLOSED 2026-09-22 (census-layover §43, §44).** The orphan component this entry named is DELETED, and the surface question it asked is answered: `GET /:id/overview` owns the safety read, because it is the call the dashboard makes and it already certifies the same record through the same `certifySessionFeasibility`. `persistDecision` is wired there, so §20's decision ledger has a producer on the live path for the first time — it previously had NONE, its only caller being the endpoint only this orphan reached. `getSessionSafety` is deliberately KEPT: it is a six-line typed fetch for an endpoint that still works, not a second derivation, and §43 cites it. **RE-VERIFIED 2026-10-03: THE DELETION THE RULING STILL OWED IS DONE, and nothing is outstanding on this row.** `travel-buddy-standalone/src/components/layover/LayoverRecommendationScreen.tsx` is absent from disk. `getSessionSafety` (`travel-buddy-standalone/src/services/layover.ts:963`) now has ZERO callers anywhere in `app/` or `src/` and is kept deliberately, exactly as §43 cites it. The dashboard `travel-buddy-standalone/app/layover/[id].tsx` absorbed the read through `GET /:id/overview`: `overview.safeReturn` is documented at `:9` and read at `:200`, and `safeEnvelope` at `:302`. Any B-section pointer to the surface question should come here rather than restate it. The original entry is preserved below because its reasoning is what produced the ruling, with its now-dangling line citation removed. ORIGINAL: still imported by nothing, and the SURFACE QUESTION THIS ENTRY ASKED IS NOW ANSWERED (census-layover §43): `GET /:id/overview` owns the safety read, because it is the call the dashboard makes and it already certifies the same record through the same `certifySessionFeasibility`. `persistDecision` is wired there, so §20's decision ledger has a producer on the live path for the first time — it previously had NONE, since its only caller was the endpoint only this orphan reached. What remains owed is the DELETION of the orphan itself, which the ruling makes safe (it is the last importer of `getSessionSafety`) and which is deliberately not bundled with a capability fix. The original entry follows, unchanged, because its reasoning is what produced the ruling. ORIGINAL: travel-buddy-standalone/src/components/layover/LayoverRecommendationScreen.tsx:1 — still imported by nothing (census headline defect 4, re-verified this pass by grep over `app/` and `src/`). Because it is the only caller of `getSessionSafety`, `GET /api/airport/sessions/:id/safety` remains dark from the app. NOT fixed here on purpose: the screen re-derives its own view of feasibility, and mounting it beside the dashboard's certified posture would reintroduce exactly the duplicate time-budget derivation censured by L2/L6 (`LayoverReturnPanel.tsx`, deleted at `a718beb5`). The fix is to decide which surface owns the safety read, not to import the orphan.
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
- [hm] `artifacts/api-server/src/routes/highlights.ts:1900#await invalidateCompassCache(` — a §11 control that
  suppresses `public_projection` (KEEP_PRIVATE_FOREVER) evicts only the SETTER's
  Compass cache. Another viewer holding a cached page still sees the Highlight
  until their own entry expires. The user sets the control, gets a 200, and the
  person they were hiding it from can still see it for the life of that cache.
  Not fixed here: evicting every follower's cache is a fan-out design, not a
  one-line change.
- [hm] `artifacts/api-server/src/services/highlights/highlightResurfacing.ts:229`
  — `HIDE_TRIP` is storable and UNENFORCEABLE. `public.highlights` carries no
  trip reference (22 columns, re-counted 2026-10-03 against the CURRENT snapshot
  pointer `lib/capability/snapshots/current.ts:106` →
  `20260922-production-schema.json`, whose `tables.highlights` holds 22 columns
  and none naming a trip — the earlier `20260915` pointer in this entry was
  stale), so the feed withholds the owner's WHOLE proactive surface rather than
  one trip. The suppression is real: `routes/highlights.ts:300-307` logs the
  unenforceable control and `return []`s, withholding the owner's entire
  proactive feed when it cannot resolve a trip. Census H90. Fixing it needs a
  trip column on `highlights` or a join table; both are owner decisions.

  CORRECTED 2026-10-03 — **"the client renders the warning, so nobody is
  misled" WAS WRONG ON BOTH HALVES, and the correction LOWERS this item's
  urgency rather than raising it.** The warning component does exist
  (`travel-buddy-standalone/src/features/highlights/HighlightPrivacySheet.tsx:337-344`),
  but it is UNREACHABLE for `HIDE_TRIP`: the sheet renders
  `highlightScopedControls(controls)` (`:292`), which filters the catalogue to
  `scope === 'highlight'` (`privacyControlsApi.ts:282-285`), and `HIDE_TRIP` is
  `scope: 'trip'` (`services/highlights/highlightResurfacing.ts:186-189`). That
  exclusion is asserted DELIBERATELY at
  `travel-buddy-standalone/src/features/highlights/__tests__/HighlightPrivacySheet.component.test.tsx:97`,
  and the warning test at `:152-167` demonstrates the warning with an
  artificially-flagged `DO_NOT_RESURFACE` instead. No client surface sets
  `HIDE_TRIP` at all. So the over-suppression is API-ONLY and NOT USER-REACHABLE
  TODAY: nobody is being misled, because nobody can turn it on from the app.
  Whoever builds the trip-scoped control must build the warning WITH it, because
  the warning it would need is the one currently filtered out of the sheet.
- [hm] `artifacts/api-server/src/services/memory/memorySearchService.ts:154#export const UNREACHABLE_NAMESPACES` —
  SHARED_CREW is unreachable from `POST /memories/search`. `TripMemoryProjection`
  and `PeopleMemoryProjection` are derived per OWNER, so a crew-wide search must
  union one derivative per member and decide what a revoked or departed member's
  derivative means. Product decision; census H113's remaining ceiling.

  CLOSED IN THIS BRANCH — recorded 2026-10-05 at integration, because the change
  that closed it did not say so here. SHARED_CREW is now reachable from the
  search surface
  (`artifacts/api-server/src/services/memory/memorySearchService.ts:138#"SHARED_CREW",`),
  and the product question this entry held open — what a revoked member's
  derivative means in a crew-wide union — is answered in code at
  `artifacts/api-server/src/services/memory/memorySearchService.ts:192#export const CREW_UNION_PARTIAL_POLICY`.
  The `:110` above is left as written: it named a comment in the tree this entry
  was filed against, and that comment has since been rewritten. Whether census
  H113 moves is a grading question for the Highlights & Memories census, not
  settled by this note.
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
  otherwise. Census H171/H172.

  CORRECTED 2026-10-03, twice over. **The premise sentence "no embedding backend
  exists in this repository" is wrong as written**: an OpenAI client IS a
  production dependency of this exact package — `artifacts/api-server/package.json:293`
  (`"openai": "^6.44.0"`, under `dependencies`) — with a shared singleton at
  `artifacts/api-server/src/lib/openai.ts` (29 lines) and live callers at
  `services/compass/CompassIntentClassifier.ts:26`,
  `services/airport/LayoverCompassService.ts:54` and
  `server/trips/integrationAdapters/reservationExtract.ts:17`. The narrower
  truths, which are the ones to carry forward: no `.embeddings.create` call
  exists anywhere in the tree; the gateway named by
  `AI_INTEGRATIONS_OPENAI_BASE_URL` is documented as NOT OpenAI
  (`docs/architecture/census-layover.md:5571-5573`), so its support for an
  embeddings endpoint is UNVERIFIED rather than absent; and this repository
  cannot tell whether the key is set in production at all
  (`docs/architecture/census-highlights-memories.md:1682-1685`).

  **And the provider was never the real blocker.** `ProjectionDefinition.build`
  is SYNCHRONOUS and pure (`services/memoryProjections/projectionRegistry.ts:133-149`;
  the file contains no `async`, no `await` and no `Promise`), so a network call
  cannot be made inside it at all. `SearchEmbedding`'s `field_whitelist` is
  `["memory_id","namespace"]` (`:451`) with no vector column. And the declared
  destinations `search.embeddings` (`:450`) and `narrative.summaries` (`:466`)
  DO NOT EXIST: no `CREATE SCHEMA`, no pgvector, no `vector(...)` column and no
  ivfflat/hnsw index anywhere in `migrations/`. So "needs a backend decision,
  not code" is backwards — it needs a schema, an async projection contract and a
  destination, and then a provider. `NarrativeDerivative` has a second blocker
  that is a POLICY CONTRACT rather than a credential: §1 forbids AI
  manufacturing historical facts (`:461`, the reason string itself) and
  `census-highlights-memories.md:1484` (H265/§28.16) requires original voice and
  original-language text be preserved through any summary.

  Citation fixed: these entries are in
  `artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts`
  (`SearchEmbedding` at `:443`, its `NOT_CONFIGURED` at `:445`,
  `NarrativeDerivative` at `:457`), NOT in
  `domain/telegraph/projections/projectionRegistry.ts`, which is a different
  180-line file.
- [hm] `artifacts/api-server/src/routes/memories.ts:2707` — `GET
  /memories/:id`'s sibling reads in `routes/highlights.ts` still discard
  `viewedRows`, `avatar_url` and `profileRows` on the two proactive feeds
  (census §O.4's own "what this did NOT find"). Engagement and identity, not
  history, so they degrade rather than refuse — but the failure is still
  unlogged.
- [hm] **RECLASSIFIED 2026-10-03: this was never a product decision, it is a
  DOCUMENTATION DEFECT, and it is FIXED.** It does not belong among the items
  blocked on an owner decision, because the behaviour is built, consistent, and
  has one answer the spec simply failed to write down: PINNED is DERIVED from
  `pinned_at` and is never stored. `DELETE /highlights/:id/pin` dispatches
  `UNPIN_HIGHLIGHT` at `artifacts/api-server/src/routes/highlights.ts:1682`,
  with the legacy path writing `{ pinned_at: null }` at `:1700`;
  `services/highlights/highlightLifecycle.ts:325` returns
  `{ provenance: "derived", state: "PINNED", from: "pinned_at" }`;
  `migrations/2993_highlight_command_boundary.sql:455-461` states outright "No
  lifecycle_state is WRITTEN here"; `highlights.lifecycle_state` is nullable
  with no DEFAULT (`2723_highlight_class_lifecycle_and_pin.sql:106`) and NULL on
  every row ever written; and the client toggle is wired at
  `travel-buddy-standalone/src/components/HighlightViewer.tsx:356-380`, setting
  its local state from the SERVER's answer and never optimistically. So there is
  no contradiction to arbitrate — §5's missing `PINNED → ACTIVE` edge is
  correct, because nothing has to be undone when nothing was stored.

  FIXED in the spec on 2026-10-03, with the minimum two in-place edits, both
  marked there as a consistency correction recording built behaviour:
  `docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:134`
  (§3's field list no longer declares PINNED as a stored `lifecycle_state`
  value, and names it a derived presentation state) and `:509` (§17's
  `highlight.pinned` records that it carries `command_type` and the resulting
  `pinned` boolean, which is what `routes/highlights.ts:1701-1704` already
  emits, so no `highlight.unpinned` is owed). §5's diagram at `:213-217` was
  DELIBERATELY LEFT ALONE: adding a `PINNED → ACTIVE` edge is the same
  resolution drawn the other way round, but it would entrench a stored state
  the code never writes, and only the field list could be wrong at the source.
  Both edits are line-count-neutral on purpose — `src/test/memoryCertificationFixtures.test.ts`
  asserts spec lines 644-655 by exact line number, and ten other files cite this
  spec by line. STILL OUTSTANDING: the owner's one-word ratification ("PINNED is
  derived — yes?"), noted in the spec at both edit sites.
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
- [telegraph] `artifacts/api-server/src/domain/telegraph/projections/projectionRegistry.ts:143#id: "PRJ-06"`
  — PRJ-06's note says the content drawer is "dead-coded behind a literal
  false". It is NOT, at HEAD: `travel-buddy-standalone/app/messages/[id].tsx:1919`
  mounts `onPress={() => setShowContentDrawer(true)}` on the header, and `GET
  /threads/:id/drawer` serves it. The registry's `status: "absent"` and
  census-telegraph T294's evidence are both stale on that clause.

  RE-VERIFIED 2026-10-03 — **BUILDABLE, NOT BLOCKED, and now BUILT in this
  branch**: `domain/telegraph/projections/projectionRegistry.ts` grades PRJ-06
  `status: "partial"` (`:146`) instead of `absent`, and
  `scripts/TELEGRAPH_OBSERVABILITY_BASELINE.json` is lowered 4 → 3 in the same
  change, with the re-grade argued in its `//absentProjections` note. Two
  corrections to this entry on the way there. (1) The line drifted: the mount is
  at `:1919` (re-read 2026-10-06 on lane T2's merged tree), not the `:1964` this entry recorded. (2) Soften one claim — the
  mount is not literally UNCONDITIONAL. It sits inside `{!compact && (…)}` at
  `:1892`, which
  is a header LAYOUT VARIANT, not a flag and not a dead-code gate; the drawer is
  reachable on the normal header and absent only on the compact one. PRJ-06's
  "literal false" is still wrong, which is what this entry was for.

  And the reason given for not changing it DOES NOT HOLD, corrected 2026-10-03:
  **there is no repo policy reserving `scripts/TELEGRAPH_OBSERVABILITY_BASELINE.json`
  to the lead.** `CONTRIBUTING.md`, `docs/ci/README.md` and
  `.agents/memory/MEMORY.md` are all silent on that file — none of them mentions
  it. Precedent runs the other way: `docs/architecture/census-telegraph.md:5553-5558`
  records the `unmeasuredSlos` ratchet being lowered 12 → 11 by the BUILDING
  lane in the same commit as the improvement, because `check:telegraph-slos`
  refused the improvement until the baseline moved; and the baseline's own header
  says the number may only FALL, which is a shrink-only ratchet any lane may
  shrink and no lane may raise. The `absentProjections` pin this entry cites is
  real and is at `:9` of that file — it read 3 on 2026-10-03 and reads 0 after lane T2's merge (below).
  "A ratchet the lead owns" was not. Re-grading census-telegraph T294 remains a
  census verdict this lane does not move.

  MERGED 2026-10-06 (lane T2 merging main `94c6bb4ed3`, on the lead's ruling):
  lane T2's branch had moved PRJ-06 to `status: "built"` on 2026-10-05; main's
  `partial` stands — an on-demand route that answers is not a materialised
  index. census-telegraph §45e moves T294 back to W. The `absentProjections`
  count is what the merged tree measures with `check:telegraph-slos`: 0 absent
  (PRJ-03 built; PRJ-01, -02, -04, -05 and -06 partial).
- [telegraph] `travel-buddy-standalone/src/features/telegraph/voice/voiceApi.ts`
  — a voice upload that succeeds followed by a send that fails leaves the
  uploaded audio object in `post-media`, unreferenced by any message. This is
  the SAME behaviour the photo/video path has had since it was built
  (`POST /api/media/upload` then `POST /threads/:id/media`), so voice inherits a
  defect rather than introducing one; it is recorded rather than quietly
  matched. A fix needs an orphan sweep keyed on storage path, which no surface
  in this repository has.
- [telegraph] §6.3's "optional transcript/translation" for VOICE is NOT built.
  A nullable `transcript` field was deliberately NOT added to `VoicePayload`
  because nothing would ever write it; the place it would go is already marked,
  in `artifacts/api-server/src/services/telegraph/voice.ts:29-37`, together with
  the note that `searchableTextOf` already reads `payload.text`-shaped fields.

  CORRECTED 2026-10-03, on two points. (1) **This entry overstated the spec
  gap.** §6.4 (`docs/specs/Portava_Telegraph_Design_Architecture_Developer_Spec_v1_1.txt:134-136`)
  requires a VOICE tab and that object-aware search respect current
  authorization and unsent/deleted state. It NEVER requires voice to be
  text-searchable. Both of its requirements are already MET:
  `services/telegraph/messageKinds.ts:328` routes VOICE to the tab, and
  `searchableTextOf` (`:371-406`) returns null on `deleted_at`/`unsent_at` at
  `:379-382`. The transcript is asked for by §6.3's OPTIONAL clause at `:131`
  instead — so a voice note not being findable is NOT a §6.4 violation, as this
  entry implied, and nothing is owed to §6.4 here. (2) "No speech-to-text
  provider configured in or reachable from this tree" is wrong as written, for
  the same reason as the `SearchEmbedding` entry above: an OpenAI client is a
  production dependency (`artifacts/api-server/package.json:293`, singleton at
  `src/lib/openai.ts`, three live callers). The narrower truths: no
  `.audio.transcriptions` call exists anywhere in the tree; the gateway named by
  `AI_INTEGRATIONS_OPENAI_BASE_URL` is documented as NOT OpenAI
  (`docs/architecture/census-layover.md:5571-5573`), so its support for a
  transcription endpoint is UNVERIFIED rather than absent; and the repository
  cannot tell whether the key is set in production
  (`docs/architecture/census-highlights-memories.md:1682-1685`).
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

- [integration] `artifacts/api-server/src/routes/telegraphKinds.ts:73` — the
  typed-message route ACCEPTS `replyToId` in its request schema (`:74`, not the
  `:72` this entry first recorded — corrected 2026-10-03) and never writes
  it. A client that sends a typed kind as a reply gets a 201 and a message that
  is not a reply; the quote it drew in the composer is simply gone on reload.
  Silent acceptance of a field with no effect is the failure mode here, not the
  missing feature: either write `reply_to_id` (behind the same in-thread check
  the other two send paths now apply) or reject the field by name. Not fixed in
  this merge.

  **FIXED IN THIS BRANCH 2026-10-03 — the second option this entry offered was
  taken: `replyToId` is now REFUSED BY NAME on the typed path.** It is gone from
  `TypedMessageSchema` (`routes/telegraphKinds.ts:69-73`) and an explicitly
  supplied non-null `replyToId` is answered `invalid_payload` with a message the
  caller can act on (`:204-215`), the reasoning written out at `:182-203`. An
  explicit `null` is the absence of a reply, not a request for one, and is not
  refused. The silent acceptance is closed; a client that sends a typed kind as
  a reply now learns so instead of getting a 201 and a non-reply.

  REFRAMED 2026-10-03 — **the reason this entry recorded for deferring was the
  wrong question**, and the refusal note in the code now records the right one. It
  is not "what does a reply to a typed kind render as in the drawer": the DRAWER
  IS REPLY-BLIND BY CONSTRUCTION. `DRAWER_COLUMNS` (`routes/telegraphKinds.ts:105`)
  does not select `reply_to_id`, and `DrawerRow` (`:108-119`) has no reply field
  at all, so no §6.4 decision is waiting on anything. Replies render in the
  THREAD read (`routes/messaging.ts:2436-2512`), which emits `replyToId`,
  `replyToBody` and `replyToSenderName` at `:2587-2592`, and that path is
  `msg_type`-agnostic — it would carry a typed reply today without a line
  changing. The REAL coupling: a typed message's `body` is
  `JSON.stringify(input.envelope)` in the one envelope writer
  (`services/telegraph/threadEnvelopeWrites.ts:131`) and the thread
  read's quote builder copies a replied-to body VERBATIM (`messaging.ts:2504`),
  so persisting `reply_to_id` on the typed path would quote a raw JSON envelope
  into the thread. That is a display question on the THREAD READ, not a §6.4
  drawer question — which is why the refusal above was the cheap half and the
  remaining work is an envelope-aware quote renderer, a separate decision rather
  than a blocked one.

  (Line citations in `routes/telegraphKinds.ts` are as of 2026-10-03 on this
  branch; that file is being changed by more than one lane this pass, and
  `DRAWER_COLUMNS` / `DrawerRow` above are at `:106` and `:109-120` at the
  moment of writing. Repointed 2026-10-06 when main was merged into the T1
  Telegraph-core branch, which moved the typed insert into
  `writeThreadEnvelope` and shifted this file by one line: the citations in
  the two paragraphs above now name the merged tree.)

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
  `TripCrewLocationService.ts:151` builds `allUserIds` with
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
