# Discovery decision register

Owner authorisation, 2026-09-28. These instructions come from the owner:

- The 2026-08-15 ranker implementation hold is lifted. The held designs may be built and tested behind flags seeded FALSE.
- Routine architecture and product decisions are to be made from the specifications, recorded here, and implemented.
- Four kinds of decision are NOT delegated:
  - real user consent;
  - financial obligations (rates, payouts, commercial terms);
  - data-retention policy;
  - production activation (production migrations, deploys, flags turned on in production).

  For each of those this register carries an exact recommended action and a specific approval request. Nothing is chosen silently.

Each lane appends its own `## <lane> — <topic>` section and never edits another lane's section. An entry has:

- **Decision id:** `D-<lane>-<n>`.
- **The question:** quoted from the census section or spec that raised it, with a citation.
- **Options considered:** each with its consequence.
- **Decision and rationale:** with spec citations.
- **Reversibility:** how to undo it, and whether anything is lost.
- **Where it is implemented:** file references, plus the tests that pin it.

An entry that needs owner approval is marked **APPROVAL REQUIRED**. It gives the recommended action with exact values, the consequence of approving, the consequence of declining, and the recovery path.

## W10-S2 — Cross-architecture adapters and product rules

Lane W10-S2, 2026-09-28, branch `disc-w10-s2-crossarch`. Census section §81. Migrations 3465–3469, each seeded OFF and applied to no shared database. Every "built" below is code and controlled tests on this branch; none of it is production evidence.

### D-W10S2-1 — Layover consumers read the certified snapshot (A13, D-4)

- **The question.** §56.9 Q2 (`docs/architecture/census-discovery.md` §56.9): *"Should `answerLayoverQuestion` read `usableMinutes` off the certified record (or the snapshot) instead of re-deriving it from `cutoffMs − now − totalBuffer`, and should Trips, Map, Safe Return and `LayoverRecommendationService` consume `certifiedLayoverSnapshot` rather than calling `certifySessionFeasibility` themselves?"* §65.8 adds the buddy gate and the replanner.
- **Options considered.**
  1. Keep inline certification over the same inputs and rule that it satisfies the spec (§65.6's second path). Cheapest; leaves two certifications per request possible and the Compass minutes a second derivation.
  2. Every consumer surface reads the snapshot; counterfactual certifications stay on the engine. One certification per request; the Compass minutes change early in a layover.
  3. Move counterfactuals onto the snapshot too. Impossible without inventing snapshot inputs (live conditions, a flipped session) that the snapshot does not carry.
- **Decision and rationale.** Option 2. Layover `:66` — *"All surfaces consume the same certified LayoverSnapshot / RecommendationContract; no duplicate time-budget logic"* — and `:803` — *"One canonical LayoverSnapshot drives Trips, Compass, Discovery, Map and Safe Return"* (`docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt`). A surface publishes a figure about the traveller's CURRENT layover, so it reads the snapshot. A counterfactual (Compass §12.1 flips, Safe Return's post-disruption `after`, the replanner's before/after under an event's live conditions, the crew wrapper for other travellers) asks about a session that is not the current one, which no snapshot of the current one can answer; those stay on the engine and are enumerated. The snapshot gains a `loaded` option so a route that already holds the session and airport does not read them twice.
- **Reversibility.** Flag `layover_snapshot_consumers_enabled` (3465, FALSE). OFF, every consumer takes its legacy arm, byte-identical. Nothing is stored differently, so nothing is lost either way.
- **Where it is implemented.** `artifacts/api-server/src/services/airport/LayoverSnapshot.ts` (`consumerLayoverSnapshot`, `consumerLayoverRecord`, the `loaded` option); `routes/airport.ts` (/safety, /return-now, /disruption, /return-deadline, /overview, /stops, /compass, /buddies); `LayoverCompassService.ts`, `LayoverBuddyGate.ts`, `LayoverSafeReturnService.ts`, `LayoverRecommendationService.ts`, `LayoverNotificationService.ts`. Tests: `src/test/layoverSnapshotConsumers.test.ts` (C1 ratchet, C2 parity on eight routes in two worlds, C3 Compass minutes, C4–C6); `layoverRouteSafetyInputs.test.ts` L256 guard restated.

### D-W10S2-2 — The Gems "How long is your layover?" tab stays (A14, D-4)

