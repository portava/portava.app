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

## W10-R3 — candidate generation, pipeline stages, exploration, cold start, graph reading

*Lane W10-R3, 2026-09-28, branch `disc-w10-r3-candidates` from `6d1e7090b`. Census section: census-discovery §85. Every behaviour below is behind a NEW flag seeded FALSE (migrations 3480–3484), and with every one of them off `rankForViewer` is byte-identical to `6d1e7090b` (`artifacts/api-server/src/test/discoveryCandidatePipelineGolden.test.ts`). Tests use controlled data only; nothing here claims real-world effectiveness.*

### D-W10-R3-1 — Where candidate generation runs, and what eligibility a generated row passes

- **The question:** census-discovery DC-12: "2 of 11, and the tree says so about itself" (`artifacts/api-server/src/lib/discoveryRankProvenance.ts:148#* Discovery's serve path today has exactly`). `06` §2 names eleven sources. `lib/discoveryPde.ts`'s header says PDE "does NOT retrieve" (D5=B), and `routes/discovery.ts` (where the two existing reads live) is not this lane's file.
- **Options considered:**
  1. Retrieve in the route, beside the two reads. Consequence: the right place, but the route is another lane's file, so nothing could be built here.
  2. Retrieve inside `rankForViewer`, per viewer, on served runs, and materialise rows under the route's own eligibility. Consequence: every PDE serve path gains the sources with no route edit. The eligibility rules must be mirrored, and a test pins the mirror.
  3. Only claim rows already in the caller's pool. Consequence: no new candidate ever appears, so this is not generation.
- **Decision and rationale:** option 2. D5=B's reason for "does not retrieve" is Overpass's rate limit and Cache A's key (`lib/discoveryPde.ts` header). The §85 retrievals read only Portava's own tables, never Overpass, and are never written into Cache A, so neither reason applies to them. `06` §4: "Candidate caches may be user-independent. Final ranking must not be". Per-viewer sources are per-request by nature.
  - Generated rows get the eligibility `queryDbPlaces` / `queryCanonicalPlaces` apply: status, city prefix, demo sources, blocked submitter (fail closed), and submitter standing (fail closed). The lane uses the same shared helpers (`lib/blocks.ts`, `lib/discoveryCacheEligibility.ts`) and the same select lists, pinned by test M1–M3.
  - The route's post-rank gates (`applyFilters`, "Not interested", Layover) then run over them unchanged.
  - Generation runs only when the result is served (`generateCandidates ?? served`). The Map reader and shadow runs never add rows, because `lib/mapDiscoveryCandidates.ts` says a projection "can neither resurrect an object a gate removed nor add one".
  - A generated row may carry only the requested tab's category (`opts.category`). Without one, it may carry only a category the caller's pool already carries.
  - Caps: 20 ids per source, and 60 rows in all, round-robin across sources.
  - Two stated differences from a route-read row: `distanceKm` is null (PDE is not given the centre), and the vote/review aggregates (a route-private helper) are absent.
- **Reversibility:** turn `discovery_candidate_sources_enabled` off (it is seeded off). Nothing is written by generation, so nothing is lost.
- **Where it is implemented:** `lib/discoveryCandidates/{generate,retrievals,materialize,candidateSources,stages}.ts`, and the `lib/discoveryPde.ts` §85 lines. Tests: `discoveryCandidateSources.test.ts` S1–S9, M1–M3.

### D-W10-R3-2 — "current Trail" and "related Trails"

- **The question:** `06` §2 "current Trail", "related Trails". Nothing in the tree says what a viewer's *current* Trail is.
- **Options considered:**
  1. The Trails the viewer follows (`trail_follows`). Consequence: this is the only viewer↔Trail relation that is stored.
  2. The last Trail viewed. Consequence: no view event names a Trail.
- **Decision and rationale:** option 1. The same set is what `loadViewerTrailModifier` already treats as the viewer's Trails.
  - Related Trails are the `trail_edges` neighbours of those Trails, in both directions, following DV-24's "navigable means both directions" (`services/trails/TrailService.ts` `relatedTrails`).
  - Archived Trails are excluded, as `listTrails` excludes them.
  - Only `place` members become candidates. Content of other kinds is not a place candidate.
