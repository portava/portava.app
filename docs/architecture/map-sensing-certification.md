<!-- PORT HEADER — added 2026-09-20. Everything below the rule is the original
     document, verbatim. -->

> ## Ported, not rewritten
>
> This document was written on 2026-09-16 on the Replit branch (commits
> `d15e0cfce`, `3c5a76fd2`) and **was not carried across by the port**
> `98fac66fc`. It is restored here unchanged because it is the only written
> physical-device certification protocol in the programme, and it is the
> artifact the Map census rows M254, M255, M258 and M292 need in order to be
> measurable at all.
>
> **Its body is a historical record and has not been edited.** Where its status
> cells read **Unknown**, that was true on 2026-09-16 and some of it is no
> longer true. A live re-measurement of production on 2026-09-20 (recorded in
> `docs/architecture/census-map.md` §43) establishes:
>
> | object | 2026-09-16 | 2026-09-20 |
> |---|---|---|
> | the four `locate_friends_*` tables | unknown | **present in production** |
> | `map_telemetry_events`, `map_telemetry_drops` | unknown | **present in production**, 0 rows |
> | `protected_zones` | unknown | **still absent** |
> | `route_flow_contribution_consent` | unknown | **still absent** |
> | `geo_zones` | unknown | present, **0 rows** |
>
> The **Enabled** column has not improved. `map_projection_enabled`,
> `map_crowd_flow_enabled` and `map_world_intelligence_enabled` have no row in
> production at all, and `map_telemetry_enabled` and `locate_friends_enabled`
> are present and FALSE. So the accurate reading of §12 and §35 today is
> *deployed and switched off*, which is a different and better fact than
> *storage absent* — and still not *works*.
>
> **The device ledger below is unchanged and still stands.** No physical iOS or
> Android device has been available in any session since, so every scenario it
> marks NOT RUN is still NOT RUN. Its rule that simulator, web and unit evidence
> "must not be entered in this ledger as a substitute" is the reason those four
> census rows are not being closed on the harnesses built for them: a harness
> that can produce the number is not the number.

---

# Map and Sensing Certification

**Date:** 2026-09-16  
**Branch:** `main` at `ef34388ac`  
**Scope:** Map, privacy-safe sensing, aggregation, intelligence projections,
World Experience consumers, ExperienceSession outcomes, client Map behavior,
and rollout controls.

## Verdict

**CERTIFIED FOR CONSTRUCTION, WITH RUNTIME AND TARGET-ENVIRONMENT BLOCKERS.**

The merged implementation passes its focused and full offline suites. The
certification does **not** claim that the target database has the required
migrations, that schedulers are reachable, that flags are enabled, or that
physical-device behavior has passed. The guarded live auditors refused to run
without an explicitly asserted non-production target; no live query was issued.

Two architecture limits also remain explicit:

1. Generic Map aggregation trusts upstream `count` and `sensitiveSubject`
   metadata. The crowd-flow producer supplies independently counted cohorts and
   protected-location checks, but the generic boundary cannot prove that every
   future publisher does.
2. Five of the eight contribution prompts are intentionally refused because no
   canonical claim vocabulary exists for them. Refusal is safe behavior, not
   feature completeness.

## Status ledger

These columns are deliberately independent.

| Unit | Built | Verified | Merged | Deployed | Enabled |
|---|---:|---:|---:|---:|---:|
| Map object contract, projection, aggregation, telemetry | Yes | Yes, offline | Yes | **Unknown** | **Unknown** |
| Authenticated Map contribution ingest | Yes | Yes, offline | Yes | **Unknown** | **Unknown; seed is OFF** |
| Sensing device credentials and revocation | Yes | Yes, migration/unit | Yes | **Unknown** | **Unknown; seed is OFF** |
| Crowd-flow production | Yes | Yes for wired sources | Yes | **Unknown** | **Unknown; seed is OFF** |
| Legacy Compass cohort guard | Yes | Yes, offline | **Pending this certification merge** | **Unknown** | **Unknown** |
| Coverage and protected-location gates | Yes | Yes, offline | Yes | **Unknown** | **Unknown** |
| World Experience projections and consumers | Yes | Yes, offline | Yes | **Unknown** | **Unknown; seeds are OFF** |
| ExperienceSession outcome/calibration seam | Yes | Yes, offline | Yes | **Unknown** | **Unknown** |
| Client Map modes, interactions, cache and fallback | Yes | Yes, code/tests | Yes | **Not established** | **Not established** |
| Retention jobs | Yes | Yes, offline | Yes | **Unknown** | **Unknown** |

