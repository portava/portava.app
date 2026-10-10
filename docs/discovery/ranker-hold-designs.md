# Ranker work under the 2026-08-15 hold — build-ready designs

*Written 2026-09-27 by the Discovery ranking-and-cache lane (census-discovery §47). **Nothing in this file is built.***

`docs/discovery/ROADMAP.md` records the owner ruling of 2026-08-15: *"RANKER WORK GOES ON EXPLICIT HOLD … No optimising ranking machinery over an empty corpus."* Later passages in the same file read the hold as governing the **flip** and not an inert build. That reading is not an owner ruling, and the owner has been asked.

Until an answer is relayed, each gap below is written so it can be started the moment it is permitted. Each entry gives:

- the exact file:line gap;
- the proposed module;
- the flag, seeded FALSE and numbered from this lane's migration range 3370–3374;
- the tests that must be green before the flag may be turned on.

**No migration in 3370–3374 has been written.** A flag row for machinery that does not exist would be a switch wired to nothing.

The **HAZARDS** of census-discovery §41.4 on DC-13 and DC-24 are binding on designs 5 and 6 below. Every design shares three rules:

- **Flag OFF means byte-identical.** `src/test/discoveryServePathIsolation.test.ts` L0 replays a golden of the tree before this lane. Any build must keep L0 green with its flag off.
- **One pipeline.** Everything plugs into `lib/discoveryPde.ts` `rankForViewer` (portavaRank, then DRS, then the modifiers stage). Nothing imports `services/ranking/rankingConfig.ts` into Discovery (§41.4, DC-13 hazard).
- **Eligibility is not ranking.** Every author, moderation and age rule stays a pre-filter or a post-rank gate, as it is today, and is never a score term.

---

## 1. DV-53 — explicit exploration inventory (reserved, relevant, not random)

**Gaps, at this tree:**

- The exploration governor runs only inside the modifiers stage, `artifacts/api-server/src/lib/discoveryPde.ts:756#if (modifiers.enabled) {`, behind `discovery_ranking_modifiers_enabled` (2289, seeded OFF).
- With the modifiers off, portavaRank's epsilon slot fills every 7th position with a pick drawn **at random** from the tail: `artifacts/api-server/src/lib/portavaRank.ts:497#export function injectExploration`. `06` §7 asks for exploration that is *"relevant, not random"*.
- Census row DV-53 says `allocateFeedSlots` has **no production caller**. That is false. It is called on the Compass `for_you` path, `artifacts/api-server/src/compass/CompassFeedBuilder.ts:714#finalPool = allocateFeedSlots(finalPool, shares, { surface: "discovery"`, behind `DISCOVERY_DIVERSITY_ENABLED`, which is FALSE on production.
- Compass fair exposure is inert on Discovery rows. `artifacts/api-server/src/compass/CompassDiscoveryAdapter.ts:36#export function discoveryPlaceToCompassItem` maps no `authorId`, so no creator is recognisable to it.

**Module:** `lib/discoveryExplorationInventory.ts`. Given the merged candidate set and the viewer, it returns four reserved buckets:

| bucket | source | rule |
|---|---|---|
| new creator | `discovery_places.submitted_by` whose first active submission is younger than N days | the submitter passes the author policy (blocks, mutes, standing) — see census-discovery §47 |
| low exposure | impression counts per `item_id` over 30 days from `rank_events` (served rows only) | below the city's p25 |
| emerging place | `lib/discoveryTrendState.ts` state `rising` / `rediscovered` | only states that ARE claims (`unknown` never qualifies) |
| new Trail | `trails.created_at` for a Trail containing the place (2910 is applied on production; 0 rows) | none until a Trail exists |

Each bucket member must clear a **relevance floor**: its portavaRank score must be at or above the page's p50 without the exploration term. That floor is what makes the pick relevant rather than random. The governor (`allocateExplorationBudget`) then places the members within the ruled 15–25 % budget. This replaces the random tail pick; `rankCandidates(…, { exploration: false })` is the existing switch.