- **Reversibility:** a code change. No data is involved.
- **Where it is implemented:** `retrieveCurrentTrail` and `retrieveRelatedTrails` in `lib/discoveryCandidates/retrievals.ts`. Test: S1.

### D-W10-R3-3 — "trip destination" reads the viewer's own trip ideas, not `trips`

- **The question:** `06` §2 "trip destination". The Trips spec §25 says Discovery consumes Trip projections "rather than duplicating Trip semantics" (`lib/discoveryTripProjectionConsumer.ts` header). `TripDiscoveryProjection` carries no places.
- **Options considered:**
  1. Read `trips` for the viewer's destination. Consequence: this duplicates Trip semantics, and the request already names the destination.
  2. Read the viewer's own `trip_saved_places`: the ideas they saved, city-matched at materialisation. Consequence: these are explicit acts, per viewer, with no Trip semantics (dates, status) re-derived.
- **Decision and rationale:** option 2. The same rows' `place_type` is also a cold-start input (D-W10-R3-7).
- **Reversibility:** a code change.
- **Where it is implemented:** `retrieveTripDestination`. Tests: S1 and C5.

### D-W10-R3-4 — "social/circle context" candidates — **APPROVAL REQUIRED** (real user consent)

- **The question:** `06` §2 "social/circle context". The data exists: `circle_memberships`, and circle mates' PUBLIC Memories in `compass_graph_edges` (`experienced` / `at_place`, which the graph builder writes from `state = 'published' AND visibility = 'public'` Memories only). Circles also carry per-member visibility settings (`circle_visibility_settings`, `circle_member_visibility_overrides`).
- **Why this is not the lane's to decide:** turning one member's activity into another member's candidates is a new use of that member's data within a small, identified group. The Memory is public, but a candidate list drawn from "your circle" is a disclosure of who in the circle went where, and it would be read by exactly the people who can tell. That is a consent question, and consent is not delegated.
- **What is built, up to the decision:** `retrieveCircleContext`. It returns only places that at least **two** distinct circle mates publicly experienced, never names anyone, and adds no reason code. It runs only when BOTH `discovery_candidate_sources_enabled` and its own flag `discovery_circle_candidates_enabled` (3480, seeded FALSE) are on. Test: S6.
- **Recommended action (exact):** approve that public, published Memories of a viewer's circle mates may generate Discovery candidates for that viewer, aggregated at k ≥ 2 distinct mates, with no attribution, reason text or count shown. Then, in production:
  - `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_circle_candidates_enabled';`
  - only after `discovery_candidate_sources_enabled` is on, and after confirming that `circle_member_visibility_overrides` has no setting that should withhold a mate's public Memories from circle use. If such a setting exists, it must be honoured in `retrieveCircleContext` first.
- **Consequence of approving:** circle context becomes the tenth live §85 source.
- **Consequence of declining:** DC-12 stays at 10 of 11 live sources, and the row keeps `AWAITS OWNER APPROVAL: D-W10-R3-4`. Nothing reads circles.
- **Recovery path:** set the flag false. The retrieval writes nothing, so nothing needs to be removed.

### D-W10-R3-5 — The graph generates candidates (DV-49): co-experience, k ≥ 2

- **The question:** DV-49: the graph "does not generate candidates … it re-weights them".
- **Options considered:**
  1. `05`'s place graph through `compass_graph_edges`: from the places the viewer viewed (30 days) or saved, walk `at_place → experienced → experienced → at_place` to places the same travellers experienced. Consequence: this is a real traversal, and every edge is from a public Memory.
  2. City-level edges. Consequence: these are too coarse to name a place.
- **Decision and rationale:** option 1, with a minimum of **2** distinct travellers per returned place (`GRAPH_MIN_CO_TRAVELLERS`). This follows `05` §4: "multiple unrelated circles independently adopt the same place … more trustworthy than one dense social cluster". It also means no single traveller's path is replayed as a list. The viewer is excluded from the travellers.
- **Reversibility:** set the flag off.
- **Where it is implemented:** `retrieveGraphRelated`. Tests: S5; mutation M17 (k = 1) goes red.

### D-W10-R3-6 — Explicit exploration: the reserved inventory (DV-53, DC-11)