“Merged” means present in a committed implementation on this checkout's `main`.
The certification report, integration proof, Compass remediation and fixture
correction are the current task diff and remain pending until this task merges.
Neither state is evidence of a published application or an applied migration.

## Requirement-to-evidence matrix

No single canonical numbered Map/Sensing acceptance matrix exists in the
repository. This census combines the available IG-01–IG-10 inventory, the Map
spec section identifiers embedded in code/tests (§10, §18, §19, §22, §37), and
the task's explicit cross-cutting requirements.

| Requirement | Construction result | Evidence or exact blocker |
|---|---|---|
| IG-01 / §18 canonical contracts | **PASS** | `intelContracts.test.ts`; `mapObjectsContract.test.ts` compares server and app vocabularies, priorities, privacy ladder, confidence and freshness. |
| IG-02 storage and authorization | **PASS offline; LIVE BLOCKED** | `intelStorage.test.ts`, `privacySafeSensingMigration.test.ts`, and service-role-only migration assertions pass. Live schema, grants and RLS were not queried because the target assertion was unavailable. |
| IG-03 / §22 contribution capture | **PASS for supported prompts** | `mapObservations.test.ts`: bearer identity, actor-field refusal, consent, subject, time, idempotency, flag chain, and observation-not-truth. Five prompt classes remain intentionally unsupported. |
| Device eligibility and credential lifecycle | **PASS offline; DEVICE/LIVE BLOCKED** | `deviceContributionCredential.test.ts`, `privacySafeSensingMigration.test.ts`: purpose/version/device binding, expiry, revocation, one-use nonce and device-unlink revocation. Requires applied migration and real-device enrollment proof. |
| IG-04 privacy, confidence and projection | **PASS for routed producers** | `privacyGate.test.ts`, `confidenceScore.test.ts`, `intelProjection.test.ts`, `mapAggregation.test.ts`. Generic publisher metadata remains an explicit trust boundary. |
| IG-05 read path / no fabricated live | **PASS offline; LIVE BLOCKED** | `liveClaimRead.test.ts`, `mapProjection.test.ts`, client truth/cache tests. Actual target flags and canonical rows are unknown. |
| IG-06 trail/navigation follow-up | **PASS offline** | `intelNavigationStartRoute.test.ts`, `trailFollowup.test.ts`; capture remains consent- and flag-gated. |
| IG-07 Compass k=1 closure | **PASS after remediation** | `CompassGraphEngine` separately reads person→time-slice `active_in` evidence, deduplicates actors, and suppresses legacy user-derived rhythm fallback without it. `compass-intelligence-graph.test.ts` covers duplicate actors and legacy models. |
| IG-08 coverage | **PASS offline; LIVE BLOCKED** | `intelCoverage.test.ts`, `intelCoverageProducer.test.ts`, `coverageState.test.ts`: no-coverage is distinct from quiet and coverage does not raise truth. Scheduler/data population unknown live. |
| IG-09 limited-live rollout | **PASS construction** | Feature readers fail closed; migration seeds are OFF; disabled/partial projection envelopes retain legacy behavior. Cohort enablement is a product/operations decision. |
| IG-10 internal projection/API | **PASS offline** | `intelApi.test.ts`, `intelPipeline.test.ts`, `worldIntelligenceConsumers.test.ts`; internal/admin and projection boundaries are covered. |
| IG-10 external partner API | **BLOCKED / NOT BUILT** | `intelligence-gathering-completion-plan.md` delegates API-key auth, rate limiting, scope enforcement, billing/metering and redistribution contracts. No external enablement claim is made. Per-field rights/QIU semantics also remain a product/legal decision. |
| §10 crowd-flow cohort and geometry | **PASS for wired producer** | `crowdFlowProducer.test.ts`: distinct actors, grouped-actor union denominator, dominant-group rejection, two-family minimum, no trajectory reconstruction, LineString geometry, stale/future rejection and counts-only output. |
| Sensitive/protected locations | **PASS for protected-location pipeline; GENERIC BOUNDARY OPEN** | `protectedLocations.test.ts`: suppress/coarsen/fail-closed behavior, safety override and counts-only report. Generic aggregation still relies on publisher-supplied sensitivity metadata. |
| Truth classes and safety authority | **PASS with declared unsupported prompts** | Observed and inferred halves remain separate; predictions never become current truth; user-owned recommendations cannot create safety holds. Tests: `crowdFlowProducer`, `worldExperience`, `worldIntelligenceConsumers`. |
| Precision and traveler authorization | **PASS offline** | `mapTravelers.test.ts`, `protectedLocations.test.ts`: opt-out/private/block/age gates, stale rejection, coarse precision and fail-closed privacy lookup. |
| Retention and revocation | **PASS construction; LIVE BLOCKED** | `intelRetention.test.ts`, `intelRetentionScheduler.test.ts`, `mapTelemetry.test.ts`. Intel contribution retention seeds OFF; telemetry retention migration enables its own flag. Applied state and scheduler execution are unknown. |
| ExperienceSession and calibration | **PASS at service boundaries; CAUSAL FLOW BLOCKED** | The seam-spanning case in `mapObservations.test.ts` runs shipping credential authorization, contribution capture, claim assembly/projection, World inference, ExperienceSession returned outcome and calibration against one adapter. Promotion and served-recommendation rows are inserted at their separate ownership boundaries, so this does not prove that the World result caused the recommendation/session. Existing suites cover each individual contract. |
| Map modes and state restoration | **PASS construction** | Client `mapMachine.test.ts`; Map screen tests cover tab switching, back restoration, country/stamp entry and selected-entity synchronization. |
| Semantic zoom | **PASS model; DEVICE RENDER BLOCKED** | `vocabulary.ts` defines world→venue bands; `loadingStrategy.test.ts` covers zoom/shift/settle thresholds. Native MapLibre visibility at every band still needs device QA. |
| Flow rendering semantics | **PASS style model; DEVICE RENDER BLOCKED** | `zoneStyle.test.ts` keeps observed flow solid and inferred cause dashed. Native LineString/arrow rendering needs device QA. |
| Object interactions and canonical handoffs | **PASS construction** | `longPress.test.ts`, `MapEntityActionRow.test.tsx`, `tripMapModel.test.ts`, and Map screen interaction tests cover bounded actions, disabled reasons, detail routes and itinerary proposals. |
| Offline, degraded and stale behavior | **PASS construction; DEVICE BLOCKED** | `mapCache.test.ts`, `loadingStrategy.test.ts`, `clientProjection.test.ts`: cached-first ladder, no blank state, no cached-as-live, stale removal, disabled/partial projection fallback. Airplane-mode hydration requires a device. |
| Partial rollout and legacy fallback | **PASS construction** | Projection service/client tests preserve legacy entities when disabled, unavailable or partial; unsupported snapshots do not become full World projections. |
| Telemetry privacy | **PASS offline** | Server stamps actor identity and recursively rejects coordinate/identity-shaped keys; client allowlist tests pass. Target retention execution remains unknown. |

