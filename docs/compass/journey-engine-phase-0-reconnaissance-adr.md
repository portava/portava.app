# Journey Engine Phase 0 — Reconnaissance, Gap Analysis, and ADR

**Status:** Proposed for human review  
**Decision type:** Architecture / privacy / data lifecycle  
**Scope:** Analysis and design only  
**Runtime changes in this task:** None  
**Database changes in this task:** None  

This packet evaluates the proposed “Travel Intelligence & Journey Decision
Engine” against the Compass and location systems already merged into Portava.
It does not replace or restate the Compass roadmap. The authoritative roadmap
and implementation history remain:

- [`master-roadmap.md`](./master-roadmap.md)
- [`phase-summaries.md`](./phase-summaries.md)

## Executive summary and proposed decision

Portava should **not build a second Journey decision stack above Discovery**.
Most of the proposed decision, social, planning, learning, world-model, and
attention capabilities already exist in Compass phases 7–15:

- candidate gating and personal-fit ranking;
- social compatibility and privacy-gated approximate presence;
- proactive signals with quiet hours, dedupe, and daily caps;
- explicit live-session state;
- partial trip recovery with confirmation;
- served-recommendation and outcome records;
- an intelligence graph and time-sliced destination world model.

The genuine gap is narrower: Portava does not have a consent-gated,
append-only observation stream or deterministic movement/stop/dwell
segmentation. It also does not classify planned social overlap as
`layover`, `transit`, `destination`, or `future`.

### ADR decision

1. **Reuse Compass as the only fit, safety, decision, plan-recovery, attention,
   outcome-learning, and world-model authority.**
2. **Pursue a narrow Phase 1 observation foundation only after the location
   session and preference schemas are reconciled.**
3. **Run segmentation in shadow mode first.** No recommendation, notification,
   social suggestion, plan mutation, or user-facing location behavior may
   consume it during Phase 1.
4. **Do not collect a continuous background trace by default.** Collection
   requires an explicit, active, revocable location session and a dedicated
   default-off feature flag.
5. **Defer latent-needs inference and social overlap materialization.** They
   require separate privacy approval and evidence that observation quality is
   adequate.
6. **Skip parallel Journey implementations** of Fit Resolution, decision
   scoring, adaptive policy, dynamic plans, notifications, outcome learning,
   and the intelligence graph.

### Recommended scope by proposed handoff phase

The original phase-by-phase handoff is not stored in this repository, so this
is a capability-based interpretation of its described phases 0–8.

| Handoff area | Recommendation | Reason |
|---|---|---|
| Phase 0 reconnaissance | **Complete through this ADR** | Establishes verified reuse and genuine gaps before code. |
| Observation foundation | **Build narrowly** | No equivalent append-only observation contract or segmenter exists. |
| Movement / stop / dwell | **Build after Phase 1 gates pass** | Genuine gap, but must remain shadow-only until quality and privacy tests pass. |
| Behavioral rhythm / latent needs | **Defer** | Sparse GPS can create harmful false inferences; Compass already has non-GPS context and rule-based Sense signals. |
| Social trajectory classes | **Defer, then build only as a coarse adapter** | Existing Compass Social and Graph cover relationships and compatibility, but not the four requested temporal overlap classes. |
| Joint opportunity + companion scoring | **Reuse + compose** | Combine existing Compass candidate ranking with `computeTravelCompatibility`; do not create a new scorer. |
| Fit Resolution / Decision Engine | **Skip new engine** | Duplicates Compass Pipeline, Safety, Eligibility, Recommendation, and Scoring. |
| Decision / outcome learning | **Reuse; optionally extend trace metadata** | Duplicates served recommendations and Phase 14 outcome learning. |
| Dynamic plans / recovery | **Reuse** | Duplicates Trip Autopilot and route/plan tables. |
| Adaptive policy / attention | **Reuse** | Duplicates Sense limits, Live session caps, preference learning, and graph/world-model feedback. |

## Decision vocabulary

- **Reuse:** existing authority is sufficient; add no parallel model/table.
- **Reuse + adapter:** existing authority remains canonical; a thin Journey
  contract may translate observations into its inputs.
- **Build:** no verified equivalent exists.
- **Defer:** potentially useful, but prerequisites or privacy decisions are
  unresolved.
- **Skip:** duplicative or contrary to existing guardrails.

---

## A. Exact existing-capability mapping

### A1. Capability map