- **The question:** DV-53. ranker-hold-designs.md design 1 wrote it for 3370, which was never created.
- **Decision and rationale:** build design 1 as `lib/discoveryCandidates/explorationInventory.ts` behind `discovery_exploration_inventory_enabled` (3481, seeded FALSE), **outside 2289**, making these choices:
  - **Buckets.** new_creator is the author's first ACTIVE submission within 30 days. low_exposure is served impressions over 30 days ≤ the list's p25 and < its max, so a list where every count ties has no low-exposure item. emerging_place is the latest `place_momentum` run's `emerging`/`rediscovered`. new_trail is membership of a non-archived Trail created within 30 days.
  - **Relevance floor.** A member must score at or above the list's median portavaRank score (design 1's rule, adopted as written).
  - **Budget.** `clampGovernorBudget` gives 15–25%: the city-confidence budget when the modifiers are on, and otherwise the band's midpoint, 20%.
  - **Allocation.** Round-robin across the four buckets, so each is reserved a share. Within a bucket the highest score goes first, and ties go by id. Nothing is drawn at random.
  - **Slot positions.** Spread at the budget's spacing with a per-(viewer, hour) offset. A slot only promotes, and position 0 stays the ranker's.
  - **One exploration pass per page.** With the inventory on, portavaRank's random every-7th slot is off (`{ exploration: false }`) and the modifiers governor stands down.
  - `services/ranking/FeedSlotAllocator.ts` is **not edited**. The lane imports its exported band constants read-only, which keeps lane R2's DV-54 edits there conflict-free.
- **Reversibility:** set the flag off.
- **Where it is implemented:** `lib/discoveryCandidates/explorationInventory.ts`, `stages.ts`, and the `lib/discoveryPde.ts` §85 lines. Tests: `discoveryExplorationInventory.test.ts` E1–E9; mutations M3 and M4.

### D-W10-R3-7 — Cold start (DV-55)

- **The question:** `06` §9's new-user inputs. §69: "PDE reads the viewer's stated Compass interests, not the profile's onboarding answers or trip context".
- **Decision and rationale:** behind `discovery_cold_start_enabled` (3482, seeded FALSE), for a viewer below the category-observation floor (the viewer `loadPdeViewer` gives no `categoryAffinities`):
  - `profiles.interests`, `travel_style` and `travel_styles`, plus the `place_type` of the viewer's own trip ideas, are added as STATED interest tags (at most 20), lowercased.
  - They are never inferred affinities, and nothing is written back.
  - Local context is the destination the request names. With 3480 on it is also the city's trending/emerging and new-place retrievals.
  - New creator and new Trail/place are D-W10-R3-6's buckets and the exploration-pool source.
  - The profile answers were given to the product as its stated-preference input, and `06` §9 names them. Using them to rank that same user's own feed is their stated purpose, so this is not recorded as a consent question.
- **Reversibility:** set the flag off. Nothing is stored.
- **Where it is implemented:** `lib/discoveryCandidates/viewerColdStart.ts`. Tests: `discoveryColdStart.test.ts` C1–C6; mutation M5.

### D-W10-R3-8 — The integrity stage, and the hook for DV-12's detector

- **The question:** DC-11 "integrity checks". The detector is lane W10-R2's (`lib/portavaRank.ts` or `lib/ranking/*`), and those files are not this lane's. At `6d1e7090b` no such export exists.
- **Decision and rationale:** build the STAGE, and resolve the detector through `registerEngagementIntegrityDetector(fn)`. The stage is behind `discovery_integrity_stage_enabled` (3483, seeded FALSE) and sits after exploration, as `06` §1 orders it.
  - A verdict is `keep`, `discount` (sinks, stably) or `withhold` (not served on this page). It is never a reason code and never a person-level penalty (`01` §10).
  - A missing detector records `detector_absent`. A detector that throws or answers null records `detector_failed`. Neither changes anything.