## Integrated scenarios exercised

The focused suite plus the seam-spanning integration case cover these
input-to-consumer outcomes:

- authorized sensing credential → contribution → observation → claim assembly
  and privacy projection, plus World and ExperienceSession/calibration service
  boundaries in the same deterministic scenario;
- invalid, missing, disabled or withdrawn consent → no capture;
- expired/revoked device credential and nonce replay → refusal;
- duplicate contribution → idempotent result;
- stale/future observation → no live result;
- low actor/group/family coverage → explicit suppression or no-coverage state;
- dominant or overlapping groups → no false independence;
- protected/sensitive location → suppress or reduce precision;
- subsystem/flag failure → disabled or partial envelope, not fabricated live;
- offline/cache path → cached geography first, stale objects removed, legacy
  entities preserved;
- observed movement and inferred cause → separate truth classes;
- World projection → required consumers → ExperienceSession outcome lineage.

The seam-spanning test uses the shipping credential, capture, projection, World
inference and ExperienceSession services against a generic in-memory
Supabase-shaped adapter. It authorizes a purpose-bound credential; it does not
model a separate device-eligibility registry. Its deliberately low 15-actor
cohort is suppressed by the shared privacy gate, so World inference receives
`no_coverage` rather than fabricated live state. Claim promotion and the served
recommendation remain separately owned boundaries, represented by explicit
rows in the test; therefore this is stitched service-boundary coverage, not a
causal sensor-to-recommendation proof. A physical sensor, real MapLibre
renderer, production scheduler, HTTP/proxy process and production data remain
outside this test.

