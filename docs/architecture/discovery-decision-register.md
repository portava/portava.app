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

## W10-D — rollout, portava-ci apply and the owner approval pack

*Lane W10-D, 2026-09-28, branch `disc-w10-d-rollout` from `debd5ad4f`. Census section §83. The documents: `docs/ops/discovery-portava-ci-apply-plan.md`, `docs/ops/discovery-production-rollout.md`, `docs/ops/discovery-owner-approval-request.md`.*

### D-W10D-1 — Q66-3: a pre-merge `portava-ci` apply plus a green `schema drift` run is the CI rehearsal

- **The question:** census §66.9 Q66-3, whether the owner requires the `portava-ci` rehearsal before merge, and what counts as it. `12` names the class *"CI rehearsal"* (`docs/specs/discovery-v1/12_Claude_Code_Implementation.md:189#- CI rehearsal`); `10` §7 says *"rehearse on `portava-ci`"* and *"production rollout only after CI rehearsal"* (`docs/specs/discovery-v1/10_Database_Architecture.md:98#- production rollout only after CI rehearsal.`).
- **Options considered:**
  - (a) Only `main`'s `schema-drift` apply-and-certify counts. DC-26 then cannot move before merge.
  - (b) A pre-merge apply by the repository's applier, followed by the PR's `schema drift` job green on `portava-ci` for the same tree, counts.
  - (c) The local harness rehearsal counts. Rejected: `10` §7 names `portava-ci`, and §54.2 already said the harness is not it.
- **Decision and rationale:** (b). The workflow's `schema-drift` job on `portava-ci` IS the rehearsal:
  - it plans against the real ledger (`db:apply-migrations:dry-run`);
  - it audits every claim against the live catalogue (`audit:schema`);
  - on `main`, it applies and certifies with the same applier.
  A pre-merge apply by that applier (owner-authorised 2026-09-28), followed by the job green on the PR head, exercises the same code against the same database. The rehearsal record is the apply's output plus that run's id.
- **Reversibility:** a documentation-level ruling. Reverting it returns DC-26 to (a); nothing is lost.
- **Where it is implemented:** apply plan §6; census §83.2. No code.

### D-W10D-2 — a TRUE flag found by a seed file stops the apply; it is never overwritten

- **The question:** how the owner's "preserving existing data and flag values" applies to the 14 flag-seed files in the pending set.
- **Options considered:**
  - (a) Proceed and let the seed's postcondition refuse: the apply stops at that file, with the TRUE value kept.
  - (b) Pre-emptively set the flag FALSE: rejected, because that changes a value.
  - (c) Skip the file: rejected, because the applier has no skip, and a skip would leave the ledger short of the tree.
- **Decision and rationale:** (a), plus the pre-flight read (apply plan §2.1 (b)) so that it is known before the apply. Rehearsed on the harness: the negative control stopped at 3351 with the TRUE value intact and no ledger row (apply plan §4.2).
- **Reversibility:** the operator decides per flag with the owner. Nothing is lost.
- **Where it is implemented:** apply plan §2.1, §3 (the flag rule), §4.2.

### D-W10D-3 — flag-seed recovery never deletes a pre-existing row

- **The question:** each flag-seed rollback deletes its FALSE row. Measured on the harness: 3351's rollback deleted a row that existed before 3351 ran (apply plan §4.4).
- **Decision:** for any seed whose row the pre-flight read found pre-existing, recovery deletes the ledger row only. The rollback file is not run for it.
- **Reversibility:** procedural. **Where:** apply plan §3.

### D-W10D-4 — certify is run with `--files`

- **The question:** `certify:migrations` scopes itself by the run id in the ledger notes, and a terminal apply has none, so it would certify nothing.
- **Decision:** the operator passes the 40 filenames with `--files` (apply plan step 6).
- **Reversibility:** procedural.

### D-W10D-5 — production order: migrations → API → client → flags; the creator ledger waits on C-11; 2893 last or never

- **The question:** the deployment order for Discovery in production.
- **Decision:**
  - D1 migrations (P0, P1; P2 only after C-11; P3 only if E-4 is approved), then D2 API, D3 client, D4 flags in the order of the rollout plan §3.1.
  - The rationale per step is in the rollout plan §2. The old API does not exercise any object D1 creates, and the new API names them.
- **Reversibility:** each step's recovery is the rollout plan §7. **Where:** `docs/ops/discovery-production-rollout.md`.

### APPROVAL REQUIRED — W10D-A (production activation), W10D-B (creator economy), W10D-C (consent and retention), W10D-D (GitHub setting)

Each request is stated in full in `docs/ops/discovery-owner-approval-request.md`: the exact action and values, the consequence of approving and of declining, the rows it unblocks, and the recovery. In brief:

- **W10D-A1:** apply batches P0 and P1 to production after the §0 gates.
  - Approve: the schema lands; no response changes until A3.
  - Decline: DEPLOY rows stay.
  - Recovery: per-file rollbacks, or the restore point.
- **W10D-A2 (A-2):** an explicit yes to 3376 while `discovery_serve_log_enabled` stays TRUE.
  - Approve: per-request rows, including anonymous serves, from the API deploy on.
  - Decline: 3376 is withheld; DV-06 and DV-40 stay W.
  - Recovery: its rollback, which refuses once rows exist.
- **W10D-A3:** deploy the API, then ship the client.
  - Recovery: redeploy the previous build.
- **W10D-A4:** flags. Recommended TRUE after A3: `discovery_candidate_projection_enabled`, `discovery_buddy_launch_gate_enabled`, `discovery_search_protected_zones_enabled`. `discovery_live_rank_enabled` at rollout step A4. Every held-design flag stays FALSE.
  - Recovery: set the flag FALSE.
- **W10D-A5 (E-2):** Phase F gates 1 and 2, as the `DISCOVERY_ENGINE_MODE` sequence shadow 5 % → compare → partial 5/25/50 % → pde all.
  - Recovery: `disable_discovery_pde` TRUE and `enabled=false`.
- **W10D-A6 (E-4):** 2893 last, or never.
  - Recovery: its REVERSAL block, which is not free.
- **W10D-A7 (A-5):** ratify that the stop values in `STOP_CONDITION_RULINGS` at the deployed commit are the ones in force.
- **W10D-B0 (C-11):** erasure retention.
  - Recommended: retain, anonymised, for a statutory period set with legal (`09` §6, §11; `04` §11).
  - Either answer is buildable before any creator row exists.
- **W10D-B1–B11 (C-1 … C-10, C-12):** each with its spec-grounded default where one exists, and "no spec value; you choose" where none does.
- **W10D-C1–C8 (B-1 … B-5, and retention):**
  - dwell (recommended: decline for now);
  - Invisible and name search (keep hiding);
  - trend disclosure (≥ 15 travellers, no neighbourhood names);
  - personal projections (decline the personal forms);
  - Trails and non-public content (no);
  - snapshot and `raw_recent` retention (no spec value; you choose).
- **W10D-D1 (A-4):** require the three verdict checks on `main` through a ruleset.
  - Recovery: disable the ruleset.

## W10-R2 — scoring

*Lane W10-R2 (ranking: the held scoring designs), branch `disc-w10-r2-scoring` from `debd5ad4f`. Census section: census-discovery §78. Rows: DV-09, DV-12, DV-18, DC-13, A18, DV-54. Every design below is built behind a flag seeded FALSE by migrations 3450–3454; nothing is turned on anywhere.*

### D-W10-R2-1 — Surface objectives are family multipliers over one scored feature record

- **The question.** census-discovery §69.2 DV-09: *"five surfaces, each ranked on its own objective"*; `01` §9 lists what each surface favours; `06` §3: *"Do not collapse everything into one permanent universal score."* ranker-hold-designs §5 names the §41.4 hazard: importing `services/ranking/rankingConfig.ts` into Discovery adds a fourth consumer of the parallel stack.
- **Options considered.**
  - (a) Reuse DRS's `SURFACE_WEIGHT_PROFILES`. Consequence: the §41.4 hazard, and DRS runs in shadow (input order) on production, so it would move nothing.
  - (b) Fit per-surface weight tables. Consequence: impossible — Discovery is dark (thirteen `surface='discovery'` rows ever), so any "fit" would be invented.
  - (c) One scored portavaRank record; each surface is a vector of multipliers over `06` §3's eleven families, on a fixed step grid (1.25 favour, 1.5 the defining family, 2 Trip Planning's trip fit, 0.75 de-emphasise), with Trail's per-kind freshness and contributor/place diversity.
- **Decision and rationale.** (c). It is the literal reading of `06` §3 (families, not one score) and `01` §9 (each surface favours a list). The grid is stated as a grid, not a fit. The owner-ruled caps (local momentum 0.15, Trail affinity 0.10) are re-applied after weighting, so no objective turns a modifier into a driver. The owner may override any family on any surface through the flag's metadata (bounded to [0, 3]).
- **Reversibility.** Flag `discovery_surface_objectives_enabled` off restores the pre-§78 ranking bit for bit (golden). Nothing is stored.
- **Where.** `artifacts/api-server/src/lib/discoveryRankObjectives.ts`; `rescoreForObjective` in `artifacts/api-server/src/lib/portavaRank.ts`; tests `discoveryRankObjectives.test.ts` (F1–F5, O1–O5, S1).

### D-W10-R2-2 — The `03` §12 detector runs on save evidence and replaces the 0.6 trust proxy

