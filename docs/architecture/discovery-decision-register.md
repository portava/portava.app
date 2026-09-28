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
