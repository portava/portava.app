# Sensing / intel surface — inventory of what exists

*Derived from the repository at branch `claude/portava-continuation-uqta94`, 2026-09-07. This file
is a **denominator**, not an assessment: it records what is in the tree and what is reachable from
it, so that a later census against a specification is a **diff against a known inventory** rather
than a fresh crawl.*

**This document contains no specification requirement, and makes no claim about what Sensing ought
to do.** No spec was available when it was written. Every line below is either a citation or a
stated failure to establish something. Paths are relative to `artifacts/api-server/src/` unless
they begin with `db/`, `docs/` or `.agents/`.

---

## MEASURED AGAINST BOTH DATABASES, 2026-09-07 — resolves "could not establish" item 1

This document was written without database access and correctly recorded that it could not
establish whether migrations `2273`–`2279` are applied in production. They are **not**, and the
gap is structural rather than incidental.

**The migration chain declares 15 `intel_*` tables. Production has 10.** The five that exist in
`portava-ci` and are **absent from production** (`ajrurzioarfkagpuxfnb`):

| Table | Migration | The code that targets it |
|---|---|---|
| `intel_state_snapshot_versions` | `2273_intel_replayable_projection.sql` | `intelReplay` |
| `intel_presence_verifications` | `2276_intel_presence_verification.sql` | `IntelCaptureService.ts:303` (write-only) |
| `intel_attributions` | `2277_intel_outcomes_attribution.sql` | `intelAttributionScheduler` |
| `intel_scoped_trust` | `2278_intel_scoped_trust.sql` | `intelScopedTrustApply` |
| `intel_historical_patterns` | `2279_intel_historical_patterns.sql` | `intelPatternScheduler` |