## Validation evidence from this certification run

| Validation | Result |
|---|---|
| Initial focused Map/Sensing/API set | **395 passed, 0 failed, 0 skipped** |
| Final Map contribution/integration suite | **45 passed, 0 failed, 0 skipped** |
| Final Compass cohort/privacy suites | **61 passed, 0 failed, 0 skipped** |
| Final full API `node:test` suite | **10,097 passed, 0 failed, 0 skipped** |
| API production and test typechecks | **PASS** |
| Mobile node tests | **5,469 passed, 0 failed, 0 skipped** |
| Mobile typecheck + import-extension guard | **PASS** |
| Mobile component tests, first run | **2 failed / 2,058** because the TripsTab “ongoing” fixture ended on 2026-09-15 |
| Final full standalone check | **375/375 native suites (2,062/2,062 tests), 2/2 web suites (4/4 tests), typecheck and static guards passed** |
| Test registration | **PASS:** 552 registered, 26 explicitly allowlisted |
| Compiler authenticity | **PASS** |
| Migration-prefix check | **PASS:** no undocumented collision |
| Flag-polarity check | **PASS:** 139 classified flags |
| Live forward/inverse schema audits | **BLOCKED before query:** missing explicit non-production target assertions |
| Live authorization contract | **BLOCKED before query:** same target assertion |

The date-only TripsTab test correction does not change production behavior or
weaken the video-badge assertion.

## Independent architecture and security review

Independent read-only reviews covered server requirements, client Map behavior,
and privacy/security boundaries. They confirmed the construction-level passes
above. The final architect review initially rejected the report because it
overstated isolated tests as an end-to-end chain and left the Compass cohort
path open. This task then added the seam-spanning test and fail-closed Compass
remediation. Remaining non-certifiable boundaries are:

- generic upstream count/sensitivity trust;
- unsupported contribution vocabularies;
- unbuilt external IG-10 gateway/commercial controls;
- absent target migration/flag/scheduler evidence;
- native semantic-zoom/flow/offline behavior requiring physical-device QA.

No acceptance denominator was changed and no test was skipped or disabled.

## External blockers before an enablement claim

1. **Requirement source:** provide the authoritative complete Map/Sensing spec if
   it contains IDs beyond the repository's IG and embedded section census.
2. **Target credentials/configuration:** configure the sanctioned read-only
   target assertions and rerun forward/inverse schema, RLS, authorization, flag,
   canonical-data and scheduler postcondition checks.
3. **Database approval:** apply any missing migrations only through the approved
   deployment process. In particular, verify `places` population/FK viability,
   retention jobs, sensing credentials, World projections and feature rows.
4. **Product/privacy decision:** decide whether generic Map publishers must
   carry a server-verifiable actor/group/sensitive-location proof, and define
   the external IG-10 partner API's rights, scopes, metering and redistribution
   terms before building or exposing it.
5. **Cross-owner causal flow:** provide or approve the production orchestration
   that promotes observations into claims and ties World consumer output to a
   served recommendation. Until then, service boundaries are tested but a
   causal sensor-to-session chain cannot be claimed.
6. **Physical devices:** run iOS and Android contribution enrollment/revocation,
   background sensing, semantic zoom, flow geometry, interaction, offline/cache
   hydration, accessibility and degraded-network scenarios.
7. **Release approval:** separately record merged, deployed, cohort-enabled and
   fully-enabled timestamps. This report establishes only merged construction
   and offline verification.

## Physical-device verification ledger

**Attempt date:** 2026-09-16
**Availability result:** **BLOCKED — no physical iOS or Android devices were
available.**
**Evidence collected:** Operator confirmation that neither platform was
available. No screenshots, recordings, OS diagnostics, battery measurements,
network-condition traces, or native MapLibre observations were produced.

This is a failed prerequisite, not a product pass or failure. Simulator, web,
unit, and component evidence must not be entered in this ledger as a substitute
for a physical-device result.