- **The question.** §69.3 DV-12: *"the trust factor is the constant 0.6 on every row … Abusive engagement is not detected (§58.5 design 4)."*
- **Options considered.**
  - (a) Set `authorTrustScore` only (design 4's first half). Consequence: OSM rows have no author, so the constant stays on most rows.
  - (b) Down-weight a flagged person's content. Consequence: a penalty on a person, which `01` §10 forbids for safety/moderation state.
  - (c) Detect abusive SAVES and discount the evidence: farm (open `gaming_suspected` review), automation (≥5 saves in 60 s), pod (≥3 accounts co-saving ≥3 places within 15 min pairwise), reciprocal saves, submitter self-network (own save 0, mutual follow 0.5), new account (<7 days, 0.5). The count excludes the discounted weight; the remainder is scaled by 0.5 + 0.5 × clean share; an unauthored row stops paying the unknown-author 0.6; an authored row carries its submitter's trust through the Trust seam, and keeps 0.6 when that is unknown.
- **Decision and rationale.** (c). It is design 4 made total over the patterns a save row can show, keeps engagement integrity separate from author trust as the row asks, and never names a person in a reason. Thresholds are lane decisions, each with its reasoning beside the constant; none is fitted. Any failed read leaves the whole set unmeasured rather than half-measured.
- **Reversibility.** Flag `discovery_engagement_integrity_enabled` off. Nothing stored.
- **Where.** `artifacts/api-server/src/lib/discoveryRankIntegrity.ts`; `unknownAuthorTrustFactor` / `evidenceIntegrityFactor` in `artifacts/api-server/src/lib/portavaRank.ts`; tests `discoveryRankIntegrity.test.ts` E1–E8.

### D-W10-R2-3 — negative_feedback is the viewer's own dismissals at category level; exploration_value is a small novelty term

- **The question.** §69.3 DC-13: DRS's negative-feedback family *"runs inside the pipeline on constant-false inputs"*; ranker-hold-designs §5: *"`negative_feedback` is dismissals as a family input at creator and category level … place-level dismissals stay a filter."*
- **Options considered.** (a) Penalise the dismissed place itself — rejected: `lib/discoveryDismissed.ts` removes it, and a re-ranked rejection is a control that visibly does not work. (b) Creator level — not available: Discovery candidates carry no author (the submitter is filtered upstream). (c) Category level over the candidate set, weight 0.4 (the mirror of `categoryAffinity`), saturating at three dismissals; plus DRS's `viewerHasHiddenItem` read from the same dismissals on the discovery surface.
- **Decision and rationale.** (c). `viewerHasReportedItem` stays false: no store records a viewer's report of a Discovery place under the id DRS ranks. `exploration_value` gets `explorationValue` = 0.1 × unseen × (1 − learned affinity) × (1 − exposure), below every taste term (`06` §7 "relevant, not random").
- **Reversibility.** Flag `discovery_feature_families_enabled` off; DRS then gets the same input array back, unread.
- **Where.** `artifacts/api-server/src/lib/discoveryRankDesigns.ts` (`categoryDismissals`), `withDiscoveryNegativeFeedback` in `artifacts/api-server/src/services/ranking/DiscoveryRankingService.ts`; tests `discoveryRankObjectives.test.ts` F3, `discoveryRankDesigns.test.ts` N1–N2.

### D-W10-R2-4 — Which feature belongs to which family

- **The question.** `06` §3 names eleven families and assigns no feature to any.
- **Decision.** relevance: interestTag, categoryAffinity, kindPrior · travel_intent: intentMatch, tripMatch, availabilityFit, capacityOpen · freshness: recency, actionability · quality: verifiedBonus, officialPublisher · trust: trust · novelty: seenPenalty · social_relevance: followedAuthor, mutualAuthor, engagedAuthor, socialProof · place_relevance: cityMatch, neighborhoodMatch, distance, placeEngagement, localMomentum · trail_relevance: trailAffinity · exploration_value: explorationValue · negative_feedback: negativeFeedback. Every key portavaRank writes has exactly one family and every family has a term (pinned).
- **Reversibility.** A mapping; changing it changes only objective-weighted runs.
- **Where.** `FEATURE_FAMILY` in `artifacts/api-server/src/lib/discoveryRankObjectives.ts`; test F1, F2.

### D-W10-R2-5 — Explicit current intent: sources, precedence and weight

- **The question.** A18, Passport `:94`: *"Compass and Discovery should weight explicit current intent more heavily than generic interests."* §69.3: the live layer is bounded by `LIVE_RANK_MAX_POSITIONS`, so it cannot.
- **Options considered.** (a) Widen the live layer's bound — it would still sit over the taste order, and 2850 is a Sensing decision. (b) A term inside portavaRank with weight above interestTag 0.3 + categoryAffinity 0.4 stacked.
- **Decision and rationale.** (b), weight 0.75 (the smallest grid value above 0.7). Sources in order: the request's declared mode (the eight §8 modes), else the viewer's own active EXPLICIT §8 availability window (plan-derived windows are inferences). Each mode's fit uses its own `INTENT_MODE_PROFILES` weights over the axes a candidate can show; unobservable axes are left out, not scored 0. Keywords are supplied only for the three modes that weight compatibility (quiet, social, high energy); Explore's profile weights compatibility 0, so no novelty preference is invented for it. `intentMatch` is NO CODE in the reason map.
- **Reversibility.** Flag `discovery_intent_term_enabled` off.
- **Where.** `artifacts/api-server/src/lib/discoveryRankIntent.ts`, `intentFit` in `artifacts/api-server/src/lib/portavaRank.ts`; tests `discoveryRankIntent.test.ts` I1–I8.

### D-W10-R2-6 — `trip_match` comes from the viewer's own trips, not a request parameter

- **The question.** §69.3 DV-18: *"`trip_match` has none; a trip-fit term is held."* ranker-hold-designs §7 proposed a `tripId` parameter, conditional on it entering `authorizedContextKey` first.
- **Options considered.** (a) `tripId` param — a route and cache-key change in files this lane does not own, and a second trip to key on. (b) Read `trips` directly — the duplication census A10 forbids. (c) The viewer's accepted trips through the Map's existing reader (`readTripStopLayer`: projection where ready, canonical otherwise).
- **Decision and rationale.** (c). Fit = timing (1 under way; 1 → 0.5 linearly to 90 days out; ended/closed/undated = 0) × city-scale proximity (1/(1 + d/25) within 50 km; 0.5 by city name when coordinates are missing). Weight 0.3 (the altitude of one interest match). Plain language "Fits your trip." names no destination or date. `REASON_CODES_WITHOUT_PRODUCER` becomes empty; three existing tests that pinned `["trip_match"]` are restated.
- **Reversibility.** Flag `discovery_trip_match_enabled` off: no trip read, no `tripMatch` key, the code is never emitted.
- **Where.** `artifacts/api-server/src/lib/discoveryRankTrip.ts`, `artifacts/api-server/src/lib/discoveryReasonCodes.ts`; tests `discoveryRankTrip.test.ts` T1–T6.

### D-W10-R2-7 — The four diversity magnitudes, seeded in the flag row

- **The question.** census-discovery §42.1: *"picking a number by resemblance would be inventing a ranking constant"*; ranker-hold-designs §2: read the magnitudes from the flag's metadata. The owner has since delegated routine ranking decisions.
- **Decision and rationale.** Seeded in 3454's metadata, never in code: place 0.35 (a repeated place is at least as redundant as a repeated creator: the creator axis's magnitude), geography 0.15 (a neighbourhood repeat is a coarse cluster like a content-type repeat: that axis's magnitude), Trail 0.25 (their midpoint: a Trail is thematic and curated, stronger than a cluster, weaker than one creator), history 0.15 per prior serve up to 3 over 7 days (below `seenPenalty` 0.6 at its cap of 0.45). A Trail key is `primary`/`supporting` membership of a non-archived Trail. A null magnitude keeps its axis off.
- **Reversibility.** Edit the metadata, or turn the flag off.
- **Where.** `artifacts/api-server/src/lib/discoveryRankDiversity.ts`, migration 3454; tests `discoveryRankDiversity.test.ts` D1–D6.

### D-W10-R2-8 — The pipeline reaches the designs through one hook this lane does not apply

- **The question.** The lane may not edit `lib/discoveryPde.ts` or `routes/discovery.ts`.
- **Decision.** Two exported functions (`loadRankDesigns`, `applyRankDesigns`) and a four-line in-place hunk for `rankForViewer` (census-discovery §78.9 H1), a one-argument hunk for the three `rankForViewer` calls (H2) and a spread for Pulse's `rankCandidates` (H3). With every flag off the hook returns the same three objects; the hunks were rehearsed on this tree (1069/1070 of the pde/route/pulse suites green, the one failure pre-existing) and reverted byte-identically. Trail, Trip Planning and Trending have no portavaRank call to spread into; their consumers are named as open in §78.4.
- **Reversibility.** Revert the hunk; nothing is stored.

### D-W10-R2-9 — Six flags in five files

- **Decision.** One flag per design. 3453 carries two (the intent and trip terms), so that each of the six can be rolled back alone within the five numbers this lane was given.

### D-W10-R2-A1 — **APPROVAL REQUIRED**: production activation of the §78 designs

- **Recommended action, exact.**
  1. Integrate hunks H1 and H2 (census-discovery §78.9) into `lib/discoveryPde.ts` and `routes/discovery.ts`, and H3 into `routes/pulse.ts`.
  2. Apply `3450_discovery_surface_objectives_flag.sql` … `3454_discovery_diversity_axes_flag.sql` to `portava-ci`, then to production, through the normal migration path. They insert rows only, all FALSE.
  3. Turn flags on in production ONE AT A TIME, in this order, each after the previous one has served for at least one week without a stop condition firing (census-discovery DV-82): `discovery_feature_families_enabled`, `discovery_trip_match_enabled`, `discovery_diversity_axes_enabled` (metadata as seeded: placePenalty 0.35, geoPenalty 0.15, trailPenalty 0.25, historyPenalty 0.15, historyMaxServes 3, historyWindowDays 7), `discovery_engagement_integrity_enabled`, `discovery_intent_term_enabled`, `discovery_surface_objectives_enabled` (metadata as seeded: every surface null).
  4. Before step 3's `discovery_engagement_integrity_enabled`, confirm that reading other accounts' save timestamps, account ages, follow edges and open `gaming_suspected` reviews for anti-abuse ranking is within the existing data-use terms. This lane did not decide it: if the owner reads it as a consent question, that flag stays off.
- **Consequence of approving.** Discovery's served order changes for signed-in viewers in `pde` cohorts under Phase F gate 2, and Pulse's order changes when objectives are on. Each flag adds its reads per ranked request (flags alone: six cached reads; integrity: six batched reads). Measurement can then begin; nothing here has production evidence.
- **Consequence of declining.** All six rows stay `W`; A18 remains built-but-unserved. No behaviour changes.
- **Recovery path.** Turn the flag off (immediate, bit-identical ranking — golden-pinned). To remove the rows, turn them off first and run `db/rollback/2026-09-28-345N-…-rollback.sql`, which refuses while a flag reads TRUE. No data is written by any design, so nothing needs cleaning up.

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

## W10-R4 — one ranking pipeline for GET /discovery (census-discovery §79)

*Lane W10-R4, branch `disc-w10-r4-pipeline`, 2026-09-28. Migrations 3455 and 3456, both seeded FALSE. The evidence is controlled: in-process routes over an in-memory database, plus a local PostgreSQL 16 harness. None of it is production evidence.*

### D-W10R4-1 — Q66-2: how `for_you` joins the PDE pipeline

- **The question.** §66.9 Q2 asks: *"Signed-in `for_you` pages are ordered by Compass's ranker and every other category by the PDE pipeline. Is `for_you` to be consolidated into the PDE pipeline under Phase F gate 2, which changes its order with no flag in front of it, or retired now?"* (`docs/architecture/census-discovery.md` §66.9). The same question is in §47.3 and in `docs/discovery/ranker-hold-designs.md` §6.
- **Options considered.**
  - (a) Retire the Compass branch now, with no flag. Every signed-in `for_you` order changes at deploy, and there is no rollback short of a revert. That is production activation, which is not delegated.
  - (b) Ride `DISCOVERY_ENGINE_MODE` (ranker-hold-designs §6): skip Compass in `pde` mode for in-cohort viewers. This couples the consolidation to the engine-mode cohort, which also governs shadow. The shadow comparison could then never measure `for_you` before the flip.
  - (c) A new capability flag, seeded FALSE, with Compass kept as a candidate gate. Chosen.
- **Decision and rationale.** (c), `discovery_for_you_pde_enabled` (3455):
  - When ON, a signed-in `for_you` page is ordered by `rankForViewer` and nothing else.
  - Compass keeps the part of its job that is not ordering. Its pipeline gates decide which candidates enter PDE: the fail-closed safety filter, eligibility, safe-return attention and Live exclusions (`compassEligibleForDiscovery`).
  - `rankItemsForDiscovery` is not called and Cache B is neither read nor written.
  - Grounds:
    - `10` §1: *"Avoid parallel systems"* (`docs/specs/discovery-v1/10_Database_Architecture.md:5#Avoid parallel systems`).
    - `12` §0: *"Do not implement PDE as a greenfield subsystem"* (`docs/specs/discovery-v1/12_Claude_Code_Implementation.md:5#Do not implement PDE as a greenfield subsy`).
    - `06` §10: *"Feature flag must keep old user-visible output unchanged"*.
    - ranker-hold-designs' common rule: *"Eligibility is not ranking."*
  - When OFF, serve points 4 and 5 are byte-identical to before (Z0, and L0).
  - A Compass failure degrades to every candidate, which is the same DV-07 degradation the Compass-order path already takes.
- **Reversibility.** Set the flag FALSE; it takes effect within 30 s (flag cache). Nothing is written by the flag, so nothing is lost. Rollback file: `db/rollback/2026-09-28-3455-discovery-for-you-pde-enabled-rollback.sql`.
- **Where it is implemented.**
  - `artifacts/api-server/src/lib/discoveryOnePipeline.ts`
  - `artifacts/api-server/src/compass/CompassFeedBuilder.ts:866#export async function compassEligibleForDiscovery(`
  - `artifacts/api-server/src/routes/discovery.ts:2106#const forYouM = await forYouCandidatesForServe(`
  - `artifacts/api-server/src/routes/discovery.ts:2276#if (callerUserId) { const places = forYouM.places;`
  - `artifacts/api-server/src/routes/discovery.ts:1838#const forYouA = await forYouCandidatesForServe(`
  - migration 3455
  - Tests: `artifacts/api-server/src/test/discoveryOnePipeline.test.ts` P1–P4 and Z0.

### D-W10R4-2 — E-2: Phase F gates 1 and 2 — **APPROVAL REQUIRED**

- **The question.** §69.1 E-2 is *"Phase F gates 1 and 2"*. `docs/discovery/ROADMAP.md` Phase F lists two gates, both *"not ruled"*:
  - *"Enabling `shadow` for any cohort"*;
  - *"The `pde`-serving flip for real users"*.
- **What was decided here (delegated).**
  - Gate 2 is expressed as the two capability flags this lane built:
    - 3455 (`for_you` on one pipeline, D-W10R4-1);
    - 3456 (Cache A ranked for every signed-in viewer, D-W10R4-4).
  - `DISCOVERY_ENGINE_MODE` keeps gate 1 (shadow) and the staged `pde` cohort.
  - The shadow now measures the consolidated pipeline before either flag is on (D-W10R4-6).
  - Sequence: gate 1, then a reading of the shadow rows, then gate 2.
- **What is NOT decided: production activation.** The recommended actions, with exact values:
  1. **Apply 3455 and 3456 to production.** Each inserts one row, FALSE, and the postcondition refuses TRUE.
  2. **Gate 1.**
     - `UPDATE public.feature_flags SET enabled = true, metadata = '{"mode":"shadow","cohort":{"kind":"users","userIds":["<internal account ids>"]}}' WHERE flag = 'DISCOVERY_ENGINE_MODE';`
     - After 7 days with no stop condition tripped, widen to `{"kind":"percent","percent":5}`.
     - Read `discovery_shadow_serves` for serve points 1, 4 and 5: `overlap_count`, `top_changed` and `pde_stages->'phase9'`.
  3. **Gate 2**, after 14 days of shadow rows and the owner's reading of them:
     - `UPDATE public.feature_flags SET enabled = true WHERE flag IN ('discovery_for_you_pde_enabled','discovery_cache_a_ranked_enabled');`
     - Then set `DISCOVERY_ENGINE_MODE` back to `{"mode":"legacy"}` or leave it in `shadow`. With both flags on, the shadow skips pages that PDE already served (`routes/discovery.ts:1960#shadowCohort`).
- **Consequence of approving.**
  - Signed-in `for_you` pages and every signed-in Cache A hit are ordered by the PDE pipeline.
  - `rank_events` gains a real impression row per served item on serve points 1, 2 and 3 (they wrote serve-log rows before).
  - C32, DC-24, DV-03, A05 and DC-14 then need only their production evidence. C32 and DC-24 also need D-W10R4-7.
- **Consequence of declining.**
  - Production keeps serving `for_you` in Compass's order.
  - Signed-in Cache A hits stay unranked.
  - Those rows stay `W`.
- **Recovery.** Set the flags FALSE, and the old behaviour returns within 30 s. Restore the previous `DISCOVERY_ENGINE_MODE` metadata. Impression rows already written are measurements, and removing them is a retention decision, not a rollback.

### D-W10R4-3 — D-7: who owns Sensing `:129` on the Compass serve points, and what a failed Live-claim read serves

- **The question.** §57.10 Q1: *"On GET /discovery's Compass serve points, which gate owns Sensing `:129`: Discovery's `discovery_live_rank_enabled`, via the demotion-only pass §57.9 wires, or Compass's `COMPASS_LIVE_CONSTRAINTS_ENABLED` environment switch?"* The brief adds what to serve when that read fails.
- **Options considered.**
  - (a) Compass's environment switch owns it. Then one surface would be governed by two unrelated switches, and a `unsafe_density` place could lead the page (§57.4 C1).
  - (b) Discovery's 2850 owns it on every GET /discovery serve path. Chosen.
  - For a failed read, three answers were considered:
    - fail open, keeping the claim. That is today's behaviour, and it contradicts Sensing §20;
    - hide the candidate. That turns a read failure into a second failure;
    - **fail closed: serve the candidate, withhold the claim, and say so.** Chosen.
- **Decision and rationale.**
  - (b): one flag and one grade for one surface. Compass's switch stays Compass's own exclusion inside its pipeline, and under 3455 it runs as part of the candidate gate.
  - The failure rule applies on all four serve paths, not only on the Compass path. With 3455 ON, For You moves to the PDE path, and a rule scoped to the Compass path would silently stop applying to For You.
  - A row fails when it has a canonical live subject (so a read was owed) and either the live layer did not run with the flag on, or its grade is `unreadable`. The row is still served in its place. Its `nearby_now` reason (*"Close to you and open around now."*) and its why-now are withheld, and the envelope carries `meta.liveSafety: { readable: false, claimsWithheld }`.
  - Grounds:
    - Sensing §20: *"Schema/permission/infrastructure failure ≠ no activity"* (`docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt:230#Schema/permission/infrastructure failure`).
    - Sensing §7: *"A dangerous place must never simultaneously be promoted as 'best move now'"* (`:129`).
    - `11` §9: a failure must not masquerade as success.
  - `DiscoveryPlace.isOpenNow` is an opening-hours fact the `openNow` filter reads, not a Live claim. The Discovery card does not render it, so it is untouched.
- **Limit found, and routed (not this lane's file).** `lib/liveClaimRead.readLiveClaims` resolves `[]` on a snapshot read error. So a claim read that errors reaches Discovery as "no claim" (`none`), not as `unreadable`, and nothing is withheld. This is pinned by `discoveryOnePipeline.test.ts` F2. The fix is for the read path's owner: return a failure the caller can see.
- **Reversibility.** With 2850 FALSE (its seeded state) nothing here runs. The rule has no flag of its own, because it only ever removes a claim.
- **Where it is implemented.**
  - `artifacts/api-server/src/lib/discoveryLiveRank.ts:519#export function liveClaimReadFailures(`
  - `artifacts/api-server/src/lib/discoveryLiveRank.ts:552#export function withLiveClaimsWithheld<`
  - `artifacts/api-server/src/lib/discoveryLiveRankRead.ts:237#gradedById: graded.byId`
  - the four serve paths in `routes/discovery.ts`
  - Tests: F1, F3, F4, F5, U1–U5, and the F2 limit.

### D-W10R4-4 — DV-03: how Cache A stops bypassing ranking

- **The question.** `01` §7: *"A user-independent candidate cache that serves raw candidates must never bypass personalization/ranking"* (`docs/specs/discovery-v1/01_Portava_Discovery_Engine.md:157#must never bypass personalization/ranking`). The brief: *"Make Cache A viewer-safe, or bypass it for personalized paths, behind a flag."*
- **Options considered.**
  - (a) Only `pde` mode plus the cohort, as today. The cold path already ranks every signed-in viewer in every mode, so the cache path disagreeing with it is a serve-path defect, not an experiment. The cohort is also shared with shadow.
  - (b) Skip Cache A for signed-in viewers. This moves Overpass load onto every signed-in request for no ranking gain.
  - (c) A flag that ranks every signed-in Cache A hit per request, which is `01` §7's *"allowed pattern"*: cache candidates, rank per user, log, serve. Chosen.
- **Decision.** (c), `discovery_cache_a_ranked_enabled` (3456):
  - When ON, serve points 1, 2 and 3 rank for the viewer in every engine mode.
  - Anonymous requests are unchanged.
  - A ranker failure still serves the cached order, as the `pde` branch always has. It is recorded as a `cache_bypass` obligation by `recordRankObligation`, and the page is marked `rankedBy: "none"`.
- **Reversibility.** Set the flag FALSE; it takes effect within 30 s.
- **Where it is implemented.**
  - `artifacts/api-server/src/routes/discovery.ts:1854#const cacheARanked = await cacheARankedEnabled(`
  - migration 3456
  - Tests: V1 and V2 (and Z0).

### D-W10R4-5 — A05 / Q71-2: For You under Compass ignores the intent mode

- **The question.** §71.6 Q71-2: *"When Compass answers, For You shows Compass's feed, which takes no mode."* The options given there:
  - carry the mode into the Compass feed request;
  - do not offer the selector on For You while Compass supersedes.
- **Decision.** Neither. Under 3455, For You's `GET /discovery` page is the one-pipeline page, and the live layer ranks it in the chosen mode like every other category (M1). The client tab stops superseding that page with the Compass feed (O1, O1b), and does not request the feed. Compass's own rails below the list are unchanged.
  - Carrying the mode into the Compass feed would keep a second ordering on the tab.
  - Hiding the selector would leave For You without intent.
  - With 3455 OFF the tab is exactly as before (O1c, O3).
- **Reversibility.** It follows 3455.
- **Where it is implemented.**
  - `travel-buddy-standalone/src/components/discovery/ForYouTab.tsx:228#if (forYouPde || !compass.data`
  - Test: `travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.onePipeline.component.test.tsx`

### D-W10R4-6 — DC-14: the shadow covers the consolidated pipeline

- **Decision.**
  - Shadow mode now observes Compass serve points 4 and 5 (`observeForYouShadow`). The legacy side is the Compass page served. The PDE side is the page the consolidated pipeline would serve: Compass's gates, then `rankForViewer`, then the same post-rank layers.
  - The Cache A shadow's `for_you` side is also the consolidated pipeline's.
  - `pde_stages.candidateSource` names the source.
  - Every call in the shadow gets a write-suppressed client, Compass's eligibility run included. S1 pins that the shadow adds exactly one write, its own row.
  - A shadow run is skipped when the served page is already PDE's, because there is no "old" page to compare.
- **Grounds.** `06` §10: *"compute old ranking, compute PDE ranking, compare overlap … Feature flag must keep old user-visible output unchanged."*
- **Reversibility.** The shadow runs only in `shadow` mode for a cohort, and production is `legacy`.
- **Where it is implemented.**
  - `artifacts/api-server/src/routes/discovery.ts:4464#async function observeForYouShadow(`
  - `artifacts/api-server/src/routes/discovery.ts:1971#const shadowCands =`
  - Tests: S1–S3.

### D-W10R4-7 — retiring the old `for_you` path — **APPROVAL REQUIRED**

- **The question.** C32's criterion is *"One ranking pipeline in the tree"*. While the flag-off branch exists, the tree still holds Compass's ordering of `for_you`.
- **Why it is not done here.** Deleting the branch now makes 3455's ON behaviour the only behaviour at deploy. That is production activation without a flag, and it removes the only rollback that does not need a revert.
- **Recommended action.** After 3455 has been TRUE in production for 14 days with no Discovery stop condition tripped, merge one commit that:
  - deletes the Compass-order branch of `routes/discovery.ts`: serve points 4 and 5, `_compassCandidateCache` for Discovery, and the value import of `rankItemsForDiscovery`;
  - deletes `forYouCandidatesForServe`'s flag read, so the consolidated path is unconditional;
  - restates `discoveryVerifyAudit2.test.ts` R1 and R2 and `discoveryOnePipeline.test.ts` P4 to the one-path behaviour;
  - adds a migration that deletes the `discovery_for_you_pde_enabled` row.
- **Consequence of approving.** The tree has one ordering pipeline for Discovery, so C32 and DC-24 can be graded `C` on runnable evidence. Rollback after that is a revert of the commit.
- **Consequence of declining.** Two orderings stay in the tree behind a flag, and C32 and DC-24 stay `W`.
- **Recovery.** `git revert` of the retirement commit restores the branch and the flag read. The flag row would need re-seeding by re-running 3455.

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

## W10-O — outcomes, telemetry product rules, stop conditions

*Lane W10-O, branch `disc-w10-o-outcomes`, 2026-09-28. Census section: `docs/architecture/census-discovery.md` §82. Nothing below is applied to `portava-ci` or production, deployed, or flag-enabled.*

### D-W10-O-1 — the seven stop-condition halt values (DV-82, DC-32; A-5)

- **The question.** `docs/specs/discovery-v1/12_Claude_Code_Implementation.md:206#Stop conditions`: "Stop rollout if: event rejection rises, recommendation logging gaps appear, creator concentration spikes, reports/hides increase materially, cache bypass reappears, RLS leaks occur, attribution double-counts." Census §54.13 Q1: *"For each, what value halts the rollout, over what window, and on how much evidence?"*; Q2: *"Do you ratify the enforced values — a 5 % event-rejection rate, a 10 % logging gap, a 20-attempt floor and a 10-minute window — or replace them?"*
- **Options considered.**
  - (a) Leave five unruled: they are measured and can never halt, so `12`'s stop is 2 of 7 in effect.
  - (b) Relative thresholds (×N a trailing baseline): no baseline exists, because production has never run the ranked path (§48.1). A relative rule over no baseline cannot fire, or fires on noise.
  - (c) Absolute conservative values, one window, each a named config value, armed by a flag seeded FALSE. **Chosen.**
- **Decision and rationale.** No spec and no ROADMAP step gives a number for any of the seven (ROADMAP has none; `12` gives verbs). A trip can only move a request to `legacy`, which is what production already serves, so a false halt costs a paused rollout and a missed halt costs a user-facing defect. So the values err toward halting:

  | condition | halts when | minimum evidence | named value |
  |---|---|---|---|
  | `event_rejection_rate` | > 0.05 of serve-log insert attempts | 20 attempts | `EVENT_REJECTION_RATE_THRESHOLD`, `STOP_MIN_SAMPLE` (kept from §12.5) |
  | `recommendation_logging_gap` | > 0.10 of served items | 20 attempts | `LOGGING_GAP_THRESHOLD` (kept) |
  | `creator_concentration` | HHI > 0.25 | 100 resolved exposures | `CREATOR_CONCENTRATION_HHI_THRESHOLD`, `CREATOR_CONCENTRATION_MIN_RESOLVED` |
  | `reports_hides` | (dismisses + place reports + Trail reports) / exposures > 0.05 | 100 exposures | `REPORTS_HIDES_RATE_THRESHOLD`, `REPORTS_HIDES_MIN_EXPOSURES` |
  | `cache_bypass` | any bypass (share > 0) | 1 owed rank | `CACHE_BYPASS_SHARE_THRESHOLD`, `CACHE_BYPASS_MIN_OBLIGATIONS` |
  | `rls_leak` | any deviation from 3390's posture | 1 catalogue read | `RLS_LEAK_DEVIATION_THRESHOLD`, `RLS_LEAK_MIN_SAMPLE` |
  | `attribution_double_count` | any live double count | 1 attribution | `ATTRIBUTION_DOUBLE_COUNT_THRESHOLD`, `ATTRIBUTION_DOUBLE_COUNT_MIN_SAMPLE` |

  One window for all seven: `STOP_WINDOW_MS`, 10 minutes (kept). HHI 0.25 is "more concentrated than four creators sharing the page equally", the classic "highly concentrated" line on the 0–1 scale. "Reappears", "occur" and "double-counts" name events, so any one halts. The two §12.5 values are kept because their healthy value is 0 and nothing measured argues for another.
- **Reversibility.** Every value is a named constant in one file, and the set carries a version (`STOP_ENFORCEMENT_VALUES_VERSION` = `stop-values-2026-09-28.1`) that a test pins to the values. Disarming is `UPDATE feature_flags SET enabled = false WHERE flag = 'discovery_stop_enforcement_enabled'`; the next non-legacy resolution reads it. Nothing is lost: a trip is evidence in memory that ages out in 10 minutes.
- **Where it is implemented.** `artifacts/api-server/src/lib/discoveryStopConditions.ts` (`ARMED_STOP_CONDITION_RULINGS`, `refreshStopEnforcement`, the §82 block at the foot), the caller `artifacts/api-server/src/lib/discoveryStopMeasurements.ts` (`refreshDiscoveryStopMeasurements` reads the arming flag), migration `3470_discovery_stop_enforcement_flag.sql` (flag `discovery_stop_enforcement_enabled`, seeded FALSE) and its rollback. Tests: `src/test/discoveryStopEnforcement.test.ts` G1–G7; `src/test/discoveryStopSevenConditions.test.ts` (unchanged, flag off).

### D-W10-O-2 — an unreadable stop measurement halts, when armed (DV-82; §54.13 Q3)

- **The question.** §54.13 Q3: *"When a stop measurement cannot be read (3391 unapplied, or the database refuses), should the rollout halt, or report `unreadable` and continue as it does today?"*
- **Options considered.** (a) Continue: a stop that cannot see lets the rollout proceed blind. (b) Halt: the rollout pauses until the instrument can see again. (c) Halt only after N consecutive unreadable reads: needs a second state machine for no stated gain.
- **Decision and rationale.** (b), and only when armed, and only for the four database conditions. The halt resolves to legacy, which is safe. Arming is recommended only with 3391 applied (D-W10-O-3), so "unreadable" then means a real failure rather than a missing function. `stale`, `no_evidence` and `input_absent` still do not halt: the first refresh after a restart is `no_evidence`, and `input_absent` (no `creator_attributions`) means no double count can exist. `STOP_UNREADABLE_HALTS_WHEN_ARMED = true`.
- **Reversibility.** One constant. Nothing is lost.
- **Where it is implemented.** `lib/discoveryStopConditions.ts` (`haltsOnUnreadable`, the `tripped` filter). Tests: G4a–G4c.

### D-W10-O-3 — APPROVAL REQUIRED: arm the stop conditions in production

- **Recommended action, exactly.** In this order, on production (`ajrurzioarfkagpuxfnb`), after this tree is merged and deployed:
  1. Apply `3390_discovery_rls_explicit_policies.sql` and `3391_discovery_stop_condition_measurements.sql` (3391 depends on 3390's posture for `rls_leak`).
  2. Apply `3470_discovery_stop_enforcement_flag.sql` (seeds `discovery_stop_enforcement_enabled` FALSE; refuses to commit it ON).
  3. Read the baselines once, read-only, before arming (census §82.8 has the SQL): the HHI of Discovery exposures and the (dismiss + report) share over the last 7 days. If either is already above its value (0.25, 0.05), arming would keep PDE on legacy from the first minute; decide whether that is wanted before step 4.
  4. `UPDATE public.feature_flags SET enabled = true, metadata = jsonb_build_object('values_version', 'stop-values-2026-09-28.1') WHERE flag = 'discovery_stop_enforcement_enabled';`. The row must name the values version: arming reads DISARMED unless `metadata.values_version` equals `STOP_ENFORCEMENT_VALUES_VERSION`, so an approval arms exactly the values it approved, and a later change to any value (which must bump the version) needs a new approval.
  5. The values armed are exactly D-W10-O-1's table, with D-W10-O-2.
- **If approved.** In shadow or PDE mode, any of the seven over its value, or an unreadable measurement, resolves Discovery to legacy (`reason: stop_condition`) for the 10-minute window, and the reading says which. In legacy mode (production today) nothing changes, because the resolver never evaluates stop conditions on legacy.
- **If declined.** Flag-off behaviour stays exactly as now: two unratified thresholds enforced, five measured and reported `unruled`. `12`'s stop stays 2 of 7 in effect, and DV-82 stays `W`.
- **Recovery.** `UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_stop_enforcement_enabled';` takes effect at the next non-legacy resolution (at most one 30-second resolver cache period). The row itself is removed only by `db/rollback/2026-09-28-3470-discovery-stop-enforcement-flag-rollback.sql`, which refuses while the flag is TRUE.

### D-W10-O-4 — §47.8's silent production defaults (DC-32; E-3)

- **The question.** `docs/specs/upgrades-v2/02-DISCOVERY-v2.md:42#Existing Ranker and Event Truth holds are`: *"reuse approved weights, exploration budgets, sensitive-location policy, freshness and thresholds; ask rather than choose silent production defaults."* §47.8: *"rule each value, or mark it PROVISIONAL with a review date."*
- **Options considered.** (a) Leave them unruled (the finding stands). (b) Change them now: nothing measured says any is wrong, and changing a served value without evidence is the thing the clause forbids. (c) Rule each as PROVISIONAL at its current value, with a review date and the evidence that would move it, and pin the code to this table. **Chosen.**
- **Decision and rationale.** Every value below is ruled **PROVISIONAL, review by 2027-03-31 or at the first production outcome judgement (D-W10-O-10), whichever is first.** None is changed.

  | value | ruled | what would move it |
  |---|---|---|
  | `CACHE_B_TTL_MS` | 10 min | a production read of how often a replayed page is revoked (`row_revoked`) |
  | `CACHE_TTL_MS` (routes/discovery.ts) | 2 h | provider cost against a measured freshness complaint rate |
  | `SEEN_WINDOW_MS`; `seenPenalty` | 24 h; −0.6 | the judgement's `useful_saves` per serve point with and without the demotion |
  | `MIN_TOTAL_CATEGORY_OBSERVATIONS` | 3 | taste stability over a production cohort |
  | stop values | D-W10-O-1 | D-W10-O-1 |
  | `TREND_MIN_RATE`; growth; decline | 3; ×1.5; ×0.6 | a labelled sample of trending calls against reports |
  | `TRAVEL_HORIZON_MINUTES`; `DEFAULT_QUEUE_TOLERANCE_MINUTES`; `LIVE_RANK_MAX_POSITIONS` | 45; 30; 15 | the live-rank layer's first production reads |
  | `authorPenalty`; `kindPenalty` | 0.35; 0.15 | `creator_diversity` in the judgement |

  The ruled values stay out of the sensitive-location leg: that is 3366 (A-3, B04), another lane's.
- **Reversibility.** A new register entry and a one-line code change per value; the pin test fails until both agree.
- **Where it is implemented.** No served value changed. `src/test/discoveryRulingsPinned.test.ts` R1 reads each value from the code and fails when it drifts from this table.

### D-W10-O-5 — keyless outcomes from shipped builds (DV-37; D-9, §62.7 Q1)

- **The question.** §62.7 Q1, as §69.1 records it: *"keyless outcomes (DV-37, §62.7 Q1)"* — every build shipped before §62's H1 sends outcomes with no `client_event_id`; a keyless retry after a second serve moves a second exposure (`src/test/db/discoveryVerifyChain.db.test.ts` V7d).
- **Options considered.**
  - (a) Server-minted key: minted per request, so a retry gets a new one. It identifies nothing, and makes an unkeyed outcome look keyed.
  - (b) Refuse keyless outcomes: every outcome from every shipped build is lost ("Not interested", opens, saves, trip adds) until the keyed build is the floor. That is right only once the keyed build is the oldest supported one, which is a release decision.
  - (c) Accept, marked unkeyed, with the retry bounded on the natural key. **Chosen.**
- **Decision and rationale.** A keyless outcome is accepted and leaves `outcome_client_event_id` NULL, and that NULL is the mark (3420's column). A keyless outcome that would move a SECOND exposure of the same (viewer, item, surface[, session]) is answered `{ ok: true, duplicate: true }`, and moves nothing, when the same outcome, or one that subsumes it, landed on another exposure of that key within `KEYLESS_OUTCOME_RETRY_WINDOW_MS` = 10 minutes. `04` §3 asks every event write to be "idempotent where retried". Ten minutes is a user-driven retry inside one visit. It is also `CACHE_B_TTL_MS`: inside it, a second serve of the item is most likely the same ranked page replayed. The cost: a genuine repeat of the same act on a new serve inside 10 minutes counts once. That cannot happen for `dismiss`, because a dismissed place is filtered from every serve path. For taps it under-counts, which is the lesser error than V7's double negative signal. A keyed request never takes this path.
- **Reversibility.** The rule is one appended function reached from two lines of the handler. Removing it restores the pre-§82 behaviour. Nothing is lost: a retry answered `duplicate` changed nothing.
- **Where it is implemented.** `artifacts/api-server/src/routes/rankEvents.ts` (`readKeylessOrUpgradable`, `keylessLandingOutcomesFor`, `KEYLESS_OUTCOME_RETRY_WINDOW_MS`). Tests: `src/test/discoveryKeylessOutcome.test.ts` L1–L8; restated: `discoveryKeyedOutcome.test.ts` K2, `rankEventsTripAddOutcome.test.ts` "selects exactly the list", `db/discoveryVerifyChain.db.test.ts` V7d.

### D-W10-O-6 — `hide` vs `not_interested` on Discovery (DV-78; E-8)

- **The question.** `04` §4's Negative list names both `hide` and `not_interested` and defines neither; census §48 DV-78: *"`hide` vs `not_interested` … are not defined by the spec — owner input."*
- **Options considered.** (a) Two controls: "Hide" (this place only, no inference) and "Not interested" (a taste negative). On a PLACE card the two acts are indistinguishable to the viewer. The taste half would feed the ranker, which is held here (and `routes`/ranker files belong to other lanes). (b) One control that records both names as one act. **Chosen.**
- **Decision and rationale.** On Discovery, `hide` ≡ `not_interested`: one control ("Not interested"), one token (`dismiss`), one analytics event (`ranking_item_hidden`, the constant `rankingAnalytics.ts` already maps both `dismiss` and `hide` to). It removes the item for that viewer (`lib/discoveryDismissed.ts`) and feeds the cross-viewer negative statistic. It is not a category-level taste signal. The §12 "hide rate" is the dismiss rate. `hide` remains a distinct act on surfaces that show authored content (the Wall).
- **Reversibility.** A second control could be added later with its own token. The existing rows keep their meaning.
- **Where it is implemented.** `lib/discoveryOutcomeReport.ts` (`dismiss_rate` is the hide rate). Tests: `discoveryOutcomeJudgement.test.ts` J1; `discoveryOutcomeReport.test.ts` O4 (restated); `discoveryNegativeFeedbackSeparation.test.ts` N1.

### D-W10-O-7 — the `immediate_skip` threshold (DV-78)

- **The question.** `04` §4 lists `immediate_skip` first among Negative events, with no threshold (DV-78: *"the threshold for `immediate_skip` [is] not defined by the spec"*).
- **Options considered.** (a) A card scrolled past: needs list viewability, which the list does not report, and is itself dwell collection on the card (§55.10 Q4, B-1). (b) An opened detail sheet left almost at once, derived downstream from the dwell rows (`04` §8: "Sequence features should be derived downstream rather than hard-coded into clients"). **Chosen.**
- **Decision and rationale.** An exposure is an immediate skip when its furthest outcome is `tap` (opened, nothing stronger) and its FOREGROUND dwell (active + passive_foreground, summed across emissions) is below `IMMEDIATE_SKIP_MAX_FOREGROUND_MS` = **2 000 ms**. Idle time never lengthens a view. The sheet animation takes a few hundred ms and reading the name and first line about a second more, so under 2 s the viewer left before reading. It is a measurement, not a ranking input. It exists only where dwell is collected, so it waits on D-W10-O-9.
- **Reversibility.** One constant. Nothing is collected by it.
- **Where it is implemented.** `artifacts/api-server/src/lib/discoveryDwellSkip.ts`. Tests: `src/test/discoveryDwellSkip.test.ts` S1–S5.

### D-W10-O-8 — dwell's interaction window, passive dwell, and the card (DV-41; §55.10 Q2–Q4)

- **The questions.** §55.10 Q2: *"How long after a viewer's last touch does foreground time still count as ACTIVE dwell?"* Q3: *"Is passive-foreground dwell … ever an interest signal?"* Q4: *"Should dwell also be measured on the place CARD?"*
- **Decision and rationale.**
  - Q2: **10 seconds**, ratified at the current `DWELL_INTERACTION_WINDOW_MS`. A detail sheet is read in bursts between touches, and 10 s covers one screenful at reading speed.
  - Q3: **No.** Only `active` is interest. `04` §4 names `active_dwell` alone, and §7 says "Do not infer interest from a phone sitting untouched".
  - Q4: **Not now.** Card dwell needs list viewability and is new collection on a second surface, so it belongs in the consent request (D-W10-O-9), not in a product rule.
- **Reversibility.** Q2 is one client constant. Q3 is `dwellCountsAsInterest`.
- **Where it is implemented.** No code changed. `travel-buddy-standalone/src/services/discoveryDwell.ts` `DWELL_INTERACTION_WINDOW_MS` and `artifacts/api-server/src/lib/discoveryDwellVocabulary.ts` `dwellCountsAsInterest` already hold the ruled values, pinned by `src/test/discoveryRulingsPinned.test.ts` R3.

### D-W10-O-9 — APPROVAL REQUIRED: dwell collection (DV-41, DV-78 dwell; B-1)

This is consent, which is not delegated. Nothing here turns collection on.

- **What is collected, exactly.** For a SIGNED-IN viewer, on the Discovery place DETAIL SHEET only, for a place served to them on surface `discovery` with a served id:
  - milliseconds of `active` (app in the foreground, touched within the last 10 s), `passive_foreground` (foreground, untouched past 10 s) and `idle` (backgrounded, screen off, or iOS inactive) time;
  - written as `rank_events` rows (`event_type 'place_dwell'`, `outcome 'analytics'`, `dwell_ms`, `dwell_kind`), one per kind per emission, with the viewer's user id, the place id and the served `recommendation_id`, `privacy_class` `raw_recent`.
  - Not collected: anything while signed out, anything on the list or the card, location, content of the screen, or other apps.
- **Consent wording needed (recommended, for the privacy notice and the in-app disclosure).** *"When you open a place from Discovery, Portava records how long the place stays open on your screen and whether you were interacting with it, so that recommendations can learn what you actually read. This is linked to your account. It is not collected when you are signed out, and it is never used to infer interest when your phone is idle."* Where the owner's consent model requires opt-in, the flag must be read together with that opt-in. This lane did not build an opt-in, because the consent model is the owner's.
- **Recommended action, exactly.** After the wording is published and a retention horizon is set (`04` §11: *"Exact retention must be decided with privacy/legal review"*; also not delegated): apply `3395_discovery_dwell_telemetry_flag.sql` to production, then `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_dwell_telemetry_enabled';`. The rules that then apply are D-W10-O-8's.
- **If approved.** Dwell rows are written for signed-in Discovery detail-sheet views. `immediate_skip` (D-W10-O-7) becomes measurable. DV-41 can reach `C` on production rows.
- **If declined.** Nothing is collected. The route answers 404 `feature_disabled` and the client sends nothing. DV-41 and DV-78's dwell leg stay `W`.
- **Recovery.** Set the flag FALSE; collection stops at the next flag read (client and server). Deleting rows already written is a retention decision (`04` §11), and the 3395 rollback deliberately does not do it.

### D-W10-O-10 — what "improves" means (DV-19; D-3, §55.10 Q6)

- **The question.** §55.10 Q6: *"For each `01` §12 item, what difference between the PDE and legacy arms, over what sample, counts as 'improves'? And is 'new-creator discovery' about creators new to the viewer or new to the platform?"*
- **Options considered.** (a) Pooled arms with a raw-lift threshold: the arms are observational and serve points are not like for like, so a pooled lift measures the mix. (b) A per-serve-point significance rule with a minimum effect and guardrails. **Chosen.** (c) Leave it the owner's: then DV-19 cannot be judged by anyone.
- **Decision and rationale.**
  1. Per serve point, never pooled.
  2. Both arms need `OUTCOME_MIN_SAMPLE_PER_ARM` = 1 000 units of the metric's own denominator.
  3. A rate differs only when the two-proportion z reaches `OUTCOME_Z_CRITICAL` = 1.96 (two-sided 95 %) AND the relative change is at least `OUTCOME_MIN_RELATIVE_CHANGE` = 0.05. For the funnel's bounded items, BOTH the lower and the upper bound must agree.
  4. Creator diversity (an HHI) differs by `CREATOR_HHI_MIN_RELATIVE_CHANGE` = 0.10 relative.
  5. `improves` iff an INTENT item (useful saves or itinerary additions) improves at some serve point AND no measured item worsens at any. `01` §12: "Raw engagement may rise or fall; it is not the sole acceptance criterion", so place opens alone never suffice.
  6. New-creator = **new to the platform**: first Discovery submission within `NEW_CREATOR_WINDOW_DAYS` = 30 days before the exposure. `01` §1 ("gives new creators fair exploration") and §10 ("suppress new creators solely due to low history") are about creators with little history, not about the viewer.
  7. "Successful trip actions" = an itinerary item from a Discovery exposure that the trip carries out. No Trips plan-item projection reaches Discovery (E-7), so it is unmeasured, and so are completed visits, event attendance, Trail freshness and repeat traveler satisfaction. Each is named, never 0.
- **Reversibility.** Every value is a named constant. The rule is a pure function kept apart from the numbers, so changing it re-judges without re-reading.
- **Where it is implemented.** `artifacts/api-server/src/lib/discoveryOutcomeReport.ts` (`judgeOutcomeImprovement`, the enrichment, the named values), `src/scripts/reportDiscoveryOutcomes.ts` (prints it). Tests: `src/test/discoveryOutcomeJudgement.test.ts` J1–J7.

### D-W10-O-11 — regret, hide and report (DV-19; §55.10 Q7)

- **The question.** §55.10 Q7: *"Is the card's 'Not interested' dismissal the §12 'regret' or 'hide' signal, or must regret be measured separately (for example, a dismissal after a save)?"*
- **Decision and rationale.** Three rates:
  - **hide** is the dismiss rate (D-W10-O-6);
  - **report** is the share of an arm's exposures of a reportable (community) place that the viewer reported (`discovery_place_reports`) within `REPORT_ATTRIBUTION_WINDOW_DAYS` = 7 days after the exposure;
  - **regret** is the share of positive outcomes (tap or stronger) whose item the same viewer dismissed on a LATER exposure within `REGRET_WINDOW_DAYS` = 30 days.

  A dismissal on the same exposure after a save cannot exist, because `dismiss` is recorded only against an impression. So "acted on it, then waved it away next time" is the regret the funnel can see. All three are lower-is-better guardrails in D-W10-O-10. The read joins the viewer's id inside the database and projects none, and the creator leaves only as `md5`.
- **Where it is implemented.** `OUTCOME_ENRICHMENT_SQL`, `readOutcomeEnrichment`. Tests: J3, J6; harness: `src/test/db/discoveryOutcomeEnrichment.db.test.ts`.

### D-W10-O-12 — reason labels and the confidence priors (DC-22; E-1)

- **The question.** §35.4: *"whether `0.8 / 0.6 / 0.4 / 0.2` are the right per-class confidence priors to put in front of a user"*; `11` §5 lists "reason labels" among the Recommendation API's outputs.
- **Options considered.** (a) Replace the priors with measured calibration: nothing measures calibration yet (Event Truth is ROADMAP work). (b) Ratify them as class priors, monotone in evidence, labelled as priors. **Chosen.** (c) Withhold confidence from the client: the spec forbids rendering prediction as fact, and a labelled prior is the honest form of it.
- **Decision and rationale.** `CONFIDENCE_PRIOR` is ratified: corroborated 0.8, observed 0.6, stale 0.4, unknown 0.2. It is PROVISIONAL until a calibration exists, and it is replaced only by one. Reason labels are the grounded `01` §11 codes with their plain-language text (`lib/discoveryReasonCodes.ts`), delivered on the `DiscoveryCandidate` projection behind 2361. §35.4's deploy-ordering blocker (`discoveryLiveRank.ts` branch-only) no longer holds: the module is in this tree.
- **Where it is implemented.** No code changed. `src/test/discoveryRulingsPinned.test.ts` R2 pins the priors to this entry.

### D-W10-O-13 — APPROVAL REQUIRED: reason labels to clients (DC-22; 2361)

- **Recommended action, exactly.** After this tree is merged and deployed to production: `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_candidate_projection_enabled';`. 2361 is already applied in production at `false` (§35.4). Then verify at runtime: one `GET /api/discovery` page, signed in, whose items carry `discoveryCandidate.reasons` with non-empty `text`.
- **If approved.** Every Discovery page item carries the projection: truth class, confidence prior, freshness and reasons. DC-22 can reach `C` on that runtime check.
- **If declined.** Served JSON stays byte-identical to today, and DC-22 stays at 4 of 5.
- **Recovery.** Set the flag FALSE. `withDiscoveryCandidates` returns the same array reference again at the next flag read (30-second cache). Nothing is persisted.

### D-W10-O-14 — APPROVAL REQUIRED: 2893 in production (DV-44; E-4)

- **Recommended action, exactly.** Apply `artifacts/api-server/src/migrations/2893_rank_events_retire_writerless_surfaces.sql` to production as written, in its own transaction (the file carries `BEGIN`/`COMMIT`), and record its ledger row. It narrows `rank_events_surface_check` from fifteen labels to eight: it retires `search`, `nearby`, `story`, `event`, `trip`, `profile` and `explore`, and keeps `pulse`, `discovery`, `events`, `compass`, `live_pulse`, `living_page`, `watch_feed` and `wall`.
- **Dependencies.**
  - 2298 must be in force (production admits the fifteen labels: census row DV-44, §48). The file refuses otherwise.
  - Zero rows may carry a retired label. The file counts them and aborts with the counts otherwise.
  - The code already writes only the eight (`src/test/discoverySurfaceWriterProof.test.ts`).
  - Pre-flight, read-only: `SELECT surface, count(*) FROM public.rank_events GROUP BY 1 ORDER BY 1;` and `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rank_events_surface_check';`.
- **If approved.** A write on a retired label is refused with 23514, and the existing rejection counter names the constraint. Today no writer exists for any of the seven. The risk grows with time: a future writer on one of the seven loses rows until the reversal (the file's own "WHAT REVERSING THIS COSTS").
- **If declined.** The seven stay admitted and writerless. DV-44 stays `W`, with the retirement in force in code only.
- **Recovery.** The reversal in 2893's header restores the post-2298 fifteen, a strict superset, so it cannot fail on an existing row:

  ```sql
  BEGIN;
  ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_surface_check;
  ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_surface_check
    CHECK (surface = ANY (ARRAY['pulse','discovery','events','compass','search','nearby','story','event','trip','profile','explore','live_pulse','living_page','watch_feed','wall']::text[]));
  COMMIT;
  ```

  Rows refused in between cannot be recovered.

### D-W10-O-15 — APPROVAL REQUIRED: the keyless-outcome rule and 3420 in production (DV-37)

- **Recommended action, exactly.** Deploy this tree (D-W10-O-5 has no flag: it is a correctness rule of the outcome route). Apply `3420_rank_events_outcome_receipts.sql` to production (§62; A-1 covers `portava-ci` first). Ship the keyed client build (§62.7 H1, built in §63) and make it the oldest supported build.
- **If approved.** Keyed outcomes land once on their receipt, and keyless outcomes from older builds land once within 10 minutes, marked by a NULL key. DV-37 can reach `C` once production shows the receipts.
- **If declined.** The route keeps today's behaviour in production: without 3420 every outcome is recorded keyless, and a keyless retry after a second serve double-counts.
- **Recovery.** Revert the deploy (the rule is code only). 3420's rollback is `db/rollback/2026-09-27-3420-rank-events-outcome-receipts-rollback.sql`.

## W10-T — Trails product rules and admin actions

Lane W10-T (census-discovery §86), branch `disc-w10-t-trails`, cut from `a658174a4`. Migrations 3485–3488. Every entry below is implemented and tested on the branch; nothing is applied outside the local PostgreSQL 16 harness, and no flag is on anywhere.

### D-W10T-1 — What goes behind a flag, and what is a product rule

- **The question.** The lane brief: "This is ranking machinery: the hold is lifted, so put it behind a flag seeded FALSE" (DV-22), and "Health orders the Trail's own modules, behind a flag" (DC-05).
- **Options considered.** (a) Flag everything this lane builds: the §10 caps and the attach rule would stay off, and DV-13/DV-23/DC-20 would stay unenforced. (b) Flag nothing: the owner's condition for lifting the hold is broken. (c) Flag what re-selects or reorders a page from behavioural readings; ship the §10/§4/§15 rules and the admin door unflagged.
- **Decision and rationale.** (c). Two flags, seeded FALSE by 3485: `discovery_trail_exploration_enabled` (§7 content moves, §8 horizon and the `hidden_gems` module, §9 rotation, the Trail's own serve count) and `discovery_trail_health_order_enabled` (§11 order). The §10 diversity rules (DV-13, DV-23) are the same kind of rule the earlier lanes shipped unflagged (the creator and place caps); the attach rule (DC-20) is authorisation (`11` §10); the admin actions change nothing until an admin acts.
- **Reversibility.** Both flags are rows. OFF stops every flagged behaviour: absent and FALSE serve the same bytes and nothing is counted or written (pinned, G0). OFF is NOT the pre-§86 output, because the unflagged §10 rules (D-W10T-2, -4, -5, -15, -16) apply either way; those revert only with the commit.
- **Where it is implemented.** `artifacts/api-server/src/migrations/3485_discovery_trail_exploration_flags.sql`; `services/trails/trailExploration.ts` (`readTrailRankingFlags`); pinned by `src/test/discoveryTrailExploration.test.ts` G0 and `src/test/db/trailsModeration.db.test.ts` W1, W8.

### D-W10T-2 — DV-13: the one-creator bound (D-1 Q3)

- **The question.** §51.10 Q3: "Is the one-creator bound per spotlight module or across the whole Trail page, and at what share? The code's 2 per module per page was not set by the spec or by you."
- **Options considered.** (a) Per module only (2): one creator can hold two slots in each of four modules and trending, i.e. up to eight distinct items on one page. (b) An absolute page cap (2): a small or single-author Trail is emptied. (c) Both: keep 2 per module, and bound a creator across the whole page to a share of its distinct items with a floor.
- **Decision and rationale.** (c). A creator may hold at most max(2, ⌊⅓ × distinct items on the page⌋) distinct items across the union of the page's modules; the per-module cap of 2 stays. At one third, two thirds of the page is somebody else's — the minimum that "never let one creator … dominate" (`02` §10) can mean. Trimmed from the tail, to a fixed point; the same content in two modules counts once; a creator-less item is never trimmed. The earlier lane's 2-per-module is kept as the per-spotlight rule, recorded here as decided.
- **Reversibility.** Constants `TRAIL_PAGE_CREATOR_SHARE` and `MAX_PER_CONTRIBUTOR_PER_PAGE`; nothing stored.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` (`creatorPageBoundRemovals`); `services/trails/TrailService.ts` (`boundCreatorsAcrossPage`). Tests: `discoveryTrailProductRules.test.ts` R4, S5; `db/trailsService.db.test.ts` H2 still holds.

### D-W10T-3 — DC-04 / DV-21: what moves §7's states, and who runs §15's moves (D-1 Q4)

- **The question.** §51.10 Q4: "What moves in-Trail content between §7's six states, and who runs §15's moderation moves (`needs_update`, `stale`, `archived`)?"
- **Options considered.** Content: (a) time alone (ages content regardless of response); (b) moderation alone (does not scale, and §9 is explicitly internal and automatic); (c) §9's own steps — evaluate the normalised response, expand or taper, retest — plus §8's horizon. Trail: (a) automatic staleness from a content-age rule (no spec threshold); (b) moderation (§15 lists "mark stale" among moderation ACTIONS).
- **Decision and rationale.** Content: (c), behind `discovery_trail_exploration_enabled`. On measured response (Discovery-surface `rank_events`, the rows whose outcomes are recorded) with §9's existing thresholds (`TRAIL_EXPOSURE_MIN_EVIDENCE` 25, `TRAIL_EXPOSURE_EXPAND_RATE` 0.05): just_arrived/rediscovered → archived_from_active_rotation on taper; → growing on expand at the exploration ceiling (500) or when §8's 7-day horizon passes; growing → archived on taper, → featured on expand sustained 7 more days; featured → growing on taper, → evergreen on expand at 30 days a member and 7 in state; evergreen → archived on taper; archived → rediscovered on expand after a 7-day rest (§9 step 5). A duration that cannot be read (3486 absent) makes no time-based move. Decided at read time, served from the decided state, persisted by compare-and-set under 3381. Trail lifecycle: (b), admin moves through one audited function (needs_update, stale, reactivation, archive); `proposed → active` on first content stays as built. Local Picks' source: `02` §5's "Portava-curated catalog" — an audited admin curate action is the one writer of `source = 'curated'`, over content verified public.
- **Reversibility.** Flag OFF stops every content move; states already moved stay (they are §7 states the relation admits; an admin can see them). Admin moves are audited and reversible within 3381's relation (archive is terminal by §7's own design).
- **Where it is implemented.** `services/trails/trailExploration.ts` (`decideContentTransition`, `persistContentTransitions`); `services/trails/TrailService.ts` (`trailModulesExplored`); 3486 (`trail_admin_move_lifecycle`, `trail_admin_curate`, the state stamp trigger); `routes/adminTrails.ts`. Tests: `discoveryTrailExploration.test.ts` L1, L3, L4; `db/trailsModeration.db.test.ts` W2, W8, W10.

### D-W10T-4 — DV-23: §10's five clauses (D-1 Q7)

- **The question.** §51.10 Q7: "Does §10's 'preserve access through more from this place' require a route that returns the held-back items, or is the place's own page that access?" and §51.6's FAILs on media, viewpoints, content similarity and venue linking.
- **Options considered.** For access: (a) the place page (it does not list the Trail's held-back posts); (b) a Trail route returning them. For viewpoint: (a) sentiment/stance (no such signal exists); (b) the same person's repeated take on the same place. For similarity: (a) an embedding (none on the Discovery path, and it would fail open); (b) the token-set similarity §5 CHECK 1 already uses.
- **Decision and rationale.** Access (b): `GET /v1/discovery/trails/:id/places/:placeId/more` returns, per module, exactly the members that module counted, from one computation. Viewpoint (b): at most one item per (creator, place) per module. Similarity (b): a post whose text is ≥ 0.8 token-set similar (at least 3 tokens) to one already on the page is held back, and counted for its place. Venue link: a post's canonical `places` row and a `discovery_places` member are one venue when their normalised names match and they are within 1.5 km — `lib/canonicalLocations.matchCanonical`'s own venue rule, reused. Media: D-W10T-5.
- **Reversibility.** Pure rules; nothing stored.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` (`diversifyTrailModule`); `services/trails/TrailService.ts` (`readMemberGeography`, `linkVenueClusters`, `moreFromThisPlace`); `routes/trails.ts`. Tests: `discoveryTrailProductRules.test.ts` R5–R7, S1, S4.

### D-W10T-5 — E-11: media diversity and "stale" content

- **The question.** §69.1 E-11: "stale content and media diversity".
- **Options considered.** Media: (a) a hard cap per type (empties a page of one type); (b) off (§51.6 FAIL); (c) a work-conserving share. Stale: (a) age alone (≥ 90 days) — makes evergreen content "stale" by definition; (b) out of rotation, or old and not durable.
- **Decision and rationale.** Media (c): a post's own media kind (`primary_media_type`, else `media_type`, else text) or the member's type; one kind may hold at most half of a module page while another kind waits; a page that would stay short is refilled from the held items. Stale (b): archived_from_active_rotation, or ≥ 90 days old and neither evergreen nor featured (`03` §3 "persistent usefulness"). One predicate serves §11's metric and the health order.
- **Reversibility.** Constants; `TRAIL_HEALTH_MODEL_VERSION` moved to `trail-health-v2`, so snapshots before and after are distinguishable.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` (`isTrailStaleObject`, `TRAIL_MEDIA_SHARE_PER_PAGE`). Tests: R1, R5.

### D-W10T-6 — DV-22: where a Trail's own serves go (D-1 Q2)

- **The question.** §51.10 Q2: "May a Trail module's own serves be written to `rank_events`, and under which surface? `discovery` is the only admitted fit, but it would feed Discovery's place momentum and make `trending_now` self-reinforcing; a `trail` surface needs a migration widening the surface CHECK."
- **Options considered.** (a) `rank_events` / `discovery`: self-reinforcing, and moves another surface's momentum. (b) A new `trail` surface: every `rank_events` reader would have to learn to exclude it. (c) A Trail-owned counter read only by §9's qualification.
- **Decision and rationale.** (c), 3487: per (Trail, member, UTC day) a count, no viewer id, no outcome. It counts toward §9 steps 1–2 (the 500 ceiling, the rotation order) and NOT toward step 3's rate, because a Trail page records no outcome and would drag every rate toward taper. Rotation: the page's reserved slots (20 %) go to the least-exposed qualified item, oldest first, so each page reaches further into the backlog; deterministic, no randomness. An unread count reserves nothing (`null`).
- **Reversibility.** Flag OFF: nothing is read or written. The table can be dropped by its rollback.
- **Where it is implemented.** 3487; `services/trails/trailExploration.ts` (`rotateExplorationSlots`, `recordTrailModuleExposures`). Tests: `discoveryTrailExploration.test.ts` L2, L5, L7; `db/trailsModeration.db.test.ts` W7, W8.

### D-W10T-7 — DC-05: the geographic cell, `new_creator_exposure`, and the health order (D-1 Q6)

- **The question.** §51.10 Q6: "What geographic cell defines `geographic_diversity`, and is `new_creator_exposure` meant to be an exposure share, rather than the membership share it is today?"
- **Options considered.** Cell: the Map's zoom-11 cell (~19.5 km: every member of a city Trail in one cell), a geohash, or the Map's own degree grid continued to neighbourhood scale. Denominator: every member (a route has no location, so never measured) or the located members. Exposure: membership share, or impressions.
- **Decision and rationale.** Cell: `lib/mapAggregation`'s degree grid at zoom 14 (0.02197°, ~2.4 km), from the member's PLACE coordinates (a place member's own row; a post's canonical place; an event's venue), never an author's GPS; server-side only. Measured over the members that have a cell; no cell at all stays null. `new_creator_exposure`: impressions (every surface, 30-day window) on the members of contributors whose first member in the Trail is under 30 days old, over impressions on every attributed member; null when unread or nothing attributed was shown. Health order (flag): inside every module, the members §11 counts against the Trail — stale objects, and the dominant contributor's members while `contributor_concentration` > ⅓ — are served after the others, each partition in the module's order; nothing is removed (§11 "not silently erase").
- **Reversibility.** Model version `trail-health-v2` / feature version `trail-member-rows-v2` mark the change on every snapshot. The order is a flag.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` (`trailGeoCell`, `newCreatorExposureShare`, `healthDemotedRowIds`); `services/trails/TrailService.ts` (`readMemberGeography`, `readMemberImpressions`). Tests: R2, R3, S2; L6; the two restated cases in `discoveryTrailModifier.test.ts`.

### D-W10T-8 — DV-24: who may declare §6's other edge kinds (D-1 Q1)

- **The question.** §51.10 Q1: "Who may declare two Trails `related`, `seasonal_variant`, `geographic_sub` or `experience_branch` — the proposer, the owner of either Trail, moderation only, or a system job — and must such an edge be reviewed before it is navigable?"
- **Options considered.** Moderation only (nothing gets declared); the owner of either Trail unreviewed (anyone can bolt their Trail onto a popular one); a system job (no rule to derive it from; `trail_relations` is read by no one, §61.6).
- **Decision and rationale.** The creator of either Trail may declare `parent`, `related`, `seasonal_variant`, `geographic_sub` or `experience_branch`. Declared by the creator of BOTH Trails it is navigable at once — the standing the proposer's own `child` edge already has. Declared by the creator of ONE, it is `pending` and navigable only after moderation accepts it (audited); moderation may also declare or reject outright. Anyone else is refused (403). `child` stays the proposal's.
- **Reversibility.** `review_state` per edge; rejecting hides it.
- **Where it is implemented.** 3486 (`trail_edges.review_state`, `trail_admin_review_edge`); `services/trails/TrailService.ts` (`declareTrailRelation`, `readUnacceptedEdges`); `routes/trails.ts`. Tests: S6; W5.

### D-W10T-9 — DC-20: who may attach, and whether a suggestion spends §4's budget (D-1 Q5)

- **The question.** §51.10 Q5: "Who may `attach` content to a Trail at the author's-statement confidence, and does a third party's `suggest` count against the content's §4 budget? Which table does a `place` member name (`discovery_places` or `places`), and what is an `itinerary`?"
- **Options considered.** Attach by anyone who can see the content (today: a stranger can take a post's one primary slot); by the owner only. Suggestions as memberships (spend the owner's budget) or as pending proposals.
- **Decision and rationale.** Attach at the statement confidence: only the content's owner — post author, event host, route owner, community-place submitter — and, for authorless content (a canonical place), the Trail's creator; anyone else is refused `not_content_owner`. A suggestion by the owner is a membership at the suggestion confidence, as before; by anyone else it is a PENDING row (3488) that spends no budget and is served by nothing until the owner accepts it (then it is attached as the owner, under §4's cap) or declines it. Without 3488 a stranger's suggestion fails closed (503). `place` names either table, as §61.4 found the read path already does. `itinerary` stays refused as unverifiable: it is not a member type until a table holds one.
- **Reversibility.** Rules in code; pending rows can be declined.
- **Where it is implemented.** 3488; `services/trails/TrailService.ts` (`routeLabelsByOwnership`, `listPendingSuggestions`, `decideSuggestion`); `services/trails/trailAttachIntegrity.ts` (`ownerIds`); `routes/trails.ts`. Tests: S7; W9.

### D-W10T-10 — E-5: Trail merge semantics

- **The question.** §69.1 E-5: "Trail merge"; `02` §15 "merge duplicate Trails"; `11` §8 "Trail merge".
- **Options considered.** Delete the source (loses history and breaks links); move members only (orphans follows, edges, children, reports); a full re-home with the source archived and pointing at the target.
- **Decision and rationale.** The last, in one audited transaction: the source's members move to the target, except content the target already holds, which is dropped (the target's label stands, so §4 is never charged twice) with its open reports re-homed onto the target's row; the source's open Trail-level reports are resolved `merged`; followers move (deduplicated); relationships are re-homed (a source↔target edge is dropped, never made a self-edge); children are re-parented; the source becomes `archived` with `merged_into_trail_id`; its health snapshots stay as history. Refused: the same Trail, an archived side, a target that descends from the source, an unknown Trail.
- **Reversibility.** Not automatically reversible (archive is terminal in §7). The audit row records every count; the source row and its history survive.
- **Where it is implemented.** 3486 (`trail_admin_merge`); `services/trails/trailAdmin.ts`; `routes/adminTrails.ts`. Tests: `adminTrailsRoutes.test.ts`; W3.

### D-W10T-11 — Trend integrity review

- **The question.** `11` §8 "trend integrity review" (DV-74), with `03` §12's anti-gaming.
- **Options considered.** A report only; or a verdict that can change what is published.
- **Decision and rationale.** Verdicts `confirmed`, `suspect`, `suppressed`, `cleared` on a Trail or a place, the newest in force, append-only, with the evidence the admin saw (the raw reading, which `11` §4 permits for admin diagnostics). `suppressed` on a Trail makes GET …/trending a measured `false` with no items; an unreadable review answers `null`, never a claim. Suppression of a PLACE is recorded but not yet read by the trend classifier: that file is the trending lane's, and the hunk is routed (§86.9).
- **Reversibility.** A later `cleared` lifts a suppression.
- **Where it is implemented.** 3486 (`trend_integrity_reviews`, `trend_integrity_review_record`); `services/trails/TrailService.ts` (`readTrendReviewVerdict`); `services/trails/trailAdmin.ts` (`trailTrendEvidence`). Tests: S8; W6.

### D-W10T-12 — B-5: non-public members in a Trail — **APPROVAL REQUIRED** (consent)

- **The question.** §64.9 Q1–Q3 and §61.12 Q4: should a Trail resolve relationships — friends for a friends-only event, invitees for an invite-only one, followers or trip members for a post, eligibility for a gated event — and serve such content to them?
- **Decided (routine, consistent with users' choices):** a Trail serves only content the viewer could already see, and never widens who sees it. The fail-closed §64 rule (a non-public member to its author, host, owner or accepted crew only) meets that rule and stays.
- **Why the rest is not decided here.** Serving a friends-only event or a followers-only post inside a public discovery space, even only to people who could open it elsewhere, is a new use of the author's content beyond the surface they chose it for. That is a consent question.
- **Options.** (A) Keep fail-closed (today). (B) Resolve each relationship exactly as the source surface does, per viewer. (C) As B, but only for content whose author has opted in ("show in Trails"), default off.
- **Recommended action.** Keep (A) in production. If widening is wanted, approve (C) with the opt-in defaulting to off; do not approve (B).
- **Consequence of approving (C).** A per-content opt-in field and the per-viewer relationship reads must be built; members widen only for opted-in content. **Of declining.** Nothing changes; non-public members stay their author's.
- **Recovery path.** The rule lives in `servableMembers` / `memberAccessFor`; reverting (C) is withdrawing the opt-in reader.

### D-W10T-13 — Production activation — **APPROVAL REQUIRED**

- **Recommended action.** Apply 3485, 3486, 3487 and 3488 (in that order, after 3381 and 3415) to `portava-ci`, then production. Keep both 3485 flags FALSE in production until a Trail exists there; then turn on `discovery_trail_exploration_enabled` first, and `discovery_trail_health_order_enabled` only after a week of `trail_member_exposures` rows shows the rotation reaching the backlog.
- **Consequence of approving.** Admin moderation, merge, curation, edge review and trend review become available; stranger suggestions stop failing closed; with the flags, Trail pages are served from §7 states.
- **Consequence of declining.** Admin Trail actions and relation declarations answer 503; a stranger's suggestion answers 503 (it never spends the owner's budget); the §10 rules and the attach rule still apply.
- **Recovery path.** The four rollbacks under `db/rollback/2026-09-28-348[5-8]-*`; the flags OFF stop every flagged behaviour (absent = FALSE, pinned); they do not restore pre-§86 output, because the unflagged §10 rules apply either way.

### D-W10T-14 — Retention of the three new stores — **APPROVAL REQUIRED** (retention)

- **What is stored.** `trail_member_exposures`: counts, no personal data; grows one row per served member per day. `discovery_admin_audit_events`: the acting admin's id is kept as a fact after that admin's erasure (as §52's `creator_ledger_audit_events`). `trail_content_suggestions`: who suggested what (SET NULL on the suggester's erasure; deleted with the owner).
- **Recommended action.** Prune `trail_member_exposures` rows older than 31 days daily (only 30 are read). Keep audit rows (moderation accountability, as §52/C-11). Delete decided suggestions 90 days after `decided_at`.
- **Consequence of approving.** A scheduled prune must be built; nothing read changes. **Of declining.** Rows accumulate; nothing served changes.
- **Recovery path.** None needed for declining; an approved prune is a job that can be stopped.

## W10-R1 — Trending: the held designs built (census-discovery §84)

*Lane W10-R1, 2026-09-28, branch `disc-w10-r1-trending` from `6d1e7090b`. Every entry below is implemented behind a flag seeded FALSE by migration 3475, and every flag-off value is byte-identical to the tree before this lane (`artifacts/api-server/src/test/discoveryDerivedProvenanceGolden.test.ts` G1–G11). Controlled evidence only; nothing here is a claim about real-world effectiveness.*

### D-W10-R1-1 — a served impression is exposure, not activity

- **The question:** census §66.9 Q66-1: *"Should a served impression count as trend activity at all, or only as the exposure that activity is divided by?"*
- **Options:** (a) keep counting it as activity — velocity then rises with how often the ranker serves a place (§66.2, T1/T2), which is the opposite of `03` §7; (b) drop impressions entirely — no denominator, so a place served ten times as often looks ten times as busy; (c) count it as the window's exposure and divide activity by it.
- **Decision:** (c), the recommended reading. `03` §5 lists *"qualified impression conversion"*, not the impression, among positive signals; `03` §7 says *"Trend velocity must be normalized by: exposure"*; §66.2 derives exactly this change. An outcome at `outcome_at` is the activity; every served row at `served_at` is one exposure.
- **Reversibility:** a flag flip (`discovery_trend_normalised_enabled` OFF) restores v1 on the next load and the next rebuild; v2 rows already stored carry `model_version = discovery-trend-state-v2` and are not read as v1. Nothing is lost.
- **Where:** `artifacts/api-server/src/lib/discoveryTrendNormalised.ts` (`aggregate`), `computeTrendStates`/`computeLocalMomentum` `{ model: "v2" }`, migration 3477 `discovery_trend_windows_v2`. Tests: `discoveryTrendNormalised.test.ts` V1–V4, harness `discoveryTrendNormalisedParity.db.test.ts` N2/N4.

### D-W10-R1-2 — the minimum exposure

- **The question:** Q66-1's second half: *"below how many exposures is a place's rate not a trend reading?"* No spec gives a number.
- **Options:** the disclosure k (15) — a privacy number, not a statistical one; 100 — safe, but most places would never read; a statistical floor.
- **Decision:** **30 exposures per window** (`TREND_V2_MIN_EXPOSURES`). At n = 30 the worst-case 95 % half-width of a sample proportion is 1.96 × 0.5/√30 ≈ ±0.18, the conventional floor for the normal approximation; below it one extra exposure moves the rate by more than 1/30. A window below the floor is *no reading*, never rate 0.
- **Reversibility:** one constant in TypeScript and one in 3477 (pinned equal by Q1); a new migration changes the SQL. Nothing is lost.
- **Where:** `TREND_V2_MIN_EXPOSURES`, 3477 `c_min_exposures`. Tests: V3, Q1, N4 (place H).

### D-W10-R1-3 — diversity of evidence in the classifier and the scalar

- **The question:** census §58.4 DV-32: *"`03` §12's 'diversity of evidence' is present only at the API's disclosure boundary, not in the classifier or the scalar"*; §58.5 design 4 left c and n to the owner.
- **Decision:** activity is summed per **independence cluster**, each capped at **one save's weight (3)**; every claim (and every "had history" window) needs **≥ 3 clusters**. 3 is derived, not chosen: with the cap 3 and the smallest positive weight 2, one cluster's share of capped activity is at most 3/(3+2(n−1)) — 60 % at n = 2, 43 % at n = 3 — so 3 is the smallest count at which no single cluster can hold a majority. Emerging's *"broad independent confirmation"* (`03` §3, DV-28) is the same floor measured on clusters, not accounts.
- **Reversibility:** constants plus a flag. Nothing lost.
- **Where:** `TREND_V2_GROUP_CAP`, `TREND_V2_MIN_GROUPS`, `clusterWindow`, 3477. Tests: D1–D4, E1, N4 (F, G).

### D-W10-R1-4 — independence is Sensing's clustering, reused

- **The question:** DV-34 (§55.5): *"Consuming [Sensing's independence clustering] for adoption convergence is ranking machinery under the 2026-08-15 hold."*
- **Options:** a new detector; the social graph (circles, follows) or Trip crews — a people-graph join that `lib/intelIndependence.ts` itself refuses (*"privacy-invasive identity joins this module refuses to perform"*); reuse the module as it is.
- **Decision:** `clusterByIndependence` over each window's positive outcomes: actor = `user_id`, no group token (rank_events carries none), value = `item|outcome`, observed at `outcome_at`, so different accounts taking the same action on the same place within 30 s are one unit (engagement pods, `03` §12). Circles and crews are not joined; that limit is recorded, not hidden.
- **Where:** `clusterWindow`; 3477's islands + recursive components (mirrors union-find exactly: every actor on one ≤30 s island is one unit). Tests: D2, D3, N2/N4 (G).

### D-W10-R1-5 — the six `03` §7 normalisers

- **The question:** DC-06, `03` §7: exposure · creator baseline · Trail baseline · location baseline · time-of-day · content age. The spec names them and defines none.
- **Decision:** exposure — D-W10-R1-1. **Time of day** — direct standardisation over four six-hour UTC bands: the baseline window's per-band conversion re-weighted to the recent window's exposure mix, over its pooled conversion (for one place a UTC band is a fixed shift of its local band). **Content age** — rows inside a place's launch window (48 h after `discovery_places.created_at`, one recent window) never count toward a baseline window; and the lifecycle horizon is the content type's (D-W10-R1-7). **Creator / Trail / location** — v is divided by M, the **largest** of three peer medians of the same v (same submitter; any shared non-archived Trail; same Local Pulse cell), each only over ≥ 3 other places; the largest, not the product, because the groups overlap and a product would divide one shared surge out two or three times.
- **Reversibility:** flag; constants. Nothing lost.
- **Where:** `timeOfDayFactor`, `aggregate` (launch), `peerFactors`, 3476 `discovery_trend_place_context()`, 3477. Tests: Z1–Z4, N1, N2, N4 (I, J, K, L).

### D-W10-R1-6 — the Local Pulse cell

- **The question:** DV-29, `03` §3: *"Local Pulse — Momentum within a geographic radius or neighborhood."*
- **Decision:** a **named neighbourhood within its city** (`discovery_places.neighborhood`, trimmed, case-folded) when the place has one; otherwise the **0.02° grid square** (`lib/mapTravelers` `AREA_GRID_DEG`, ≈2.2 km, the finest cell the map shows). An OSM place with no `discovery_places` row has no cell (recorded limit).
- **Where:** `cellKeyOf`, `buildPlaceTrendContext`, 3476, `area_momentum`. Tests: P1, N1, N3.

### D-W10-R1-7 — `03` §4's content-type lifecycle

- **The question:** DV-28 (b): *"Trend lifecycle must depend on content type. A nightclub event decays in hours. A temple guide may remain valuable for years."*
- **Decision:** three classes matched exactly on `category` then `place_type`: **ephemeral** (event, festival, concert, performance, party) decays **12 h** after its last positive activity; **enduring** (temple, church, museum, landmark, beach, park, …) **365 d**; everything else **standard**, **30 d**. Mapping from the six `03` §9 states: emerging→emerging, trending→growing, established→**evergreen** when non-ephemeral and sustained across all three windows, else **peak**; rediscovered→rediscovered; cooling→cooling, or **inactive** past the horizon; unknown→inactive past the horizon, else no claim.
- **Where:** `contentClassOf`, `lifecycleOf`, 3477 `place_momentum_lifecycle_v2`, `place_momentum.lifecycle_state`. Tests: E2–E4, N4 (D, N).

### D-W10-R1-8 — the flags and the version strings

- **Decision:** five capability flags, all seeded FALSE by 3475 (postcondition refuses TRUE): `discovery_trend_normalised_enabled`, `discovery_trend_rebuild_scheduler_enabled`, `discovery_trend_snapshot_retention_enabled` (metadata `keep_days: null`), `discovery_trend_lists_enabled`, `discovery_trend_rediscovery_retest_enabled`. v2 stamps model `discovery-trend-state-v2` / `discovery-place-velocity-v2` and feature `discovery-exposure-activity-v3`; v1 keeps its model strings.
- **Where:** 3475; `TREND_STATE_MODEL_VERSION_V2`, `TREND_FEATURE_VERSION_V2`, `LOCAL_MOMENTUM_*_V2`. Tests: F1–F5, Q1.

### D-W10-R1-9 — what a trend reason says

- **The question:** DV-33 / §58.12 Q3: *"should it name the signal that drove the trend (saves, trip adds), which is not computed today?"*
- **Decision:** the **driver** is what a strict majority of the recent window's independence clusters did: **trip adds**, else **saves**, else **independent groups** (true of every v2 claim, which needs ≥ 3 clusters). Cooling and unknown name none. **First-time visitors have no input**: rank_events holds no visit history per traveller per destination, so no reason claims them. Sentences avoid every word the trend API's closed-shape guard forbids (a first draft said "travellers"; B2 caught it and the sentence changed, not the guard).
- **Where:** `driverOf`, `explainTrendReading`, `TREND_DRIVER_CODES`, 3477 `place_momentum_reason_v2`. Tests: R1, R2, Q3, L-I1.

### D-W10-R1-10 — B-3: may a public reason name a neighbourhood?

- **The question:** §58.12 Q3 / B-3: *"May a public trend explanation name a neighbourhood, as `03` §11's 'Rising quickly in Sukhumvit tonight' does?"*
- **Is it consent?** No. No individual's data or choice is disclosed: the sentence names an area's aggregate over many people, which is disclosure policy (the k-anonymity floor §58.2 already applies), not a user's consent. No APPROVAL REQUIRED entry is needed.
- **Decision (conservative):** a reason names a neighbourhood only when (1) it is a **named** neighbourhood, never a grid square (whose key is a coordinate); (2) the neighbourhood's own Local Pulse reading carries **≥ `PRIVACY_THRESHOLD_V1.minUniqueActors` (15) distinct travellers in both windows** — §58.2's k, applied to the area named; (3) the place's own state is disclosable under §58.2. Otherwise the sentence has no location. No time-of-day word ("tonight") is used: no place time zone is stored.
- **Where:** `mayNameNeighbourhood`, `v2Trend`, `localPulse`. Tests: L-I1, L-I2, L-G1.

### D-W10-R1-11 — DC-07 / D-2: rebuild cadence

- **The question:** §58.12 Q4: *"At what cadence should rebuild_place_momentum run …?"*
- **Decision:** **every 5 minutes, on the 5-minute boundary** — half the 10-minute freshness bound the API serves a run for, so one late or failed tick does not make every answer stale; flooring `p_now` makes two instances write the same run. The third part of Q4 (serve a stored state longer than 10 minutes?) is answered no: the bound is unchanged.
- **Where:** `artifacts/api-server/src/lib/discoveryTrendRebuildScheduler.ts`, one line in `src/index.ts`. Tests: S1–S6.

### D-W10-R1-12 — APPROVAL REQUIRED: how long trend snapshots are kept

- **Why not decided here:** data-retention policy is not delegated.
- **Recommended action, exact values:** set `feature_flags.metadata = '{"keep_days": 30}'` and `enabled = true` on `discovery_trend_snapshot_retention_enabled`, together with (never before) turning on `discovery_trend_rebuild_scheduler_enabled`. 30 days is the trend model's longest window: an older run describes a window nothing reads again.
- **If approved:** each tick deletes `place_momentum` and `area_momentum` runs older than 30 days. At a 5-minute cadence that bounds the store at ~8,640 runs × places with activity.
- **If declined:** keep the retention flag FALSE; runs accumulate without bound once the scheduler is on (288 runs a day). Do not turn the scheduler on without a retention answer.
- **Recovery:** flip the flag OFF or set `keep_days` larger; deleted runs are derived and rebuildable from `rank_events` for any instant still inside `rank_events`' own retention (`rebuild_place_momentum(p_now)` is idempotent per instant).

### D-W10-R1-13 — DC-21: the three list actions

- **The question:** §58.5 design 7: *"ORDERED — by what is the question."*
- **Decision:** lists name only states that claim a **gain** (`03` §1 "gaining meaningful travel relevance now"): trending, then emerging, then rediscovered; within a state by v2's normalised velocity (never served), then id. Each item must pass the k-floor, be an **active** community place, pass the author policy for this viewer (blocks both ways, standing) and not be suppressed or coarsened by a protected zone (an unreadable zone policy withholds every positioned place). **Personalised** orders by the viewer's Compass category affinity first and says `basis: "none"` when there is none. **Emerging Trails**: the v2 model over each active Trail's **place** members only (a post, event or route-plan member may be withheld from the viewer, §64), listed above the k-floor. **Local Pulse** lists named neighbourhoods only. A v1 run reads `not_located`.
- **Where:** `lib/discoveryTrendExplanation.ts` (foot), `routes/discoveryTrending.ts`, `lib/discoveryTrailAffinity.ts` `trailTrendStatesFromRankEvents`. Tests: `discoveryTrendingLists.test.ts` L-A–L-H.

### D-W10-R1-14 — DV-31: retesting a cooled place

- **The question:** `02` §9.5 *"periodically retest promising items"*; §58.5 design 3.
- **Decision:** candidates are v2 readings that are `cooling`, or `unknown` after ≥ 3 clusters of history — never `inactive`, never a place not on the page. One pick per candidate set per **24 h**, rotated by hash(period, place); moved to the **middle** of the page (never position 0, never demoted), **one per page** (inside the ruled 15–25 % exploration band for pages of ≥ 4). The retest is measured by the existing exposure log and the next rebuild.
- **Where:** `lib/discoveryTrendRediscovery.ts`. The serve-path call is hunk H-W10R1-1 in `lib/discoveryPde.ts` (another lane's file; census §84). Tests: R1–R5.

### D-W10-R1-15 — DV-80 / D-2: the two unmeasured monitors, and which bounds the governor may move

- **The question:** §58.12 Q5: *"Which policy bounds may the Ecosystem Governor move, within what ranges and on which monitor values — and is it automatic, or a proposal an admin approves? And what do 'new creator' and 'success' mean?"*
- **Decision, monitors:** **new creator** = a submitter whose first `discovery_places` row is in the 30 days before the window's end; **success** = a positive outcome by someone other than the creator on a served place of theirs; value = successful / served new creators, with opportunity beside it. **Stale content** = an item first served ≥ 30 days before the window's end with no positive outcome in those 30 days; value = its share of exposures.
- **Decision, bounds:** proposals only (an admin applies them; nothing is automatic, nothing per user), only over a measured sample ≥ 30, only inside an existing range: concentration HHI > 0.25 → `MAX_PER_CONTRIBUTOR_PER_PAGE` −1 in [1, 2]; new-creator success < 0.5 → `GOVERNOR_BUDGET_MIN_PCT` +5 in [15, 25]; repeated recommendations > 0.5 → the seen-set window ×2 in [24 h, 7 d]; Trail freshness < 0.5 → `TRAIL_EXPLORATION_SLOT_PCT` +5 in [15, 25]. Spam, stale content, hidden-gem exposure and duplicate saturation move no bound (reasons in the module).
- **Where:** `lib/discoveryEcosystemGovernor.ts` (foot), `lib/discoveryEcosystemBounds.ts`, `scripts/reportDiscoveryEcosystem.ts`. Tests: `discoveryTrendOps.test.ts` G1–G6, `discoveryEcosystemGovernor.test.ts`, harness `discoveryEcosystemReport.db.test.ts` E1.

### D-W10-R1-16 — the feature version's name

- **Decision:** 3435's `discovery-weighted-activity-v2` is renamed `discovery-row-activity-v2` by **amending 3435 itself** (applied to the local harness only), so the TypeScript constants and 3435's rows agree and no migration is needed for the name. The trend API's B2 guard is restored to full strictness (its exact-string exception removed); B3 still pins the constant.
- **Where:** 3435 (constant + postcondition), `TREND_FEATURE_VERSION`, `LOCAL_MOMENTUM_FEATURE_VERSION`. Tests: B2, B3, F3, V1–V5.

### D-W10-R1-17 — APPROVAL REQUIRED: production activation of §84

- **Recommended action, exact values, in order:** (1) apply 3435 (amended), 3475, 3476, 3477 to `portava-ci` and run the harness suites there; (2) apply them to production; (3) turn on `discovery_trend_rebuild_scheduler_enabled` **only with** D-W10-R1-12 approved; (4) turn on `discovery_trend_normalised_enabled`; (5) after one production day of v2 runs, turn on `discovery_trend_lists_enabled` (it also needs `discovery_trending_api_enabled`, §58.12 Q1); (6) `discovery_trend_rediscovery_retest_enabled` only after hunk H-W10R1-1 is merged.
- **If approved:** stored trend states become v2 (exposure-normalised), the trend API serves driver-led reasons and four lists, and — only under `discovery_ranking_modifiers_enabled` (2289, still FALSE) — the ranker's momentum term becomes v2.
- **If declined:** every deployment stays byte-identical to today (all flags FALSE; 3477's dispatcher runs 3435's body).
- **Recovery:** each flag OFF takes effect on the next request / load / rebuild; the rollbacks in `db/rollback/2026-09-28-347{5,6,7}-*` restore 3435's function and drop the v2 objects (3476's drops the v2 columns and `area_momentum`, a retention decision in itself).

### D-W10T-15 — DV-23 follow-up: every list applies §10's five clauses, and nothing held back is unreachable

- **The question.** An independent verifier ran at `de2ae1ca0` and found two gaps. GET …/trending still used the old creator-and-place pass: no text, no media kind, no viewpoint, no venue link, and no access to what it held back. On /modules, items held by the per-module creator cap, and items removed by the DV-13 page bound, were neither counted nor listed; in one fixture the bound emptied a whole module and nothing listed the removed posts. D-W10T-4(b) promised access to what a page holds back.
- **Options considered.**
  - (a) Count only the place-clause items, and let the rest be "pagination". The creator cap and the page bound then silently hide content (§11: "not silently erase").
  - (b) Backfill the page bound from other creators. It changes what DV-13 bounds, and still leaves the per-module cap's items unreachable.
  - (c) Record every item any list holds back, whatever held it, under its place when it has one, and as unplaced otherwise, and make all of them reachable.
- **Decision and rationale.** (c), with four parts.
  - GET …/trending runs the same pass every module runs (`diversifyTrailModule`), over venue-linked clusters, with each post's text and media kind.
  - Every held item counts under its place. Trending serialises `moreFromThisPlace` only when it is non-empty, so a response with nothing held keeps its prior shape.
  - `GET …/places/:placeId/more` lists each module's held items for the place, and trending's under the key `trending`.
  - A new `GET /v1/discovery/trails/:id/more` lists everything held back, per list, by place and unplaced. An item with no place still has a door.
  - The page bound itself is unchanged (D-W10T-2); what it removes is recorded in the module that removed it.
- **Reversibility.** Code only; no migration, no flag. Reverting restores the earlier counts.
- **Where it is implemented.**
  - `lib/discoveryTrailHealth.ts`: `diversifyTrailModule`, including `heldBackUnplaced`.
  - `services/trails/TrailService.ts`: `trailTrending`, `boundCreatorsAcrossPage`, `moduleSaturationItem`, `heldBackLists`, `moreFromThisPlace`, `moreFromThisTrail`.
  - `routes/trails.ts`.
  - Tests: `discoveryTrailProductRules.test.ts` F1–F6, with G1–G3 and H pinning DV-13 and the wiring.

### D-W10T-16 — DV-23 round 2: past the page is held, not "pagination"

- **The question.** The verifier re-ran at `8dcbb5acc` and found that `diversifyTrailModule` stopped classifying once a page was full: "beyond the page is pagination, not suppression". No route paginates a module (/modules is fixed at 8 items, trending at 20), so items after the page filled were neither counted nor listed. Four posts about a place that arrived after the page filled vanished from "more from this place".
- **Options considered.**
  - (a) Real pagination: a cursor per module and per list. That is new client surface for every spotlight, and each page would need its own §10 pass.
  - (b) Keep classifying past the page: every candidate the page had no room for is held (`beyond_page`), counted under its place, or listed as unplaced.
- **Decision and rationale.** (b). A spotlight is a bounded page by design (`02` §8: "without creating a million-item chronological feed"). Access to the rest is §10's "more from this place", which the "more" routes already provide (D-W10T-15). It holds on /modules and on trending alike.
- **Reversibility.** Code only.
- **Where it is implemented.** `lib/discoveryTrailHealth.ts` `diversifyTrailModule`. Tests: `discoveryTrailProductRules.test.ts` J1 and J2.

### D-W10T-17 — DV-23 round 2: the 500-member window and clause 5

- **The question.** `readMembers` reads a Trail's newest 500 members. Members past 500 were never served or listed anywhere. How does "preserve access" hold for a larger Trail?
- **Options considered.**
  - (a) Raise the window: it moves the problem and makes every read heavier.
  - (b) An unbounded /more.
  - (c) A bounded page with a cursor.
- **Decision and rationale.** (c).
  - Every list, and the page it serves, is computed over the newest `TRAIL_MEMBER_WINDOW` (500) members, now in a total order: created_at, then id.
  - When the window is full, both "more" routes return `next`, an opaque cursor at the window's edge.
  - `?cursor=` returns one bounded page of up to `TRAIL_MORE_PAGE_SIZE` (200) older members, as the list `beyond_window`, by place and unplaced, with the cursor to the page after. It is keyset on (created_at, id), so a tie at the edge is neither repeated nor skipped.
  - A cursor page is the viewer's view (`servableMembers`), like every other read. A malformed cursor is 400.
- **Reversibility.** Code only; the cursor is opaque, so its format may change.
- **Where it is implemented.**
  - `services/trails/TrailService.ts`: `TRAIL_MEMBER_WINDOW`, `olderMembersPage`, `moreFromThisPlace` and `moreFromThisTrail`.
  - `routes/trails.ts`.
  - Tests: J4, and J3 for the viewer's view.

## W10-S1 — search safety and search product decisions

Lane W10-S1, 2026-09-28, branch `disc-w10-s1-search`. Census section: census-discovery §80. Rows: B02, DV-83, B04, A08. Owner items from §69.1: D-8 (both halves), A-3, E-9.

### D-W10-S1-1 — emoji in search (B02; D-8, first half)

- **Question:** census-discovery §6 D5, re-keyed D-8 in §69.1: *"Emoji in queries. Stripping them changes which results a query returns."* The options are §46.5's.
- **Options considered:**
  - **(a) status quo.** "🔥 bar" finds only rows whose text literally holds "🔥 bar", so "Sky Bar" is missed. No 400s.
  - **(b) strip emoji from the search key**, using the platform's rule. "🔥 bar" finds "Sky Bar" and the emoji-named row both, because the key is "bar". An emoji-only query has no searchable characters: `400 invalid_payload` on `/discovery/search` (the answer "((" has always had) and a `query_too_short` refusal on `/discovery/suggest`. A row can no longer be found by its emoji alone.
  - **(c) strip for place, people and geo types; keep literal for content types.** `type=all` would mix two rules in one answer, and no spec clause names a split by type.
  - **(d) search both forms.** Every emoji query costs a second pattern per type. It is also a policy no other platform field uses.
- **Decision: (b).** Discovery's search key takes the shared input platform's field-context rule: `stripsEmoji("global_search")` is true, and the strip applies to the key only, never to the text the person sees. Grounds:
  - GII §10: *"Punctuation and emoji handling appropriate to field context"*.
  - GII §2: *"One platform layer."*
  - census-input-intelligence G62 is `C` on this exact function.
  - A Discovery search box is a lookup field, not prose.
  - It also keeps the Map sheet's gateway page (D-W10-S1-5) identical to `/discovery/search`, which it could not be under (a), (c) or (d).
- **Reversibility:** revert the two edited lines in `routes/discoverySearch.ts`. Nothing is stored, so nothing is lost.
- **Where it is implemented:**
  - Code: `artifacts/api-server/src/routes/discoverySearch.ts:140#let q = applyAliases(stripEmoji(qAfterHandle));` and `artifacts/api-server/src/routes/discoverySearch.ts:414#const q = sanitizeQuery(applyAliases(stripEmoji(`, which apply `stripEmoji` from `lib/inputAssistance/queryNormalizer.ts`. `lib/inputAssistance/searchPage.ts` `prepareSearchQuery` does the same.
  - Tests: `src/test/discoverySearchQueryPolicy.test.ts` Q2–Q6, restated as the visible diff §46.5 said they would be; `src/test/inputAssistanceMapSearchPage.test.ts` "E: an emoji in the query".

- **The follow-up (independent verification at `bc0ba4a94`, decided and built the same day).** Four gaps in the first strip were found:
  - **Subdivision flags** (🏴 + TAG characters U+E0020–U+E007F) left invisible tags in the key. The TAG block is now part of the emoji class, so "🏴 pub" searches "pub", and the flag alone is refused.
  - **Keycaps** kept their base character, so "1️⃣ bar" searched "1 bar" and "*️⃣*️⃣" searched "* *". The whole sequence `[0-9#*]️?⃣` is now removed.
  - **An emoji inside a word.** Rule: an emoji between two LOWERCASE letters is inside one word and is removed without a gap ("caf☕e" searches "cafe"). Anywhere else it separates, as a space: between words, at an edge, or before an UPPERCASE letter that starts a new word ("Sky🔥Bar" searches "Sky Bar"). The trade-off: "Sky🔥bar", all lowercase, joins to "Skybar". "caf☕e" does not find "Café Luna", for the same reason "cafe" does not: Discovery's free-text place names are matched accent-sensitively, which is outside G62 (§46.3's stated limit of B01). "caf☕é luna" does find it.
  - **A literal `*`** is PostgREST's like-wildcard, so "**" matched every row. `sanitizeQuery` now drops `*` the way it drops `(`, `)` and `,`.
  - One function serves both callers, so the gateway's key is the same (Q8c).
  - **Where:**
    - `lib/inputAssistance/queryNormalizer.ts`: the class line, the `stripEmoji` line, and `KEYCAP_RE` / `IN_WORD_EMOJI_RE` at the foot;
    - `lib/inputAssistance/searchCandidates.ts` `sanitizeQuery`;
    - pinned by `discoverySearchQueryPolicy` Q7a–Q7e (every hidden-mark class, one at a time), Q8a–Q8c and Q9.

- **The backslash (round 3, independent verification of `5a434ec7b`).** In a LIKE pattern `\` is the escape character, and the search pattern escaped `%` and `_` but not `\` itself. So "kiosk\" sent `%kiosk\%`, where the trailing `\` escaped the closing wildcard, and "k\iosk" sent `%k\iosk%`, which matches "kiosk". Rule: **every user string that reaches a LIKE pattern is literal**; `\`, `%` and `_` are each escaped with `\`.
  - `lib/inputAssistance/searchCandidates.ts` `sqlPattern` now escapes `\` as well. "kiosk\" finds only the row that literally holds it, "k\iosk" does not find "Kiosk Row", and "100%" does not match "1000 Lakes".
  - `lib/inputAssistance/duplicateDetection.ts` spliced names into `.or()` through the shared `lib/postgrestFilter.ts#safeOrIlikeValue`, which LIKE-escapes first and then strips `\` as an `.or()` structural character, so it removes the escapes it has just added: a place named "100%" was scanned as `100<anything>`. The scan now strips the `.or()` structure first and LIKE-escapes second, so no user backslash survives and the escapes do.
  - Every other place a user string reaches `ilike` on the search and gateway paths was checked and is safe by construction: `discoverySearchCanonical.ts` and `canonicalLocations.ts` match on `searchKey` / `normalizeLocationName` output (`[a-z0-9\s]` only), and `socialIdentity.ts` matches a hashtag slug (`[A-Za-z0-9]`).
  - **Not changed here:** the shared helper itself. It is not this lane's file, and `routes/follows.ts` and `routes/tags.ts` use it; it is routed in census-discovery §80.13.
  - **Then fixed (§80.14, at the coordinator's request):** the shared helper now strips first and escapes second, the same order. Its callers `routes/follows.ts` (`GET /users/search`), `routes/tags.ts` (`GET /tags/suggestions`) and `services/airport/AirportProfileService.ts` (`searchAirports`) now match `%` and `_` literally. Pinned by `src/test/postgrestFilterLikeEscape.test.ts` on the helper and over HTTP on the two routes. Those routes' census rows belong to census-passport, census-layover and census-discovery's own non-search rows; each got an argued staleness acknowledgement and none is re-graded.
- **Uncased scripts (round 4).** The in-word rule reads CASE, so it said nothing about scripts without case, and there every emoji separated. Thai, Lao, Khmer, Myanmar, Han and kana are written without spaces between words, so a gap inserted there is never a boundary the person typed, and it breaks the substring match ("กรุง🔥เทพ" searched "กรุง เทพ", which cannot find "กรุงเทพ").
  - **Decision:** an emoji between two letters of a script written without spaces is removed without a gap, like the lowercase case. Uncased scripts that do space their words (Arabic, Hebrew) keep the separating default, because nothing in the text says the emoji is inside a word. A change of script is a boundary ("tokyo🔥東京" → "tokyo 東京").
  - **And the gateway strips before it transliterates.** It used to transliterate first, so an in-word emoji split the word the transliteration dictionary looks up: "моск🔥ва" keyed "moskva" while "москва" keyed "moscow". Stripping first gives the emoji-free word's key in every script.
  - **Where:** `lib/inputAssistance/queryNormalizer.ts` (`SPACELESS` and `IN_WORD_EMOJI_RE` at the foot; the first three steps of `normalizeQuery`). Pinned by `discoverySearchQueryPolicy` Q8e; Q8d's title now says it covers cased scripts.
  - Pinned by `discoverySearchQueryPolicy` Q10a–Q10d and Q11a. The in-word rule is also pinned for Greek and Cyrillic (Q8d: "αθ🔥ήνα" → "αθήνα", "моск🔥ва" → "москва", "Москва🔥Питер" → "Москва Питер").

### D-W10-S1-2 — partial coverage: may a consumer render `partial` as complete, and in what words (DV-83 ground 2; D-8, second half)

- **Question:** census-discovery §60.8 Q1, verbatim: *"May a Discovery consumer render a `coverage: "partial"` answer as a complete result with no notice … Or must every consumer that renders a list surface `failedSources` … If the second, which wording is ratified?"*
- **Options considered:**
  - **(i) Partial may render as complete.** DV-83's criterion stays met by 8 of 11 consumers as they are. A person reading a short list cannot tell it is short: the `11` §9 masquerade with rows in front of it.
  - **(ii) Every list-rendering consumer says the list is incomplete.** Each consumer gains one notice, and a partial with no rows can no longer read as "nothing found".
- **Decision: (ii).** Grounds:
  - `02-DISCOVERY-v2` "Privacy, degradation and integration": *"retain permitted baseline retrieval and recommendations with honest limitations"*.
  - `11` §9: *"A failure must not masquerade as success."*
  - The owner's D11 ruling: *"A distinguishable response body alone is insufficient if consumers still treat it as successful empty data."*
- **The rule:**
  - Rows are kept: they are real and they were served.
  - One notice says the list may be incomplete.
  - A partial with no rows is never the "nothing found" state.
  - `failedSources` holds table and bucket names. They are for logs and alerts, so they are not printed. "Surfacing" them means stating that something is missing.
- **The wording:** taken from sentences the app already ships, with one home in `travel-buddy-standalone/src/services/discoveryCoverageNotice.ts`.
  - **Search surfaces** (the search screen, its suggestions panel, the Map search sheet):
    - rows present: "These results are incomplete — part of the search couldn’t be run." (already verbatim in `MapSearchSheet` and `app/search.tsx`);
    - no rows: "Some of this search could not run." with "Part of the search failed, so this is not a statement about what exists. Try again in a moment."
  - **Browse lists** (Discovery tabs and sections, the Map's places layer):
    - rows present: "Some {noun} couldn’t be loaded just now, so this list may be incomplete." This is the Telegraph search screen's shape;
    - no rows: "Some {noun} couldn’t be loaded just now" with "This is on our side, not your filters. Try again in a moment." (the category tab's own phrase).
- **On the server:**
  - The input gateway's envelope now carries coverage in the same refusal vocabulary (`refusal`, and `laneRefusals.saved` for the Map page). Its typeahead used to answer a failed read with the body of an empty one.
  - A serve that throws carries `suggest_failed`.
  - Before this, E-9 (D-W10-S1-4) would have made the global typeahead lose the partial and refused notices the legacy route carried.
- **Reversibility:** remove the notices. The rows never change, so nothing is lost.
- **Where it is implemented:**
  - Server: `artifacts/api-server/src/lib/inputAssistance/gateway.ts` (coverage sink, `generateSuggestionsWithCoverage`, `gatewayFailureRefusal`), `artifacts/api-server/src/routes/inputAssistance.ts` (lines 36, 263, 297, 320, each edited in place) and `artifacts/api-server/src/lib/inputAssistance/types.ts`.
  - Client transport: `platform/input-assistance/services/suggestResponse.ts`, `services/inputAssistance.ts` and `hooks/useInputAssistance.ts` (exposes `refusal`, never caches a refused or partial serve).
  - Client consumers: `hooks/useSearchSuggestions.ts`, `hooks/useGlobalSearchSuggestions.ts`, `hooks/useCommunityDiscovery.ts`, `components/search/SearchSuggestionsPanel.tsx`, `app/search.tsx`, `components/discovery/ForYouTab.tsx`, `components/discovery/DiscoveryCategoryTab.tsx`, `components/map/MapSearchSheet.tsx`, `app/map/index.tsx`.
  - Static pin: `src/services/__tests__/discoveryRefusalConsumers.guard.test.ts` G7 and G8.
  - Tests: listed in census-discovery §80.4.

### D-W10-S1-3 — what the protected-zone search pass does (B04; A-3, semantics)

- **Question:** census-discovery §69.1 A-3: *"a ruling on 3366's protected-zone pass (B04)"*, and §46.4: *"Is the flag still needed?"*
- **Decision: the semantics, and that they are correct.**
  - **What it decides:** each search CANDIDATE, by its stored position, before projection. This happens on every serve that reaches the Discovery searchers:
    - `GET /discovery/search` (all three branches);
    - `GET /discovery/suggest`;
    - since §80, the input gateway: the typeahead's and the pickers' candidates, and the Map search sheet's `map.search` page.
  - **Actions:**
    - zones read and none registered: identity, the same array;
    - allow: the same object;
    - coarsen: the position is snapped to the zone anchor, with `coordsPrecision: "approximate"`;
    - suppress: the row is not served, and **not suggested by name** either (§46.4's reported gap, closed);
    - policy unreadable: positions withheld (`coordsPrecision: "hidden"`), rows kept;
    - a malformed zone: `unknown` coverage, so every positioned row is suppressed.
  - **What it never does:** put counts on the wire; empty a search because the policy is unreadable; loosen anything. Every failure branch tightens.
  - **Why it is correct:** it applies Map spec §24 through the one reader of `protected_zones` (`lib/protectedZoneStore.ts`) and the contract's own `applyProtection`. The same row is judged the same way on every serve point, so a place hidden from search is not findable by name in the typeahead.
  - **Is the flag still needed:** not for safety. With production's 0 zones it is the identity. It stays because turning it on is production activation (AR-W10-S1-1).
- **Reversibility:** flag OFF restores byte-identical bodies. This is pinned by §46's R2 and by `inputAssistanceMapSearchPage` Z4 and I2.
- **Where it is implemented:**
  - Code: `lib/discoverySearchProtection.ts` (unchanged); `lib/inputAssistance/gateway.ts` `protectGatewayCandidates`; `lib/inputAssistance/searchPage.ts`; migration `3460_discovery_search_protection_scope.sql`, which updates the flag's description only and never its state.
  - Tests: `src/test/inputAssistanceMapSearchPage.test.ts` Z1–Z5 and `src/test/db/discoverySearchProtectionGateway.db.test.ts` W0–W3 (harness).

### AR-W10-S1-1 — APPROVAL REQUIRED: turn the protected-zone search pass on in production (B04, A-3 activation)

- **Recommended action, exact:**
  1. Apply `artifacts/api-server/src/migrations/3366_discovery_search_protected_zones_flag.sql`, then `3460_discovery_search_protection_scope.sql`, to production through the ledgered path. 3366 seeds the row FALSE; 3460 rewrites the description only.
  2. Then set it on:

     ```sql
     UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_search_protected_zones_enabled';
     ```

  - Reader: `lib/discoverySearchProtection.ts` `searchProtectionEnabled`, which caches for 30 s per process.
- **Prerequisites:**
  - `protected_zones` exists (2217, applied 2026-09-21, §46.1). It holds **0 rows** as last read (2026-09-27), so the flip is a byte-identity until zones are registered.
  - 3366 and 3460 are both unapplied in production.
  - The server build carrying §80 is deployed; without it the gateway leg does not exist.
  - Registering zones is a separate act of policy, not asked here.
- **Monitoring:**
  - The server log line "discovery search: §24 protection pass changed what was served" (`lib/discoverySearchProtection.ts`). It carries counts only: evaluated, coarsened, suppressed, withheld, and `policy: read|unreadable`. Since §80 its `route` names `POST /input-assistance/suggest` for the gateway.
  - The rate of `policy: "unreadable"`. Each such serve withholds every position until the read heals.
  - `protected_zones` row count, and the 30 s cache TTL.
  - No count is on the wire, by design.
- **If approved:**
  - Every search serve reads the flag and, while zones exist, `protected_zones`, at most once per 30 s per process.
  - With 0 zones, nothing changes on screen.
  - Once zones are registered: shelters and similar places vanish from search, suggest, the typeahead and the Map sheet; clinics are coarsened.
  - If the table becomes unreadable, positions are withheld from search results until it heals.
- **If declined:** B04 stays `W`. A zone registered later has no effect on any search serve, while the Map already honours it.
- **Recovery:**

  ```sql
  UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_search_protected_zones_enabled';
  ```

  This takes effect within 30 s and restores byte-identical bodies. Nothing is stored by the pass, so nothing needs repair. 3366's rollback (`db/rollback/2026-09-27-3366-discovery-search-protected-zones-flag-rollback.sql`) refuses while the flag is ON, by design.

### D-W10-S1-4 — the legacy typeahead (A08 reason 2; E-9)

- **Question:** census-discovery §69.1 E-9, *"the legacy typeahead"*; §53.4 reason 2: *"Until the gateway returns at least one suggestion on a mount, both requests fire per keystroke."*
- **Options considered:**
  - **(a) Keep the proving window.** Two requests on every first keystroke, and on every keystroke of a mount whose queries never match.
  - **(b) Retire it once the gateway has answered at all.** The first keystroke still doubles.
  - **(c) Run the legacy typeahead only while the gateway reports `unavailable`.**
  - **(d) Delete it.** GII §38 requires a failure ladder, so no.
- **Decision: (c).** A gateway that has not answered yet has not failed. GII §38's signal is `unavailable` (404/405/501, offline, no token, an unreadable schema). The fallback is one keystroke away when that fires, and `GET /discovery/suggest` stays as that fallback. A transient 5xx keeps what is on screen, which is GII §38's *"Provider failure must not collapse the input UI"*.
- **Reversibility:** one line (`legacyEnabled`).
- **Where it is implemented:**
  - Code: `travel-buddy-standalone/src/hooks/useGlobalSearchSuggestions.ts`.
  - Tests: `useGlobalSearchSuggestions.singleSystem.component.test.tsx`. The first case is restated from "every keystroke still fetches the legacy typeahead" to "no keystroke fetches it", because this decision changed it. A control and a never-matching-mount case were added.

- **The timeout (follow-up).** With E-9 the fallback starts only on `unavailable`, and a gateway that accepted the connection and never answered was never `unavailable`. Every request to `POST /input-assistance/suggest`, from both the typeahead and the Map page, now has a **5 000 ms** budget (`SUGGEST_TIMEOUT_MS`).
  - When the budget runs out, the request is aborted and reported as `unavailable`, which starts the legacy typeahead. The Map sheet shows its error line.
  - The caller's own abort of a superseded keystroke stays `aborted`.
  - Why 5 s: it is two orders of magnitude over GII §33's 100–150 ms debounce, so a slow but live serve is not cut off, and a person still typing gets the fallback while it helps. GII names no latency number.
  - **Where:**
    - Code: `travel-buddy-standalone/src/platform/input-assistance/services/inputAssistance.ts` (`withBudget`).
    - Tests: `services/__tests__/requestTimeout.component.test.ts`, with fake timers.

- **The missing policy (round 3, independent verification of `5a434ec7b`).** With no authoritative policy table — never fetched, the fetch failed, another account's table, past the 12 h expiry, or a newer `policyVersion` noted — `global_search` resolves to the conservative policy, whose `minChars` is unreachable. The gateway hook then returns before any request and reports `unavailable = false`, so under (c) the legacy typeahead never started either: the search bar did nothing. The table was refetched only on auth events, so a failed startup fetch stayed failed for the session, and a mounted hook never re-read the store.
  - **Decision:** a non-authoritative `global_search` policy counts as the gateway being unavailable, and the legacy typeahead runs. The gateway still obeys the conservative policy and sends nothing. The fallback is `GET /discovery/suggest`, the same matcher (`dispatchSearch`) the gateway calls, with the server's own rules applied, so this does not widen what the viewer may see; it keeps search working while the assistance policy is missing.
  - **Refresh on use.** While the field is used without a current table, the policy is fetched again, through the store and fetcher `installInputPolicySync` installed, at most once per 30 s (`POLICY_RETRY_MIN_GAP_MS`) and one at a time. It is not a schedule: no typing, no fetch. A failed fetch still relaxes nothing (`refreshPolicies` installs only a payload that survives `PolicyStore.install`).
  - **A mounted screen picks the table up.** `useInputAssistance` keys its resolved policy on `policyEpoch()` (active account, held account, version, and whether the table is current), so a table that lands, expires or is superseded changes the field on the next render instead of the next mount. The search hook re-renders when a refresh installs a table, so the gateway takes over again without a keystroke.
  - **Scope:** only `global_search` falls back to the legacy route, because only it has one. Refresh on use is wired from this hook only; the `policyEpoch()` re-read applies to every field.
  - **Reversibility:** `legacyEnabled` and `preferGateway` in `useGlobalSearchSuggestions.ts`, the memo key in `useInputAssistance.ts`, and the `bindPolicyRefreshOnUse` call in `installInputPolicySync.ts`, each one line.
  - **Where:**
    - Code: `travel-buddy-standalone/src/hooks/useGlobalSearchSuggestions.ts` (`legacyEnabled`, `preferGateway`, `usePolicyRefreshOnUse`); `platform/input-assistance/hooks/useInputAssistance.ts` (the memo key and `policyAuthoritative` in the result); `platform/input-assistance/services/policyStore.ts#policyEpoch`; `platform/input-assistance/services/policyRefreshOnUse.ts` (new); `platform/input-assistance/services/installInputPolicySync.ts` (the binding).
    - Tests: `src/hooks/__tests__/useGlobalSearchSuggestions.missingPolicy.component.test.tsx`, which runs the real gateway hook inside the real search hook with no policy seeded, and `services/__tests__/policyRefreshOnUse.component.test.ts`. The two mocked-gateway suites (`singleSystem`, `refused`) now state `policyAuthoritative: true` in their stand-in, the premise every case there already described (a healthy gateway); no assertion changed.

- **The handoff (round 4).** When the table landed mid-typing, the legacy hook turned off at once and the gateway, which had not answered yet, was shown empty for about one debounce. That contradicted this hook's own rule that it never replaces a live legacy list with an empty one.
  - **Decision:** once the screen has shown legacy rows, it keeps showing them, and keeps the legacy hook running so they stay current, until the gateway has answered the query currently typed. Then it switches, once, with no mixing.
  - "Answered" is `useInputAssistance`'s new `answeredText`: the text of a served answer (network or an exact cache hit). A local-tier list shown while the answer is fetched is not an answer.
  - The cost is at most one duplicate request per keystroke typed during the handoff. It ends at the gateway's first answer.
  - **Also pinned:** the re-render when a table lands, and the shared in-flight refresh attempt that lets a second mounted field see the same landing. Neither had a test that failed without it.
  - **Where:** `useGlobalSearchSuggestions.ts` (`handoff`, the legacy hook's `enabled`, `preferGateway`); `useInputAssistance.ts` (`answeredText`). Tests: `missingPolicy` (three round-4 cases), `policyRefreshOnUse` (the in-flight case), `useInputAssistance.answeredText`.

### D-W10-S1-5 — the Map search sheet on the gateway (A08 reason 3)

- **Question:** census-discovery §70.3: *"Moving it would change what a person sees … it carries none of the `refusal.coverage` notices the sheet renders."*
- **Decision:** the sheet is the `map.search` FIELD of the `global_search` context. GII §13 phase 3 names Map among Global Search's consumers, and GII §2 says *"The field owns behavior"*.
  - The gateway serves this field as a **search page** (`lib/inputAssistance/searchPage.ts`):
    - the same platform searchers (`searchAll` plus `saved`, limit 20, as the sheet always asked);
    - the same eligibility reads;
    - the same §24 pass;
    - the same query preparation.
  - Projection: the §42 suggestion plus `mapResult`, which carries the wire type, the display fields, and from `metadata` only `lat`, `lng`, `coordsPrecision`, `savedKind` and `bounds`.
  - Coverage: each lane's coverage on the envelope.
  - One request per settled keystroke instead of two.
- **Visible behaviour:** the same rows and the same notices. `inputAssistanceMapSearchPage` E compares the route and the gateway over eleven query shapes, healthy and degraded. The sheet's twelve cases are restated onto the new transport.
- **Known differences, none visible on a healthy search:**
  - A 429 now carries the gateway's text ("Too many suggestion requests. Please wait.") instead of the route's. The bucket is `input_assist_suggest`, 90/min, shared with the global typeahead, instead of 30/min for two requests per keystroke.
  - The Map sheet's searches no longer write Discovery serve-point-8 rows (`rank_events`). They were typeahead traffic counted as search exposures, two per keystroke. The gateway logs its serve (`input-assistance/suggest served`).
  - The Compass search signal is sent once per answered query instead of twice.
- **Reversibility:** restore the sheet's `run` (git). The server page is additive.
- **Where it is implemented:**
  - Code: `lib/inputAssistance/searchPage.ts`, `lib/inputAssistance/gateway.ts`, `routes/inputAssistance.ts`, `travel-buddy-standalone/src/platform/input-assistance/search/mapSearch.ts`, `services/inputAssistance.ts` `requestMapSearchPage`, and `components/map/MapSearchSheet.tsx`.
  - Tests: `inputAssistanceMapSearchPage.test.ts`, `mapSearch.test.ts` and `MapSearchSheet.refusal.component.test.tsx`.

- **Nothing searchable (follow-up).** For "🔥", "((", "@a" (the second keystroke of every handle search) or a subdivision flag, the gateway page answers a `validation` / `query_too_short` refusal on both lanes. Before the move this was the route's `400`.
  - The sheet now treats class `validation` as not-enough-to-search: the state it already has for a one-character query. It shows no rows, no outage sentence, no "Nothing matched", and no error line.
  - It does not print the route's developer message ("q must be at least 2 characters after sanitization"), which the old error line did. That is the only visible difference, and it removes a message nobody should have seen.
  - **Where:** `MapSearchSheet.tsx` (`tooShortNow`) and `mapSearch.ts` (`tooShort`). Tests: sheet case (11) with the outage control (11b), and `mapSearch.test.ts` V1.

### D-W10-S1-6 — the search helpers join the platform module (A08, the residual §70 named)

- **Question:** census-discovery §70.8: *"`routes/discoverySearchHelpers.ts` into the platform layer."*
- **Decision:** move it verbatim to `lib/inputAssistance/searchQueryHelpers.ts`, keeping the same lines. The six `lib/` importers now import it there. `routes/discoverySearchHelpers.ts` becomes a one-line re-export, so no Discovery caller changes.
- **Reversibility:** `git mv` back.
- **Where it is implemented:** `searchPlatformBoundary.test.ts`. B5 is now an empty list and B6 pins the re-export.

### D-W10T-18 — The "more" cursor: strict, and never in the future

- **The question.** The verifier re-ran at `879333996`. It found that `decodeMemberCursor` accepted any `c` that `Date.parse` accepts. "1", "2026" and "2026-09-28 junk" all passed, and then PostgreSQL refused them with 22007, so the route answered 500. A cursor dated in the future would relabel members inside the window as `beyond_window`.
- **Options considered.** For the timestamp: round-trip through `toISOString`, or match PostgREST's own timestamptz shape. `toISOString` truncates microseconds, so it would break the keyset on real rows. For a future cursor: clamp it to now, or refuse it.
- **Decision and rationale.**
  - The cursor's timestamp must match `YYYY-MM-DDTHH:MM:SS[.ffffff](Z|±HH:MM)`, which is what PostgREST and the fakes write, and it must parse.
  - A cursor after the request's clock is refused with 400. A window edge is a member's `created_at`, never in the future, so such a cursor was not minted by this server. Refusing it is honest; clamping would guess.
  - An archived or unknown Trail refuses a cursor page (404), as it refuses every Trail read.
- **Reversibility.** Code only.
- **Where it is implemented.** `services/trails/TrailService.ts`: `decodeMemberCursor` and `olderMembersPage`. Tests: `discoveryTrailProductRules.test.ts` K1 and K2, and J4 for the id tiebreak.

## W11-A — open-row audit

*Lane W11-A, 2026-09-28, branch `disc-w11-audit` from `3478500bb`. Census section §92. This lane graded no code and changed none. It classed the 37 census-discovery rows that carried neither `IMPLEMENTATION-COMPLETE; awaits:` nor `AWAITS OWNER APPROVAL:`. Before writing a new request it searched this register and `docs/ops/discovery-owner-approval-request.md`, and it reuses an existing id wherever one already covers the decision. Three decisions had no request, so they are written below.*

### D-W11A-1 — how an open row is classed, and when it carries both markers

- **The question:** the integrator's brief for §92. Each unmarked row goes into exactly one class. (P) waits only on production state or evidence. (O) waits on a decision this programme may not make. (B) waits on code that no decision blocks.
- **Options considered:**
  - (a) Every production step is an owner decision, so every P row also carries `AWAITS OWNER APPROVAL`. Rejected: the marker would then carry no information. The rollout plan's standard steps (apply P0/P1, deploy, the A4 flag plan) are already requested as one pack (W10D-A1, A3, A4).
  - (b) A row is P when all that remains is one of those standard steps plus the evidence it produces. It is O when a named request needs an answer of substance: consent, money, retention, a data-collection yes such as W10D-A2, or a GitHub setting. An O row that is otherwise implementation-complete carries both markers. **Chosen.**
- **Decision and rationale:** (b). It follows the lane rules' split between "waits on production activation or evidence" and "waits on a non-delegated owner decision". A P row names the pack id that covers its activation inside its `awaits:` list, so the approval is still traceable.
- **Reversibility:** a bookkeeping rule. Restating a row under (a) loses nothing.
- **Where it is implemented:** census-discovery §92.1–§92.2. No code.

### D-W11A-2 — §6 D9's remaining defaults are product decisions, and stand as coded

- **The question:** census-discovery §6 D9: *"Ratify or replace the `DiscoveryCandidate` mapping defaults … the truth-class rules …, the per-class confidence priors (0.8/0.6/0.4/0.2), and the ≤3-feature `whyForUser`."* A03 and A25 still cite "D9 unratified" as a ground (§57).
- **Options considered:**
  - (a) Keep D9 as an owner question. Rejected: it is a product mapping, not consent, money, retention or activation, and the owner delegated those on 2026-09-28.
  - (b) Ratify the remaining defaults as coded. **Chosen.**
- **Decision and rationale:** (b). D-W10-O-12 already ratified the priors and the reason labels. The truth-class rules never assign a class that no producer backs (never `inferred` or `predicted` from static facts), which is Sensing §5.1's rule that *"prediction must never be rendered indistinguishably from observation"*. `whyForUser` is empty whenever no per-user ranker ran. Neither needs an owner answer. What remains before A03 and A25 is activation only: W10D-A4a and D-W10-O-13.
- **Reversibility:** a later lane may replace either mapping by a register entry. Nothing is stored.
- **Where it is implemented:** `artifacts/api-server/src/lib/discoveryCandidate.ts`, unchanged. Census §92.1 (A03, A25).

### AR-W11A-1 — APPROVAL REQUIRED: the Buddy payment-eligibility leg (B03; commercial terms)

- **The question:** B03 (G71/G283) asks for *"launch/safety/payment eligibility"*. Four legs are built. The payment leg is not: *"There is no payment processor … No column says a buddy can be paid"* (`artifacts/api-server/src/lib/discoveryPeopleBuddy.ts:64#PAYMENT — NOT BUILT, AND NOT FAKED`). What makes a buddy payment-eligible depends on which processor and payout relationship the marketplace uses, and `09` §1 defers real payouts. That is a commercial term.
- **What is built up to the decision:** safety, category, availability and launch. Launch is behind `discovery_buddy_launch_gate_enabled` (2360, FALSE; W10D-A4b). Every read fails closed.
- **Recommended action (exact):**
  1. Approve that B03's payment leg is a read of a per-buddy payout-readiness state, written by the payment-processor integration you choose under W10D-B6.
  2. Until a processor exists, approve W10D-A4b as written: `discovery_buddy_launch_gate_enabled` TRUE after the API deploy. While `rent_buddy_enabled` is FALSE, no buddy is suggested, so no unpaid-able buddy is shown.
  3. No processor, fee or payout term is chosen here.
- **If approved:** once a processor writes a readiness state, a lane builds the leg behind a new flag seeded FALSE: a buddy with no ready state is not a Buddy suggestion, and an unreadable state withholds. B03 can then reach `C` on production evidence.
- **If declined:** B03 stays `W`. The launch gate still keeps buddies off the search surface while the marketplace is off.
- **Recovery:** nothing is built, so there is nothing to undo. The launch gate reverts with `UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_buddy_launch_gate_enabled';`.

### AR-W11A-2 — APPROVAL REQUIRED: which people-derived signals may count as independent convergence (DV-34; consent and data use)

- **The question:** `03` §6 names five convergence signals: unrelated travellers, *"multiple circles visit independently"*, *"saves convert into visits"*, *"visitors post afterward"*, and *"activity occurs across multiple networks"*. §84 computes the first from `rank_events` through Sensing's clustering (D-W10-R1-4). That module refuses identity joins (`artifacts/api-server/src/lib/intelIndependence.ts:39#privacy-invasive identity joins`). The others need circle membership, crews, and visit records (`passport_stamps`, `circle_checkins`, `plan_checkins`). Using them to rank a public trend is a new use of that data. D-W10-R3-4 already treats "your circle" as consent for candidates, for the same reason.
- **What is built up to the decision:** the unrelated-traveller leg, behind the §84 flags (FALSE).
- **Buildable without this decision:** the "visitors post afterward" leg, read only from PUBLISHED, PUBLIC Memories. D-W10-R3-5 already uses that basis for candidates. It is work item W11A-B9 in §92.3.
- **Recommended action (exact):**
  - (a) **Decline circle and crew membership as a trend input for now.** A circle is small and identified, so "independent circles" discloses who went where to exactly the people who can tell. This follows W10D-C5's recommendation on personal projections.
  - (b) **Decline visit records (`passport_stamps`, `circle_checkins`, `plan_checkins`) as a trend input for now.** They are location history, and their collection purpose is the traveller's own passport and plans.
  - (c) Note that declining (a) and (b) leaves DV-34 short of `03` §6's full list. The row stays `W` until either is approved.
- **If approved instead (either signal):** a lane builds the signal as aggregated counts only, never naming anyone. It needs at least 2 distinct circles, or 2 distinct travellers, per place per window, and sits behind a new flag seeded FALSE. The approval must name the consent basis. Circle signals should also honour `circle_visibility_settings` and `circle_member_visibility_overrides`.
- **If declined:** DV-34 stays `W` on the missing legs. Nothing reads circles or visits for trends.
- **Recovery:** nothing is built. Any later build is flag-gated and stores nothing (the trend tables are derived and rebuildable), so turning the flag off restores the prior state.

### AR-W11A-3 — APPROVAL REQUIRED: one production path that records the graph reading for debugging (DV-52; production activation and retention)

- **The question:** DV-52, `05` §9: *"it remains explainable enough for debugging."* The code is complete. §63 records the reading on a served page under `discovery_ranking_modifiers_enabled` (2289), and the DRS debug sample lands under `RANKING_EXPERIMENT_ENABLED` (`artifacts/api-server/src/services/ranking/DiscoveryRankingService.ts:1257#if (experimentEnabled && db) {`). 3421 makes it land on production's structure. No production deployment has either switch on. 2289 is a held-design flag that W10D-A4f keeps FALSE. `RANKING_EXPERIMENT_ENABLED`'s production value has never been read (§57.10 Q5).
- **Recommended action (exact):**
  1. Pre-flight, read-only: `SELECT flag, enabled FROM public.feature_flags WHERE flag IN ('RANKING_EXPERIMENT_ENABLED','discovery_ranking_modifiers_enabled');`.
  2. Apply 3421 with batch P1 (W10D-A1), then deploy the API (W10D-A3).
  3. Keep 2289 FALSE, as W10D-A4f says. Turn on the debug sampler, not the modifiers, because the sampler changes no order: `UPDATE public.feature_flags SET enabled = true WHERE flag = 'RANKING_EXPERIMENT_ENABLED';`.
  4. Leave it on until one `ranking_debug_samples` row with `surface = 'discovery'` and a non-null `content_type` exists. Then set it FALSE again.
  5. The samples carry `viewer_id`. The existing `purge_old_ranking_debug_samples()` deletes them by `sampled_at`; 3421's rollback header gives its horizon as 7 days. Whether that purge is scheduled in production was not read here. If it is not, the samples wait for the horizon you set in W10D-C8.
- **If approved:** DV-52 gets its production evidence from one sampled serve. Every DRS surface writes samples while the flag is on, so the window should be short.
- **If declined:** DV-52 stays `W`. It can instead wait for 2289's own production request, which comes with §78's measured designs.
- **Recovery:** `UPDATE public.feature_flags SET enabled = false WHERE flag = 'RANKING_EXPERIMENT_ENABLED';`. Sample rows can be deleted by id, and no served order depended on them.

## W10-I — integration of the wave-10 ranking lanes (census-discovery §91)

*Lane W10-I, branch `disc-w10-i-integration` from `6594dd495` (§78, §85 and §79 merged). Every behaviour below stays behind the lanes' flags, all seeded FALSE; with every flag off the three lanes' goldens pass unchanged. The evidence is controlled: in-process routes over in-memory databases, plus the local PostgreSQL 16 harness. None of it is production evidence, and nothing here claims real-world effectiveness.*

### D-W10-I-1 — §85's P2 golden and §78's six flag reads

- **The question.** `discoveryCandidatePipelineGolden` P2 went red after §78 merged. Did §78 change `rankForViewer`'s flag-off output?
- **Finding.** No. P2's three output hashes (order, scores, features, `stages`, governor) are byte-identical. What moved is P4's pin on the READ sequence. DRS's `withDiscoveryNegativeFeedback` reads §78's six flags (`loadRankDesignFlags`, cached per client) on the `discovery` surface, so the sequence gained six `feature_flags` reads. With those six removed, the sequence hashes to the golden captured at `6d1e7090b` exactly.
- **Options considered.**
  - (a) Gate the read behind its own flag. Impossible: a flag gate must read its flag.
  - (b) Re-capture the golden. Declined: the lane rules forbid re-capturing to go green, and nothing in the output moved.
  - (c) Recognise §78's reads in P4 as §85 already recognises its own one read, and assert that each §78 flag is read at most once.
- **Decision.** (c). The fake records the flag name of an `eq("flag", …)` read, as it already did for `in("flag", …)`. P4 removes exactly the reads of the six `RANK_DESIGN_FLAGS` names and asserts that none repeats. The golden hash is unchanged. No reason-code or DRS behaviour was re-gated, because none changed flag-off output.
- **Reversibility.** Revert the test and fake lines. Nothing is stored.
- **Where.** `test/discoveryCandidatePipelineGolden.test.ts` (P2), `test/helpers/fakeCandidateDb.ts`.

### D-W10-I-2 — §85's K2 fixture takes §77's stored Trail key

- **The question.** `discoveryOutputKinds` K2 ("Trails are ranked, not listed") went red.
- **Finding.** This was not §78. §77, merged after R3's base `6d1e7090b`, makes `listTrails` compare 3441's stored `destination_key`. K2's fixture Trail rows had no such column, so the listing was empty.
- **Decision.** The fixture rows carry `destination_key: "miami"`, the value `trailDestinationKey("miami")` computes and 3441 stores. The assertion is unchanged.
- **Where.** `test/discoveryOutputKinds.test.ts`, one line.

### D-W10-I-3 — DC-11's integrity stage calls DV-12's detector: what it may do, and under which flags

- **The question.** D-W10-R3-8 left `registerEngagementIntegrityDetector(<R2's detector>)` to the integrator. §85's stage asks a detector for a per-item verdict (`keep`, `discount` or `withhold`). §78's detector (`detectEngagementAbuse`, read through `loadEngagementIntegrity`) measures per-place save evidence. Someone has to decide the mapping.
- **Options considered.**
  - (a) Discount any place whose read saves are mostly abusive by any `03` §12 pattern. Consequence: a third party can farm, automate, pod-save or new-account-save a COMPETITOR's place and sink it. That is a sabotage lever.
  - (b) Withhold such places. Consequence: the same lever, made worse. A manipulated count does not make a place unsafe, and withholding it would be a penalty on its submitter (`01` §10).
  - (c) Discount only when more than half of a place's read saves carry a pattern the SUBMITTER'S OWN SIDE produced: `self_network` (the saver is the submitter, or they follow each other) or `reciprocal`. Third-party patterns are neutralised where they belong, inside the score, by §78's evidence discount under 3451. Never withhold.
- **Decision.** (c). The count is a lower bound: a save carrying both self-serving patterns is counted once, so the stage errs toward keeping.
  - **The data-use gate.** The detector reads other accounts' save times, account ages, follow edges and open gaming reviews. D-W10-R2-A1 step 4 asks the owner to confirm exactly that data use before `discovery_engagement_integrity_enabled` (3451) is turned on. So the detector runs only with 3451 on, as well as the stage's own `discovery_integrity_stage_enabled` (3483). With 3451 off it reads nothing and answers `"off"`, which the stage records as the new status `detector_off`. A failed or truncated read answers null (`detector_failed`) and changes nothing.
  - The detector is registered at `lib/discoveryPde.ts`'s module load, so every `rankForViewer` caller has it.
- **Reversibility.** Either flag off. To unwire it, remove the registration line; the stage then records `detector_absent`.
- **Where.** `lib/discoveryRankIntegrity.ts` (`engagementIntegrityStageDetector`, `integrityStageVerdict`), `lib/discoveryCandidates/integrity.ts` (the `"off"` answer and `detector_off`), `lib/discoveryPde.ts` (the registration). Tests: `discoveryIntegrationHooks.test.ts` I1–I3; mutations M8–M12.

### D-W10-I-4 — DC-01's three output kinds are served at `GET /v1/discovery/recommendations/:kind`

- **The question.** §85 hunk R2: serve `rankTrailsForViewer`, `rankSharedMomentsForViewer` and `rankEmergingForViewer` when `discovery_output_kinds_enabled` is on, in a route shape taken from the specs.
- **Options considered.**
  - (a) Reorder `GET /trails` (`11` §3 "list/search Trails"). Consequence: a listing API silently becomes a personal recommendation, and the Trails lane's list contract and its §64 member rules sit under a Discovery flag.
  - (b) Add a `category=trails` tab to `GET /discovery`. Consequence: its envelope, caches, serve points and client are all place-shaped.
  - (c) One route in `11` §5's Recommendation API shape. Inputs: the surface (the kind) and the session context (`destination`). Outputs: `items`, and `cursor: null` for one page of at most 50, the rankers' own cap.
- **Decision.** (c).
  - Signed-in only, since every order is the viewer's own.
  - The flag is read as a literal per request.
  - `11` §9 error semantics: 401; 404 `feature_disabled` for the flag off or an unknown kind; 400 `invalid_payload` for emerging discoveries without a destination; 503 `degraded_unavailable` carrying the ranker's reason. A failed read never answers 200 with an empty list.
  - No reason labels are served: the three rankers run with every modifier off, and no grounded reason code describes a Trail or a Shared Moment.
- **Not logged, and why.** The other serve points write `rank_events` impressions and a per-request `recommendations` row. 3376's `recommendations_serve_point_check` admits serve points 1–12 only, and 0153's `rank_events.item_kind` has no Trail or Shared Moment kind. Widening them is a migration, and this lane has no migration range. So no `recommendation_id` is minted, since an id that joins to no row misleads. This is routed as an open item (census §91.7).
- **Reversibility.** Flag off returns 404. To remove the route, delete the route file and its mount.
- **Where.** `routes/discoveryOutputKinds.ts`, mounted in `routes/index.ts` line-neutrally. Tests: K1–K5; mutations M13–M15.

### D-W10-I-5 — §78's four score terms are storable on a served row

- **The question.** §78's awaits clauses name production rows "whose features carry `intentMatch`" (A18) or "`negativeFeedback`" (DC-13). DV-39's storage screen (`screenFeaturesForStorage`) refuses any key `DISCOVERY_FEATURE_KEY_CLASSES` does not classify, and none of `intentMatch`, `tripMatch`, `explorationValue` or `negativeFeedback` was classified. A served row would therefore store them only as names in `privacyRefused`, so the evidence §78 awaits could never exist.
- **Decision.** Classify all four as `derived_ranking_signal`, the class of every other per-item score component (`interestTag`, `categoryAffinity`, `trailAffinity`, …). Each is a number and never a position. Each exists only while its flag is on. The row's `reasonCodes` were already derived from the unscreened features, so nothing else changes.
- **Where.** `lib/discoveryRecommendationRecord.ts`, on the existing classification line. Test: H2, and mutation M4.

### D-W10-I-6 — where the hooks sit (§78 H1–H3, §85 R1)

- **H1.** `rankForViewer` loads the designs just before the rank clock (`prT0`), so the rank clock still brackets only the ranker. Both `rankCandidates` branches go through `rankWithDesigns`. That is `applyRankDesigns` then `rankCandidates`, and with the designs inactive it is `rankCandidates(candidates, viewerContext, {})`. `{}` is `rankCandidates`' own default. `stages.rankDesigns` is assigned only when a design flag is on.
- **H2.** The raw `?intentMode=` goes to both served calls (serve points 1/2/3 and 6) and to both shadow calls. Shadows therefore compare like with like; on a shadow run the mode is read only under 3453. The Compass-path shadow passes its already-parsed mode, which `loadViewerIntent` accepts.
- **H3.** Pulse spreads `surfaceObjectiveOptions(sc, "pulse")` into its own options. With 3450 off that is `{}`.
- **R1.** `category` goes to the two SERVED calls only, because generation runs only on served runs (D-W10-R3-1). `servedGraphReadingFeatures` adds a seventh key, `graphProvenance`, only when the reading carries a provenance record, which happens only under 3484 with the modifiers on. It is classified `record_metadata`, as its per-row twin `graphReadingProvenance` is.
- **§85's flag read.** It is made literal (`.in("flag", [eight literals])`) and declared a `bulk` DIRECT_READS entry in `check:flag-polarity`, as DRS's bulk read is. No INERT_SEEDED_FLAGS entry was added: all eight flags are read. X0 pins the literals equal to `PIPELINE_FLAG_NAMES`.

### D-W10-I-7 — the client says when a page's "now" claims were withheld (A07)

- **Decision.** When a GET /discovery page carries `meta.liveSafety.readable === false`, both Discovery tabs show one quiet line: "We couldn't check what's live nearby just now." That is the first sentence of DiscoveryEventPostsRail's existing refusal copy.
  - The category tab clears it on each new page-1 answer.
  - For You shows it only while the GET /discovery page is what is on screen, never over the Compass feed, which it does not describe.
- **Where.** `travel-buddy-standalone/src/components/discovery/liveUnchecked.ts`, which is its own module because the component suites mock `services/discovery.ts` exhaustively; the two tabs, edited line-neutrally; and the `meta` type on `DiscoveryResult`.

### D-W10-I-8 — `fakeCandidateDb` joins the Supabase conformance contract

- **Decision.** It is registered as `candidateSubject`. Four behaviours now match the real client instead of being declared as gaps:
  - a write is sent only when awaited or continued, and at most once;
  - `maybeSingle()` over more than one row answers PGRST116;
  - the contract's own read and write errors are passed through (`readFailure`, `writeFailure`);
  - `count` is present only when requested.
- `.single()` and RETURNING after a write now throw an honest refusal. No §85 path uses either.
- The remaining divergences are declared and named in the double's header:
  - writes are recorded, never applied;
  - no constraints;
  - no schema;
  - an rpc resolves empty;
  - no RLS.
- **Where.** `test/helpers/fakeCandidateDb.ts`, `test/helpers/supabaseConformance.ts`. The §85 suites pass 104/104 on the changed double.

### D-W10-I-9 — §85's unapplied objects under a production-ON Compass flag

- **The question.** `check:flag-schema-prerequisites` found that `COMPASS_V1_RULE_BASED_ENABLED`, ON in production, reaches through GET /discovery and `rankForViewer` to two §85 reads of schema production lacks. The first is `compass_city_confidence.{model_version,feature_version,source_window}` (3484) in `loadGraphReadingProvenance`. The second is `place_momentum` (2892) in `loadInventoryBuckets`.
- **Finding.** With every flag FALSE, production issues neither query. `pdePreRankStages` returns the inert pipe, and `pdePostRankStages` returns before any read. Each read has its own inner flag besides:
  - the provenance read needs 3484's flag, which 3484 seeds in the same file as the columns, and 2289;
  - the inventory read needs 3481.
  Both degrade to a recorded status. Nothing needed gating.
- **Decision.** Record the pair as the checker prescribes: an `unguarded` KNOWN entry, appended at the END of the map (census-compass cites this file's lines). The entry lists all seven objects and states each inner flag and each degradation. It says STRIKE when 3484 and 2892 are applied to production.
- **Where.** `src/scripts/checkFlagSchemaPrerequisites.ts`. `snapshotFreshnessGuard` and the prerequisite suites pass 16/16.

### D-W10-I-A1 — **APPROVAL REQUIRED**: activation-order amendments that follow from this integration

- **Recommended action, exact.** Amend D-W10-R3-13 and D-W10-R2-A1 as follows. Nothing else in either changes.
  1. D-W10-R3-13 step 7 (`discovery_integrity_stage_enabled = true`) goes after D-W10-R2-A1 step 4's data-use confirmation, and after `discovery_engagement_integrity_enabled` is TRUE. Until then the stage records `detector_off` and reads nothing.
  2. D-W10-R3-13 step 8 (`discovery_output_kinds_enabled = true`) is satisfied on the code side, because a route now serves the kinds. Turn it on only after a migration widens 3376's `recommendations_serve_point_check` to admit a serve point for the kinds and a logging commit lands, so that served kinds are measured (§91.7).
  3. D-W10-R2-A1 step 1 (integrate hunks H1–H3) is done at this branch. Steps 2–4 are unchanged.
- **Consequence of approving.** The integrity stage cannot run on data whose use the owner has not confirmed, and no output kind is served unmeasured.
- **Consequence of declining.** Both flags can be switched on in D-W10-R3-13's original order. The integrity stage would still record `detector_off` until 3451 is on, and the kinds would be served without impressions.
- **Recovery path.** Any flag off takes effect on the next read (30-second caches). Nothing here writes.

## W11-X3 — projections and client

*Lane W11-X3, 2026-09-28, branch `disc-w11-x3-data` from `3cc027a06`. Census section §95. Every new behaviour is behind a flag seeded FALSE: two new ones in 3496, and the client legs behind the server's existing 3467 and 3468 flags. Migrations 3495–3496 are applied to the local PostgreSQL 16 harness only. Controlled data only; nothing here claims real-world effectiveness.*

### D-W11X3-1 — `place_cooccurrence` is built from places that share a Trail, and only from that

- **The question:** census-discovery W11A-B10 (§92.3), W10D-C5 and §61.12 Q2: *"Is place co-occurrence computed from people's itineraries, trip sequences and transitions … or only from places sharing a Trail, which needs no personal data?"* W10D-C5 recommends the Trail form and names it as the form built either way.
- **Options considered:**
  - (a) Itinerary / trip-sequence co-occurrence. A behavioural inference over people; it needs the owner's consent answer (W10D-C5). Not built.
  - (b) Trail membership: two places co-occur when a non-archived Trail holds both. `content_trails` records an editorial act, as 3416's common-content relation already treats it. **Chosen.**
  - (c) (b) plus archived Trails. Rejected: an archived Trail no longer vouches for its members, and the Trail read path withholds it.
- **Decision and rationale:** (b). Pairs are stored once (`place_a < place_b`), counted as the number of distinct non-archived Trails that hold both; several labels on one place are one membership. A Trail holding more than 100 places contributes no pair: its n² pairs would swamp every curated Trail and say nothing about which two places belong together. No strength is computed, because `05` §6 gives no formula (§61.6); the count and its source window are the ingredients. The table's CHECK admits only basis `shared_trail`, so a people-derived basis needs a new migration and the owner's answer. One flag, `discovery_place_cooccurrence_enabled` (3496, FALSE), gates both the hourly rebuild tick and the reader. The reader answers ids with lineage, never rows; a serving surface still applies its own eligibility.
- **Reversibility:** turn the flag off; 3495's rollback drops the table and function. The projection is derived, so a rebuild restores every row.
- **Where it is implemented:** `src/migrations/3495_place_cooccurrence_trail_projection.sql`, `src/migrations/3496_discovery_w11x3_flags.sql`, `src/lib/discoveryPlaceCooccurrence.ts`, `src/index.ts` (one call on an existing line). Tests: `src/test/db/placeCooccurrenceRebuild.db.test.ts` R1–R6, `src/test/discoveryPlaceCooccurrence.test.ts` C1–C6, T1, M1–M3.

### D-W11X3-2 — "visitors post afterward" joins the v2 classifier's convergence input

- **The question:** W11A-B9 (§92.3) and AR-W11A-2: build the one `03` §6 signal that needs no new data use — posts after a visit, from PUBLISHED, PUBLIC Memories, aggregated, with at least two distinct travellers, behind a new FALSE flag — without touching the circles, crews and visits legs.
- **Options considered:**
  - (a) Count every public post at the place. Rejected: `03` §6 says *afterward*; a post with no visit behind it is not convergence.
  - (b) Count authors who posted after their own positive Discovery outcome at the place, and add their independence clusters to the window's group count G. **Chosen.**
  - (c) Add them as activity. Rejected: activity is per exposure (D-W10-R1-1); a post is not a served impression's conversion, and it would move the rate.
- **Decision and rationale:** (b), with four rules.
  - *Who counts:* `memories.state = 'published' AND visibility = 'public'` only, the Compass builder's rule (`isPublicWorldMemory`), restated because this module may not import the engine.
  - *K-floor, twice:* at least 2 distinct qualifying authors per key and window, and again at least 2 among the authors NEW to the window (not already one of its activity actors). No count this leg adds rests on one person.
  - *Independence:* the new authors are clustered by Sensing's clustering (`clusterByIndependence`), so two accounts posting in lockstep are one group.
  - *Only adds:* G never falls. Activity, exposure and rate are unchanged. The evidence carries counts only (`postConvergence`), never an author id; an unreadable or truncated Memory read is `unread` and adds nothing.
  - The flag `discovery_trend_post_convergence_enabled` (3496, FALSE) is read only inside the v2 branch of `loadLocalMomentum`, so with it off no Memory is read and the reading is §84's, byte for byte.
- **What it does not reach:** ~~the stored twin `rebuild_place_momentum_v2` (3477), which the trend API serves, is not extended.~~ **Superseded by D-W11X3-5 (census §95.9):** 3497 gives the stored twin the same leg, and a harness suite holds the two equal row for row.
- **Reversibility:** flag off. Nothing is stored.
- **Where it is implemented:** `src/lib/discoveryTrendPostConvergence.ts`, the appended block of `src/lib/discoveryTrendNormalised.ts`, the pass-through in `src/lib/discoveryTrendState.ts`, and `src/lib/discoveryLocalMomentum.ts`. Tests: `src/test/discoveryTrendPostConvergence.test.ts` P0–P10, L1–L3.

### D-W11X3-3 — a generated Discovery row carries the route's distance and aggregates

- **The question:** D-W10-R3-1's *"two stated differences from a route-read row: `distanceKm` is null (PDE is not given the centre), and the vote/review aggregates (a route-private helper) are absent."*
- **Options considered:**
  - (a) Import the route's helpers. Not possible: they are private to `routes/discovery.ts`, which lanes W11-X1/X2 own.
  - (b) Restate both helpers in a lib, pinned token for token against the route's source, and hand the reference point to generation through `rankForViewer`'s options. **Chosen.**
- **Decision and rationale:** (b). `materialiseCandidates` measures `distanceKm` from `ctx.center` with the route's rounding, and merges `worthItCount`, `avgRating` and `reviewCount` onto curated rows exactly as `queryDbPlaces` does (canonical rows get none, as in the route; a failed read merges nothing, as in the route). `PdeRankOptions.center` is declared by module augmentation in `lib/discoveryCandidates/stages.ts`, because `lib/discoveryPde.ts` is another lane's file. The two PDE serve points in `routes/discovery.ts` must pass `center: distRef`: routed hunk R-X3-1 (census §95). Until it lands, a production generated row still has `distanceKm` null; its aggregates are already merged. Everything here runs only with 3480's flag on.
- **Reversibility:** a code change; nothing is stored.
- **Where it is implemented:** `src/lib/discoveryPlaceAggregates.ts`, `src/lib/discoveryCandidates/materialize.ts`, `generate.ts`, `stages.ts`. Tests: `src/test/discoveryCandidateRowParity.test.ts` R1–R5.

### D-W11X3-4 — the client's Save is a Telegraph command, and "Ask me first" is offered only when the server offers it

- **The question:** §81.4 routed hunks R1 (A21) and R3 (DV-76), behind the server's existing flags.
- **Decision and rationale:**
  - **R1:** the card's Save posts the command, then confirms its one proposed action. Only `404 feature_disabled` falls back to today's `toggleSave`, so with the flag off the person sees exactly today's behaviour. A `403` (the server's authorize said no) is shown with the server's reason, and nothing is saved by the old path: a second write path around the server's refusal would defeat `§30A.10`. A network failure is `failed`, never `fallback`, because a flag we could not read is not a flag that is off.
  - **R3:** the server had no list of a person's pending tags, so one route is added: `GET /api/me/tags/pending`, behind the same 3468 flag, naming the tagger by @handle only. Its `feature_disabled` is the client's single capability probe. The settings list stays the four options unless the probe answers 200, or the stored choice is already `approval_required`. The inbox's Approve calls `POST /api/tags/:id/approve`; Decline calls the existing `DELETE /api/tags/:id`. A tag leaves the list only when the server accepted the answer.
  - **Not decided here:** what `interacted` or `friends_only` mean (D-W10S2-9). `tag_permission_consent_copy_enabled` stays FALSE and owner-held; nothing here reads it.
- **Reversibility:** a client release; with either server flag off, the client is inert.
- **Where it is implemented:** client `src/services/discoveryCardSave.ts`, `src/components/DiscoveryCardMessage.tsx` (line-neutral), `src/services/tagging.ts`, `src/components/PendingTagInbox.tsx`, `app/profile/edit/connected.tsx`; server `src/routes/tags.ts` (appended route). Tests: the two client service suites, the two client component suites, and the server's `src/test/tagPendingInbox.test.ts`.

### D-W11X3-5 — the stored twin gets the post leg through a new migration (3497), not an edit of 3477

- **The question:** census §95.4 O-1, and the coordinator's follow-up: extend `rebuild_place_momentum_v2` so the stored trend rows carry "visitors post afterward", with exactly the TS leg's semantics. Do it in a new file if 3477 is in §87's certified set; if 3477 is unapplied everywhere, choose, and say why.
- **Options considered:**
  - (a) Amend 3477. It is allowed: 3477 is not in §87's `portava-ci` set (`docs/ops/discovery-portava-ci-apply-plan.md` §1: `3338` … `3441` plus `3436`), and it is applied to no shared database. But it is lane W10-R1's file. Its harness proof N0–N5 and its rollback describe its current text, and amending it would couple this leg's rollback to the whole v2 model's.
  - (b) A forward file, 3497, that re-creates `rebuild_place_momentum_v2` as 3477's body plus three named changes and adds one helper, `discovery_trend_post_groups_v2`. Its own rollback restores 3477's text verbatim. **Chosen.**
- **Decision and rationale:** (b).
  - **Semantics** are the TS leg's, rule for rule: published and public Memories; strictly after the author's own earliest positive outcome at the place; at least 2 distinct authors, and again at least 2 among authors who are not the window's activity actors; Sensing's 30-second clustering; counts only.
  - **Gating:** only under `discovery_trend_post_convergence_enabled`, gated by a pseudo-constant qual so that with the flag off the helper never runs.
  - **Feature version:** the leg writes its own, `discovery-exposure-activity-v3+post-after-visit-v1`, and the in-process reading now carries the same one when the leg answered. The per-row contribution to convergence differs, and `10` §9 requires that to be named.
  - **One TS tightening:** a row served before the window is not a visit. That is the loader's read and 3477's `base`, so production input is unchanged.
  - **Local Pulse is not given the leg:** the TS leg is place-level.
- **Reversibility:** turn the flag off, which takes effect on the next rebuild. `db/rollback/2026-09-28-3497-…` restores 3477's function; it refuses while the flag is TRUE. Stored rows keep their feature version, which names the arithmetic that wrote them.
- **Where it is implemented:** `src/migrations/3497_discovery_trend_post_convergence_stored.sql` and its rollback; `src/lib/discoveryTrendPostConvergence.ts` (one line); `src/lib/discoveryTrendState.ts` (the version). Tests: `src/test/db/discoveryTrendPostConvergenceStored.db.test.ts` S0–S5, and `src/test/discoveryTrendPostConvergence.test.ts` P11–P13.

### D-W11X3-A1 — **APPROVAL REQUIRED**: production activation of 3495–3497 and the two new flags

- **Recommended action (exact), after W10D-A1's batches are applied and the API is deployed:**
  1. Apply `3495_place_cooccurrence_trail_projection.sql`, then `3496_discovery_w11x3_flags.sql`, then (after 3475–3477) `3497_discovery_trend_post_convergence_stored.sql`, with the repository's applier.
  2. `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_place_cooccurrence_enabled';` The hourly tick then rebuilds from Trail membership only. Verify with `SELECT count(*), max(computed_at) FROM public.place_cooccurrence;` after the next hour boundary.
  3. `discovery_trend_post_convergence_enabled`: only after `discovery_trend_normalised_enabled` is TRUE (W10-R1's activation, D-W10-R1-17). Then `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_trend_post_convergence_enabled';`. It covers both the in-process reading and the stored rebuild (3497). Verify with `SELECT feature_version, count(*) FROM public.place_momentum WHERE computed_at = (SELECT max(computed_at) FROM public.place_momentum) GROUP BY 1;`, which must show `discovery-exposure-activity-v3+post-after-visit-v1`.
  4. The client legs follow the server's own requests: `telegraph_discovery_actions_enabled` (D-W10S2-15) and `tag_permission_approval_required_enabled` (D-W10S2-17's family), once the oldest supported client build carries this change.
- **If approved:** the co-occurrence projection exists and is readable by a future surface; the trend classifier counts public post-after-visit convergence. Neither changes a served order at this tree: no ranker reads the projection, and the post leg only raises a group count.
- **If declined:** nothing is read or rebuilt. DV-72 and DV-34 stay `W`.
- **Recovery:** `UPDATE public.feature_flags SET enabled = false WHERE flag IN ('discovery_place_cooccurrence_enabled', 'discovery_trend_post_convergence_enabled');` takes effect on the next read. `db/rollback/2026-09-28-3495-…` and `…-3496-…` remove the objects; the projection is derived, so nothing is lost.

W10D-C5 (the three personal projections) and AR-W11A-2 (circles, crews, visits) are unchanged and still need the owner's answer. No new consent request is written: this lane built only what those two entries already name as buildable without one.

## W11-X1 — ranker core

*Lane W11-X1, 2026-09-28, branch `disc-w11-x1-ranker` from `3cc027a06`. Census section §93. Items W11A-B1 (A11), W11A-B4 (DV-31), W11A-B3 (DV-09) and hunk H-W10T-1 (§86.9). Every new behaviour is behind a flag seeded FALSE, or changes nothing until an admin records a verdict. The evidence is controlled: in-process routes and libraries over in-memory databases, plus the local PostgreSQL 16 harness. None of it is production evidence, and nothing here claims real-world effectiveness.*

### D-W11X1-1 — A11: the dead free-time arms are deleted, and what the golden does about it

- **The question.** §81.4 hunk R2 (D-W10S2-7 decided the deletion; §92.3 W11A-B1 routed it here): delete `availableNow` and `availableMinutes` from `ViewerContext` and both arms of `availabilityFitScore`. §78's `portavaRankGolden.json` pins every flag-off byte of the ranker, and its `full`, `layover` and `noNeighbourhood` fixture viewers SET the two fields. The deletion therefore moves 30 of the golden's 40 hashes, although no production caller ever set either field (`discoveryFreeTimeRetirement` F1).
- **Options considered.**
  - (a) Keep the arms. Declined: D-W10S2-7 decided the deletion, and Trips `:185` forbids the independent calculation.
  - (b) Re-capture the golden from the new ranker. Declined as stated: that is going green by fiat.
  - (c) Remove the two fields from the fixture's viewers, and re-capture the golden with the BASE ranker (`3cc027a06`) over those viewers. Then prove that the new ranker reproduces that file byte for byte, from the stripped viewers AND from the original viewers.
- **Decision.** (c). Transcript (§93.4): base ranker on stripped viewers = new ranker on stripped viewers = new ranker on the original viewers, sha256 `665bb6a6…` for all three. The ten `empty` hashes did not move; the 30 that moved are exactly the scenarios whose viewer set a deleted field. The deletion is line-neutral: comment lines take the places of the deleted lines, so no census citation into `portavaRank.ts` moves. The `availabilityFit` feature stays in the record as 0, so stored feature keys keep their shape (a free-time fit from Temporal Freedom windows can later land as its own term).
- **Tests restated, none weakened:**
  - `discoveryFreeTimeRetirement` F2 now asserts the arms are GONE (red at `3cc027a06`);
  - `discoveryFreeTimeDuplicate` P2 was P1's control ("a timed candidate DOES move"). It now asserts the timed candidate no longer moves (red at `3cc027a06`);
  - `portavaRank` "availability fit" asserts 0 for the old inputs (was 1, -0.5, 1). The event-beats-viral case drops `availableNow` from its context and still passes.
- **Reversibility.** Restore from history; the golden's old file is in history too.
- **Where.** `lib/portavaRank.ts` (`ViewerContext`, `availabilityFitScore`), `test/helpers/portavaRankGoldenScenarios.ts`, `test/fixtures/portavaRankGolden.json`.

### D-W11X1-2 — DV-31: where the rediscovery retest sits on the page

- **The question.** §84.5 hunk H-W10R1-1: call `planRediscoveryRetest` inside `rankForViewer`, after the exploration governor.
- **Decision.** As §84.5 gives it, with four stated details.
  - It runs after the governor and before §85's post-rank stages, and only with the modifiers (2289) on. The retest pool IS the momentum load's own v2 readings for the candidate key, and that load runs only with the modifiers on. With them off nothing is read, so §47's L0 and §85's pipeline golden cannot move.
  - The key is the same expression the momentum load was given.
  - The moved row is stamped `rediscoveryRetest: 1`. DV-39's screen classifies the key as `exposure_coordinate` ("where/when/how an item was served"), so a served row stores it. `stages.rediscoveryRetest` records `{ id, slot, fromIndex }`, only when a place moved.
  - Never fatal: a throw leaves the governor's page.
- **Tests.** `discoveryRediscoveryRetestServe` Q0–Q3, through signed-in GET /discovery. Q0 pins the flag-off page to a golden captured at `3cc027a06`, before the hunk. `discoveryTrendOps` R5 ("nothing on a serve path calls it") is restated to name `lib/discoveryPde.ts` as the one caller.
- **Reversibility.** `discovery_trend_rediscovery_retest_enabled` (3475) off. To unwire it, remove the one call.
- **Where.** `lib/discoveryPde.ts` (`pdeRediscoveryRetestStage`, appended), `lib/discoveryRecommendationRecord.ts` (one key on the registry's last line).

### D-W11X1-3 — DV-09: the three new rankers each have their own flag, and need 3450 too

- **The question.** W11A-B3: route Trail, Trending and Trip Planning through `surfaceObjectiveOptions`, each behind a FALSE flag, and build the smallest honest ranker where none exists.
- **Options considered.**
  - (a) 3450 alone. Consequence: turning on the objectives for Discovery would also turn on three new rankers at once, with no way to roll back one surface.
  - (b) A surface flag alone, ranking on Discovery's default weights when 3450 is off. Consequence: a fourth objective nobody specified.
  - (c) A surface flag (3500, seeded FALSE) AND 3450, read in that order. Either off ⇒ the call site's own array, untouched.
- **Decision.** (c). Migration 3500 seeds `discovery_trail_objective_rank_enabled`, `discovery_trending_objective_rank_enabled` and `discovery_trip_planning_objective_rank_enabled` FALSE. With the surface flag off, 3450 is not read. Each ranker is portavaRank itself (`rankCandidates` with `objective`), with no exploration slot and the ranker's default diversity plus the objective's own.
- **Reversibility.** Any of the four flags off, on the next request. Rollback file for 3500 in `db/rollback/`.
- **Where.** `lib/discoverySurfaceObjectiveRank.ts`; `src/migrations/3500_discovery_surface_objective_rank_flags.sql`. Tests: `discoverySurfaceObjectiveRank` S0–S5.

### D-W11X1-4 — DV-09: the product details of each surface's ranker

- **Trail: `02` §8's "Personalized Picks" spotlight.** It is a named spotlight nobody served, and it is the one place on a Trail page where ranking for the viewer is the product.
  - The four existing modules keep their own §8 objectives (recency, momentum, durable quality, curation). Re-ranking them would overwrite what §8 says each is for.
  - Candidates are the members the viewer may be served (§64), minus members out of active rotation (§7). In the explored branch they are the decided states.
  - Inputs: the creator (followed authors, from `loadPdeViewer`), the member's place (place affinity), the attach time (recency; events fresher and places evergreen come from the objective), and `trail_relevance` = the member's own membership confidence. Inside one Trail, `01` §9's "Trail relevance" and "confidence" are the same fact. It is still capped (TRAIL_AFFINITY_MAX_CONTRIBUTION).
  - The module is appended last, so every existing module key keeps its index. It passes through the same §10 diversity and DV-13 page bound as every module. Objective label: `trail_objective`.
- **Trending: GET …/trending/places only, inside each claimed state.** D-W10-R1-13's state order (trending, emerging, rediscovered) stays first, because a list names states that claim a gain.
  - Inside a state the Trending objective orders by the place's freshness (`discovery_places.created_at`), velocity (normalised to the state's fastest, because the ranker clamps a momentum input to [0,1]; still under the owner's cap), verified status and saves (de-emphasised).
  - `for-you` keeps its decided affinity-first order, and `emerging` its fold. Both are other `11` §4 actions with their own decided orders.
  - The objective re-orders and never decides what is listed. An unread feature read leaves the decided order. No number reaches the wire.
- **Trip Planning: GET /trips/:tripId/nearby-places.** It is the one Discovery list the product serves inside a trip.
  - Trip fit uses §78's kernel (`tripFitMap`) with the trip being planned as the context, whatever its dates. A trip being planned is the trip in question, and a far-off start date is not a reason to rank it as no trip.
  - Route fit ≈ distance from the trip's destination. Saves are `discovery_places.saved_count` (save/add-to-trip behaviour). The viewer's category affinity comes from `loadPdeViewer`.
  - Rating is not a portavaRank term, so it remains the tie-break (the input order). The response shape is unchanged; only the order moves.
- **Not claimed.** "Itinerary utility" and "budget/availability" have no input here (Trips publishes no plan-item projection, E-7). The Trip Planning objective ranks on what exists.

### D-W11X1-5 — H-W10T-1: a suppressed place review reaches the trend classifier's consumers

- **The question.** §86.9: `trend_integrity_reviews` records `suppressed` on a place, but nothing read it.
- **Decision.**
  - `lib/discoveryTrendState` asks `TrailService.readTrendReviewVerdict(sc, "place", id)` for every reading that could publish something: a claim, or a v2 reading the retest could pick. `id` is the trend store's own place key verbatim (`rank_events.item_id` = `place_momentum.place_id`), the id an admin sees in the evidence.
  - **suppressed** → the reading stays, as no claim: `unknown`, lifecycle `inactive`, no driver. No reason code, no sentence, no list, no retest.
  - **unread** → the reading is removed ("not computed"), following D-W10T-11's "an unreadable review answers null, never a claim".
  - **none** → unchanged. 3486 absent reads `none`.
  - Applied where readings are made public: `loadLocalMomentum` (the served trend states and the retest pool), and the trend API's two stored-row readers (`readTrendSnapshot`, `readLocatedRun`).
- **Limits, stated.**
  - The momentum SCALAR (a capped ranking modifier, never a public claim) is not changed by a verdict. Zeroing it is a separate anti-manipulation choice, left to `03` §12's owner.
  - One indexed single-row read per claimed place; a batch read is a follow-up.
- **Tests restated, none weakened.** Four test fakes that threw on, or could not chain, the new read now model the table as readable and empty. The goldens they hold are unchanged. `discoveryModifiers` "thin city" adds `trend_integrity_reviews` to the tables the loader reads.
- **Where.** `lib/discoveryTrendState.ts` (appended), one line each in `lib/discoveryLocalMomentum.ts` and `lib/discoveryTrendExplanation.ts`. Tests: `discoveryTrendReviewSuppression` T1–T4.

### D-W11X1-A1 — **APPROVAL REQUIRED**: production activation of DV-09's last three surfaces and of DV-31's page call

- **Recommended action, exact values, in order:**
  1. Apply 3450 and 3500 to `portava-ci`, then to production (both only seed FALSE rows).
  2. Set `discovery_surface_objectives_enabled = true` (3450), per D-W10-R2-A1.
  3. Then each surface on its own, one at a time (none of the three logs a served rank today, so the rollback is the only instrument): `discovery_trip_planning_objective_rank_enabled = true`, then `discovery_trail_objective_rank_enabled = true`, then `discovery_trending_objective_rank_enabled = true` (this one also needs `discovery_trending_api_enabled` and `discovery_trend_lists_enabled`, D-W10-R1-17 step 5).
  4. D-W10-R1-17 step 6 (`discovery_trend_rediscovery_retest_enabled = true`) is now satisfiable on the code side, because H-W10R1-1 is merged here. It still needs 2289 and the v2 flag on.
- **If approved.** Each surface ranks on its own `01` §9 objective, and a cooled place gets its periodic retest slot.
- **If declined.** Every deployment serves exactly today's bytes on all three surfaces and on GET /discovery (S0, Q0).
- **Recovery.** Any flag off takes effect on the next request (the §78 flag cache is 30 s). 3500's rollback deletes its three rows only while they are FALSE. Nothing these flags gate writes anything.

## W11-X2 — serve path

*Lane W11-X2, 2026-09-28, branch `disc-w11-x2-serve` from `3cc027a06`. Census section §94. Rows: DV-83, C19, DC-17, DC-01, A07 (the F2 limit). Work items: W11A-B8, W11A-B2, W11A-B7 and §91.7 items 1, 2 and 5. Migrations 3490 and 3491 (range 3490–3494), both applied to the local PostgreSQL 16 harness only. Every new behaviour that changes what a user is served sits behind a flag seeded FALSE; the two defect repairs (the feed's event-post read, the Live claim read) are not flagged, because each changes output only when a read fails. All evidence is controlled; none is production evidence.*

### D-W11X2-1 — the feed carries a failed event-post read (DV-83, hunk §80.7)

- **The question.** Census §80.7, and §92.3 W11A-B8: *"`lib/eventPostsDiscovery.ts` computes `readFailed` and drops it. `routes/discovery.ts`'s feed `.catch`es the whole fetch to `[]`."* How does the failure reach the envelope, and under which code?
- **Options considered.**
  - (a) Change `fetchEventPostsForDiscovery` to return `{ posts, readFailed }`. Consequence: its two other callers (the event-post unit suite and census-media's location-mode suite) and census-media's anchored citation of the route's call line all move for no behavioural reason.
  - (b) An optional `readStatus` sink on the existing params, set where `readFailed` is computed; the route passes one and also sets it in its `.catch`. Every other caller is byte-identical.
  - Code: (i) reuse `feed_places_read_failed` for every failure, as §80.7's "no new vocabulary" read literally; (ii) keep it when a place category failed, and use `feed_event_posts_read_failed` when only the event posts did.
- **Decision.** (b) and (ii). `"event_posts"` joins `failedCats`, so the refusal's `failedSources` names it beside any failed category, and the existing coverage rule decides `nothing` (the body is empty because of the failure) or `partial`. A code is *"stable enough to alert on"* (`lib/discoveryRefusal.ts`); an alert on the places code raised by an event-post outage would send an operator to the wrong table. A thrown fetch is a failed read, not an empty one. A failed read is still never cached (unchanged), and a `partial` serve still logs its items.
- **Reversibility.** Revert the five in-place lines in `routes/discovery.ts` and the two in `lib/eventPostsDiscovery.ts`. Nothing is stored.
- **Where.** `routes/discovery.ts` (the feed), `lib/eventPostsDiscovery.ts`. Tests: `src/test/discoveryFeedEventPostsCoverage.test.ts` E1–E5, C1–C3.

### D-W11X2-2 — the "Live from events" rail says when its own list is short (DV-83)

- **The question.** Once the feed names `event_posts`, what does `DiscoveryEventPostsRail` render for a `partial` answer?
- **Decision.** D-W10-S1-2's browse-list rule, with the rail's own noun: posts kept, one line "Some event posts couldn’t be loaded just now, so this list may be incomplete."; no posts is the partial-empty state ("Some event posts couldn’t be loaded just now" / "This is on our side, not your filters. Try again in a moment."), never the silence a quiet city gets. A `partial` that names only place categories does not describe this rail, which renders event posts only, and shows no notice. `coverage: "nothing"` keeps the existing refused state.
- **Where.** `travel-buddy-standalone/src/components/discovery/DiscoveryEventPostsRail.tsx` (line-neutral above the cited `if (refused) {`); the guard entry moves from n/a to three branch fragments (`discoveryRefusalConsumers.guard.test.ts` G7, G8). Tests: `DiscoveryEventPostsRail.coverage.component.test.tsx` P1–P5.

### D-W11X2-3 — the community byline's canonical shape (C19, W11A-B2)

- **The question.** §92.3: *"behind a new flag seeded FALSE, emit `name` in the canonical shape (the real name iff `nameAllowed`, else null) or drop it. Which of the two is a routine product choice for the building lane."*
- **Options considered.**
  - (a) Drop `submittedBy.name`. A client that reads the key gets `undefined`; the object's shape changes for every consumer, including ones this census does not see.
  - (b) Keep the key, emit the canonical value: the real name iff `nameAllowed` (self-exemption first, then opt-in), else null. The key's position and every other field are unchanged, and `name` equals `displayName`.
- **Decision.** (b), behind `discovery_community_byline_canonical_enabled` (3490, seeded FALSE). The rule is `.agents/memory/display-name-privacy.md`'s "null name + separate handle"; the handle keeps travelling in `handle`, which the shipped resolver (`features/discovery/communityByline.ts`) reads. A submitter with no handle and no permission is null, not "Traveler". The flag is read once per request, only when a byline will be built. Flag OFF, absent or unreadable: byte-identical (golden G0/G1, captured at `3cc027a06`).
- **Reversibility.** Flag off; the next request is the legacy shape. Nothing is stored.
- **Where.** `routes/discovery.ts` (two in-place lines and a foot import; the `name` type is `string | null`). Tests: `src/test/discoveryCommunityBylineCanonical.test.ts` G0, G1, B1–B5.

### AR-W11X2-1 — **APPROVAL REQUIRED**: turning on the canonical community byline in production (C19)

- **Recommended action, exact.** Once the oldest app build the product still supports contains `features/discovery/communityByline.ts` (census §60.8 Q2's first half, a release fact): apply 3490 to production with the W10D-A1 batch, deploy the API build carrying §94, then `UPDATE public.feature_flags SET enabled = true WHERE flag = 'discovery_community_byline_canonical_enabled';`.
- **Consequence of approving.** No served `submittedBy.name` starts with `@`. A build older than the floor that renders `name` raw prints nothing for a withheld name (it shows the handle nowhere, because it never read `handle`).
- **Consequence of declining.** The legacy shape stays: `@username` in `name` for every caller, the one redaction shape no other surface uses. C19 stays `W`.
- **Recovery path.** `UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_community_byline_canonical_enabled';` takes effect on the next request. Nothing is written by the flag.

### D-W11X2-4 — the platform path's graph reading records its own four facts (DC-17, W11A-B7)

- **The question.** §92.3: *"the platform producer's record (§75.3 blocker 3) gains the four facts; that record is CPV2-12's owner's."* §75.3 blocker 3: a Compass producer version stamped on a platform reading *"would be false exactly when the platform answers"*.
- **Options considered.**
  - (a) Add `model_version` / `feature_version` / `source_window` columns to `intel_coverage_snapshots` and have the platform producer (`lib/intelCoverageScheduler.ts`) write them. Consequence: a migration and a producer change in the Intelligence Gathering domain, and still no record of how Compass FOLDS those cells into the served depth, which is the number PDE consumed.
  - (b) Record, at read time, what is true of the served reading: its depth is computed by Compass's read-time fold (`platformCoverageDepthScore` over the unexpired cells' `coverage_state` and `current_confidence`), not stored by the platform. The model version names the fold; the feature version names what one cell contributes; the window names the cells the read admitted; the computation time is the reading's.
  - (c) Leave `platform_producer` with no facts. DC-17 then never reaches the platform path.
- **Decision.** (b), behind `discovery_platform_graph_provenance_enabled` (3490, seeded FALSE). Cross-lane ownership is no reason to stop, and (b) touches neither CPV2-12's store nor its producer: it re-reads the governing read verbatim and re-folds it.
  - **The same reading or none.** Unless the re-read's newest `computed_at` and folded depth both equal the reading's, the answer is `reading_moved`.
  - **No claim where none can be made.** The governing read is capped (2000) and unordered; when the re-read reaches the cap, the corpus is whatever subset the planner returned, so the answer stays `platform_producer` (§75.3 blocker 1's rule).
  - **The versions cannot drift silently.** `compass-platform-coverage-fold-v1` is pinned to a digest of `platformCoverageDepthScore` and `tierForScore` over a grid; `intel-coverage-cell-state-v1` to `coverageState`'s outputs; the cap and the projection to the engine's own text (V1).
  - A failed read is `read_failed`. Provenance only: nothing ranks on it.
- **Reversibility.** Flag off: `platform_producer`, as before, and no re-read. To unwire, revert one line in `lib/discoveryCandidates/graphReadingProvenance.ts`.
- **Where.** `lib/discoveryPlatformGraphProvenance.ts` (new); `lib/discoveryCandidates/graphReadingProvenance.ts` (one line in place, one foot import; outside this lane's list, stated in §94). Tests: `discoveryPlatformGraphProvenance.test.ts` P0–P6, W1, V1; `discoveryIntegrationHooks.test.ts` R2p (served rows, serve points 1 and 6).

### D-W11X2-5 — the three output kinds are logged at serve point 13 (§91.7 item 1; DC-01)

- **The question.** §91.7: *"a migration widening the per-request CHECK to a new serve point, and a `logDiscoveryServe` call in `routes/discoveryOutputKinds.ts`."* What is logged, under which kind?
- **Decision.**
  - One new serve point, `OUTPUT_KINDS = 13`, for all three kinds; the kind travels in the context as `type` (an already classified context key), so no new stored key is created. It is in `RANKED_IN_REQUEST`, because each kind is ranked by `rankForViewer` in the request.
  - `rank_events.item_kind` gains no value. A Trail and a Shared Moment are none of 0153's six kinds, so they are logged as `trail/<id>` and `moment/<id>` (the ids the rankers rank them under) with a NULL kind, the rule search uses for a hashtag. An emerging discovery is a place and is logged as one.
  - Every served item carries the `recommendationId` its impression row carries, from one exposure per response (DV-40). D-W10-I-4's "no id is minted" was conditional on there being no row to join; there is now.
  - 3491 drops and re-adds `recommendations_serve_point_check` as `BETWEEN 1 AND 13`, NOT VALID then VALIDATE, with its behavioural probes inside the applying transaction (3376's rule). Its rollback refuses while any row carries 13: narrowing would delete the only record of those serves, and how long those are kept is W10D-C8's.
  - No `unapplied` drift entry: 3491 adds no table and no column, and `recommendations` is already recorded `unapplied` (3376). 3491 refuses to run without 3376.
- **Where.** `routes/discoveryOutputKinds.ts`, `lib/discoveryServeLog.ts` (two in-place edits: the constant and the ranked set), `lib/discoveryServePointReport.ts` (its label, in place), migration 3491 and its rollback. Tests: `discoveryOutputKindsServeLog.test.ts` L1–L6, M1; `discoveryTelemetryConstraints.db.test.ts` (13 admitted, 14 refused).

### AR-W11X2-2 — **APPROVAL REQUIRED**: applying 3491 to production

- **Recommended action, exact.** Apply `3491_discovery_recommendations_output_kinds_serve_point.sql` to production immediately after 3376, in the same W10D-A1 batch and only if W10D-A2 (3376) is approved. Then D-W10-I-A1 step 2 is satisfied on the code side: `discovery_output_kinds_enabled` may be turned on under D-W10-R3-13 step 8.
- **Consequence of approving.** Each served output-kind request writes one `recommendations` row, and each served item one `rank_events` impression, while `discovery_serve_log_enabled` (TRUE in production) and 3483's flag are both on.
- **Consequence of declining.** If 3376 is applied without 3491, a served output-kind request's per-request row is refused (23514) and reported as a rejection; the impressions still land. If neither is applied, nothing changes.
- **Recovery path.** Turn `discovery_output_kinds_enabled` off. The 3491 rollback restores 1–12 and refuses while any 13 row exists; deciding what happens to those rows is W10D-C8.

### D-W11X2-6 — the client asks for the output kinds behind the server's flag (§91.7 item 2)

- **Decision.** `services/discoveryRecommendations.ts` (its own module, so the pinned carriers in `services/discovery.ts` are unchanged) calls the route with the viewer's token and keeps `11` §9's answers apart: 404 `disabled`, 401 or no token `signed_out` (no request is sent without a token), 400 `invalid`, any other failure `unavailable`, a thrown fetch `network`. `DiscoveryOutputKindsRail` reads `discovery_output_kinds_enabled` through FeatureFlagsContext, which fails soft to OFF; with it off, signed out, or emerging discoveries with no destination, it renders nothing and sends nothing. For You renders one rail per kind. An empty page renders nothing; `unavailable` renders the browse list's no-rows sentence (D-W10-S1-2), never silence.
- **Read-only cards.** The client has no Trail screen and no emerging-place screen to open, so a card names the item and does not navigate. Building those screens is outside this lane.
- **Copy.** Rail titles "Trails for you", "Your shared moments", "Emerging nearby"; nouns "trails", "shared moments", "emerging places". Routine product copy, changeable in one file.
- **Where.** `travel-buddy-standalone/src/services/discoveryRecommendations.ts`, `src/components/discovery/DiscoveryOutputKindsRail.tsx`, `ForYouTab.tsx` (two in-place appends). Tests: `services/__tests__/discoveryRecommendations.test.ts` S1–S7; `DiscoveryOutputKindsRail.component.test.tsx` O1–O6.

### D-W11X2-7 — the shared Live claim read marks a failed read (§79 F2, §91.7 item 5; A07)

- **The question.** §79.6: *"`lib/liveClaimRead.readLiveClaims` collapses a failed read into an absence … return a failure the caller can see."*
- **Options considered.**
  - (a) Throw on a failed read. Every one of the read's twelve production callers (the Wall, the Map, Compass, placeLiving, Telegraph …) would have to be re-checked for an unhandled rejection; census-sensing, census-map and census-wall grade several of them.
  - (b) Change the return type to a result union. The same twelve call sites change.
  - (c) Keep the value every caller receives (`[]`) and MARK it: `liveClaimReadFailed(result)` is true for exactly the three failures (an unreadable promoted-scope allowlist, a snapshot read error, a throw) and false for the three real absences (gates closed, nothing promoted, nothing live). `readLiveClaimEnvelopes` carries the mark. The mark is a module-private WeakSet, the idiom `lib/discoveryRefusal.ts` uses, so it cannot be forged or leak onto the wire.
- **Decision.** (c). Discovery's live read (`lib/discoveryLiveRankRead.ts`, one line in place and a foot import; outside this lane's list, stated in §94) reads the mark and grades the row `unreadable`, so §79's rule — the row keeps its place and loses its "now" claim, and `meta.liveSafety` says so — covers an errored read. An unreadable allowlist is no longer confused with an empty one, and is still not cached. Every other caller is unchanged byte for byte; whether each should also branch on the mark is its owner's (recorded in §94 for census-sensing).
- **Reversibility.** Revert the in-place lines; nothing is stored.
- **Where.** `lib/liveClaimRead.ts`, `lib/discoveryLiveRankRead.ts`. Tests: `liveClaimReadFailure.test.ts` L1–L7, D1, D2; `discoveryOnePipeline.test.ts` F2, restated.

### D-W11X2-8 — existing assertions restated by the decisions above

- `discoveryOnePipeline.test.ts` F2: it pinned the limit and said a fix *"turns this red and … should then be restated to the fail-closed answer"* (§79.10). It now asserts that answer: no `nearby_now`, no why-now, `meta.liveSafety: { readable: false, claimsWithheld: 3 }`.
- `discoveryServePointReport.test.ts`: the writer's population is 1–13 (three pins), and the "unrecognised" fixture moves from 13 to 14, as its own comment prescribes.
- `db/discoveryTelemetryConstraints.db.test.ts`: serve point 14 is refused (was 13), and 13 is admitted.
- `discoveryRefusalExposure.test.ts`: its fake lacked `.not()`, so the positive control's event-post Path B threw into its own catch and failed. The failure was invisible until the feed reported it; the fake gains `.not()` (as D11's fake did) and every assertion stands.
- `discoveryRefusalConsumers.guard.test.ts` G7: the n/a set loses the rail, which now has a partial branch.

### D-W11X2-9 — §95's two routed hunks in `routes/discovery.ts` (R-X3-1, R-X3-2)

- **The question.** Lane W11-X3 (§95) routed two hunks into this lane's file: pass the request's distance reference to both served `rankForViewer` calls (`PdeRankOptions.center`, which §95 added), and have the route import the two per-row aggregate helpers from `lib/discoveryPlaceAggregates.ts` instead of keeping private copies.
- **Decision.** Both applied as routed.
  - **R-X3-1.** Both served calls pass `center: distRef`, the same reference each path already measures its pooled rows from (`userCoords ?? clientCoords` on Cache A, `userCoords ?? coords` on the cold path). A generated row is served with a distance measured from the request, as every pooled row beside it is. It moves nothing unless 3480 generates a row. Pinned by `discoveryIntegrationHooks.test.ts` R1c (serve points 1 and 6), red first on `distanceKm: null`.
  - **R-X3-2.** The route's private `haversineKm`, `VoteRatingAgg` and `batchFetchVoteAndRatingAggregates` are deleted and imported from the one module generated rows use. Their lines are left blank with a two-line note, so every cited line of the route keeps its number. `discoveryCandidateRowParity` R1 is restated from "the copies match token for token" to "there is one implementation, and both the route and `materialize.ts` import it": it asserts both imports and the absence of any private copy, so re-introducing a copy is red (M32). What R1 proved (the route and generated rows compute the same values) holds by construction, and R2–R5 still pin the values.
- **Reversibility.** Revert the two in-place edits and restore the copies from git.
- **Where.** `routes/discovery.ts` (two lines in place, the padded deletions, one foot import); `test/discoveryIntegrationHooks.test.ts` R1c (appended); `test/discoveryCandidateRowParity.test.ts` R1 (restated). §95's DC-12 citation of R1 is repointed to the restated case, and its sentence "The route does not pass the centre yet (routed hunk R-X3-1)" is superseded by §94.

### D-W11X2-10 — a failed identity lookup on the feed is a failed event-post read (DV-83, round 2)

- **The question.** The independent verifier (census §94.11): with a valid Bearer token, `auth.getUser` throwing or answering `AuthRetryableFetchError` left `viewerId` null, the feed sent `Promise.resolve([])`, and the answer was 200, `posts: []`, no refusal — the rail's "nothing live" screen for a read nobody performed.
- **Options considered.** (a) Refuse the whole feed. The places half really was read, and discarding it is the opposite defect. (b) Treat the owed event-post read as failed: `failedSources: ["event_posts"]` under the feed's existing coverage rule. (c) Treat every `getUser` error as a failure. A definitive 4xx (invalid or expired token) then reads as an outage, and every signed-out client with a stale token sees "couldn't check".
- **Decision.** (b), classified on the error's status. A missing status, 0, 408, 429 or any 5xx is a lookup that did not happen (supabase-js's `AuthRetryableFetchError` carries 0 or 502–504; the auth server's rate limit is an `AuthApiError` 429). Any other 4xx means the token names nobody: the anonymous case, exactly as a request with no header (C2, V3). A thrown lookup with a Bearer header is a failure (V1). The block read throwing after the viewer resolved keeps its documented fail-open posture; it is not an identity failure.
- **Where.** `routes/discovery.ts` (the feed's viewer block, in place; `isTransientAuthError` at the foot). Tests: `discoveryFeedEventPostsCoverage` V1–V4.

### D-W11X2-11 — the rail says "couldn't check" on a transport failure (DV-83 under D-W10-S1-2)

- **The question.** The rail rendered nothing for `ok: false` (a 5xx, the network, now the request budget), pinned by "CONTROL: a transport failure is not a refusal and still renders nothing". Nothing is what a quiet city renders.
- **Options considered.** (a) Keep silence: a transport failure reads as an absence, the masquerade D-W10-S1-2 forbids for a partial answer. (b) The refused state itself: indistinguishable in tests from a server refusal, which differ for attribution. (c) The same honest sentence under its own testID.
- **Decision.** (c). "We couldn't check what's live nearby just now — this isn't a sign that nothing is happening. Pull to refresh." — the rail's existing refused copy, now one constant — under `discovery-event-posts-rail-unavailable`. Neither state keeps a session id. A later load that answers clears it. The existing control is restated, not deleted: it still asserts a transport failure is NOT the refused state, and now asserts it is not silence.
- **Where.** `travel-buddy-standalone/src/components/discovery/DiscoveryEventPostsRail.tsx`. Tests: `DiscoveryEventPostsRail.coverage` U1–U3; `DiscoveryEventPostsRail.refusal` CONTROL (restated).

### D-W11X2-12 — `getDiscoveryFeed` is bounded at 15 s

- **The question.** A hung request never resolved, so the rail never appeared in any state.
- **Decision.** 15 000 ms, `DISCOVERY_FEED_TIMEOUT_MS`, the Compass section budget (`services/compass.ts` `COMPASS_SECTION_TIMEOUT_MS`): the feed's only caller is a supplementary strip in the For You tab, beside the Compass sections, and should give up on the same clock. Longer than the server's own upstream budgets for the event-post path, which reads only the database (the rail asks `includePlaces=0`). A timeout answers `{ ok: false, error: 'timeout' }`, the transport-failure shape, which D-W11X2-11 renders.
- **Where.** `travel-buddy-standalone/src/services/discovery.ts` (in place; the constant at the foot). Tests: `discovery.feedTimeout` T1–T4, with node:test's fake timers.

### D-W11X2-13 — a pull refetches the rail

- **Decision.** `ForYouTab.handleRefresh` bumps a `refreshKey` that the rail takes as an effect input, so the "Pull to refresh" the refused and unavailable copy promises is true. Nothing else is refetched by it.
- **Where.** `ForYouTab.tsx` (in place), `DiscoveryEventPostsRail.tsx`. Tests: `ForYouTab.railRefresh` R1, R2 on the real ForYouTab and the real rail.

### D-W11X2-14 — Overpass reports a failed read, and DV-83 covers it

- **The question.** Is `queryOverpass`'s silent `[]` (routes/discovery.ts, the OSM half of GET /discovery, the feed and the counts) inside DV-83?
- **Finding.** Yes. DV-83's criterion is the consumer leg, but §80.1 already held that a server path which absorbs a failure blocks it — *"the rail cannot branch on a failure it is never sent"* — and the event posts were graded on exactly that. The places list is a carrier of the same envelope, and `sendDiscoveryPlacesEnvelope` recorded the gap in its own words ("Overpass cannot [report]"). So DV-83 cannot be `C` while it stands.
- **Decision.** `queryOverpass` returns the same empty array, MARKED as failed (a WeakSet, the idiom of `lib/discoveryRefusal.ts`), for a thrown fetch, a non-OK status and an unparseable body; an answered empty list is unmarked.
  - GET /discovery's cold serve paths (4, 5, 6) add `"overpass"` to `failedSources`. Overpass alone is `overpass_unavailable`, class `upstream_unavailable` (the owner's seventh class); with a DB half it is the combined `discovery_place_sources_read_failed`. Coverage stays `partial` while any retrieval answered; with all three failed and nothing served it is `nothing`, so no exposure is logged.
  - The feed names `"overpass"` beside its categories. The counts treat such a category as failed, D11's own rule there ("a count taken over the OSM half alone is not a smaller number, it is a DIFFERENT number").
  - A failed read is never cached (Cache A writes only OSM rows that exist).
  - **Fixtures.** Ten suites and the legacy-scenario helper stubbed Overpass with a throw where they meant "Overpass answered nothing". A throw is now an outage the route names, so each answers an empty 200 instead, on the same line. No assertion changed, and every golden (§79 Z0/L0, §47's legacy suite) passes unre-captured, which is the evidence that nothing else moved. `discoveryClientRouteE2E` gets the same one-line change and cannot load on this runner's Node 22 (§76.5).
- **Where.** `routes/discovery.ts` (in place, and the helpers at the foot). Tests: `discoveryOverpassFailedSource` O1–O7, C1.

## W11-P — the owner approval request, consolidated

*Lane W11-P, 2026-09-28, branch `disc-w11-approvals` at integration head `3fd11f858`. Census section §96. Docs only. The document is `docs/ops/discovery-owner-approval-request.md`. The apply plan gains §8 and the rollout plan gains §9. No approval entry is added and none is answered: every action in the document is an existing APPROVAL REQUIRED entry, deduplicated.*

### D-W11P-1 — one numbered list of owner actions, in the order they must happen

- **The question.** The owner, 2026-09-28: *"Bring me a concrete approval request instead of a list of unexplained decision codes."* The requests were spread over W10-D's pack (A1–A7, B0–B11, C1–C8, D1) and some thirty later register entries.
- **Options considered.**
  - (a) Keep one request per register entry. Consequence: over sixty items, most of them repeating "apply X" or "turn Y on" steps that can only happen together.
  - (b) Group by the four reserved categories, as W10-D did. Consequence: the order in which things must happen is lost.
  - (c) One list, in dependency order: step 0, then 25 actions. Each "apply X to production" part of every entry collapses into one batch (action 3). Each flag flip joins the activation step it belongs to (5, 6, 7, 8, 10, 13, 14). Each consent, money or retention question becomes a question with a recommended answer, placed just before the first action it gates.
- **Decision.** (c). The document's §2 maps every earlier id to its action, so no entry is lost.
- **Reversibility.** Documentation only.
- **Where.** `docs/ops/discovery-owner-approval-request.md` §1–§5.

### D-W11P-2 — which rows "wait only on production"

- **The question.** How to count, from the census markers, which open rows wait only on production and which wait on an owner policy answer.
- **Decision.** A row waits on a policy answer when any action it needs is a consent, money or retention question. That includes a row reached only through an activation that this document gates on such an answer, for example the trend scheduler, which D-W10-R1-17 forbids without D-W10-R1-12's retention answer.
- **Result at `3fd11f858`.** 101 C. Of the 87 open rows, 51 wait only on production and 36 on a policy answer. The 36 are the 24 whose `AWAITS OWNER APPROVAL:` names a policy entry, plus 12 through a gated activation.
- **Reversibility.** A counting rule. It moves no verdict.
- **Where.** Approval request §1 and §7.

### D-W11P-3 — census §66.9 Q4 (ß, æ, œ) is carried as a question, with the recorded reading as its default

- **The question.** Is B01's owner question 4 one of the reserved decisions?
- **Decision.** No. It is a product definition, so it is delegable. §66.9 put it to the owner, and this docs-only lane does not answer it. The document carries it as question 25, recommending "no". "No" is §77's recorded reading, under which B01 stays C.
- **Reversibility.** The owner's answer replaces the default.
- **Where.** Approval request question 25.

### Finding, routed and not decided: a tripped stop does not turn off the gate-2 flags

- `lib/discoveryEngineMode.ts` resolves the engine mode to legacy on a tripped stop.
- `lib/discoveryOnePipeline.ts` reads only `discovery_for_you_pde_enabled` and `discovery_cache_a_ranked_enabled`, and not the stop state. Neither does the §78 flag reader.
- So with gate 2 on, a trip does not return `for_you` or Cache A to their pre-§79 order.
- The document states the manual recovery: action 8's SQL, also added to rollout plan §9.3.
- Making those reads honour a trip is a routine engineering change for the serve-path owner. This lane does not build it.

## W11-S — safety and recovery

*Lane W11-S, 2026-09-28, branch `disc-w11-safety` at integration head `532227796`. Census section §97. Rows restated: DV-82, DC-32, DC-18, DC-27. Work items: the three gaps lane W11-P routed (approval request §4 action 8 and §3; apply plan §8.3). No migration added. One unapplied migration corrected (3460). Eleven rollback files written, one rollback file corrected (3385). Harness: PostgreSQL 16 on port 55465, data under `/var/tmp/w11s-*`, deleted afterwards. All evidence is controlled; none is production evidence, and nothing was applied to `portava-ci` or production.*

### D-W11S-1 — a stopped Discovery reads every rollout flag OFF, at the flag's own reader

- **The question.** W11-P, register "Finding, routed and not decided": *"`lib/discoveryOnePipeline.ts` reads only `discovery_for_you_pde_enabled` and `discovery_cache_a_ranked_enabled`, and not the stop state. Neither does the §78 flag reader. So with gate 2 on, a trip does not return `for_you` or Cache A to their pre-§79 order."* `12` "Stop conditions": *"Stop rollout if: event rejection rises, recommendation logging gaps appear, creator concentration spikes …"*.
- **Options considered.**
  - (a) Keep the manual flag flip (approval request action 8). Consequence: the automatic half of the stop protects only `DISCOVERY_ENGINE_MODE`; 3455 and 3456 serve PDE in every mode, and serve point 6 runs §78's designs and §85's stages for every signed-in viewer in `legacy` too, so a trip leaves most of the rollout serving.
  - (b) Check the stop at each serve point in `routes/discovery.ts`. Consequence: four call sites in the route plus every other caller of `rankForViewer` (the output-kinds route, the Map reader, Pulse's objective), each a place to forget.
  - (c) Check it at the readers: `forYouPdeEnabled`, `cacheARankedEnabled`, `loadRankDesignFlags` (§78's six), `loadPipelineFlags` (§85's eight) and the output-kinds route's own flag read. A stopped Discovery reads each of those flags OFF, which is exactly what the manual recovery does.
  - (d) As (c), but latched until a human clears it. Consequence: the engine mode is not latched (a cleared condition returns the configured mode on the next resolution), so a latch here would make the two halves disagree.
- **Decision.** (c), not latched, through one module, `lib/discoveryStopGate.ts`.
  - **What halts:** a tripped `12` condition (`evaluateStopConditions`, the verdict the resolver takes, in-process), or the manual stop `disable_discovery_pde` TRUE, read fail-closed through `isKillSwitchEngaged` and cached 30 s per client. Every gated path is PDE serving, so the switch named "disable PDE" disables it on each of them; the resolver already reads it for `pde` (D3=B).
  - **Only when the flag reads ON.** A reader whose flag is OFF never reaches the gate, so flag-off reads and bytes are unchanged, pinned by B0/B1 and by the untouched goldens (§79 Z0, §85 P1–P3, §78 G1–G3).
  - **The gate also measures.** The resolver refreshes 3391's four database conditions only for a non-legacy mode, and 3455/3456 serve in `legacy`. So the 3455 and 3456 readers run the same single-flight refresh, at most once per 30 s per client (G6). The §78/§85 readers do not: they are handed a write-suppressed client on shadow runs, whose `rpc` answers inertly, and a refresh through it would record four false `unreadable` readings that halt once armed (M8 proves the difference). Action 10 activates those flags in `pde` cohorts, where the resolver measures.
  - **Scope.** 3455, 3456, 3450–3454 (including Pulse's objective, which shares 3450 and so returns to its flag-off order too), 3480–3484's pipeline reads (including the output kinds and 3484's served graph-provenance leg). **Not** gated, each with its reason: `discovery_live_rank_enabled` (2850) is Sensing's safety demotion, and turning a demotion of dangerous places off automatically is not a safe fall-back; 3500's objective ranks (Trail, Trending, Trip Planning), 3485's Trail exploration, 3490, 3496 and 2361's projection serve surfaces the stop does not measure or change no order. Their recovery stays the flag flip in the approval request.
- **Reversibility.** Revert the five one-line hunks (`discoveryOnePipeline.ts` ×2 plus its import line, `discoveryRankFlags.ts`, `pipelineFlags.ts`, `routes/discoveryOutputKinds.ts`) and delete the module. Nothing is stored.
- **Where.** `artifacts/api-server/src/lib/discoveryStopGate.ts`; the readers above. Tests: `src/test/discoveryStopGate.test.ts` B0, B1, G1–G6 and controls C1–C4c; mutations M1–M11 (census §97.4).

### D-W11S-2 — a rollback file for every file that had none, and what each refuses

- **The question.** Approval request §3 and §4: *"2901, 2921 and 2930 have no rollback file and no in-file reversal note"*; *"No `db/rollback/` file exists for 3440, 3441, the P0 files 2289, 2297, 2892, 2894 and 2995, or 2893."*
- **Options considered.** (a) Leave the in-file notes (the gap is "the file form, not the method"). Consequence: 2297's and 2894's notes DELETE user rows, 2892's drops a table under later files that build on it, and 2901/2921/2930 have nothing. (b) Files in the style of W10-F's: guarded, deleting their own ledger row, with postconditions, refusing where data or an ON flag would be lost.
- **Decision.** (b), eleven files, each rehearsed (census §97.5).
  - **Refuse, never delete, where user or financial data would be lost:** 2297 while a `dismiss` row exists; 2894 while a `trip_add` row exists; 2901 and 2921 while their ledgers hold any row (the owner's retention question, W10D-B0 / C-11). **For 2901 and 2921 a true rollback is unsafe once a row exists, so those files are the refusing kind.**
  - **Refuse where an ON flag would be lost:** 2289 while its flag is TRUE (and keep a row 2289 did not write); 2921 and 2930 while `creator_attribution_enabled` is TRUE.
  - **Refuse while a later file builds on it** (newest first): 2297 under 2894 or 2995; 2892 under 3410, 3435 or 3476 (a column outside its fifteen), 3476 or 3477; 2901 under 2930 or 3387; 2921 under 3385 or 3387; 2930 under 3385; 2893 unless the CHECK is exactly its eight.
  - **2892 refuses while `place_momentum` holds any row.** The rows are derived, but whether their `rank_events` source still exists is a retention fact the file cannot check; the operator deletes them deliberately and re-runs.
  - **3440 and 3441 are their footers as files,** with 2220's and 3415's function bodies copied byte for byte by script. 3441's stored slugs are not rewritten back, and its file says so with a NOTICE count.
- **Reversibility.** Each file is run only as the recovery for a named failure; re-applying the forward file restores the catalogue exactly (0 of 12,320 lines differ, §97.5).
- **Where.** `db/rollback/2026-09-28-{2289,2297,2892,2893,2894,2901,2921,2930,2995,3440,3441}-…-rollback.sql`.

### D-W11S-3 — 3460's postcondition is re-runnable after COMMIT

- **Found by the rehearsal.** Certify stage 4 re-runs every assertion-only non-`$pre$` block after commit. 3460's `$post$` reads `_3460_before`, a `TEMP … ON COMMIT DROP` table, so the re-run fails with `relation "_3460_before" does not exist`: W10-F's F4 defect in a file that landed after F4.
- **Options.** (a) Retag the block `$pre$`: the description check would never be re-run. (b) When the temp table is absent (after commit), re-check only what the committed database can answer, the description; inside the applying transaction, the state check runs as before.
- **Decision.** (b), line-neutral (two lines added at the top of the block's body; no statement changed). 3460 is applied nowhere (apply plan §8.1, its own header), so this is not an edit of an applied migration.
- **Where.** `artifacts/api-server/src/migrations/3460_discovery_search_protection_scope.sql`. Controls: after commit, a description without the gateway fails; inside a transaction, a changed state still fails (census §97.6).

### D-W11S-4 — a `+post` flag file records its ledger row before it can refuse a TRUE flag

- **Found by the rehearsal's negative control.** With `discovery_for_you_pde_enabled` pre-set TRUE, the apply stopped at 3455 (`POSTCONDITION FAILED (3455): … is ON`), and the flag kept its TRUE value, as the plan requires. But 3455 **was recorded** in the ledger: its "ships OFF" check sits in the post-`COMMIT` tail, which the applier runs after the body and its ledger row commit. Apply plan §3 says a file *"is never recorded"* in that case; that is true of 3351 (W10-D's control, an in-transaction check) and false of the 26 flag-seeding files whose only TRUE check is after COMMIT: 3366, 3395, 3400, 3410, 3450–3456, 3465, 3467–3470, 3475, 3480–3485, 3490, 3496, 3500.
- **Options.** (a) Move the TRUE check into each file's transaction: 26 files rewritten for a case the pre-flight already excludes. (b) Correct the plan: the pre-flight reads (§2.1 (b), §8.2 (b')) require every one of these flags ABSENT or FALSE before the apply, and the operator stops if one is not; state the recovery if it happens anyway.
- **Decision.** (b). No value is overwritten either way, and certify stage 4 re-runs the same `$post$` block, so a TRUE flag under a recorded file is never silent. Recovery: turning the flag off is a production decision; until then the file stays recorded and its rollback refuses while the flag is TRUE.
- **Where.** Apply plan §8.5.

### D-W11S-5 — 3385's rollback restores 2930's view comment; the seven tighter privilege lines stay

- **The question.** Apply plan §4.4 and §7.4: after every rollback, eight catalogue lines differ from the baseline, all tighter or equal.
- **Decision.** The one cosmetic line (3385's comment left on the restored view) is fixed: the rollback now sets 2930's comment, verbatim. The other seven are privileges 3390's and 3410's rollbacks do not re-grant to `anon` and `authenticated`. Re-granting them would widen client access to restore a state the rollout itself judged wrong, so they stay, stated.
- **Where.** `db/rollback/2026-09-27-3385-creator-share-ledger-includes-creator-entries-rollback.sql`.

### D-W11S-6 — the rehearsal driver rehearses the current set

- **Decision.** `rehearse-pending-apply.ts` gains `PENDING_AT_3FD11F858` (apply plan §8.1's 73, with §8.1's `+post` shapes), used by `plan`, `postconditions`, `rollback` and `emit-rollback-rehearsal`. `REHEARSE_SET=84318d1b2` selects the historical 40. Line 71, which the census cites, did not move. The zero-persistence file now covers all 73 (step 3 of the apply plan's §8.4).
- **Where.** `artifacts/api-server/scripts/local-db/rehearse-pending-apply.ts`.

No APPROVAL REQUIRED entry is added. Arming the stop (D-W10-O-3) and gate 2 (D-W10R4-2) remain the owner's; D-W11S-1 changes only what happens after either trips.

## DV-83's two remaining paths, from a parallel session (§98)

*2026-09-28, on `claude/sensing-completion-20260925` after `532227796` and the integration of the media test fix. Census section §98 (written as §97 on the branch, renumbered at integration: §97 is W11-S). Row: DV-83 (held at W by §94.10). No migration and no flag. Both changes are line-neutral in every cited file.*

### D-W11X2-15 — a signed-in request whose viewer cannot be resolved is a failed event-post read (DV-83, §94.10)

- **The question.** §94.10: *"A signed-in viewer whose identity cannot be resolved has the event-post read skipped silently … an `auth.getUser` throw, or an `AuthRetryableFetchError`, answers 200 with no posts and no refusal, the same screen as 'nothing live'."* Which failures make a viewer unresolved rather than anonymous, and what does the envelope say?
- **Options considered.**
  - (a) Any `getUser` error is unresolved. Consequence: a revoked or expired token, which Supabase Auth answers with a 4xx, would refuse the feed on every request until the client re-authenticates. A rejection is an answer about the caller, not a failure to look.
  - (b) Only a failure to answer is unresolved: a throw, a presented token with no service client to resolve it, `AuthRetryableFetchError` (auth-js's network and 5xx/52x class), `AuthUnknownError` (a response it could not read), a 429 or 408 (the service declined to evaluate the token, which says nothing about it; `lib/discoveryRefusal.ts` rules a rate limit an outage for the same reason), any error with status 0 or ≥ 500, and a 4xx that carries no Auth error code. A rejection is Supabase Auth's verdict on the token, and a verdict names itself: auth-js sends `X-Supabase-Api-Version` and reads Auth's error code (`bad_jwt`, `session_not_found`, `user_not_found`, …). A code-less 4xx came from in front of Auth, e.g. the API gateway refusing this server's own key ("Invalid API key"), and the token was never evaluated. So a 4xx with a code, `AuthSessionMissingError` (auth-js's name for a revoked session) and `AuthInvalidJwtError` stay anonymous, which owes no event-post read (C2's posture). An error with no status and no known name is read as a rejection, the feed's documented posture for a token it cannot use.
  - Class: (i) `transient_db`, as the other event-post failures; (ii) `upstream_unavailable`, the owner's 2026-09-14 class for a dependency this deployment calls and does not operate.
- **Decision.** (b) and (ii). The unresolved state starts the event-post read as failed (`readFailed: viewerUnresolved`), so the existing path names `"event_posts"` in `failedSources` and the existing coverage rule decides `nothing` or `partial`. Code `feed_viewer_unresolved`. When a place category also failed, the places code and `transient_db` stand, as in D-W11X2-1, with both sources named. No exposure is logged for a refused answer, and nothing is cached.
- **The limit of the rule, stated.** It relies on Auth coding its rejections, which hosted Supabase Auth does for every request that sends `X-Supabase-Api-Version ≥ 2024-01-01` (auth-js sends it; the verifier read `supabase/auth`'s `internal/api/errors.go`, which falls back to `unknown` rather than no code). Two setups would read an expired token as unresolved and show the refused copy instead of the anonymous empty rail: a self-hosted GoTrue from before error codes existed, and a proxy between the api-server and Auth that strips the version header. Neither applies here (every Supabase URL in the repo is `*.supabase.co`), and the failure is an over-refusal, never a silent empty answer.
- **Not decided here, routed.** An unresolved viewer is served community places as an anonymous request is: their own blocks and mutes cannot be applied because they cannot be known. Failing those rows closed would silently withhold places, which is a product choice. §98 records it as a finding. A server with no service client is a deployment misconfiguration; with a Bearer token presented it is an unresolved viewer too (N1).
- **Reversibility.** Revert the six in-place lines in `routes/discovery.ts` and the helper at its foot. Nothing is stored.
- **Where.** `artifacts/api-server/src/routes/discovery.ts` (the feed; `authServiceUnreachable` at the foot). Tests: `src/test/discoveryFeedEventPostsCoverage.test.ts` V1–V9 and C4–C8, appended below the anchored cases; `src/test/discoveryFeedNoServiceClient.test.ts` N1, N2. §98's independent verifier (the parallel session's) found three gaps across two rounds, each fixed before the row moved: 429 and 408 classed as rejections, the no-client case left silent, and the gateway's code-less 401 read as a rejection.

### D-W11X2-16 — a pull refetches the rails whose copy asks for one (DV-83, §94.10)

- **The question.** §94.10: *"Pull-to-refresh also does not refetch the rail its refused copy asks the user to pull."* `DiscoveryEventPostsRail` fetched only when its destination or coordinates changed.
- **Decision.** `ForYouTab` bumps a `refreshKey` on every pull and passes it to `DiscoveryEventPostsRail` and to each `DiscoveryOutputKindsRail`, whose failure copy says "Try again in a moment." Each rail adds the key to its fetch effect's dependencies, so a pull refetches it and nothing else does.
- **Reversibility.** Drop the prop; the rails return to fetching on place changes only.
- **Where.** `travel-buddy-standalone/src/components/discovery/ForYouTab.tsx`, `DiscoveryEventPostsRail.tsx`, `DiscoveryOutputKindsRail.tsx` (line-neutral). Tests: `DiscoveryEventPostsRail.refresh.component.test.tsx` R1, R2; `ForYouTab.pullToRefresh.component.test.tsx`'s third case (every pull, not only the first); `DiscoveryOutputKindsRail.component.test.tsx` O6 (restated: the wiring carries `refreshKey`) and O7 (two pulls).

### D-W11X2-17 — reconciling the two implementations of the same two paths

- **What happened.** Lane W11-X2's round 2 (D-W11X2-10, -13) and a parallel session (D-W11X2-15, -16) fixed the same two §94.10 paths on separate branches. Both were merged at integration. The server had to end with one classifier and one flag. The client had to end with one refresh key.
- **Classifier (superseded by D-W11X2-21).** X2's `isTransientAuthError` is kept, and `authServiceUnreachable` is dropped. X2's rule covers every case the other rule covers: a network failure (status 0), a 5xx, `AuthRetryableFetchError`, and `AuthUnknownError` (no status). It also covers a 408, a 429 and any error without a status, which the other rule read as a rejection. The narrower rule would serve a rate-limited lookup as an anonymous quiet city, which X2's V4 test forbids. A definitive 4xx, including `AuthInvalidJwtError` (400), stays anonymous under both rules. That is C2's posture, and the other session's C4 and C5 controls pass unchanged.
- **Code and class.** The other session's `feed_viewer_unresolved` / `upstream_unavailable` is kept. The auth service is a dependency this deployment calls, and a distinct code keeps an alert on `feed_event_posts_read_failed` from firing for an auth outage. X2's V1 and V4 assertions now expect it. They are no weaker: each still requires a refusal, the same `failedSources`, and the same coverage.
- **Flag and wiring.** One variable (`viewerUnresolved`) and one set on the thrown path. X2's duplicate line was restored to its original text, so the route diff stays line-neutral (6 lines changed in place). The client keeps one `railRefreshKey`: the other session's duplicate declaration was restored. It keeps the other session's wider wiring, which passes the key to the output-kinds rails too.
- **Where.** `routes/discovery.ts`; `ForYouTab.tsx`; `src/test/discoveryFeedEventPostsCoverage.test.ts` (21/21).

### D-W11X2-21 — one auth-lookup classifier, after the parallel session's third round

- **What happened.** After D-W11X2-17 kept X2's `isTransientAuthError`, the parallel session pushed its third round. That round refined `authServiceUnreachable` with three changes: a 4xx is Auth's verdict only when it carries Auth's error `code`, `AuthSessionMissingError` and `AuthInvalidJwtError` are rejections by name, and 429/408 are failures. Its independent verifier checked each change. The two rules now disagreed in both directions. X2's rule read a code-less 401, such as the gateway refusing this server's own key, as an anonymous caller. The refined rule read an error with no status and no known name as a rejection.
- **Decision.** One rule, fail-closed wherever the two rules disagreed. `authServiceUnreachable` is the classifier; line 2633 of the feed calls it, and `isTransientAuthError` now only delegates to it.
  - It keeps the refined rule's verdict test: a coded 4xx, or a named auth-js rejection, is an anonymous caller.
  - It keeps X2's reading of a missing status: an error with no status and no known name is not a verdict, so the viewer is unresolved.
  - Every other disagreement also resolves to "unresolved". DV-83 forbids serving a failure as an empty answer; wrongly refusing is the recoverable error, and a silent quiet city is not.
- **Tests.**
  - The parallel session's V1–V9, C4–C8, N1 and N2 pass unchanged.
  - X2's V3 control (a definitive 401 is anonymous) keeps its assertion. Its fixture now carries Auth's `code: "bad_jwt"`, as a real Supabase Auth rejection does. The code-less 401 is the refined rule's V9 case, and V9 asserts the opposite outcome.
  - The same code is added to the fixture's wrong-token answer on line 102.
- **Reversibility.** Revert line 2633's call and the one line at the foot that reads a status-less error; nothing is stored.
- **Where.** `artifacts/api-server/src/routes/discovery.ts` (line 2633; `isTransientAuthError`'s body; `authServiceUnreachable` at the foot); `src/test/discoveryFeedEventPostsCoverage.test.ts` lines 101–102.

## TM-P — people search failure honesty (testing mode)

*Lane tm-people, 2026-09-29, branch `lane-tm-people` from `f10a4ac9f`. Census section §106. No flag, no migration, nothing under payments; `routes/compass.ts` and `routes/compassSense.ts` untouched.*

### D-TMP-1 — a failed read on `GET /users/search` answers `db_error`; the emergency stop answers the refusal envelope

- **The question.** The route failed CLOSED on five reads (blocks, discovery opt-outs, the name-visibility rule, follow state, the `disable_profile_search` stop) but said so with `200 {users: []}`, the body a genuine miss gets. DV-83's principle (census-discovery §§60–98): a failed read is never presented as empty.
- **Options considered.**
  - (a) Keep 200 and add a refusal envelope everywhere. Honest, but the route already answers its own profiles-read failure with `sendError(res, "db_error")`, so a second failure vocabulary inside one handler.
  - (b) `db_error` for every failed read, and the refusal envelope only for the stop. The stop is a deliberate soft stop whose 200 shape `emergencyFlags.test.ts` pins; a refusal (`feature_disabled`, `profile_search_stopped`, coverage `nothing`) keeps that shape and stops it being byte-identical to a miss.
  - (c) `db_error` for the stop too. Rejected: it would restate the pinned soft-stop contract, and an engaged stop is not a database failure.
- **Decision and rationale.** (b). Still fail-closed — no row is served on any of these paths — and healthy bodies are byte-identical (golden G1, captured before the fix). The stop's flag read also fails closed (`isKillSwitchEngaged` treats an unreadable flag as engaged), so an unreadable flag gets the same refusal; the body says nothing was searched, which is true either way.
- **Follow-state reads.** A failed read of the viewer's follow edges or pending requests used to serve every row as "not following" / "no request sent" — a wrong action on a real row. It now fails the search (`db_error`) instead of serving degraded rows. A failed shared-destination read still only drops the decorative "Both going to …" label, as before.
- **Reversibility.** Revert the six in-place lines; nothing is stored.
- **Where.** `artifacts/api-server/src/routes/follows.ts` (line-neutral), `artifacts/api-server/src/lib/publicIdentity.ts` (`readNameVisibilitySet` at the foot; `nameVisibilitySet` unchanged for its other callers). Tests: `src/test/userSearchFailureHonesty.test.ts` G1–G4, F1–F7, K1–K2.

### D-TMP-2 — the client treats a refusal or a list-less 200 as a failed read

- **Decision.** `searchUsers` returns `ok: false` for a body carrying `refusal` (errorKind = the refusal class) and for a 200 whose `users` is not an array (`malformed_response`); `getSuggestedTravelers` does the same for a list-less 200. Every consumer already branches on `ok`, so the refusal never reaches a screen as data.
- **Where.** `travel-buddy-standalone/src/services/follows.ts` (two lines, in place). Tests: discover D3, D4, S3.

### D-TMP-3 — every people-search surface: a failed state with Retry, a true empty, and a generation guard

- **Decision.** Each surface over `searchUsers` keeps a generation ref (the `loadIdRef` pattern of DiscoveryCategoryTab, D-W11X2-38 on the open branch): a new query, a clear, a closed sheet or a query shorter than the search minimum bumps it, and an answer for an older generation writes nothing — not its rows, not its failure, not its spinner. A failed read shows the surface's failed state with a Retry control (accessibility label "Retry"); a genuine miss keeps the surface's existing "none found" copy. Two surfaces that showed nothing at all for a miss (Create Event's invite step, the media InvitePanel) now say "No travellers found", in the spelling those screens already use, so a miss and a failure are different screens.
- **Where.** `app/discover.tsx`, `app/close-friends.tsx`, `app/events/create/index.tsx`, `src/components/HostDashboardPanel.tsx`, `src/components/ShareSheet.tsx`, `src/components/DiscoveryShareSheet.tsx`, `src/features/media/components/MediaActionPanels.tsx` (all line-neutral except `app/discover.tsx`, which no document cites by line).

### D-TMP-4 — Close Friends adds only the exact handle

- **The question.** `searchUsers(raw, 1)` took the first `%raw%` match on name, handle or username, so "@ali" could add "@alison" to Close Friends — who then sees Close Friends stories.
- **Decision.** Search with the default page (20) and add only the row whose handle equals the typed one, case-insensitively; otherwise "Not found". A failed lookup says so and offers Retry.
- **Reversibility.** One line. **Where.** `app/close-friends.tsx`; tests C4, C5.

### D-TMP-5 — `app/search.tsx` is not edited by this lane

- **The question.** The brief names the global search's people section. On `main` its Travelers tab already routes a failed or refused read to the error state with "Tap to retry" (`travel-buddy-standalone/app/search.tsx:232#if (!res.ok) {`), and `GET /discovery/search` refuses an unreadable block or age set (`artifacts/api-server/src/routes/discoverySearch.ts:243#if (!blockedSet || !ageRestrictedSet) {`). What remains on `main` is the stale-answer race (same query and tab re-run; a superseded page 1 ending the newer one's loading).
- **Decision.** Leave the file to the open branch `origin/claude/sensing-completion-20260925`, whose commit `c2221c48f` adds exactly that generation guard (D-W11X2-44) on lines this lane would have to rewrite. Editing them here would conflict with that branch and duplicate its fix.
- **Consequence.** Until that branch lands, the race remains on `main`'s global search. Recorded in §106 as open.

## OWNER-1004 — the owner's answers to questions 11(a), 12, 15 and 16

*Owner answers taken 2026-10-04, recorded by lane `claude/owner-decisions-20261004` from `f71cfb85f`. They answer four of the questions in `docs/ops/discovery-owner-approval-request.md` §5 — 11(a) (W10D-C8, the raw half of D-W10-R1-12's three values), 12 (§58.12 Q1, the first half of W10D-C4), 15 (D-W10-O-9, W10D-C1) and 16 (D-W10-R3-4, AR-W11A-2, W10D-C5). This section does not edit those entries; it records what was answered, under the register's one-section-per-lane rule.*

**Documentation only.** No migration was applied, no flag was flipped, no route changed, nothing was deployed and no collection was enabled by this section. **An answer authorises work; it moves no verdict.** No census row changes on the strength of a ruling — each still needs its own acceptance evidence, measured after the change lands. Two of the four are **conditional approvals and must not be read as clearances**: see D-OWNER1004-1 and D-OWNER1004-3.

### D-OWNER1004-1 — question 11(a): 30 days as a PROPOSED default, pending the required legal review

- **The question** (W10D-C8; approval request §5 question 11, part (a)). How long are the `raw_recent` behavioural rows kept — `recommendations` (3376, 3491), `rank_events` dwell rows, `ranking_debug_samples`? The request records that there is **no spec value**, and that `04` §11 requires *"Exact retention must be decided with privacy/legal review"*.
- **The answer, verbatim.**

  > "Set Q11(a) raw behavioural-row retention to 30 days, then delete the identifiable raw rows; retain only irreversibly aggregated data where needed. Treat 30 days as the proposed product default **pending the required legal review**."

- **The gating condition, stated as the condition it is.** 30 days is a **proposed product default**. The legal review `04` §11 requires **has not happened**, and nothing in this record says it has. Until it has, the number is a proposal: a sweep may be designed and tested against it, and **no retention horizon may be presented to a user, published in a notice, or treated as the settled policy**. The answer does not itself authorise deletion of any production row.
- **What the tree enforces today, measured at `f71cfb85f`.** The tier is a **label with no enforcement**: `recommendations` ships `retention_tier` defaulting to `raw_recent` and the migration says so in terms — `artifacts/api-server/src/migrations/3376_discovery_recommendations_per_request.sql:48#and ENFORCED NOWHERE, exactly` — and `rank_events` carries the same default (`artifacts/api-server/src/migrations/2890_rank_events_behavior_engine_columns.sql:275#ADD COLUMN IF NOT EXISTS retention_tier text NOT NULL DEFAULT 'raw_recent';`). **No sweep exists** over either store at any horizon. So the state after this answer is: a number proposed, a sweep still owed, and rows still accumulating unswept.
- **CONFLICT, recorded and NOT resolved here.** `ranking_debug_samples` is already purged at **7 days** by a function in the chain — `artifacts/api-server/src/migrations/0203_backfill_counter_and_purge_functions.sql:91#WHERE sampled_at < now() - INTERVAL '7 days';` — and the approval request's own recommendation was to **keep** that 7 days for debug samples. Reading "30 days" onto that store would **lengthen** an existing enforced purge, which is a weakening and is not something this record authorises. The 7-day purge is left exactly as it is. Which horizon governs `ranking_debug_samples` is **unknown** and is one of the things the legal review must settle.
- **What it unblocks.** The design and testing of a sweep to a 30-day horizon over the identifiable raw rows, with irreversible aggregation where a longer-lived figure is needed. Nothing is scheduled by this answer.
- **What it does NOT unblock.** Question 15 (dwell) — the request's own rule is *"Do not turn on dwell (question 15) without it"*, and 11(a) being answered conditionally does not satisfy that; question 15 is separately refused below. Parts **11(b)** (trend snapshots) and **11(c)** (the three new Trail stores) are **still unanswered**, so action 11 is **not closed** and the trend scheduler (13.1) is still gated: DC-06, DC-07, DC-17, DV-28–DV-31, DV-33 and DV-34 continue to wait on 11(b).
- **Reversibility.** Documentation. The number may be replaced by whatever the legal review sets, at no cost, because no sweep has been built to it and no row has been deleted under it.

### D-OWNER1004-2 — question 12: the trend API may publish, under k ≥ 15 and protected-zone suppression

- **The question** (§58.12 Q1, the first half of W10D-C4; approval request §5 question 12). Must a published trend meet `PRIVACY_THRESHOLD_V1` (at least 15 distinct travellers per window) and be withheld inside protected zones?
- **The answer, verbatim.**

  > "Close Q12 with the threshold of at least 15 travellers and suppress contributions inside protected zones."

- **Decision.** Closed: yes to both floors. `discovery_trending_api_enabled` and `discovery_trend_lists_enabled` may be turned on in the order action 13 gives, and DC-21, DV-29 and DV-33 then need production rows.
- **The approval request claimed "The lists already apply both." VERIFIED at `f71cfb85f`, and the claim holds for the place legs only.**
  - **The k floor — HOLDS on every published leg.** k is `PRIVACY_THRESHOLD_V1.minUniqueActors`, which is 15 (`artifacts/api-server/src/lib/intelContracts.ts:733#minUniqueActors: 15,`), reused rather than re-chosen (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:71#export const TREND_DISCLOSURE_MIN_TRAVELERS = PRIVACY_THRESHOLD_V1.minUniqueActors;`) and required in **both** windows (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:136#function travelersOk(v: unknown): boolean {`, `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:145#export function mayDiscloseTrend(row: TrendSnapshotRow): boolean {`). Applied to the place lists in `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:531#export function orderLocated(rows: readonly LocatedRow[]`, to named neighbourhoods in `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:356#export function mayNameNeighbourhood(area: TrendAreaRow`, and to the emerging-Trails fold in `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:760#async function emergingTrails(sc: any, viewerId: string, destination: string, nowMs: number)`. A row written before 3410 carries no counts and is never disclosed, so the floor is fail-closed. Pinned by `artifacts/api-server/src/test/discoveryTrendingLists.test.ts:227#it("L-D1.` and `artifacts/api-server/src/test/discoveryTrendingLists.test.ts:286#it("L-G1.`.
  - **Protected-zone suppression — HOLDS for `places`, `for-you` and the places half of `emerging`.** `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:478#export async function eligibleListPlaces(sc: any, viewerId: string, placeIds: readonly string[])` reads the active zones (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:489#const zones = await loadActiveProtectedZones(sc);`), withholds **every** positioned place when the zone policy is unreadable (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:608#if (zones === null) return false;`), and drops a place the zone pass suppresses or coarsens (`artifacts/api-server/src/lib/discoveryTrendExplanation.ts:612#return applyProtection([probe], zones).objects[0] === probe;`). A list is never served with a rule it could not apply. Pinned by `artifacts/api-server/src/test/discoveryTrendingLists.test.ts:241#it("L-E1.` and `artifacts/api-server/src/test/discoveryTrendingLists.test.ts:259#it("L-E2.`.
  - **CORRECTION, 2026-10-04 — this bullet was true at `f71cfb85f` and is no longer true of the tree.** PR #591 closed both legs after this entry was written, lifting the decision into `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:604#export function zoneAllowsPosition(` and calling it from the `areas` list and the emerging-Trails fold. The two PRs were each green alone; merging both is what made the citations below stale, which nothing could catch pre-merge. The finding is kept as written because it records what was verified, and when. The contribution-side bullet that follows is UNAFFECTED and still holds.
  - **Protected-zone suppression — DOES NOT HOLD for the `areas` (Local Pulse) list, nor for the emerging-Trails leg.** `artifacts/api-server/src/lib/discoveryTrendExplanation.ts:695#export async function localPulse(sc: any, destination: string, nowMs: number)` never calls `eligibleListPlaces`, reads no zone, and filters on the k floor alone; `emergingTrails` likewise reads no zone. So for those two legs **this answer is answered-but-not-yet-implemented**.
  - **No contribution-side suppression exists at either producer.** The answer's words are *"suppress contributions inside protected zones"*. What the tree does is withhold the **output** for a positioned place; it does not exclude a contribution made inside a zone from the momentum computation. Neither `place_momentum` nor `area_momentum` is produced with any zone filter: no rebuild migration in the chain (2892, 3410, 3417, 3435, 3475–3477, 3497) reads a protected zone. Whether the owner's words require input-side exclusion as well as output-side withholding is **unknown** and is not decided here.
- **Consequence for activation.** The place legs are covered. Turning on the `areas` list, the emerging-Trails leg, or either momentum producer on the strength of this answer alone would ship a leg whose zone floor is not applied. That is a code gap, named here, not a decision.
- **Reversibility.** `UPDATE public.feature_flags SET enabled = false WHERE flag IN ('discovery_trending_api_enabled', 'discovery_trend_lists_enabled');` — both are read per request, fail-closed, so revoking takes effect on the next request.

### D-OWNER1004-3 — question 15: dwell-time publishing stays OFF until a privacy notice is written and approved

- **The question** (D-W10-O-9, W10D-C1; approval request §5 question 15). For a signed-in viewer, on the Discovery place detail sheet only, may Portava record active, passive and idle milliseconds as `rank_events` rows linked to the account?
- **The answer, verbatim.**

  > "Keep Q15 dwell-time publishing off until the privacy notice is written and approved."

- **This is a refusal with a condition attached, not an approval.** `discovery_dwell_telemetry_enabled` stays FALSE. Nothing is measured, sent, read or written, and the route answers 404 `feature_disabled`. The migration that seeds the flag asserts the OFF state as a postcondition (`artifacts/api-server/src/migrations/3395_discovery_dwell_telemetry_flag.sql:76#WHERE flag = 'discovery_dwell_telemetry_enabled' AND enabled = TRUE;`), and that assertion stands untouched.
- **The condition that gates it, and its state.** A privacy notice must be **written and approved**. Approval request §5 question 15 carries **draft** wording for it, beginning *"When you open a place from Discovery, Portava records how long the place stays open on your screen…"*. That wording is a draft referenced by this record. **It has not been written into any notice and it has not been approved.** Nothing here approves it. Who approves it, and whether the consent model also needs an opt-in built, are **unknown**.
- **Consequence.** DV-41 and DV-78 stay **W**. DV-41 still owes one production `place_dwell` row, which cannot exist while the flag is FALSE; DV-78 additionally owes the Trail-open event, which is not built. Neither is a defect.
- **Reversibility.** Nothing to reverse: the answer keeps today's state.

### D-OWNER1004-4 — question 16: "no" to all three people-derived-data uses

- **The question** (16(a) D-W10-R3-4, 16(b) AR-W11A-2, 16(c) W10D-C5; approval request §5 question 16).
- **The answer, verbatim.**

  > "Answer Q16 'no' for all three people-derived-data uses."

- **Decision, part by part, with the consequence the request states for each. These consequences are the ANSWER working as intended. They are not defects and must not be "fixed".**
  - **16(a) — no.** Circle mates' published Memories may **not** generate Discovery candidates. `discovery_circle_candidates_enabled` stays FALSE; 3480 asserts both its flags ship OFF (`artifacts/api-server/src/migrations/3480_discovery_candidate_sources_flag.sql:73#SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN (`) and the retrieval is only reached when the caller opts in (`artifacts/api-server/src/lib/discoveryCandidates/generate.ts:119#...(opts.circle ? [retrieveCircleContext(ctx)] : []),`, over `artifacts/api-server/src/lib/discoveryCandidates/retrievals.ts:392#export function retrieveCircleContext(ctx: RetrievalContext): Promise<RetrievalOutcome> {`). **Consequence: DC-12 stays at 10 of 11 sources, and stays W.** The eleventh source is refused, not missing. A later reading that counts 10 sources as incomplete coverage is re-litigating this answer.
  - **16(b) — no, for now.** Circle and crew membership, and visit records (`passport_stamps`, `circle_checkins`, `plan_checkins`), may **not** count as independent convergence for a public trend. No aggregated-count lane is authorised. **Consequence: DV-34 stays W on those legs.** The post-after-visit leg DV-34 also carries is unaffected by this answer and continues to wait on action 11(b) and action 13.
  - **16(c) — no.** `traveler_affinities`, itinerary-based `place_cooccurrence` and `circle_momentum` may **not** be built from people's data. The Trail-only form stands and is built (`3495_place_cooccurrence_trail_projection.sql`), and it needs no personal data. **Consequence: DV-72 stays W** until one `place_cooccurrence` run exists in production; its personal forms are refused permanently, not owed.
- **Reversibility.** Each part is a FALSE flag or an unbuilt projection. "No" leaves today's state; a later "yes" would need its own consent basis named, and 16(a) additionally needs `circle_member_visibility_overrides` honoured in `retrieveCircleContext` before its flag could be turned on at all.
