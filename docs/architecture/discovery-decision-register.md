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