| Required capability | Coverage | Existing implementation | Tables / migrations | Routes | Decision |
|---|---|---|---|---|---|
| Hierarchical world state | **Partial** | `LocationIntelligenceEngine` derives city/district/country, freshness, and approximate distance buckets. `DiscoveryLocationContext` resolves near-me/in-city/trip/crew/safety modes. `CompassLocationContext` exposes only city-level safe context. `CompassGraphEngine` provides city nodes, local time slices, destination models, and city confidence. `GeoZoneService` supplies city/neighborhood/district/venue/safety zone records. | `user_location_state` (`0025_location_system.sql`), `geo_zones` / `place_profiles` (`0034_geo_zones.sql`), `compass_graph_nodes`, `compass_graph_edges`, `compass_city_models`, `compass_city_confidence` (`20260730_compass_intelligence_graph.sql`) | `GET/POST /api/me/location-state`, `GET /api/discovery`, `GET /api/compass/city-confidence`, admin graph routes | **Reuse + adapter.** Do not create a second world graph. Add a typed `WorldRef` bridge only if observation segmentation needs canonical lineage below city. |
| Journey lifecycle state machine | **Partial / equivalent** | `CompassContextState` covers normal, exploring, planning, arrival, night, safety, privacy, budget, booking, and active-trip states. `CompassLiveEngine` provides explicit active/ended session lifecycle and rolling plan context. `LocationSessionService` starts/ends expiring location sessions. Trips, route plans, stops, and Autopilot proposals have their own persisted state machines. | `compass_live_sessions` (`20260727_compass_live.sql`), `location_sessions` (`0033_location_sessions.sql`, with migration-path drift noted below), `route_plans` / `route_stops` / `route_legs` (`0058_trip_flow.sql`), `trip_autopilot_proposals` (`20260728_compass_autopilot.sql`) | `/api/compass/live/session`, `/start`, `/stop`, `/check`; trip Autopilot routes | **Reuse + adapter.** A Journey state must reference these states, not replace them. The only new lifecycle should be observation-segment state. |
| Movement, stop, and dwell inference | **Not covered** | `LocationSafetyService` compares snapshots for impossible jumps/speed, but does not infer movement. `LocationSessionService` scopes sharing sessions but does not process a trace. `POST /api/location/exit-geofence` is a client assertion for delayed publication, not a generalized segmenter. | `location_snapshots`, `location_sessions`, `location_trust_events` | Existing location routes only | **Build**, shadow-only: append-only observations plus deterministic segment revisions. |
| Behavioral rhythm | **Partial, different level** | `CompassGraphEngine` models **aggregate city rhythm** by local weekday/daypart/month. `CompassContextEngine` and intent modes model current situational context. No verified per-user mobility rhythm exists. | `compass_city_models`, graph nodes/edges | Graph/city-confidence routes; `/api/compass/ask` consumes context | **Reuse aggregate city rhythm. Defer personal mobility rhythm** until minimum sample size, retention, opt-out, and bias review are approved. |
| Latent-needs inference | **Partial, rule-based equivalent only** | `CompassSenseEngine` detects grounded needs such as leave-earlier, weather disruption, event starting, circle plan change, and a free-time block. `CompassLiveEngine` adds next-up, arriving-early, and ride-home prompts. These use plans/time/weather, not inferred private behavior. | `compass_sense_settings`, `compass_sense_nudges`, `compass_live_sessions` | `/api/compass/sense/*`, `/api/compass/live/*` | **Reuse grounded signals. Defer latent inference.** Never infer sensitive states (health, impairment, relationships, lodging, religion, or protected traits) from movement. |
| Social trajectory overlap: layover | **Gap** | Compass Social can establish a trusted social context and approximate presence; trips provide planned destination/time. No layover classifier was verified. | `circle_presence`, trips and trip membership, graph tables | Compass social tools through `/api/compass/ask` | **Build later as planned/coarse overlap only**, after consent review. No precise-airport or GPS-derived disclosure. |
| Social trajectory overlap: transit | **Gap** | Route plans/legs and trip crew sharing are adjacent, but no traveler-to-traveler transit overlap classifier exists. | `route_plans`, `route_stops`, `route_legs`, trip crew location tables | Route/trip crew routes | **Defer.** Prefer shared planned route/time windows; never expose live co-presence from raw traces. |
| Social trajectory overlap: destination | **Partial** | `getWhosAround` returns privacy-gated approximate presence in shared trip/event contexts. Group recommendation and trip membership establish trusted contexts. Graph city/trip edges show aggregate relationships. | `circle_presence`, `trip_members`, events/RSVPs, graph tables | Compass social tools; graph routes | **Reuse + coarse classifier adapter.** Existing consent/block/visibility guard remains authoritative. |
| Social trajectory overlap: future | **Partial** | Upcoming trips/events and group contexts are available; no explicit future-overlap record/classifier was verified. | trips, trip members, events/RSVPs | Compass tools, Discovery `going_soon` mode | **Build later from explicit plans only**, with opt-in and automatic expiry. |
| Companion compatibility | **Covered** | `CompassSocialEngine.computeTravelCompatibility` produces deterministic 0–100 compatibility from shared interests/styles/languages plus budget/pace alignment and reveals only overlap. It is relationship-gated and has a trust floor at the tool boundary. | Existing profile, circle, and trip membership data | Compass tools `get_travel_compatibility`, `get_group_recommendation` | **Reuse.** |
| Opportunity candidate generation | **Covered** | Discovery merges OSM/Overpass and `discovery_places`; Compass tools and feed adapters generate DB-backed place/event/person/trip candidates. Candidate generation remains separate from model explanation. | `discovery_places`, discovery caches, domain tables | `GET /api/discovery`, `/api/discovery/feed`, Compass tool calls through `/api/compass/ask` | **Reuse.** Add source adapters only where a candidate type cannot enter the existing pipeline. |
| Joint opportunity + companion scoring | **Partial** | `CompassPipeline` ranks opportunities. `buildGroupRankingProfile` aggregates group constraints and `get_group_recommendation` ranks with the same pipeline. `computeTravelCompatibility` scores a companion. There is no single persisted “joint score,” but the needed authorities exist. | Existing served recommendation / profile tables | Compass group-recommendation tool | **Reuse + compose.** Keep separate explainable dimensions; do not collapse safety, opportunity fit, and companion fit into one opaque number. |
| Fit Resolution layer | **Covered for recommendation fit; partial for Journey-critical feasibility** | `CompassPipeline` is the single recommendation authority: Safety is fail-closed, Eligibility is explicitly fail-open on exceptions, Privacy sanitizes, then Scoring ranks. `CompassRecommendationEngine` adds independent Compass Match and Community Score plus grounded ranking factors. `CompassGraphEngine` adds a bounded city-rhythm factor. Some Compass tool paths also fall back to an unranked raw DB list when ranking fails. | Safety/eligibility/scoring logs; `compass_served_recommendations.ranking_factors` | Compass feed, section, tool, and `/api/compass/why/:id` paths | **Skip a new Fit Resolution engine, but add a fail-closed Journey feasibility wrapper.** A Journey-critical error must return `no_safe_option`/`insufficient_confidence`; it must never use the raw-list fallback. Successful candidates still enter Compass for canonical ranking. |
| Uncertainty-aware scoring | **Covered for source confidence; partial for segmentation** | Phase 8 confidence labels distinguish verified-live, community-reported, historical, and AI-inference sources. City confidence reports deep/moderate/thin data depth. No movement-segment confidence contract exists. | Confidence snapshots in tool/nudge payloads; `compass_city_confidence` | Compass live-intelligence consumers and city-confidence route | **Reuse confidence vocabulary; build segment confidence only.** |
| Hard privacy and safety gates | **Covered with an important exception-policy boundary** | `CompassSafetyFilter` fails closed; `CompassEligibilityEngine` handles trust, age, verification, capacity, membership, and visibility but fails open on exceptions; `CompassPrivacyGuard` strips exact GPS/address/hotel/safe-return/emergency/admin/identity/private-booking data. Social uses the same block/consent/staleness gates as Circle presence. | Compass logs and domain privacy tables | Every Compass pipeline caller | **Reuse Safety, Privacy, and social guards without bypass.** Journey feasibility, consent, session ownership, and precise-location policy must be separate fail-closed preconditions. Do not use Discovery or Compass raw-candidate fallback when one of those checks errors. |
| Decision records | **Mostly covered** | `compass_served_recommendations` stores legitimate delivery records, opaque recommendation IDs, item/type/section, explanation, and ranking-factor snapshots. `trip_autopilot_proposals` stores proposed plan decisions and before/after changes. Missing: a compact record of the full candidate-set gate summary and policy/config versions. | `compass_served_recommendations` (`0055_compass_ux.sql` + ranking-factors migration), `trip_autopilot_proposals` | `/api/compass/why/:id`, Autopilot proposal routes | **Reuse; optionally extend trace metadata.** Do not create a parallel Journey decision ledger. |
| Outcome records and adaptive feedback | **Covered** | `CompassOutcomeEngine` records the deduplicated chain viewed → saved → went → stayed → liked → invited → made_memory → returned, compares realized and predicted fit, and nudges the same category weights consumed by ranking. | `compass_outcome_events` (`20260729_compass_outcome_learning.sql`), `compass_user_preferences` | `POST /api/compass/outcomes`, admin `GET /api/compass/value-delivered` | **Reuse.** |
| Dynamic plans and recovery | **Covered** | `CompassAutopilotEngine` detects timing, weather, social, cancellation, delay, and closure issues; builds minimal repairs; never moves fixed items; honors permissions; persists proposals; and requires confirmation. Route plans/stops/legs provide route state. | `trip_plan_items.lock_type`, `trip_autopilot_settings`, `trip_autopilot_proposals`, route tables | `/api/trips/:tripId/autopilot/*`, `/api/autopilot/proposals/:id/*`, heartbeat | **Reuse.** Add Journey observations only as another monitor input after separate approval. |
| Attention budget | **Covered** | Sense defaults to Passive, performs no evaluation in Passive, allows 3/day in Aware and 6/day in Active, honors per-category settings, quiet hours, and 24-hour dedupe. Live adds a 12/session cap and uses the same durable nudge log. | `compass_sense_settings`, `compass_sense_nudges`, `compass_live_sessions` | `/api/compass/sense/*`, `/api/compass/live/*` | **Reuse.** No Journey notification scheduler or quota table. |
| Adaptive policy layer | **Covered / partial** | Outcome deltas update Compass category weights; memory contributes a bounded boost; the city model contributes a bounded rhythm boost; graph and confidence rebuild from accumulated outcomes. This is already the adaptive policy loop. | `compass_user_preferences`, memories, outcomes, graph/city models | Existing Compass surfaces | **Reuse.** Any future policy experimentation must operate through versioned Compass factors and existing flags. |