- **The question.** §56.9 Q3: *"Is the Gems screen's 'How long is your layover?' tab — a traveller in no layover browsing gems by a hypothetical duration — a product surface to keep?"*
- **Options considered.** Keep it (a planning surface for a traveller not yet in a layover); or answer only a live certified layover (removes a shipped planning tab).
- **Decision and rationale.** Keep. Layover §25 governs Discovery *"in Layover mode"*; a traveller with no live layover is not in Layover mode, and §56.2 already makes a live layover's figure the snapshot's and ignores the query figure. The tab plans; it certifies nothing. No code change.
- **Reversibility.** Removing the tab later is a client change plus refusing the stated figure in `lib/discoveryLayoverGems.ts`; nothing is stored.
- **Where it is implemented.** Unchanged: `artifacts/api-server/src/lib/discoveryLayoverGems.ts` (`layoverGemWindow`), pinned by `discoveryLayoverGems.test.ts`.

### D-W10S2-3 — A dwell source with provenance (A14, D-4)

- **The question.** §37.5 item 2 and §56.14: *"A dwell source with real provenance — a duration column, or a derived figure carrying a source class and confidence … Not a category average."*
- **Options considered.** (a) A category default — the fabrication §37 and the Layover lane deleted. (b) A figure derived from other travellers' plan stops — a use of their itineraries they never agreed to (a consent question). (c) A curated per-place figure stated by someone accountable for it, with source class, confidence and evidence.
- **Decision and rationale.** (c). Two source classes only: `venue_stated` and `curator_measured`; bounds 5–720 minutes, `layover_plan_stops.duration_min`'s own CHECK. A traveller's own stop supersedes a curated figure. A curated figure fills only the ACTIVITY term; the journey still has to be measured (routed port or the traveller's stop), so admission is unchanged wherever travel is unmeasured.
- **Reversibility.** Flag `layover_place_dwell_enabled` (3465, FALSE). Table `layover_place_dwell` (3466) has a rollback; its rows are administrators' statements and are lost on drop (the rollback reports the count first).
- **Where it is implemented.** `services/airport/LayoverPlaceDwell.ts`; `lib/discoveryLayoverTiming.ts` (three line-neutral edits: the source and absence vocabulary, and the activity term; a file outside this lane's list, changed minimally); `routes/airport.ts` admin `PUT/DELETE /admin/airport/place-dwell/:placeId`. Tests: `src/test/layoverPlaceDwell.test.ts` (W1–W8).

### D-W10S2-4 — Trips publishes the plan-item and viewer next-trip projections (A10, E-7)

- **The question.** §57.10 Q3: *"Will Trips publish a viewer-scoped 'next trip' projection for Discovery's `?context=going_soon`, and should it count `upcoming` trips and trips the viewer has joined?"*; and §69.2 A10: Trips publishes no plan-item projection.
- **Options considered.** Keep Discovery's reader (owned, `planning`/`active`); or Trips' own definition (owned or accepted-member, `planning`/`upcoming`/`active`).
- **Decision and rationale.** Trips publishes both projections, and the next trip counts `upcoming` and joined trips. Trips `:25`, `:488`: *"Map, Compass, Discovery… consume explicit Trip projections/contracts rather than duplicating Trip semantics"* (`docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt`). `upcoming` is the storage label for a trip ahead of the traveller; an accepted member's trip is theirs on every other Trip surface (`requireTripMember`). The plan-item projection states the one Trip rule the read carried (`removed_at IS NULL`); visibility stays the parent trip's.
- **Reversibility.** Flag `discovery_trip_viewer_projections_enabled` (3467, FALSE). OFF, both direct reads are served byte-identically.
- **Where it is implemented.** `domain/trips/contracts/tripViewerProjections.ts`; `lib/discoveryTripViewerConsumer.ts`; the read sites `lib/inputAssistance/searchCandidates.ts` (the `trip_plan_items` statement only, in place) and `services/location/DiscoveryLocationContext.ts` (`getNextTripCity`). Tests: `src/test/discoveryTripViewerProjections.test.ts` (V1–V6); `discoveryTripReadInventory.test.ts` unchanged and green.

### D-W10S2-5 — Telegraph registers a Discovery-object action (A21, D-5)

- **The question.** §56.9 Q4: *"Should the actions a Telegraph rich card offers on a shared Discovery place … become executable Telegraph actions (tap → command → Discovery authorization and write, §30A.11) registered under domain `discovery`, or stay direct calls to their owning domains outside `TELEGRAPH_ACTION_REGISTRY`?"*
- **Options considered.** Leave direct client calls (Telegraph never authorizes or previews them); register every card action under `discovery`; register the one action whose canonical write is Discovery's.
- **Decision and rationale.** Register Save as `discovery_save_place` under domain `discovery`. Telegraph `:607`: *"Every executable Telegraph action registers authorize, preview, execute, and optional compensate behavior. Telegraph orchestrates; … Discovery … retain[s] canonical business truth"*; `:610`: *"Rich-card actions follow tap -> command -> owning domain authorization/write"*; `:608`: *"Action buttons are derived from current capabilities"* (`docs/specs/Portava_Telegraph_Design_Architecture_Developer_Spec_v1_1.txt`). The write goes through Discovery's own save path, extracted from `POST /api/wishlist` into `services/discovery/DiscoveryWishlistSave.ts` so both doors use one writer. Add to Plan / ADD_TO_TRIP is a Trips write and is already Trips' registration (`add_to_plan`); MEET_HERE, SHARE_PLACE, DO_THIS_NOW are coordination messages whose write is Telegraph's own. Those stay with their owners.
- **Reversibility.** Flag `telegraph_discovery_actions_enabled` (3467, FALSE); OFF the command is `feature_disabled` and authorize refuses. Compensate removes only a save the action created.
- **Where it is implemented.** `services/telegraph/actionRegistry.ts`, `routes/telegraphCommands.ts` (`POST /telegraph/commands/discovery-card`, the canonical-failure path), `services/discovery/DiscoveryWishlistSave.ts`, `routes/wishlist.ts` (line-neutral delegation; outside this lane's list). Tests: `src/test/telegraphDiscoveryAction.test.ts` (T1–T7); `telegraphCommandRoute.test.ts` exhaustiveness still green.

### D-W10S2-6 — The abandoned-upload sweep's rule (DV-77, D-5)

- **The question.** §56.9 Q5: *"May the abandoned-upload sweep run unattended … including a resumable video its owner is still sending? If yes, are one hour, 200 per pass and hourly the numbers?"*
- **Options considered.** Keep one hour from reservation (sweeps a slot whose signed URL is still live, and a resumable upload in progress); a longer fixed age (arbitrary); an activity rule derived from the upload authority's own lifetime.
- **Decision and rationale.** A pending slot is abandoned only when no upload can still land in it under an authority the server issued: its latest activity — reservation, a resumable session's renewal (stamped before part URLs are minted), or its newest part's write — is older than a signed upload URL's lifetime (storage-js: *"They are valid for 2 hours"*) plus 30 minutes for a PUT authorized at that URL's last valid instant (the largest single object, 100 MiB, at 0.5 Mbit/s is about 28 minutes). An owner still sending is therefore never swept. 200 a pass and hourly bound latency and cadence, not what is deleted, and stay. Phase 0.4: *"no raw unstripped original can persist merely because a completion handler never runs"* (`docs/specs/discovery-architecture-v1/discovery-v1-12-implementation-plan.md:28#Redesign durable ingest so no raw unstripped original can persist`). Whether the sweep RUNS in production is D-W10S2-16.
- **Reversibility.** Constants in one file; the session's renewal stamp is an `updated_at` write on the user's own pending row.
- **Where it is implemented.** `services/media/PendingUploadSweep.ts` (the rule, `latestSlotActivityMs`, `renewPendingSlot`); `routes/postcardMediaTransport.ts` (renew before mint; outside this lane's list, one line); `routes/postcards.ts` (a stale comment, one line). Tests: `src/test/mediaPendingUploadRule.test.ts` (R1–R8); `mediaPendingUploadSweep.test.ts` unchanged and green.

### D-W10S2-7 — The dead free-time arms are deleted (A11)

- **The question.** §57.10 Q4: *"`portavaRank.availabilityFitScore`'s `availableMinutes` / `availableNow` arms have no caller that sets either field. Delete them under the hold, or keep them for a Temporal Freedom consumer that would supply windows instead?"*
- **Options considered.** Keep them for a future consumer; delete them.
- **Decision and rationale.** Delete. Trips `:185`: consumers *"consume these [Temporal Freedom] windows rather than independently calculating 'free time'"*. A scalar minute budget is exactly that independent calculation, and a future consumer has `TripFreedomConsumers.fitInstantToWindows`. The hold is lifted. `lib/portavaRank.ts` is not this lane's file, so the deletion is a routed hunk (census §81.4); until it lands a ratchet keeps the arms unfed.
- **Reversibility.** A deleted optional field and two branches; restorable from history.
- **Where it is implemented.** Routed hunk in census §81. Test: `src/test/discoveryFreeTimeRetirement.test.ts` (F1 ratchet; F2 turns red when the hunk lands).

### D-W10S2-8 — Tagging Phase 0 #5–#7 and `approval_required` (DV-76, D-10)

- **The question.** §62.7 Q2: *"Tagging Phase 0 items #5, #6 and #7 appear in no document, test or commit. What were they?"*; Q3: *"Should approval_required be added to the enum and the settings UI, or is the pending path to be removed?"*
- **Options considered.** For #5–#7: wait indefinitely for a list nobody holds; fold them into another list; close the catalogue as it exists. For `approval_required`: remove the pending path; make it reachable as a new, opt-in choice.
- **Decision and rationale.** #5–#7 are closed as retired numbers: the implementation plan's criterion is *"other catalogued Phase 0 findings"* (`docs/specs/discovery-architecture-v1/discovery-v1-12-implementation-plan.md:25#other catalogued Phase 0 findings`), and the catalogue (`docs/security/phase0-tagging-privacy-state.md`) records no finding under those numbers in any artifact or commit. The catalogue is therefore #1–#4, #8, Finding 16, and the three defects §62/§63 found (client DML on `tags` — 3422; the route tagging a `nobody` user; an unknown value allowing), all fixed. `approval_required` is kept and made reachable: Phase 0.3 names *"pending tag visibility"*, which presupposes a pending state, and choosing "Ask me first" is a new choice a user makes for themselves — nobody's existing setting changes, so it is not a consent change. What was missing is added: the enum value, the PATCH accepting it, and the tagged user's approve route (reject is the existing DELETE).
- **Reversibility.** Flag `tag_permission_approval_required_enabled` (3468, FALSE). The enum value's rollback refuses while any user holds it.
- **Where it is implemented.** `artifacts/api-server/src/migrations/3468_tag_permission_approval_required.sql`; `routes/tags.ts` (PATCH schema under the flag, `POST /api/tags/:id/approve`). The client settings option is a routed hunk (census §81.4). Tests: `src/test/tagPermissionApprovalRequired.test.ts` (Q1, Q3–Q5).

### D-W10S2-9 — What `interacted` and `friends_only` mean — **APPROVAL REQUIRED** (DV-76, D-10, consent)

- **The question.** §63.7 Q5: *"The settings copy says 'People I've interacted with — Only people you've followed or messaged' and 'Friends & circle members — Only mutual follows and circle members'. The server reads these three ways … Which definitions are the product's, and should circle membership and a message thread count?"*
- **Why this is not decided here.** Users chose these settings against that copy. Any definition changes who may tag a user who already chose, so it is a consent question. The copy is also not ordered: a circle member is admitted by "Friends & circle members" and not by "People I've interacted with", so no reading can honour the copy word for word and keep the scale ordered.
- **Recommended action, exact values.** Adopt the copy as the definition, read fail-closed where the server cannot yet observe an arm: `interacted` = the tagged user follows the tagger, or they share a direct message thread; `friends_only` = a mutual follow, or a shared circle membership; and amend the `interacted` copy to "…followed, messaged, or share a circle with" so the scale is ordered. Turn ON `tag_permission_consent_copy_enabled` (3468) once the two unobserved arms are built; until then the flag's reading (built) is the fail-closed subset: `interacted` = the tagged user follows the tagger; `friends_only` = a mutual follow.
- **Consequence of approving.** A follower whom the user never followed can no longer tag them under "interacted"; a friend who is not a mutual follower can no longer tag under "friends_only"; mutual followers who are not friends can. POST /api/tags only; no shipped client calls it (§63.2).
- **Consequence of declining.** The engine's reading stays (a follow either way or a friendship; an accepted friendship), which admits people the copy does not name.
- **Recovery path.** Turn the flag OFF; the engine's reading returns on the next request. Nothing is stored.
- **Where it is built.** `services/interactionPermissions.ts` (`tagDefinitions: "consent_copy"`, two line-neutral switch arms), `routes/tags.ts`. Test: `src/test/tagPermissionApprovalRequired.test.ts` Q2.

### D-W10S2-10 — The graph decay rule (DV-51, D-6)

- **The question.** §56.9 Q6: *"What is the decay rule for a graph edge — the function of the age of its latest support (with its frequency, diversity and confirmed experiences) that sets its strength, the constant or constants in that function per edge type, and the strength below which an edge is retired — and may a rebuild retire an edge whose source rows it did not read?"*
- **Options considered.** Keep weight = count (the permanent score §6 forbids); retire what a capped build did not write (unsound, §56.6); a graded rule over the four named inputs, judged on complete anchored support.
- **Decision and rationale.** `05` §6: *"Use derived strength from: recency, frequency, diversity, confirmed experiences. Do not store 'relationship truth' as a single permanent score"*; §9: *"it can decay stale relationships"* (`docs/specs/discovery-architecture-v1/discovery-v1-05-graph-engine.md:92#as a single permanent score.`, `docs/specs/discovery-architecture-v1/discovery-v1-05-graph-engine.md:124#it can decay stale relationships,`). strength = (log2(1 + d) + ½·log2(f/d)) × 2^(−age/H), with f = observed count, d = distinct UTC days, age = days since the latest support. H is set by confirmation: 365 days for an edge supported by a confirmed experience (presence stamps, public Memories, trips taken, outcomes `went`/`stayed`/`made_memory`/`returned`) — one seasonal cycle, the period the world model buckets by; 14 days for an intent edge (`behavior:*`, outcomes `viewed`/`saved`/`liked`/`invited`) — the repository's existing activity half-life (`ranking.activity.decayHalfLifeDays`). Structural edges (a trip's owner and destination, an event's city, host and vibe, a circle's owner and city, an experience's own edges) are object attributes and do not decay. Retire below 1/8: one observation after three half-lives. The last clause is answered NO by construction: decay is judged inside §67's reconcile on complete anchored support; an undecided edge keeps its stored weight.
- **Reversibility.** Flag `compass_graph_decay_enabled` (3469, FALSE). OFF: weight = count, byte-identical. A retired stale edge returns on the next rebuild if new support arrives; its old weight is not restored (it was a count, which `observed_count` still carries on every surviving edge).
- **Where it is implemented.** `compass/CompassGraphEngine.ts` (appended rule; line-neutral hooks in the batch, build, replay and reconcile). Tests: `src/test/compassGraphDecay.test.ts` (D0–D7); `compassGraphRevocation.test.ts` unchanged and green.

### D-W10S2-11 — Switching to "Nobody" and existing tags — **APPROVAL REQUIRED** (DV-76, D-10, consent)

- **The question.** §63.7 Q6: *"When a user switches to 'Nobody', tags that already exist stay approved and visible; the setting binds only new tags. Should the switch also hide or remove existing tags of that user, or is that the tagged user's per-tag DELETE /api/tags/:id?"*
- **Why this is not decided here.** The copy the user chose says only *"Your name won't appear in @ suggestions"* (`TAG_PERMISSION_OPTIONS`). Hiding existing tags goes beyond what they were told, and it also changes content other people published. That is a consent question.
- **Recommended action, exact values.** Make the switch retroactive by HIDING, not deleting: at render (`lib/enrichSpans.ts`), a tag whose tagged user's current `tag_permission` is `nobody` is not rendered; switching away restores it. Amend the "Nobody" copy to "Nobody can tag you; existing tags of you are hidden". Build it behind a new FALSE flag in the render path's owner lane.
- **Consequence of approving.** Existing tags of users who chose Nobody stop rendering; reversible by switching back.
- **Consequence of declining.** The setting binds new tags only; a user removes an existing tag with DELETE /api/tags/:id.
- **Recovery path.** Turn the render flag OFF; nothing is deleted.
- **Where it is built.** Not built: the only enforcement point is `lib/enrichSpans.ts`, another lane's render path, and a write-side hide would be irreversible. Recorded in census §81.4.

### D-W10S2-12 — Activate the Layover consumers on the snapshot — **APPROVAL REQUIRED** (A13, production activation)

- **Recommended action.** Apply 3465 to production; set `layover_snapshot_consumers_enabled = TRUE`.
- **Consequence of approving.** One certification per Layover request; the in-layover Compass answer states the envelope's usable minutes, which early in a layover (before the exit delay has elapsed) is fewer than it states today. Every other surface publishes the same record.
- **Consequence of declining.** Consumers keep certifying inline over the same inputs; A13 stays W.
- **Recovery path.** Set the flag FALSE; the legacy arms answer on the next request.

### D-W10S2-13 — Activate Layover mode with the dwell source — **APPROVAL REQUIRED** (A14, production activation)

- **Recommended action.** Apply 3465 and 3466; curate `layover_place_dwell` rows through the admin route; set `layover_discovery_mode_enabled = TRUE` and `layover_place_dwell_enabled = TRUE`. A place nobody planned is admitted only with a measured journey, which needs `LAYOVER_ROUTED_CORRIDOR_ENABLED` and `GOOGLE_MAPS_API_KEY` (a spend decision, E-6).
- **Consequence of approving.** A traveller in a live layover sees on Discovery only places the certified universe admits.
- **Consequence of declining.** Discovery ignores the layover; A14 stays W.
- **Recovery path.** Set either flag FALSE.

### D-W10S2-14 — Activate Discovery's reads of the Trip projections — **APPROVAL REQUIRED** (A10, production activation)

- **Recommended action.** Apply 2420 (after 2334 → 2337, as §6 D3 orders) and 3467; set `discovery_trip_projection_enabled` (2550) and `discovery_trip_viewer_projections_enabled` TRUE.
- **Consequence of approving.** Discovery reads no Trip table directly; `going_soon` counts upcoming and joined trips; trip search sees what the trip page shows a non-member.
- **Consequence of declining.** The legacy reads stay; A10 stays W.
- **Recovery path.** Set the flags FALSE.

### D-W10S2-15 — Activate the Telegraph Discovery action — **APPROVAL REQUIRED** (A21, production activation)

- **Recommended action.** Apply 3467; ship the client hunk (census §81.4); set `telegraph_discovery_actions_enabled = TRUE`.
- **Consequence of approving.** A shared card's Save is authorized, previewed, executed and compensable through Telegraph.
- **Consequence of declining.** The card keeps saving directly; A21 stays W.
- **Recovery path.** Set the flag FALSE; commands answer `feature_disabled`.

### D-W10S2-16 — Turn on the abandoned-upload sweep — **APPROVAL REQUIRED** (DV-77, production activation; deletes user uploads)

- **Recommended action.** Apply 3400 and 3467; set `media_pending_upload_sweep_enabled = TRUE`. Before: `SELECT count(*), min(created_at) FROM public.post_media WHERE processing_status = 'pending' AND greatest(created_at, updated_at) < now() - interval '150 minutes';`.
- **Consequence of approving.** Every postcard upload with no activity for 2 h 30 whose completion never ran is removed (object, variants, parts, poster, row) within one further hour; no unstripped original persists indefinitely.
- **Consequence of declining.** Abandoned unstripped originals persist in `post-media` (never served to anyone but their owner, §56.5); DV-77 stays W.
- **Recovery path.** Set the flag FALSE; the next pass does nothing. Deleted uploads are not recoverable: they were never completed and never visible.

### D-W10S2-17 — Apply 3422 and activate "Ask me first" — **APPROVAL REQUIRED** (DV-76, production activation)

- **Recommended action.** Apply 3422 (as §62.6 orders) and 3468; set `tag_permission_approval_required_enabled = TRUE` once the client option ships.
- **Consequence of approving.** Clients cannot write `tags`; a user may choose "Ask me first" and approve pending tags.
- **Consequence of declining.** DV-76 stays W on 3422.
- **Recovery path.** 3422's and 3468's rollbacks; the flag OFF.

### D-W10S2-18 — Activate graph decay — **APPROVAL REQUIRED** (DV-51, production activation)

- **Recommended action.** Apply 3469; set `compass_graph_decay_enabled = TRUE`. Before: `SELECT edge_type, count(*), min(last_seen) FROM public.compass_graph_edges GROUP BY edge_type;` to size the first run's retirements.
- **Consequence of approving.** Intent edges older than about six weeks and presence edges older than about three years leave the graph on the next rebuild; surviving weights become derived strengths.
- **Consequence of declining.** Weights stay counts; DV-51 stays W.
- **Recovery path.** Set the flag FALSE; the next rebuild writes counts again. Retired edges return only with new support.

### D-W10S2-19 — Activate Temporal Freedom windows for Discovery — **APPROVAL REQUIRED** (A11, production activation)

- **Recommended action.** Apply 2760–2785; set `trip_operational_projections_enabled` (2778) TRUE; land D-W10S2-7's routed deletion.
- **Consequence of approving.** Discovery's trip-scoped search fits candidates to the trip's freedom windows.
- **Consequence of declining.** A11 stays W.
- **Recovery path.** Set 2778 FALSE.