| Scenario | iOS | Android | Required evidence |
|---|---|---|---|
| Enrollment and permission grant/denial | **NOT RUN** | **NOT RUN** | Screen recording plus OS permission state |
| Background contribution while app is backgrounded and suspended | **NOT RUN** | **NOT RUN** | Timestamped client/server audit events with identifiers redacted |
| Credential expiry and replay refusal | **NOT RUN** | **NOT RUN** | Device-visible refusal and redacted server response/audit event |
| Consent revocation stops contribution | **NOT RUN** | **NOT RUN** | Before/after recording and absence of post-revocation writes |
| Device unlink revokes its credential | **NOT RUN** | **NOT RUN** | Unlink recording and subsequent refused contribution |
| Semantic zoom bands from world through venue | **NOT RUN** | **NOT RUN** | Recording showing each band and its zoom level |
| Observed flow is solid; inferred cause is dashed | **NOT RUN** | **NOT RUN** | Native MapLibre screenshots at the same viewport |
| LineString, direction/arrow, collision and pan/zoom stability | **NOT RUN** | **NOT RUN** | Recording across rotate, pitch, zoom and pan |
| Object select, long press, action row and canonical handoff | **NOT RUN** | **NOT RUN** | Recording ending on the canonical destination |
| Warm-cache airplane-mode hydration | **NOT RUN** | **NOT RUN** | Before/offline/after recording with cached timestamp visible |
| Expired cached objects never appear live | **NOT RUN** | **NOT RUN** | Clock/timestamp evidence and resulting stale/removed UI |
| Degraded network and recovery | **NOT RUN** | **NOT RUN** | Network conditioning settings and recovery recording |
| Partial rollout and legacy fallback | **NOT RUN** | **NOT RUN** | Flag/cohort state plus resulting Map recording |
| VoiceOver/TalkBack order, labels and actions | **NOT RUN** | **NOT RUN** | Screen-reader recording |
| Dynamic Type/font scaling and reduced motion | **NOT RUN** | **NOT RUN** | OS settings and resulting Map screenshots |
| Battery impact during background sensing | **NOT RUN** | **NOT RUN** | Device model, OS, duration, start/end battery and OS energy view |

### Required execution protocol

Run the matrix on one currently supported physical iPhone and one currently
supported physical Android phone using the same candidate build and sanctioned
non-production target.

1. Record build identifier, app version, device model, OS version, MapLibre
   native version, account/cohort, target environment and test start time.
2. Begin from a clean install. Exercise permission denial, later enrollment,
   foreground contribution, background contribution, credential expiry,
   consent revocation and device unlink. Confirm server-side effects only
   through redacted audit evidence.
3. Load a fixture viewport containing observed and inferred flow plus
   interactive canonical objects. Record every semantic zoom transition,
   geometry style, directional marker, collision result, object action and
   handoff.
4. Warm the cache online, record its freshness label, enable airplane mode,
   force-stop and reopen the app, and verify cached geography hydrates without
   cached intelligence being labelled live. Repeat after the object expiry
   boundary.
5. Repeat with high latency and packet loss, then restore connectivity. Verify
   there is no blank Map, fabricated live state, duplicate interaction, or
   broken recovery.
6. Exercise disabled, partial-cohort and legacy envelopes. Capture the exact
   flag/cohort state and verify unsupported snapshots do not become full World
   projections.
7. Run VoiceOver or TalkBack through Map controls and selected-object actions;
   repeat with the largest supported font size and reduced motion enabled.
8. Measure an agreed background-sensing interval with the screen off and no
   unrelated foreground use. Record OS battery/energy diagnostics and thermal
   warnings; do not infer a battery pass from a short foreground session.
9. Attach evidence references to each row and replace **NOT RUN** only with
   **PASS** or **FAIL**. Any missing evidence remains **NOT RUN**.

### Device certification rule

Physical-device certification requires every row to have evidence-backed
results on both platforms. Any **NOT RUN** or unresolved **FAIL** keeps the
client Map and sensing verdict blocked. As of 2026-09-16, the physical-device
verdict remains **NOT CERTIFIED**.

## Certification statement

The previously committed Map and Sensing upgrade is **built, merged, and
independently verified at the construction level** on this checkout. The
additional integration proof and Compass privacy remediation are pending this
task's merge. The system is **not certified as deployed or enabled**, and it is
**not certified on generic future-publisher trust boundaries, the external
IG-10 gateway, or physical-device behaviors** listed above. Those exact
blockers must be cleared with new evidence; they must not be inferred from this
green branch.