### A2. Existing contracts that remain canonical

- `CompassContext`, `CompassContextState`, and `CompassSignals` in
  `artifacts/api-server/src/compass/types.ts`.
- `CompassProfile` and its block/mute, preference, trip, trust, and feedback
  fields in the same file.
- `CompassItem` as the candidate adapter contract for all Safety, Eligibility,
  Privacy, and Scoring gates.
- `PipelineResult` in `CompassPipeline.ts` for final score, Compass Match,
  Community Score, and grounded factors.
- `CompatibilityResult` in `CompassSocialEngine.ts`.
- `LiveSession`, `LiveRollingContext`, and `LiveSessionEvent` in
  `CompassLiveEngine.ts`.
- `PlanItem`, `TripIssue`, `RepairProposal`, and `TripHeartbeat` in
  `CompassAutopilotEngine.ts`.
- `OutcomeStage`, `RecordOutcomeRequest`, and `RecordOutcomeResult` in
  `CompassOutcomeEngine.ts`.
- `PublicLocationContext` and `DistanceBucket` in
  `LocationIntelligenceEngine.ts`.

---

## B. Genuine gaps and build-vs-reuse decisions

### B1. Gaps that justify new work

| Gap | Why it is real | Decision | Earliest phase |
|---|---|---|---|
| Versioned append-only location observation contract | Existing location state is a mutable snapshot; trust snapshots are fraud signals, not a journey event stream. | **Build** behind explicit session + flags. | Phase 1 |
| Deterministic movement/stop/dwell segmenter | No existing engine derives moving, candidate-stop, dwelling, or departed states. | **Build shadow-only.** | Phase 1 |
| Segment confidence and provenance | Existing source confidence does not describe GPS accuracy, gaps, or segment uncertainty. | **Build**, reusing Phase 8 confidence principles. | Phase 1 |
| Canonical coarse world reference below city | Existing labels/zones/places are separate and sometimes free text. | **Reuse + adapter** before considering new canonical tables. Prefer existing canonical-location/place IDs. | Phase 1 design gate |
| Four temporal social overlap classes | Existing presence and compatibility do not classify layover/transit/destination/future overlap. | **Defer**, then build only from consented coarse/planned data. | Later, separate approval |
| Full candidate-set decision trace | Served rows store delivered choices and factors, not compact rejected-alternative/gate summaries or policy versions. | **Optional extension** to Compass records if audit use cases justify the retention cost. | Later |
| Explicit retention enforcement for new trajectory data | Existing snapshot expiry is narrow; no repository-wide exact-location retention policy was verified. | **Build before ingestion**: TTL columns, purge job, revocation deletion, metrics. | Phase 1 |

### B2. Areas to reuse or skip

| Handoff ask | Decision | Required integration rule |
|---|---|---|
| New candidate ranker | **Skip** | Adapt candidates to `CompassItem` and call `runPipeline`. |
| New Fit Resolution score | **Skip** | A fail-closed Journey feasibility pre-gate may reject or contribute a named factor; Compass Match remains personal fit. On feasibility/gate error, return no option—never an unranked/raw candidate fallback. |
| New social compatibility model | **Skip** | Use `computeTravelCompatibility` and existing relationship gate. |
| New safety/privacy filter | **Skip** | Use Compass Safety/Eligibility/Privacy and Circle presence guards. |
| New decision/outcome store | **Skip parallel store** | Use served recommendations and Compass outcomes; add only trace references if approved. |
| New dynamic itinerary engine | **Skip** | Use Trip Autopilot, route tables, locks, permissions, and confirmation. |
| New notification attention system | **Skip** | Route any future signal through Compass Sense and its quotas. |
| New world/intelligence graph | **Skip** | Add derived aggregate edges to the existing Compass graph only after privacy review. |
| New adaptive preference learner | **Skip** | Use Compass outcome deltas and category weights. |

### B3. Prerequisite reconciliation

Before Phase 1 code is scoped, reconcile these verified repository risks:

1. `0033_location_sessions.sql` exists in multiple migration roots with
   incompatible shapes. `LocationSessionService` expects fields such as
   `expires_at`, `lat`, `lng`, `city`, and related IDs that are not present in
   the older copy.
2. Confirm that `user_location_preferences` is the single deployed table used
   by `LocationPermissionService` and location-preference routes.
3. Confirm which migration root is canonical for new work. A committed
   migration file alone is not proof that a schema exists live.