**Flag:** `discovery_exploration_inventory_enabled`, migration **3370**, seeded FALSE. Its postcondition RAISEs if seeded TRUE, which is 2289's shape.

**Tests:**

- (a) flag off: L0 green and `injectExploration` unchanged;
- (b) flag on: no page slot is filled by a candidate below the relevance floor;
- (c) the budget never exceeds 25 % of the page;
- (d) a blocked, muted or non-active submitter is never a new-creator pick;
- (e) seeded allocation is deterministic per (viewer, hour);
- (f) with an empty bucket nothing is invented.

## 2. DV-54 — the remaining diversity axes

**Gaps:**

- `placePenalty` and `geoPenalty` have no default at `artifacts/api-server/src/lib/portavaRank.ts:591#placePenalty?: number;` and `:592`. Absent means 0 (`artifacts/api-server/src/lib/portavaRank.ts:603#function resolveDiversityPenalties(`), so both axes compare keys and multiply the result by zero.
- The repeated-recommendation window is one page. Nothing looks across serves.

**Module:** `lib/discoveryDiversityPolicy.ts`. It reads the two magnitudes and a cross-serve history window **from the flag row's metadata**, never from a code constant. That keeps them owner-set values (census-discovery §42.1: *"picking a number by resemblance would be inventing a ranking constant"*). It passes them to `rankCandidates` as `DiversityOptions`. For history it reuses `loadPdeViewer`'s seen set (already per viewer, 24 h, served rows only) as a place-level repetition key across serves.

**Flag:** `discovery_diversity_axes_enabled`, migration **3371**, seeded FALSE with `metadata = {"placePenalty": null, "geoPenalty": null, "historyServes": null}`. A null magnitude keeps its axis at 0, so enabling the flag without a ruling changes nothing.

