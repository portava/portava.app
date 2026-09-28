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