- **The hook (one line, for the integrator once R2's export lands):**
  - `registerEngagementIntegrityDetector(<R2's exported detector>)`, at module load of `lib/discoveryCandidates/integrity.ts`'s importer.
  - Or replace `registeredEngagementIntegrityDetector()` in `stages.ts` with a direct import.
  - The detector signature is `EngagementIntegrityDetector` in `lib/discoveryCandidates/integrity.ts`.
- **Reversibility:** set the flag off.
- **Where it is implemented:** `lib/discoveryCandidates/integrity.ts` and `stages.ts`. Tests: `discoveryPipelineStages.test.ts` I1–I4; mutation M8.

### D-W10-R3-9 — The Compass city-confidence producer reads its corpus ordered and windowed (H-P21-4)

- **The question:** census-discovery §75.3 blockers 1 and 2, and §75.8's question to the ranker hold: "may the city-confidence reads be ordered, which moves `depth_score` above the cap?" The owner's 2026-09-28 authorisation lifts the hold for building behind a flag.
- **Decision and rationale:** behind `compass_city_confidence_windowed_reads_enabled` (3484, seeded FALSE), `computeCityConfidenceIndex` reads its four inputs through `compass/cityConfidenceWindowedReads.ts`:
  - **Order.** Newest `last_seen` / `updated_at` first, with `id` as the tie-break.
  - **Paging.** `.range()` pages of 1,000, up to 100,000 rows per read.
  - **The window.** `unbounded_start` at the computation clock when every row was read. `bounded` from the oldest row read when a read stopped at the cap, with `truncated: true`.
  - **A failed read** scores NO city on that run. The last good reading stays, the failure is logged, and the read is returned in `readErrors`. The old path scored zero.
  - **The record.** Each reading records `model_version` (`compass-city-depth-v1`), `feature_version` (`compass-city-depth-signals-v1`) and `source_window` beside `computed_at` (3484's three nullable columns). The flag ships in the same file as the columns, so it can never be on where they are absent.
  - With the flag off, the producer's reads and upsert payload are byte-identical (W0, captured at `6d1e7090b`).
  - The edits in `compass/CompassGraphEngine.ts` are at the producer's read sites only, in place and line-neutral, so no cited line moved.
  - **What moves when the flag is on:** `depth_score` (and so `tier`) for any city whose edges were beyond the old unordered 20,000-row cap. W4 shows a city read as unvisited under the cap and correctly under the flag.
- **Reversibility:** set the flag off. The next rebuild writes the old way and the columns stay NULL. The 3484 rollback drops the columns (it refuses while the flag is on).
- **Where it is implemented:** `compass/cityConfidenceWindowedReads.ts`, `compass/CompassGraphEngine.ts` (producer read sites), and migration 3484. Tests: `compassCityConfidenceWindow.test.ts` W0–W5 and `db/discoveryCandidatePipelineMigrations.db.test.ts` H2–H4; mutations M9–M11.

### D-W10-R3-10 — Learn from outcomes (DC-11)

- **The question:** DC-11: "outcomes are ingested and nothing learns".
- **Decision and rationale:** behind `discovery_outcome_learning_enabled` (3483, seeded FALSE).
  - The per-item outcome rate is computed over 30 days of served Discovery rows (`outcome <> 'analytics'`). Positive outcomes are `tap`, `save`, `join`, `rsvp`, `attended` and `trip_add`; `dismiss` counts as served with no positive.
  - The rate is smoothed toward the read's own rate (prior strength 10) and turned into a shift of at most 3 positions on DRS's order.
  - Only items with 20 or more served rows move.
  - The version is `discovery-outcome-rate-v1`, and the window is recorded on `stages.outcomeLearning`.
  - It is user-independent, like momentum. This is not a trained model, and nothing claims it improves anything; §55's instrument measures that.
- **Reversibility:** set the flag off.
- **Where it is implemented:** `lib/discoveryCandidates/outcomeLearning.ts`. Tests: L1–L3; mutations M6 and M7.

### D-W10-R3-11 — Trails, Shared Moments and emerging discoveries as ranked output kinds (DC-01)

- **The question:** DC-01. §69: Trails are listed newest-first and ranked by nothing. Shared Moments and emerging discoveries are absent.
- **Decision and rationale:** each is ranked by `rankForViewer`, the one pipeline, mapped onto `PdePlace`, behind `discovery_output_kinds_enabled` (3483, seeded FALSE).
  - **Kind.** portavaRank has no `trail` / `shared_moment` kind, and adding one is lane R2's file, so both rank as kind `place`, whose kind prior is 0 (neutral). This is recorded, not disguised.
  - **Trails:** a Trail's signals become its tags and its followers its social proof.
  - **Shared Moments:** the viewer's ACCEPTED memberships only, through the existing `loadSharedMomentCandidates`, behind the Shared Moments capability flag as well. An owner who is not active, or who is blocked in either direction, is excluded (fail closed on an unreadable block set). The consent boundary is reused, not re-decided.
  - **Emerging:** the latest run's `emerging` / `rediscovered` places, materialised under D-W10-R3-1's eligibility.
  - The rankers call `rankForViewer` with `served: false` and every §85 stage off. They write nothing, and the caller that serves a kind logs it.
  - **No route serves them.** The Trails, Shared Moments and Discovery routes are other lanes' files. The routed hunk is recorded in §85.
- **Reversibility:** set the flag off.
- **Where it is implemented:** `lib/discoveryCandidates/outputKinds.ts`. Tests: `discoveryOutputKinds.test.ts` K1–K5; mutation M16.

### D-W10-R3-12 — The served graph reading's provenance, and the platform path

- **The question:** §75.3 blocker 3: where the platform's coverage store answers, a Compass version would be false.
- **Decision and rationale:**
  - On the `compass_graph` path, PDE reads the three 3484 columns for the SAME reading (its `computed_at` must match) and records `recorded` with all four facts on `stages.graphReading.provenance` and on every scored row (`graphReadingProvenance`, `record_metadata`).
  - On the `platform_coverage` path it records `platform_producer`, and never a Compass version, because CPV2-12 says Compass never writes that store.
  - Otherwise it records `not_recorded`, `reading_moved`, `columns_absent` or `read_failed`.
  - It reads only with the 3484 flag on and the modifiers on.
- **Reversibility:** set the flag off.
- **Where it is implemented:** `lib/discoveryCandidates/graphReadingProvenance.ts`. Tests: G1–G6; mutations M13 and M15.

### D-W10-R3-13 — Production activation of 3480–3484 — **APPROVAL REQUIRED** (production activation)

- **Recommended action (exact), in this order, each only after the one before is observed healthy:**
  1. Apply `3480_discovery_candidate_sources_flag.sql`, `3481_discovery_exploration_inventory_flag.sql`, `3482_discovery_cold_start_flag.sql`, `3483_discovery_pipeline_stages_flags.sql` and `3484_compass_city_confidence_provenance.sql` to production through `scripts/src/apply-migrations.ts`. All flags stay FALSE.
  2. `compass_city_confidence_windowed_reads_enabled = true`. Wait one daily rebuild, then compare every city's `depth_score` / `tier` against the previous day's. Expect movement only for cities with more than 20,000 edges or a failed read.
  3. `discovery_candidate_sources_enabled = true`.
  4. `discovery_exploration_inventory_enabled = true`.
  5. `discovery_cold_start_enabled = true`.
  6. `discovery_outcome_learning_enabled = true`.
  7. `discovery_integrity_stage_enabled = true`, only after DV-12's detector is registered (D-W10-R3-8).
  8. `discovery_output_kinds_enabled = true`, only after a route serves a kind.
  9. `discovery_circle_candidates_enabled` only under D-W10-R3-4.
- **Consequence of approving:** the served Discovery order changes for every PDE-ranked request. New rows appear, reserved slots move rows, cold viewers are ranked with their stated interests, and a converting row may move up to 3 places. `rank_events.features` gains `candidateSources`, `explorationReserve` and `graphReadingProvenance`. The rows DC-12, DC-11 (except integrity), DV-49, DV-53 and DV-55 can then be graded on production evidence.
- **Consequence of declining:** production behaves exactly as today. The five rows stay W with `IMPLEMENTATION-COMPLETE; awaits:` markers.
- **Recovery path:** set any flag false. Its stage stops on the next flag read (30 s cache), and no stage wrote anything but the `rank_events` feature keys already written. Migration rollbacks: `db/rollback/2026-09-28-348{0..4}-*-rollback.sql`. Each refuses while its flag is TRUE.