4. Confirm that an expiry/purge scheduler actually calls the relevant cleanup
   functions; a TTL column without a worker is not retention enforcement.
5. Confirm mobile background-location platform permissions and store-policy
   disclosures before any background collection is proposed.

#### B3 resolution — 2026-08-21

The schema prerequisites in items 1–3 were resolved by canonical migration
`artifacts/api-server/src/migrations/2110_location_sharing_schema_convergence.sql`.
The decisions and live evidence are:

1. **Canonical migration root:** all new location migrations go in
   `artifacts/api-server/src/migrations/`. `artifacts/api-server/migrations/`
   is frozen legacy history and the repo-root `migrations/` directory is
   archived history. Conflicting `0032`/`0033` files in those roots are not
   edited or replayed.
2. **Preference authority:** `user_location_preferences` is the canonical
   sharing-mode and precision table used by `LocationPermissionService`, the
   location-preference GET/PATCH routes, map/circle privacy gates, Compass, and
   profile setup. The live table matches the service's five mode values,
   nullable precision overrides, four booleans, and timestamps.
   `location_preferences` remains deployed only as a rollback source; its
   visibility columns use the incompatible audience vocabulary
   (`everyone`/`circle`/`trip_members`/`nobody`) and must not be read as
   precision.
3. **Session contract:** live `location_sessions` already contained all legacy
   and service columns, but its CHECK accepted only
   `live_share`/`trip_check_in`/`auto`. Migration 2110 widens the accepted
   values to include the four `LocationSessionService` types while preserving
   every legacy value and column.
4. **Rollback:** migration 2110 drops or renames nothing. The previous
   application can be redeployed immediately because the legacy table,
   columns, values, and rows remain intact. Backfilled canonical rows are not
   deleted during rollback because users may have updated them after rollout.
5. **Journey remains gated:** migration 2110 creates no observation table,
   collector, scheduler, or feature flag. Items 4–5 above remain mandatory
   gates before any Journey observation ingestion can be proposed.

---

## C. Proposed migrations and rollback notes — design only, not applied

No SQL file is added by this ADR. Names below are placeholders for a future,
separately approved implementation task.

### C1. Migration J1 — observation foundation

**Proposed name:** `YYYYMMDD_journey_observation_foundation.sql`

#### `journey_observations`

Append-only, service-written observations collected only inside an explicitly
active location session.

| Column | Proposed shape | Notes |
|---|---|---|
| `id` | UUID PK | Server generated. |
| `user_id` | UUID, cascade delete | Owner identity; never exposed to another user. |
| `location_session_id` | UUID | Must resolve to an active, owner-matching location session. Add FK only after session schema reconciliation. |
| `event_version` | smallint | Starts at `1`; required for taxonomy evolution. |
| `observed_at` / `received_at` | timestamptz | Supports out-of-order handling and clock-skew checks. |
| `source` | text check | `foreground_gps`, `background_gps`, `plan_checkin`, `manual`. Manual observations cannot prove physical movement. |
| `lat` / `lng` | double precision nullable | **Restricted exact-location data.** Required only for GPS sources; null for manual/check-in evidence. Never selected by public routes or passed to Compass/model prompts. |
| `accuracy_m` | numeric nullable | Required for GPS sources; null is valid only for non-GPS evidence. |
| `speed_mps` / `heading_deg` | numeric nullable | Evidence only; never treated as authoritative. |
| `world_ref` | JSONB nullable | Required for `plan_checkin`/`manual` hints and null for GPS observations at ingestion. Validated coarse IDs only; coordinate-like keys are prohibited. |
| `consent_scope` | text | Snapshot of the explicit collection scope at ingestion. |
| `idempotency_key` | text | Unique per user/session to make retries safe. |
| `trust_class` | text | `accepted`, `low_accuracy`, `suspicious`, `manual`; integrates with `LocationSafetyService`. |
| `expires_at` | timestamptz | Mandatory deletion deadline. Default recommendation: 24 hours, hard maximum 72 hours for failed segmentation/replay. |
| `created_at` | timestamptz | Audit time. |

**Indexes**

- unique `(user_id, location_session_id, idempotency_key)`;
- `(user_id, observed_at)`;
- `(expires_at)` for purge;
- no general geospatial index until a demonstrated server query requires it.

**Shape constraints**

- `foreground_gps` / `background_gps` require `lat`, `lng`, and `accuracy_m`
  and require `world_ref IS NULL`;
- `plan_checkin` / `manual` require a validated `world_ref` and require
  `lat`, `lng`, `accuracy_m`, `speed_mps`, and `heading_deg` to be null;
- the `world_ref` schema allows only country/region/city/district/place IDs and
  rejects latitude, longitude, address, hotel, home, and arbitrary metadata
  keys.

**RLS**

- no cross-user reads;
- authenticated users may request deletion but should not query raw rows through
  a public endpoint;
- service role may ingest, segment, and purge;
- no graph/model role receives raw coordinates.

### C2. Migration J2 — append-only segment revisions

**Proposed name:** `YYYYMMDD_journey_segment_revisions.sql`

#### `journey_segment_revisions`

Each row is an immutable revision. A later revision points to the superseded
row instead of updating history in place.

| Column | Proposed shape | Notes |
|---|---|---|
| `id` | UUID PK | Segment revision ID. |
| `user_id` | UUID, cascade delete | Owner. |
| `location_session_id` | UUID | Source consent/session boundary. |
| `segment_key` | UUID | Stable logical segment across revisions. |
| `supersedes_id` | UUID nullable | Prior revision. |
| `state` | text check | `moving`, `candidate_stop`, `dwelling`, `departed`, `discarded`. |
| `started_at` / `ended_at` | timestamptz | `ended_at` nullable for open segment revisions. |
| `duration_s` | integer nullable | Derived, non-negative. |
| `world_ref` | JSONB | Coarse canonical references only: country/region/city/district/place IDs when permitted. No exact coordinate. |
| `movement_class` | text | `unknown`, `walking`, `vehicle`, `transit`; default `unknown`. |
| `confidence` | numeric | 0–1 with named evidence in `confidence_factors`. |
| `confidence_factors` | JSONB | Accuracy, sample count, gap, radius, and algorithm reasons; no raw trace. |
| `algorithm_version` | text | Required for reproducibility. |
| `observation_count` | integer | Evidence count, not raw IDs. |
| `expires_at` | timestamptz | Default recommendation: 30 days for user-level segments. |
| `created_at` | timestamptz | Revision time. |

**Constraints**