**Tests:** flag off L0-identical; each magnitude bites only when set (extending census §42's E2/P-series); a null magnitude changes nothing; the history axis never demotes a place the viewer has not been served.

## 3. DV-55 — cold start (new user · new creator · new Trail/place)

**Gaps:**

- `loadPdeViewer` reads interests only from `compass_user_preferences` (`artifacts/api-server/src/lib/discoveryPde.ts:435#.select("interests, category_weights")`). A new user has none there.
- The onboarding answers the product already stores, `profiles.interests` and `profiles.travel_style` (`artifacts/api-server/src/routes/profile.ts:490#interests: z.array(z.string().max(50)).max(20).optional(),`), reach no ranker.
- New creator is design 1's bucket. New Trail and new place are design 1's emerging-place and new-Trail buckets.

**Module:** `lib/discoveryColdStart.ts`. When the viewer's category observations fall below `MIN_TOTAL_CATEGORY_OBSERVATIONS`, it seeds `interestTags` from `profiles.interests` and `travel_style`, tagged `source: "onboarding"`. Stated interests are an instruction, not an inference, so they are used as interests and never as learned affinities. It never writes to Compass preferences.

**Flag:** `discovery_cold_start_enabled`, migration **3372**, seeded FALSE.

**Tests:** flag off L0-identical; a viewer at or above the observation floor is untouched; an unreadable profile read degrades to today's behaviour and records `degraded`; no onboarding value is ever written back.

## 4. DV-12 / DC-11 integrity — never reward abusive engagement

**Gaps:**

- The one defence is a **constant** on Discovery. `artifacts/api-server/src/lib/portavaRank.ts:314#const trustFactor = c.authorTrustScore != null` multiplies social proof by 0.6 whenever `authorTrustScore` is unknown.
- No Discovery candidate sets it: the candidate map at `artifacts/api-server/src/lib/discoveryPde.ts:590#const candidates: PlaceCandidate<T>[] = places.map((p) => ({` has no trust field. So every row carries the same factor and the defence discriminates nothing.
- The detector exists. `services/trust/TrustGamingDetectionService.ts` writes `trust_reviews` of type `gaming_suspected`: check-in cluster farming, mutual upvote rings, and rapid score jumps.

**Module:** `lib/discoveryEngagementIntegrity.ts`. For the candidate rows' submitters and the accounts behind each row's saves, it reads open `gaming_suspected` reviews and the submitter's trust score. It then:

- sets `authorTrustScore` on authored rows;
- recomputes `likeCount` (the save count) **excluding saves by flagged accounts**.

It is a discount on inflated evidence, never a penalty on a person: `01` §10 forbids turning a safety event into a public reputation penalty, and the reason-code guardrail already keeps `trust` out of explanations.

**Flag:** `discovery_engagement_integrity_enabled`, migration **3373**, seeded FALSE.

**Tests:** flag off L0-identical; a farmed save does not raise a row; an unflagged row is untouched; a read failure keeps today's constant rather than zeroing social proof; no trust or gaming signal reaches a reason code (`discoveryCandidate` I5).

## 5. DV-09 / DC-13 — surface objectives and feature families — **HAZARD**

**Gaps:**

- Discovery ranks with portavaRank's one weight bag, `artifacts/api-server/src/lib/portavaRank.ts:220#export const DEFAULT_WEIGHTS`.
- The named-family configuration with per-surface weights and a `negativeFeedback` penalty lives in `services/ranking/rankingConfig.ts`.

**§41.4 HAZARD:** importing that config into Discovery adds a fourth consumer of the parallel stack DC-24 grades as a failure. Its `negativeFeedback` penalty would also contribute 0.

**Module:** `lib/discoveryFeatureFamilies.ts`. It is a pure **view** that groups portavaRank's existing feature keys into `06` §3's eleven families. `trail_relevance` becomes `trailAffinity`. `negative_feedback` is **dismissals as a family input at creator and category level**. The dismissal writer and reader now exist (`lib/discoveryDismissed.ts`); place-level dismissals stay a filter. The view reads per-surface family weights from its own flag's metadata. Discovery never imports `rankingConfig.ts`.

**Flag:** `discovery_feature_families_enabled`, migration **3374**, seeded FALSE, metadata `{"surfaces": {"discovery": null, …}}`.

**Tests:** flag off L0-identical; the family view reproduces today's scores exactly when every family weight is 1; no import edge from `lib/discovery*.ts` or `routes/discovery*.ts` to `services/ranking/rankingConfig.ts` (a source guard); a place-level dismissal is still removed and never merely down-weighted.

## 6. DC-24 — one ranker for `for_you` — **HAZARD**

**Gaps:**

- A signed-in `for_you` cold request with Compass on is ordered by Compass (`artifacts/api-server/src/routes/discovery.ts:2175#const scored = await rankItemsForDiscovery`) and not by `rankForViewer`.
- §41.4: consolidating removes the parallel path that is DV-09's only passing leg. It would also change served `for_you` order **with no flag in front of it**.

**Design:** no new flag. The consolidation rides the existing `DISCOVERY_ENGINE_MODE`. In `pde` mode, for an in-cohort viewer, the Compass branch is skipped and the cold `for_you` page is ranked by `rankForViewer`, so it is gated by Phase F gate 2 like every other pde change. Legacy keeps Compass. Design 5's `discovery` surface objective must exist **first**, so that DV-09's Discovery leg is carried by the consolidated pipeline before Compass leaves it.

**Tests:** legacy L0-identical; pde plus cohort `for_you` never reaches `rankItemsForDiscovery` and never writes Cache B; pde with a closed cohort behaves as legacy (`discoveryServePathIsolation` M1 extended to the Compass branch).

## 7. `trip_match` (DV-18, DV-09 Trip Planning)

**Gap:** no trip-fit term in either ranker, and `GET /discovery` takes no `tripId`.

**Design:** a capped modifier inside the existing modifiers stage, like `trailAffinity`, reading the trip projection (`lib/discoveryTripProjectionConsumer.ts`). It sits behind `discovery_ranking_modifiers_enabled` (2289), so it needs no new flag. **Precondition:** a `tripId` parameter must enter `authorizedContextKey` before it enters the ranker. Otherwise census-discovery §12.5's DSV2-06 trip-context clause turns red.

**Tests:** modifiers off L0-identical; the term is capped; a request with a `tripId` and a cached page for another trip misses Cache B.