All four schedulers are **registered and running** in production (`index.ts:150`, `:166`, `:167`,
and `intelReplay`'s caller) against tables that do not exist there.

**Why nothing is currently erupting, and why that is luck rather than design.** The flags gating
those passes — `intel_attribution`, `intel_pattern_learning`, `intel_scoped_trust` — are **absent
from the production `feature_flags` table**, and an unseeded flag reads `false`
(`.agents/memory/unseeded-feature-flag-gates.md`), so each scheduler returns before it touches its
missing table. **Seeding any one of those three flags in production points a running scheduler at
a table that is not there.** That is a live landmine, not a hypothetical.

**The general finding, which outlives these five tables.** `audit:schema`
(`auditMigrationsVsLive.ts`) runs only against the sanctioned CI project — enforced, correctly, by
`.github/scripts/assert-nonprod-supabase.sh`. So **CI is structurally incapable of detecting
production schema drift.** It has been green throughout, while production has been missing five
declared tables. `docs/architecture/10_Database_Architecture.md` §2 already records that the three
descriptions of the schema disagree; this is that disagreement with a measured instance and a
named blast radius.

For contrast, the same measurement confirms the flags this lane *does* have live:
`intel_capture_quick_signal`, `intel_claim_projection_crowd` and `intel_rewards` are all **TRUE**
in production despite every migration seeding them `false` — see
`docs/architecture/intel-spine-liveness.md`, which also records that all seven measurable intel
tables hold **zero rows**.

*Everything below is the original code-derived inventory and stands unchanged.*

A prior commit recorded a "CONSTRUCTED / CORRECT" percentage for this lane. That number is **not
reproducible from this repository** and is deliberately not repeated here. Counts below are counts.

## How this was measured, and where the instrument stops

Writer/reader attribution comes from the repo's **own** analyzer, `scripts/checkWriterlessReads.ts`
and its AST half `scripts/lib/tableAccessExtract.js`, driven over the same four server directories
it judges (`scripts/checkWriterlessReads.ts:76-81`) plus the same write-only directories
(`:83-87`) and SQL roots (`:88-92`). The run scanned 630 server files and 1391 other files.

The analyzer declares its own limit and this inventory carries it unchanged
(`scripts/checkWriterlessReads.ts:39-41`):

> A dynamic `.from(expr)` anywhere makes attribution incomplete, and the run says so rather than
> pretending otherwise.

**The run reports `sawDynamicFrom = true` in both the server scope and the client/scripts scope.**
Writer attribution is therefore **incomplete by the instrument's own declaration**, and it errs
toward silence: an unattributable write means a table is *not* reported as writerless. So "no
writer found" below means exactly that — not "no writer exists".

Two further blind spots were measured rather than assumed:

- **`.from()` string matching misses RPCs.** Four RPC call sites in this lane write intel tables
  through SQL functions that no `.from("table")` scan can see:
  `lib/intelPromotionScheduler.ts:55` (`system_promote_admissible_intel_claims`, which
  `INSERT`s into `intel_claims`, `migrations/2174_intel_system_claim_promotion.sql:85`);
  `lib/intelRetentionScheduler.ts:79` (`purge_expired_intel_snapshots`, `DELETE FROM
  intel_state_snapshots`, `migrations/2133_intel_retention.sql:56`);
  `lib/intelRetentionScheduler.ts:125` (`purge_intel_contributions_older_than`, deleting
  `intel_evidence` / `intel_confirmations` / `intel_observations`,
  `migrations/2173_intel_contribution_retention.sql:71,75,82`); and
  `services/accountDeletion/AccountDeletionService.ts:1131` (`erase_intel_for_actor`, deleting
  `intel_scoped_trust`, `intel_attributions`, `intel_evidence`, `intel_confirmations`,
  `intel_observations` — `migrations/2278_intel_scoped_trust.sql:201,205,209,213,217`).
- **A grep for `from("table")` is not a reference check.** An earlier attempt of exactly that shape
  wrongly reported `memory_events` as unreferenced. Where a fact could not be established, this
  file says "could not establish" rather than reporting a zero.

No database was queried. Three facts about the live database were **supplied to this session as
verified** and are labelled as such wherever used; nothing here re-derives them.

## 1. The modules

**33 modules** under `lib/` match `intel*`; there are additionally **6** route files, **5**
services under `services/intel/`, **2** report scripts and **45** test files. **No file in this
tree matches `sensing*`** — see §6.

"Reached from" is the shortest live chain to a process entry point: **boot** = called from the
`app.listen` callback in `index.ts`; **http** = imported by a router mounted in `routes/index.ts`;
**script** = only reachable via a `package.json` script; **tests only** = nothing outside
`src/test/` imports it.

| Module | One line | Non-test importers | Reached from |
|---|---|---|---|
| `lib/intelAcceptanceTests.ts` | §28 acceptance-id registry, pure data, "no imports, no runtime behaviour" (`:26`) | **0** | **tests only** — `test/intelAcceptanceTraceability.test.ts` |
| `lib/intelApiProjection.ts` | Field-licensing projection for the internal redistributable view | 1 | http — `routes/intelApi.ts:23` |
| `lib/intelAttribution.ts` | Pure Table-22 attribution weights | 1 | boot — `lib/intelAttributionScheduler.ts` |
| `lib/intelAttributionScheduler.ts` | Outcome events → attribution rows, 15-min pass | 2 | **boot** — `index.ts:52,167` |
| `lib/intelCalibrationScheduler.ts` | Daily calibration/density report, logs only | 1 | **boot** — `index.ts:50,154` |
| `lib/intelConflict.ts` | Pure material-conflict predicate | 6 | boot + http |
| `lib/intelConsent.ts` | Server-authoritative contribution-consent gate | 3 | http — `routes/intel.ts` |
| `lib/intelContracts.ts` | Canonical vocabularies + the `INTEL_FLAGS` list | **33** (widest in the lane) | boot + http |
| `lib/intelCoverageScheduler.ts` | Coverage-gap snapshots + mission candidates, 10-min pass | 1 | **boot** — `index.ts:24,145` |
| `lib/intelDomainEvents.ts` | Emits §21 domain events onto `canonical_events` | 2 | boot |
| `lib/intelEvidenceCapture.ts` | Evidence station of the capture pipeline | 1 | http — `routes/mapObservations.ts` |
| `lib/intelFunnelReport.ts` | Capture→serve funnel tally | 4 | boot + http + script |
| `lib/intelGroupKey.ts` | Derives the ephemeral independent-group key | 4 | http |
| `lib/intelIndependence.ts` | Pure independence clustering (anti-brigading) | 1 | boot — `lib/intelProjectionAggregator.ts` |
| `lib/intelLiveScope.ts` | Limited-Live density/scope gating | 3 | boot + script |
| `lib/intelMissionNonce.ts` | Single-use mission nonce for P4 presence | 3 | http |
| `lib/intelObservabilityReport.ts` | Shaped read behind the four admin dashboards | 1 | http — `routes/intelObservability.ts` |
| `lib/intelOutcomes.ts` | Outcome-event vocabulary and readers | 10 | boot + http + script |
| `lib/intelPatternLearning.ts` | Pure §12 pattern derivation | 1 | boot — `lib/intelPatternScheduler.ts` |
| `lib/intelPatternScheduler.ts` | Nightly pattern producer | 1 | **boot** — `index.ts:49,150` |
| `lib/intelPilotMetrics.ts` | The two non-trivial density-gate inputs | 1 | `lib/intelFunnelReport.ts` |
| `lib/intelProjection.ts` | Claims → live state; sole writer of the snapshot tables (`:4-5`) | 4 | boot |
| `lib/intelProjectionAggregator.ts` | Producer-side assembly of the projection input | 1 | boot — `lib/intelProjectionScheduler.ts` |
| `lib/intelProjectionScheduler.ts` | 5-minute projection driver | 1 | **boot** — `index.ts:47,137` |
| `lib/intelPromotionScheduler.ts` | Observation → active-claim promotion, 5-min | 1 | **boot** — `index.ts:48,136` |
| `lib/intelPulse.ts` | Neighborhood Pulse aggregation | 1 | http — `routes/intelReadModels.ts` |
| `lib/intelReplay.ts` | Replays a projection from versioned inputs | 1 | **script only** — `scripts/reportIntelLineageAudit.ts` |
| `lib/intelRetentionScheduler.ts` | Snapshot sweep + contribution retention | 1 | **boot** — `index.ts:46,135` |
| `lib/intelRewardScheduler.ts` | Books non-cash credits to the reward ledger, 15-min | 1 | **boot** — `index.ts:51,158` |
| `lib/intelScopedTrust.ts` | Pure scoped-trust update rule | 2 | boot |
| `lib/intelScopedTrustApply.ts` | DB half of scoped trust; registers the applier | 1 | **boot** — `index.ts:53,166` |
| `lib/intelThrottle.ts` | Pure prompt-throttle decision | 1 | http — `routes/intelReadModels.ts` |
| `lib/intelligenceGraphScheduler.ts` | Daily Intelligence Graph rebuild | 2 | **boot** — `index.ts:23,124` |

**32 of the 33 lib modules have at least one non-test importer.** The single exception is
`lib/intelAcceptanceTests.ts`, and that is by construction: it is a registry consumed only by
`test/intelAcceptanceTraceability.test.ts`, which asserts each of its eighteen ids appears in a
test title (`lib/intelAcceptanceTests.ts:15-18`).

Supporting files, all reachable: `services/intel/CoverageService.ts`,
`services/intel/IntelCaptureService.ts`, `services/intel/PresenceVerifier.ts`,
`services/intel/RewardOracle.ts`, `services/intel/RewardService.ts`;
`scripts/reportIntelFunnel.ts` (`package.json:39`, `report:intel-funnel`) and
`scripts/reportIntelLineageAudit.ts` (`package.json:169`, `report:intel-lineage-audit`).

## 2. The tables

**15 `intel_*` tables have a `CREATE TABLE` in this tree.** The 10 confirmed present in production
were supplied to this session as a verified fact and are marked ✅; the other 5 are marked ❔ —
their creating migrations are all numbered 2273–2279 and **this tree carries no applied-migration
ledger, so whether those migrations are applied could not be established from the repository.**
No `sensing_*` table is created anywhere in this tree.

| Table | Created by | Writer in server code | Reader |
|---|---|---|---|
| ✅ `intel_observations` | `migrations/2130_intel_storage.sql` | `services/intel/IntelCaptureService.ts:427`; SQL: deleted by `purge_intel_contributions_older_than` (`2173:82`) and `erase_intel_for_actor` (`2278:217`) | **18** server readers (e.g. `routes/intel.ts:247`, `lib/intelProjectionAggregator.ts:152`, `lib/trailServe.ts:292`) |
| ✅ `intel_claims` | `migrations/2130_intel_storage.sql` | `services/intel/IntelCaptureService.ts:526,550,644`; SQL `INSERT` in `2174:85` | 9 server readers (e.g. `lib/intelProjectionScheduler.ts:61,123`) |
| ✅ `intel_evidence` | `migrations/2130_intel_storage.sql` | `lib/intelEvidenceCapture.ts:262`, `lib/media/mediaEvidenceLink.ts:157`; SQL deletes (`2173:71`, `2278:209`) | 4 (e.g. `lib/intelProjectionAggregator.ts:196`) |
| ✅ `intel_confirmations` | `migrations/2130_intel_storage.sql` | `services/intel/IntelCaptureService.ts:587`; SQL deletes (`2173:75`, `2278:213`) | 3 |
| ✅ `intel_state_snapshots` | `migrations/2130_intel_storage.sql` | `lib/intelProjection.ts:408`, `lib/intelProjectionScheduler.ts:167`; SQL delete in `2133:56` | 12 (e.g. `routes/intelApi.ts:41`, `lib/liveClaimRead.ts:321`) |
| ✅ `intel_mission_candidates` | `migrations/2167_intel_mission_candidates.sql` | 8 sites — `services/intel/CoverageService.ts:77,92,125,157,183`, `services/intel/PresenceVerifier.ts:434`, `services/media/MediaViewRequestService.ts:182`, `services/accountDeletion/AccountDeletionService.ts:1178` | 3 (`routes/intelCoverage.ts:103`, `services/intel/PresenceVerifier.ts:414`, `lib/intelCoverageScheduler.ts:205`) |
| ✅ `intel_reward_ledger` | `migrations/2170_intel_reward_ledger.sql` | `services/intel/RewardService.ts:72`, `services/accountDeletion/AccountDeletionService.ts:1149` | 2 (`routes/intelObservability.ts:98`, `services/intel/RewardService.ts:78`) |
| ✅ `intel_contribution_consent` | `migrations/2172_intel_contribution_consent.sql` | `lib/intelConsent.ts:118`, `services/accountDeletion/AccountDeletionService.ts:1139` | 5 (e.g. `lib/crowdFlowProducer.ts:1008`, `lib/trailServe.ts:312`) |
| ✅ `intel_live_promoted_scopes` | `migrations/2179_intel_live_promoted_scopes.sql` | **none found** | 1 — `lib/liveClaimRead.ts:229` |
| ✅ `intel_coverage_snapshots` | `migrations/2181_intel_coverage_snapshots.sql` | `lib/intelCoverageScheduler.ts:112,198` | 1 — `routes/intelCoverage.ts:77` |
| ❔ `intel_state_snapshot_versions` | `migrations/2273_intel_replayable_projection.sql` | `lib/intelProjection.ts:386` | 3 (`routes/mapProjectionTemporal.ts:397`, `lib/intelReplay.ts:181,306`) |
| ❔ `intel_presence_verifications` | `migrations/2276_intel_presence_verification.sql` | `services/intel/IntelCaptureService.ts:303` | **none found — write-only** |
| ❔ `intel_attributions` | `migrations/2277_intel_outcomes_attribution.sql` | `lib/intelAttributionScheduler.ts:196`; SQL delete in `2278:205` | 2 (`routes/intelObservability.ts:100`, `lib/intelScopedTrustApply.ts:156`) |
| ❔ `intel_scoped_trust` | `migrations/2278_intel_scoped_trust.sql` | `lib/intelScopedTrustApply.ts:181,188`; SQL delete in `2278:201` | 1 — `lib/intelScopedTrustApply.ts:135` |
| ❔ `intel_historical_patterns` | `migrations/2279_intel_historical_patterns.sql` | `lib/intelPatternScheduler.ts:158,181` | 3 (`routes/intelReadModels.ts:214`, `lib/liveClaimRead.ts:476`, `lib/intelPatternScheduler.ts:116`) |

Two entries need their caveat stated in place rather than as a footnote:

- **`intel_live_promoted_scopes` has no writer, and that is the ruled design, not a defect.** It is
  on the analyzer's ratchet classified `human-allowlist`, with the reason recorded verbatim at
  `scripts/checkWriterlessReads.ts:172-180`: it starts empty so that turning the global
  `intel_limited_live` flag on exposes nothing until a scope is explicitly promoted after a density
  gate and human review. Its emptiness is the fail-closed default. **Reader count matches the
  ratchet exactly (1).**
- **`intel_presence_verifications` is written and never read** in server code. The write is
  `services/intel/IntelCaptureService.ts:303`. This is the mirror image of the defect the analyzer
  exists for, and the analyzer does not look for it — `findWriterless` only walks the reads map
  (`scripts/checkWriterlessReads.ts:283-296`). Whether that is intended could not be established
  from the tree.

An unmerged sixteenth intel table, **`intel_claim_reviews`**, exists in PRs #456/#457 and was
applied by hand to the `portava-ci` project. It is **not in this tree**: the only trace of it here
is its rollback section, `db/rollback/2026-09-07-ci-migrations-rollback.sql:185-196`.

## 3. The schedulers — every one is registered

This is the column that matters, so it is stated flatly: **all nine schedulers in this lane are
registered at a site that actually runs them, and none is a module nothing invokes.** Every
registration is a direct call inside the `app.listen` callback in `index.ts:98`, which is the
entry point the shipped process runs (`package.json:9`, `start` → `./dist/index.mjs`).

| Scheduler | Registered? | Registration site | Cadence | Flag it fails closed on |
|---|---|---|---|---|
| `intelligenceGraphScheduler` | **yes** | `index.ts:124` (import `:23`) | 1 min delay, then daily (`lib/intelligenceGraphScheduler.ts:29-30`) | **none** — ungated; skips only if no service client (`:114-118`) |
| `intelRetentionScheduler` | **yes** | `index.ts:135` (import `:46`) | 7 min delay (`:23`), interval from `INTEL_RETENTION_SWEEP_INTERVAL_SECONDS` (`:39-43`) | `intel_retention_sweep_enabled` + `intel_contribution_retention_enabled` (`:153`) |
| `intelPromotionScheduler` | **yes** | `index.ts:136` (import `:48`) | 2 min delay, 5 min (`:27-28`) | `intel_claim_projection_crowd` (`:83`) |
| `intelProjectionScheduler` | **yes** | `index.ts:137` (import `:47`) | 3 min delay, 5 min (`:31-32`) | `intel_claim_projection_crowd` (`:219`) |
| `intelCoverageScheduler` | **yes** | `index.ts:145` (import `:24`) | 4 min delay, 10 min (`:30-31`) | `intel_coverage` (`:99`) |
| `intelPatternScheduler` | **yes** | `index.ts:150` (import `:49`) | 6 min delay, nightly (`:38-39`) | `intel_pattern_learning` (`:63`) |
| `intelCalibrationScheduler` | **yes** | `index.ts:154` (import `:50`) | 8 min delay, daily (`:37-38`) | `intel_calibration_report` (`:60`) |
| `intelRewardScheduler` | **yes** | `index.ts:158` (import `:51`) | 6 min delay, 15 min (`:59-60`) | `intel_rewards` (`:127`) |
| `intelAttributionScheduler` | **yes** | `index.ts:167` (import `:52`) | 8 min delay, 15 min (`:41-42`) | `intel_outcome_attribution_enabled` (`:117`) |

Alongside them, `registerScopedTrustApplier()` is called at `index.ts:166` (import `:53`), which
installs the scoped-trust fold that runs inside the attribution pass
(`lib/intelScopedTrustApply.ts:266`).

**There is no unregistered scheduler in this lane.** Registration is not the same as effect:
eight of the nine read a feature flag before doing any work and return early when it is off
(`lib/intelRetentionScheduler.ts:119-121` is the shape, `reason: "disabled"`), so under the seeded
defaults of §4 each registered pass is an inert no-op. Two exceptions matter:
`intelligenceGraphScheduler` reads no flag at all and rebuilds on its own schedule, and
`intelRewardScheduler`'s gate `intel_rewards` is TRUE in production (§4), so it is the one
flag-gated intel pass known to be doing work.

## 4. The flags, and their seeded defaults

`lib/intelContracts.ts:747-757` declares eight capability flags as the contract, with a dependency
chain at `:763-772` (`intel_claim_projection_crowd` requires `intel_capture_quick_signal`,
`intel_live_label_crowd` requires the projection, and so on). Migrations seed **sixteen** flag rows.

| Flag | Seeded by | Seeded default | What it gates |
|---|---|---|---|
| `intel_capture_quick_signal` | `2165:37-43` | **false** | The whole capture path; "head of the intel flag dependency chain" |
| `intel_claim_projection_crowd` | `2132:32-38` | **false** | Projection + promotion schedulers |
| `intel_live_label_crowd` | `2131:27-33` | **false** | The LIVE label on place surfaces |
| `intel_trail_followup` | `2166:45-51` | **false** | Trail follow-up capture surface |
| `intel_missions` | `2167:68-74`, re-asserted `2181:81-83` | **false** | Mission generation/dispatch |
| `intel_limited_live` | `2168:36-41` | **false** | IG-09 pilot Live capability |
| `disable_intel_live_labels` | `2168:42-46` | **false** | Global kill switch (a DB error engages it) |
| `intel_compass_rhythm_actor_gate` | `2169:37-43` | **false** | Time-sliced Compass rhythm line |
| `intel_rewards` | `2170:59-65` | **false** | Reward producer / `intel_reward_ledger` writes |
| `intel_contribution_retention_enabled` | `2173:103-109` | **false** | The 180-day contribution deletion |
| `intel_retention_sweep_enabled` | `2133:70-76` | **false** | Expired-snapshot sweep |
| `intel_coverage` | `2181:73-79` | **false** | Coverage producer |
| `intel_presence_verification_enabled` | `2276:79-85` | **false** | Presence ladder P2–P4 |
| `intel_outcome_attribution_enabled` | `2277:257-263` | **false** | Attribution + scoped-trust fold |
| `intel_pattern_learning` | `2279:172-176` | **false** | Nightly pattern producer |
| `intel_calibration_report` | `2279:177-181` | **false** | Daily calibration report |

**Every seeded default in this lane is `false`, and no later migration in this tree moves one.**

**Three declared flags have no seed row anywhere in the tree** — `intel_movement_prediction`,
`intel_external_api` and `intel_qiu_cash_pool`, declared at `lib/intelContracts.ts:752,754,755`. An
unseeded flag reads FALSE silently, with no error and no log; that failure mode is written up in
`.agents/memory/unseeded-feature-flag-gates.md`. So these three are off, and off in a way that is
indistinguishable from "not built" at runtime. `routes/intelApi.ts:13` and
`lib/intelObservabilityReport.ts:414` both already say in prose that no partner surface exists
behind `intel_external_api`.

**One seeded default is known to diverge from production.** Supplied to this session as a verified
live fact: **in production `intel_rewards = TRUE`**, against a seed of `false` at `2170:61`. Nothing
in this tree performs that flip; it was made out of band. That makes `intelRewardScheduler` the one
intel pass whose flag gate is known to be open in production.

Two further verified live facts were supplied, and are recorded here only to close them out:
**`ACTIVITY_DISCOVERY_BOOST_ENABLED = false`** (seeded false, `2084_codify_live_read_flags.sql:55`)
and **`discovery_ranking_modifiers_enabled` ABSENT** (seed text exists at
`2289_discovery_ranking_modifiers_flag.sql:55`, so the migration is evidently unapplied, and an
unseeded flag reads FALSE). **Neither flag is referenced by any file in this lane** — a grep across
`lib/intel*`, `services/intel/` and `routes/intel*` returns zero hits for both. They gate
`services/ranking/DiscoveryRankingService.ts` and `services/ranking/FeedSlotAllocator.ts`, which
are not part of this surface.

## 5. The HTTP routes

Six intel routers are mounted in `routes/index.ts` — `routes/intel.ts`, `routes/intelCoverage.ts`, `routes/intelApi.ts`, `routes/intelReadModels.ts`,
`routes/intelOutcomes.ts` and `routes/intelObservability.ts` (`routes/index.ts:291,293,294,295,298,300#router.use`) — carrying
**24 endpoints**. Two further endpoints on other routers reach intel modules or tables directly.

Mounting is not assumed: `test/intelRouterRegistrationGuard.test.ts` mounts the *composed* router
and asserts each path answers with the handler's own gate rather than a 404, precisely because 56
handler tests stayed green with the mount commented out (`:1-18`).

| Method + path | File:line | Notes |
|---|---|---|
| `GET /v1/intel/consent` | `routes/intel.ts:169` | user consent read |
| `PUT /v1/intel/consent` | `routes/intel.ts:176` | the only user-facing writer of `intel_contribution_consent` |
| `POST /v1/intel/observations` | `routes/intel.ts:189` | capture entry point |
| `POST /v1/intel/observations/:id/claims/propose` | `routes/intel.ts:299` | |
| `POST /v1/intel/observations/:id/claims/approve` | `routes/intel.ts:300` | |
| `POST /v1/intel/observations/:id/claims:action` | `routes/intel.ts:302` | |
| `POST /v1/intel/claims/:id/confirm` | `routes/intel.ts:309` | |
| `POST /v1/intel/claims/:id/correct` | `routes/intel.ts:319` | |
| `GET /v1/internal/intel/trail/movement` | `routes/intel.ts:358` | publication gated by the unseeded `intel_movement_prediction` (`:349`) |
| `GET /v1/internal/intel/redistributable/:subjectId` | `routes/intelApi.ts:27` | admin; returns `[]` when the kill switch is engaged (`:36-39`) |
| `POST /v1/internal/intel/coverage` | `routes/intelCoverage.ts:60` | |
| `GET /v1/internal/intel/coverage` | `routes/intelCoverage.ts:71` | reads `intel_coverage_snapshots` (`:77`) |
| `GET /v1/internal/intel/missions` | `routes/intelCoverage.ts:100` | |
| `POST /v1/internal/intel/missions` | `routes/intelCoverage.ts:112` | |
| `POST /v1/internal/intel/missions/:id/dispatch` | `routes/intelCoverage.ts:122` | |
| `POST /v1/internal/intel/missions/:id/accept` | `routes/intelCoverage.ts:136` | |
| `POST /v1/internal/intel/missions/:id/complete` | `routes/intelCoverage.ts:157` | |
| `POST /v1/internal/intel/missions/:id/decline` | `routes/intelCoverage.ts:175` | |
| `GET /v1/internal/intel/observability` | `routes/intelObservability.ts:54` | the four admin dashboards |
| `POST /v1/intel/outcomes` | `routes/intelOutcomes.ts:80` | outcome events |
| `GET /v1/experiences/:id/live-state` | `routes/intelReadModels.ts:140` | |
| `GET /v1/experiences/:id/typical-patterns` | `routes/intelReadModels.ts:198` | reads `intel_historical_patterns` (`:214`) |
| `GET /v1/neighborhoods/:id/pulse` | `routes/intelReadModels.ts:274` | |
| `GET /v1/intel/prompt-eligibility` | `routes/intelReadModels.ts:360` | |
| `POST /map/observations` | `routes/mapObservations.ts:895` | mounted `routes/index.ts:265`; the only caller of `lib/intelEvidenceCapture.ts` |
| `GET /map/projection/temporal` | `routes/mapProjectionTemporal.ts:412` | mounted `routes/index.ts:263`; reads `intel_state_snapshot_versions` (`routes/mapProjectionTemporal.ts:397`) |

## 6. PR #475 — measured, not merged

`sensing_anon_contributions`, `lib/sensingAnonStore.ts` and `lib/sensingCoverageAggregate.ts`
**are not in this tree.** They exist only on the unmerged `pr/475` ref, commit `0597a245`
("Anonymous sensing contribution store (migration 2315), inert"), which adds exactly six files:
the two lib modules, `src/migrations/2315_sensing_anon_contributions.sql`, their two tests, and a
one-line `package.json` change. `git merge-base --is-ancestor 0597a245 HEAD` is false.

The table was **applied by hand to `portava-ci` only** (project ref `hwokxgbmezheskbzskfr`), on
2026-09-07, because CI's schema-drift job fails a PR whose migration is not yet live —
`db/rollback/2026-09-07-ci-migrations-rollback.sql:1-11,100-112`. That rollback file, which *is* in
this tree, is the only mention of `sensing` anywhere in it. Supplied as a verified fact: the table
does **not** exist in production.

**Measured reachability, re-derived here from the `pr/475` tree:** nothing outside its own tests
references either module or the table. The only non-test import of `sensingAnonStore` is its
sibling `sensingCoverageAggregate.ts:81`; the only import of `sensingCoverageAggregate` is
`test/sensingCoverageAggregate.test.ts:39`. The module says so itself
(`lib/sensingAnonStore.ts:23-26`): "Nothing outside this module's tests imports it. There is no
route, scheduler, job or feature flag behind it. It is a contract, waiting for a decision to use
it." The PR ships a test that *enforces* that inertness by scanning the tree for referrers
(`test/sensingAnonStore.test.ts:347-366`), so the store cannot be quietly wired without turning
that test red.

**What it would need in order to be reachable** — stated as gaps in the tree, not as requirements:

1. **The migration applied where it is meant to run.** `2315` is live on `portava-ci` only.
2. **A caller.** There is no route, no scheduler registration in `index.ts`, and no job. The four
   exported entry points (`recordSensingContribution:373`, `readSensingCohort:413`,
   `revokeSensingContributions:487`, `purgeExpiredSensingContributions:531`) have no non-test call
   site. A TTL store with no purge caller would also accumulate rows.
3. **A feature flag.** Migration `2315` seeds none, so there is no switch to turn this on or off.
   (Several intel table migrations also seed no flag — `2130`, `2273`, `2278` among them — so this
   is not unique to `2315`; it is recorded because a gate is what the eight seeded producers in §4
   all have and this store does not.)
4. **A server pepper in the environment.** `SENSING_CONTRIBUTOR_PEPPER`, or a fallback of
   `INTEL_GROUP_KEY_SECRET` or `SESSION_SECRET` (`lib/sensingAnonStore.ts:141-146`). There is no
   constant fallback: with none of the three set, every token derivation throws.
5. **A service-role caller specifically.** The table is service_role only, with RLS on and no anon
   or authenticated policy, enforced by a postcondition that raises if one appears
   (`2315:280-290`, postcondition `:382`).

## What is not built here

- **No `sensing_*` module, table or route exists in this tree at all.** The entire sensing surface
  is the unmerged PR #475 described in §6.
- **`intel_presence_verifications` has no reader.** Written at
  `services/intel/IntelCaptureService.ts:303`, read by nothing in server code.
- **`intel_live_promoted_scopes` has no writer, deliberately** — the human-curated allowlist whose
  emptiness is the fail-closed default (`scripts/checkWriterlessReads.ts:172-180`). There is no
  promotion endpoint; promotion is an out-of-band human act.
- **No cash path.** `intel_qiu_cash_pool` is declared (`lib/intelContracts.ts:755`) and never
  seeded; `2170:63` states cash transfer is "a separate, unbuilt switch" with `cash_amount = 0`
  enforced by the table.
- **No partner/external API surface.** `intel_external_api` is declared and never seeded;
  `routes/intelApi.ts:13` says the partner surface "is not built".

## What could not be established

Recorded plainly, because a stated gap is worth more than a confident number the instrument cannot
support:

1. **Whether migrations 2273–2279 are applied in production.** The tree carries no applied-migration
   ledger; `schema_migration_ledger` is a database table and no database was queried. The five
   tables those migrations create are absent from the supplied production list of 10, which is
   consistent with them being unapplied, but this file does not assert it.
2. **Complete writer attribution for any table.** The analyzer reports `sawDynamicFrom = true` in
   both scopes and errs toward silence by design (`scripts/checkWriterlessReads.ts:39-41`). Four
   RPC-mediated writers were found by hand and are listed above; there may be others that neither
   the AST scan nor a hand grep reaches.
3. **Whether `intel_presence_verifications` being write-only is intended.** Nothing in the tree
   states a reason either way, and no existing check looks for write-only tables.
4. **Runtime behaviour of any pass.** Everything above is static: registration, imports, flag seeds
   and call sites. Whether a registered pass has ever executed successfully in production is not
   knowable from the tree.
5. **The provenance of the production `intel_rewards = TRUE` flip.** No migration in this tree sets
   it; where and when it was flipped could not be established here.