- one current revision per `segment_key` may be enforced by a partial unique
  index on a materialized `is_current` field, or current state may be selected
  by latest `created_at`; choose one during implementation;
- `world_ref` must pass a server-side schema validator before insert;
- no user-to-user matching query may read this table.

### C3. Migration J3 — optional Compass decision trace extension

**Proposed name:** `YYYYMMDD_compass_decision_trace.sql`

This is optional and should be built only if audit requirements cannot be met
from served recommendations, ranking factors, and existing rank events.

#### `compass_decision_runs`

- append-only run ID, owner, surface, request/session correlation ID;
- `context_version`, `candidate_contract_version`, `policy_version`,
  `ranking_version`, and feature-flag snapshot;
- input/eligible/blocked/rejected/selected counts;
- compact reason-code histograms and uncertainty summary;
- selected item IDs only; rejected candidate payloads are not retained;
- default retention recommendation: 30 days;
- own-row read, service-role write.

#### Existing table extension

- nullable `decision_run_id` on `compass_served_recommendations`;
- no new “Journey score” column;
- outcomes continue to resolve through existing recommendation IDs.

### C4. Migration J4 — deferred coarse overlap candidates

**Proposed name:** `YYYYMMDD_journey_overlap_candidates.sql`

This migration is **not part of Phase 1**. It requires a separate privacy
review.

Proposed fields:

- subject user, other user, and a provable shared-context reference;
- `overlap_class`: `layover`, `transit`, `destination`, `future`;
- coarse world reference and bounded time window;
- confidence, evidence class (`explicit_plan`, `explicit_checkin`,
  `approximate_presence`), policy version, and permission snapshot;
- status (`candidate`, `suppressed`, `surfaced`, `expired`);
- mandatory expiry: seven days, or 24 hours after the overlap window,
  whichever is sooner;
- service-role-only reads until a final privacy gate produces a safe projection.

It must never store:

- either person’s raw observation IDs or trace;
- exact coordinates;
- lodging/private-stay locations;
- inferred home/work/religious/medical locations;
- a block or denial reason visible to the other person.

### C5. Rollback plan

| Migration | Rollback order | Data consequence | Safety note |
|---|---|---|---|
| J1 observations | Disable flags → stop ingestion → drain/cancel segment jobs → purge raw rows → drop policies/indexes/table | Raw observations are intentionally disposable. | Verify no background client continues uploading before table removal. |
| J2 segments | Disable segment consumers → delete segment revisions → drop table | Derived state is rebuildable while J1 observations still exist; after raw TTL it is not. | Never extend raw retention merely to make rollback easier. |
| J3 decision trace | Stop trace writes → remove served-rec FK/column → drop trace table | Existing served recommendations/outcomes remain valid. | Make the FK nullable and non-cascading from trace to served rows. |
| J4 overlaps | Disable overlap flag and all surfacing → purge rows → drop table | Candidates disappear; no durable social graph promise. | Block/pause/revocation must suppress reads immediately even before purge completes. |

Every future migration must be tested both forward and backward in an isolated
database. None should alter existing Compass behavior while all Journey flags
are false.

---

## D. Typed contract sketches reconciled with existing types

These are sketches, not committed TypeScript. The design deliberately embeds
or references existing contracts rather than recreating them.

### D1. Shared primitives and event

```ts
import type {
  CompassContext,
  CompassItem,
  CompassProfile,
} from "../../artifacts/api-server/src/compass/types.js";
import type { Confidence } from "../../artifacts/api-server/src/lib/liveIntelligence.js";

type JourneyContractVersion = 1;

interface JourneyWorldRef {
  countryCode: string | null;
  regionId: string | null;
  cityId: string | null;
  districtId: string | null;
  placeId: string | null;
  // Public/derived contract: exact lat/lng is intentionally impossible here.
}

interface JourneyUncertainty {
  score: number; // 0..1 confidence in the derived conclusion
  tier: "low" | "medium" | "high";
  reasons: string[];
  algorithmVersion: string;
  computedAt: string;
}

type JourneyEvent =
  | {
      version: JourneyContractVersion;
      id: string;
      kind: "location_observation";
      userId: string;
      locationSessionId: string;
      observedAt: string;
      source: "foreground_gps" | "background_gps";
      exact: { lat: number; lng: number; accuracyM: number }; // restricted ingest only
      consentScope: string;
      idempotencyKey: string;
    }
  | {
      version: JourneyContractVersion;
      id: string;
      kind: "location_hint";
      userId: string;
      locationSessionId: string;
      observedAt: string;
      source: "plan_checkin" | "manual";
      world: JourneyWorldRef; // non-GPS evidence; exact coordinates are impossible
      consentScope: string;
      idempotencyKey: string;
    }
  | {
      version: JourneyContractVersion;
      id: string;
      kind: "plan_transition";
      userId: string;
      observedAt: string;
      tripId: string;
      planItemId: string;
      transition: "scheduled" | "started" | "completed" | "cancelled";
    }
  | {
      version: JourneyContractVersion;
      id: string;
      kind: "presence_change";
      userId: string;
      observedAt: string;
      sharedContext: { type: "trip" | "event"; id: string };
      // Reference the consent-gated Circle presence projection; no coordinates.
      presenceRef: string;
    };
```

Only the GPS `location_observation` branch carries exact coordinates, and that
branch is legal only inside the restricted ingestion/segmentation boundary.
Manual and plan-check-in evidence use `location_hint` and cannot prove physical
movement. Model prompts, Compass candidate adapters, notification payloads,
logs, and public responses must use `JourneyWorldRef`.

### D2. Journey state

```ts
import type { LiveRollingContext } from
  "../../artifacts/api-server/src/compass/CompassLiveEngine.js";

type SegmentState =
  | "moving"
  | "candidate_stop"
  | "dwelling"
  | "departed"
  | "discarded";

interface JourneySegmentRevision {
  segmentKey: string;
  revisionId: string;
  supersedesRevisionId: string | null;
  state: SegmentState;
  startedAt: string;
  endedAt: string | null;
  world: JourneyWorldRef;
  movementClass: "unknown" | "walking" | "vehicle" | "transit";
  uncertainty: JourneyUncertainty;
  evidence: {
    observationCount: number;
    medianAccuracyM: number | null;
    maxGapSeconds: number | null;
  };
  algorithmVersion: string;
}

interface JourneyState {
  version: JourneyContractVersion;
  userId: string;
  computedAt: string;
  compass: CompassContext;       // canonical situational context
  live: LiveRollingContext | null; // canonical explicit live-session context
  activeSegment: JourneySegmentRevision | null;
  recentSegments: JourneySegmentRevision[];
  // Profile remains canonical; do not persist a second preference model here.
  profileRef: Pick<CompassProfile, "userId" | "computedAt">;
}
```

### D3. Candidate

```ts
import type { CompatibilityResult } from
  "../../artifacts/api-server/src/compass/CompassSocialEngine.js";

interface JourneyFeasibility {
  eligible: boolean;
  hardReasonCodes: string[]; // internal only; public explanations stay generic
  travelMinutes: number | null;
  arrivesBeforeClose: boolean | null;
  budgetCompatible: boolean | null;
  planConflict: boolean;
  uncertainty: JourneyUncertainty;
}

interface JourneyCandidate {
  version: JourneyContractVersion;
  item: CompassItem; // canonical Safety/Eligibility/Privacy/Scoring input
  provenance: {
    source: "discovery" | "event" | "trip" | "meetup" | "compass_tool";
    sourceId: string;
    observedAt: string | null;
    confidence: Confidence;
  };
  feasibility: JourneyFeasibility;
  companionFit?: CompatibilityResult; // separate from opportunity fit
}
```

The candidate adapter may reject an impossible option before ranking, but it
may not bypass `runPipeline`. Companion fit remains separate so the explanation
can say “great place, uncertain companion overlap” rather than hide a tradeoff
inside one score.

### D4. Decision

```ts
import type { PipelineResult } from
  "../../artifacts/api-server/src/compass/CompassPipeline.js";

interface JourneyDecision {
  version: JourneyContractVersion;
  decisionRunId: string;
  userId: string;
  surface: string;
  decidedAt: string;
  compassContextState: CompassContext["contextState"];
  policyVersion: string;
  rankingVersion: string;
  featureFlags: Record<string, boolean>;
  counts: {
    input: number;
    blocked: number;
    rejected: number;
    selected: number;
  };
  selected: Array<{
    result: PipelineResult; // canonical scores and factors
    recommendationId: string; // canonical served-recommendation provenance
    feasibility: JourneyFeasibility;
    companionFit?: CompatibilityResult;
  }>;
  resolution: "serve" | "no_safe_option" | "insufficient_confidence";
}
```

There is no `journeyFitScore`. The decision retains Compass Match, Community
Score, final score, feasibility, and companion fit as distinct dimensions.

### D5. Outcome

```ts
import type {
  OutcomeStage,
  RecordOutcomeRequest,
  RecordOutcomeResult,
} from "../../artifacts/api-server/src/compass/CompassOutcomeEngine.js";

interface JourneyOutcomeSignal {
  version: JourneyContractVersion;
  recommendationId: string;
  stage: OutcomeStage;
  source:
    | "journey_segment"
    | "plan_transition"
    | "client"
    | "existing_organic_route";
  occurredAt: string;
  segmentRef?: string; // opaque derived segment reference, never raw observations
}

type JourneyOutcomeWrite = RecordOutcomeRequest;
type JourneyOutcomeResult = RecordOutcomeResult;
```

Outcome ingestion must call `recordOutcome`; it must not create a second stage
taxonomy or preference update path.

---

## E. Feature-flag plan

Use the existing `feature_flags` table and Compass namespace rather than create
a second flag store. The existing `Compass flags.ts` loader caches values for
30 seconds: that is acceptable for non-sensitive presentation behavior, but it
is **not an authorization or emergency-stop control for precise-location
ingestion**. Ingestion and consent gates require an uncached, worker-safe check
described below.

### E1. Proposed flags

| Flag | Production default | Purpose |
|---|---:|---|
| `COMPASS_JOURNEY_ENGINE_ENABLED` | `false` | Master kill switch. Required for every new path. |
| `COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED` | `false` | Accept new observation events inside explicit sessions. |
| `COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED` | `false` | Produce derived segments for validation only; no consumers. |
| `COMPASS_JOURNEY_DECISION_TRACE_ENABLED` | `false` | Optional compact trace metadata on existing Compass decisions. |
| `COMPASS_JOURNEY_OVERLAP_ENABLED` | `false` | Later coarse overlap classification and surfacing. |
| `COMPASS_JOURNEY_NEEDS_INFERENCE_ENABLED` | `false` | Later, separately reviewed latent-needs features. |
| `COMPASS_JOURNEY_AUTOPILOT_SIGNAL_ENABLED` | `false` | Later allows a high-confidence derived segment to become an Autopilot monitor input. |

### E2. Evaluation rules

1. Missing flag means false, matching `isEnabled`.
2. Every child flag requires `COMPASS_JOURNEY_ENGINE_ENABLED`.
3. Every ingestion batch performs an uncached read of the master and ingest
   flags, or checks a distributed kill-switch epoch with a tested maximum
   propagation bound of five seconds. The 30-second in-process Compass cache
   must never be the sole ingestion gate.
4. Every ingestion batch performs fresh authorization checks for session
   ownership/status and sharing pause/revocation; these checks are not cached.
5. Observation ingestion also requires:
   - an authenticated owner;
   - an explicitly active, unexpired location session;
   - a compatible location preference;
   - sharing not paused;
   - source-specific permission.
6. Segmentation shadow mode writes no nudge, overlap, recommendation, graph
   edge, plan proposal, or outcome.
7. Turning the master flag off stops new ingestion within the tested
   five-second propagation bound and stops consumers before their next unit of
   work; purge continues so disabling the feature cannot defeat retention.
8. Production rollout order:
   - local/test;
   - internal allowlist;
   - small opt-in cohort in shadow mode;
   - privacy/quality review;
   - explicit approval before any user-visible consumer.

---

## F. Privacy, data classification, and retention

### F1. Classification

| Data | Classification | Allowed consumers | Proposed retention |
|---|---|---|---|
| Raw exact observation (`lat`, `lng`, timestamp) | **Restricted precise location** | Ingest validator, segmenter, purge worker, narrowly scoped safety checks | 24 hours by default; hard maximum 72 hours |
| Accuracy/speed/heading and trust class | **Restricted mobility metadata** | Segmenter and safety checks | Same row/TTL as raw observation |
| Coarse segment world reference and dwell duration | **Sensitive behavioral location** | Owner Journey state, approved aggregate builder; not social matching directly | 30 days |
| Planned trip/event overlap window | **Sensitive social/itinerary data** | Permission gate and overlap classifier | Until 24 hours after window, max 7 days for candidates |
| Surfaced approximate overlap | **Private social projection** | Only both eligible users inside a provable shared context | Re-evaluate on every read; candidate TTL above |
| Decision trace counts/version/reasons | **Private behavioral analytics** | Owner explanation path and restricted analytics | 30 days |
| Existing Compass outcome stage | **Private recommendation outcome** | Existing Phase 14 engine and owner/admin policies | Existing policy; no new location payload added |
| Aggregated city rhythm | **Aggregate non-personal output** | Existing Compass graph/world model | Existing policy, only after aggregation thresholds |

### F2. Collection and purpose limitation

- No collection solely because the app is open.
- No collection outside an explicit active location session.
- “Live during activity” must end when the activity/session ends.
- Raw observations are used only to validate and produce segment revisions.
- Raw observations never enter OpenAI/model prompts, recommendation items,
  notifications, logs, graph attributes, analytics events, or social responses.
- Manual check-ins may inform plan state but cannot prove movement, arrival, or
  co-presence.
- Exact private-stay/hotel/home-like locations are not converted into social
  overlaps or graph edges.

### F3. Permission, block, and revocation behavior

- Existing location preferences remain the source of truth.
- Existing block, blocker, mute, Circle presence, account restriction, and
  shared-context gates remain mandatory.
- Sharing pause or consent revocation:
  1. rejects new observations;
  2. closes the active segment as discarded or consent-ended;
  3. suppresses overlap candidates immediately;
  4. schedules raw and derived user data for deletion;
  5. does not reveal to another person whether block, pause, or missing consent
     caused non-appearance.
- User deletion cascades through observations, segments, traces, and overlap
  candidates.

### F4. Inference prohibitions

The system must not infer or label:

- home, workplace, hotel room, medical facility usage, religious practice,
  relationship status, sexual behavior, substance use, disability, health,
  immigration status, or other protected/sensitive traits;
- “unsafe,” “drunk,” “lost,” “lonely,” or similar personal states from a trace;
- another person’s precise route or future location.

Allowed Phase 1 outputs are mechanical and uncertainty-labeled:
`moving`, `candidate_stop`, `dwelling`, `departed`, `unknown`.

### F5. Retention enforcement

- `expires_at` is mandatory on every new raw or derived row.
- A scheduled purge must be observable with deleted-row count, oldest expired
  row age, failure count, and alerting.
- Purge continues even when Journey features are disabled.
- Backups and analytics exports must document their own deletion window before
  production collection starts.
- Do not retain raw data longer because a job failed; retry within the hard TTL
  or discard.
- Aggregate graph updates require minimum cohort/sample thresholds and must not
  retain source user IDs in returned graph data.

---

## G. Concrete Phase 1 acceptance and test plan

Phase 1 means **observation ingestion plus shadow segmentation only**.

### G1. Contract and ingestion tests

1. Accept a valid v1 GPS observation only for the authenticated owner of an
   active, unexpired, compatible location session.
2. Reject ingestion when master or ingest flag is absent/false.
3. Reject paused/off sharing, ended/expired session, wrong owner, invalid
   coordinates, impossible accuracy, future timestamp, and unsupported version.
4. Deduplicate retries by `(user, session, idempotencyKey)`.
5. Store `observed_at` and `received_at` separately.
6. Bound out-of-order acceptance; reject or quarantine observations older than
   the session or raw-retention window.
7. Treat manual/check-in events as non-GPS evidence, persist their validated
   coarse `world_ref`, and reject either missing `world_ref` or any coordinate
   fields/coordinate-like keys on those sources.
8. Verify one malformed event cannot poison the rest of a batch.
9. Prime the existing Compass flag cache with `true`, then disable the master
   flag and prove the next ingestion batch is rejected without waiting 30
   seconds.
10. Prove a sharing pause/session revocation on one worker rejects the next
    batch on another worker within the five-second control bound.

### G2. Segment state-machine tests

Use deterministic timestamped fixtures, not wall-clock sleeps.

1. Stationary points with acceptable accuracy progress:
   `moving → candidate_stop → dwelling`.
2. Departure beyond the configured radius produces a `departed` revision.
3. GPS jitter inside the accuracy envelope does not create false departures.
4. A short pause does not become a dwell.
5. Sparse points or a long observation gap produce low confidence or
   `discarded`, not a confident dwell.
6. Low-accuracy points cannot establish a precise place.
7. Walking and vehicle-like fixtures do not flip repeatedly around a threshold.
8. Out-of-order points produce deterministic revisions.
9. Duplicate points do not inflate duration or evidence count.
10. Algorithm replay with the same version and observations is idempotent.
11. A new algorithm version creates attributable revisions without rewriting
    old records.
12. Session end closes or discards open segment state deterministically.

### G3. Privacy and authorization tests

1. No public route, Compass prompt context, candidate, notification, log, error,
   or graph API contains exact coordinates or raw observation IDs.
2. RLS prevents cross-user reads and writes.
3. Service-role reads are limited to ingestion/segment/purge paths.
4. Pause, block, membership removal, account restriction, and consent
   revocation suppress downstream projections immediately.
5. Deletion removes raw observations, derived segments, and future optional
   overlap candidates.
6. Private-stay/hotel-like references never become social output.
7. Error responses are adversarially uniform and do not reveal whether a
   person, block, session, or overlap exists.

### G4. Retention and operations tests

1. Purge removes expired raw rows while leaving unexpired rows.
2. Purge continues when the master flag is false.
3. Failure is visible in logs/metrics and retries without extending TTL.
4. Oldest-expired-row monitoring crosses an alert threshold in a simulated
   stuck-worker test.
5. Ingestion backpressure rejects safely rather than buffering precise
   location indefinitely.
6. Batch size, per-user rate, and total write throughput have explicit limits.
7. Replay/segment jobs are idempotent after worker restart.

### G5. Existing-system regression tests

With all Journey flags false:

1. Compass feed order, Safety/Eligibility/Privacy behavior, and `/why` responses
   are unchanged.
2. Discovery responses and cache-hit/cold paths are unchanged.
3. Sense evaluates and delivers exactly as before; no new nudge category exists.
4. Live starts/stops/checks exactly as before; no observation collection occurs.
5. Autopilot creates no new issue or proposal type.
6. Outcome recording and category-weight updates are unchanged.
7. Graph rebuild consumes no Journey table.
8. A simulated Journey feasibility, eligibility, or ranking exception returns
   `no_safe_option`/`insufficient_confidence`; no Journey surface returns the
   raw/unranked candidate-list fallback.

### G6. Migration and schema tests

1. Resolve and test the canonical `location_sessions` and location-preferences
   schemas before writing Journey migration SQL.
2. Apply proposed migrations to an isolated database from the canonical
   migration path.
3. Run forward migration twice where `IF NOT EXISTS` is used, but do not treat
   idempotence as schema-convergence proof.
4. Inspect columns, constraints, indexes, and RLS explicitly.
5. Run the documented rollback in reverse order.
6. Re-run existing API typecheck/tests with no new schema assumptions on
   default-off paths.

### G7. Phase 1 exit criteria

Phase 1 is complete only when:

- flags default false in production;
- schema reconciliation is documented and verified;
- exact-location leak tests pass;
- deterministic segment tests pass at agreed precision/recall thresholds;
- purge is scheduled, observable, and tested;
- no existing Compass/Discovery output changes with flags off;
- shadow results are reviewed for false stop/dwell rates across GPS accuracy,
  timezone, transit, indoor, and low-connectivity fixtures;
- privacy review approves whether any Phase 2 consumer may proceed.

---

## H. Dependencies, risks, and duplicate-scope callouts

### H1. Dependencies and risks

| Risk / dependency | Impact | Mitigation / gate |
|---|---|---|
| Duplicate, divergent location migration paths | Service/runtime mismatch and failed ingestion | Reconcile live schema and canonical migration root before implementation. |
| Background location platform permission | Feature may be impossible or non-compliant on iOS/Android | Product/legal/store-policy review; explicit opt-in; foreground-only fallback. |
| Battery and network cost | User harm and poor data quality | Adaptive sampling belongs in client/platform design; server rate limits and batch bounds. |
| GPS noise, indoor drift, tunnels, flights, clock skew | False stops, movement, or overlap | Accuracy-aware state machine, uncertainty labels, deterministic fixtures, shadow-only rollout. |
| Event taxonomy drift | Old clients/jobs become ambiguous | `event_version`, tolerant readers, versioned algorithm and migration contract. |
| Exact-location breach | Severe privacy/safety harm | Restricted tables, no public select path, short TTL, leak tests, no model/log/graph copy. |
| Shared DB load | High write volume and graph/ranking contention | Capacity model before cohort rollout; short retention; bounded batches; no geospatial index without query proof. |
| Retention worker failure | Precise data persists beyond promise | Mandatory `expires_at`, monitored purge, oldest-expired alert, no silent fallback. |
| Block/consent race | Social disclosure after revocation | Re-evaluate permission on every read; candidates are not authorization. |
| Sparse-data needs inference | Harmful or creepy recommendations | Defer; minimum samples; prohibited inference list; user-visible controls and explanations. |
| Dual ranking authorities | Inconsistent and unsafe choices | `CompassPipeline` remains the only fit authority. |
| Compass Eligibility and Discovery eligibility exceptions are fail-open; Compass tools may fall back to a raw DB list on ranker failure | Safety-critical Journey path might pass or serve an un-gated option on error | Run Journey consent/session/feasibility checks fail-closed before Compass, retain Compass fail-closed Safety, and prohibit raw/unranked fallback on Journey surfaces. |
| Outcome feedback self-reinforcement | Narrowing/filter bubble | Keep bounded existing ±10 weights, separate Community Score, monitor calibration/diversity. |
| Social overlap existence probing | Reveals travel plans, blocks, or account state | Trusted-context requirement, approximate output, uniform denial, short TTL. |
| Route/opening/transit data quality | “Feasible” option may be wrong | Use Phase 8 source confidence and honest unknown; no auto-execution. |
| Concurrent live/Sense/Autopilot jobs | Duplicate nudges/proposals | Reuse existing dedupe keys, quotas, partial unique indexes, and confirmation. |

### H2. Explicit Compass phase 7–15 duplication map

| Compass phase already merged | Proposed Journey duplication | Recommendation |
|---|---|---|
| Phase 7 — formal recommendation engine | Fit scoring, factor explanations, personal vs community score | **Reuse; do not rebuild.** |
| Phase 8 — live intelligence | Uncertainty/source confidence and honest degradation | **Reuse confidence vocabulary and outage behavior.** |
| Phase 9 — social intelligence | Companion compatibility, group fit, approximate “who is around” | **Reuse; add only temporal overlap classification later.** |
| Phase 10 — Compass Home | Context-aware “best next move” orchestration | **Reuse as a consumer; do not create a second home/next-move ranker.** |
| Phase 11 — Compass Sense | Needs signals, permissions, quiet hours, dedupe, attention budget | **Reuse; no Journey notification engine.** |
| Phase 12 — Compass Live | Journey/live lifecycle and rolling plan context | **Reuse; observation collection may attach to explicit sessions but must not redefine them.** |
| Phase 13 — Trip Autopilot | Dynamic plan monitoring, conflict detection, partial recovery | **Reuse; no second replanner.** |
| Phase 14 — Outcome Learning | Append-only outcome chain, calibration, adaptive preferences | **Reuse; no second outcome taxonomy.** |
| Phase 15 — Intelligence Graph | Social/travel graph, world model, behavioral/outcome edges | **Reuse; add only privacy-reviewed aggregate edges, never raw trajectory.** |

### H3. Human approval checklist before Phase 1 is scoped

- [ ] Approve the ADR decision: narrow observation foundation, no parallel
      Journey decision engine.
- [ ] Approve explicit-session-only collection; reject default continuous
      background tracking.
- [ ] Reconcile location session/preferences schemas and migration root.
- [ ] Approve raw observation TTL (recommended 24 hours, hard max 72).
- [ ] Approve derived segment TTL (recommended 30 days).
- [ ] Approve prohibited inference list.
- [ ] Approve default-off flag names and shadow-only rollout.
- [ ] Assign privacy/security review for observation storage and deletion.
- [ ] Define segment quality thresholds before any consumer is allowed.
- [ ] Keep overlap, latent needs, decision-trace extension, graph updates,
      notifications, and Autopilot inputs out of Phase 1.

## Final recommendation

Approve only the **Phase 1 observation and shadow-segmentation foundation**,
subject to the checklist above. Treat the rest of the Journey proposal as an
integration program over Compass phases 7–15:

- observations may eventually contribute a named, uncertainty-aware context
  signal;
- candidate and fit resolution stays in Compass;
- social permission and compatibility stays in Compass Social;
- attention stays in Sense/Live;
- plan recovery stays in Autopilot;
- learning stays in Outcomes;
- aggregate destination intelligence stays in the Compass Graph.

This preserves the useful new idea—understanding movement and dwell—without
duplicating the already-merged decision system or creating a second store of
precise travel behavior.