# Layover: 165-row remediation tracker (continuously updated)

Owner directive of 2026-10-18: correct all 165 built-but-wrong Layover requirements. This file is the source of truth for progress and the handoff checkpoint. Final evidence goes to `docs/ops/layover-165-final-verification.md`.

**Acceptance rule, for every row and not weakened:** the requirement, in the spec's own words (docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt, as the census quotes it), is met on a path a traveller in production really reaches, proven by a test that would fail if it broke. Database-dependent rows need evidence against the real migrated schema. A row is **VERIFIED PASS** only with that evidence, plus production activation where production is the requirement. "Code exists", "migration written" and "flag exists" are never a pass.

**Status values:**
- OPEN: not started;
- IN PROGRESS;
- BUILT (code + tests, not yet verified end to end);
- VERIFIED (independent verifier accepted; production activation pending where required);
- VERIFIED PASS (verified, plus production evidence where the row needs it);
- BLOCKED-EXTERNAL (the exact external dependency is named).

**Standing limits:**
- Production database writes, flag flips and deploys are the owner's press (owner instruction, 2026-10-17); this work prepares the packets.
- No purchase, account or credential is created by the agents.
- Native-speaker review is never claimed without a reviewer.

## Summary

| Batch | Rows | OPEN | IN PROGRESS | BUILT | VERIFIED | VERIFIED PASS | BLOCKED-EXTERNAL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B1-C assistant | 14 | 0 | 0 | 14 | 0 | 0 | 0 |
| B1-F flight data | 6 | 0 | 0 | 6 | 0 | 0 | 0 |
| B1-P pressed-state verification | 58 | 0 | 0 | 56 | 0 | 0 | 2 |
| B1-R1 routing (server) | 12 | 0 | 1 | 10 | 0 | 0 | 1 |
| B2-BUDDY Rent-a-Buddy specialist/Safe Return | 2 | 0 | 0 | 2 | 0 | 0 | 0 |
| B2-CREW crew/consent/sensing/rides | 8 | 0 | 0 | 7 | 0 | 0 | 1 |
| B2-CURATE curation/maturity/entry | 15 | 0 | 0 | 9 | 0 | 0 | 6 |
| B2-LIVE live intelligence | 10 | 0 | 0 | 9 | 0 | 0 | 1 |
| B2-MAP map and client | 9 | 0 | 1 | 2 | 0 | 0 | 6 |
| B2-PLATFORM metrics/audit/real-schema/typed reads | 9 | 0 | 2 | 7 | 0 | 0 | 0 |
| B2-RECS recommendations/snapshots/contracts | 14 | 0 | 0 | 14 | 0 | 0 | 0 |
| B3-ENGINE lifecycle/timing/engine refactor/phrases | 8 | 0 | 1 | 6 | 0 | 0 | 1 |
| **Total** | **165** | **0** | **5** | **142** | **0** | **0** | **18** |

## Checkpoint (resumable; updated after every batch)

**Resumed October 20 (Claude):** current-position typing and client test, plan-bound between-stop geometry, registered 3895/3908 rollbacks and the client `check:all` failures are repaired; L56 and L259 moved to BUILT. Evidence and two owner decisions (Routes reserve for previews, map for executing plans) are in [the ledger](layover-165-final-verification.md).

**Handoff requested October20:** implementation stopped at the owner's request. Read [the Claude handoff](layover-165-claude-handoff-20261020.md) first for the latest failures, uncommitted state and resume order; the earlier checkpoint below is historical.

Last updated 2026-10-19 during the Codex continuation of Claude's usage-limited session. The owner reattached the full directive and explicitly requested parallel agents. The baseline and tracker each contain exactly 165 unique row sections; no acceptance criterion has been reduced.

**Branch:** `claude/wave4-build-20261017`, worktree `/Users/areyouok/portava-sandbox/wt-claude-wave4-20261017`, [PR #764](https://github.com/portava/portava.app/pull/764), stacked on #763 and #762. No merge, deployment, production migration or production flag change has been performed in this continuation.

**Committed:** assistant `f87a92e3f`; routing and pressed-state harness `2a59ad5f7`; flight and validation repairs `2a99ebc365ba8445c3b929380e021afde6a3ac53` (39 files, pushed to the existing PR branch). The isolated flight tree remains `/Users/areyouok/portava-sandbox/lead-clean-suite`; ongoing batches are unstaged in the shared worktree.

**Active work:**

| Owner | Batch | Current work |
| --- | --- | --- |
| Lead | Integration and verification | Update evidence, register schema protections, regenerate inventories, repair guard failures and run combined checks. |
| Curation agent | MAP, then ENGINE follow-on | Continuous WALK isochrones, permitted map geometry and validated airport layout; then per-stage timing, traveller origin and activity interruptibility. |
| Snapshot agent | Independent verification | Canonical/RLS and service-audit review delivered; repairing and proving PostgreSQL/PGlite isolation, transactions and absent-migration replay. |
| Crew agent | L259 durable route events | L273, L144 and atomic3895 route watches delivered. Building bounded leased fanout with atomic publication and recovery in3908. |

**Evidence from this continuation:** flight passed all 33 repository gates after fixes; focused flight/rollout 37/37 and beta scripts 379/379. The fresh broad isolated API run recorded pretest 2763 passed/2 expected skips and main 41079 passed/2 failed; both failures were static schema blind-spot checks subsequently fixed and rerun green (37/37). This is NOT recorded as an all-green final full suite. The final aggregate suite remains required. All logs are under `/private/tmp/codex-layover-resume-20261019/`.

**Integrated repairs awaiting commit:** assistant safety holes and six regression mutants; shared live Compass certification (red 40-minute deadline difference, then 10/10 migrated tests); all four remaining typed-reader conversions; curation schema readiness (missing-table W15 refuses, restores and recovers, 17/17 migrated workflow tests). Curation, crew and canonical snapshot handbacks include rollback and targeted evidence; their independent acceptance review is still pending.

**Next batches:** objective producers, continuous WALK coverage and airport-layout pipeline are delivered with named external/geometry gaps. Continue sourced timing (3881), activity commitments (3907), traveller origin, Buddy abort authorization and durable route fanout. Independent review found and fixed audit retention backlog reporting and rollback permission drift. Route review exposed partial publication and lost watches after snapshot changes; these are being corrected, not marked complete. Regenerate inventories, finish census evidence, run all gates and final full suite/CI without raising guard ceilings.

**External boundaries:** production remains the owner's press. Licensed live-flight/airport feeds, Google Routes deployment credentials, Apple Time Sensitive entitlement/device evidence, and native-speaker validation must be evidenced before affected rows are VERIFIED PASS. Do not turn on flags to manufacture completion. Explicit Compass recheck now executes through a version-bound server action; migration 3897 and client/database/rollback evidence are delivered. General model-authored schedule editing is not claimed.

**Recovery:** original lane briefs, progress, handbacks and proofs are under `/private/tmp/claude-501/-Users-areyouok/e549004b-da6f-4ba8-b5b4-1f48a2f1f7e9/scratchpad/`. Initial staged and unstaged changes were backed up in the continuation evidence directory. Do not reset the shared worktree or stage other lanes wholesale.

## Rows

### L1 — A dedicated Layover domain with one canonical operational truth
- **Original requirement:** A dedicated Layover domain with one canonical operational truth (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** One canonical truth is derived (certifySessionFeasibility) but never persisted; storage 2700+2992 (+3623, +3792 which widens 2700's verdict CHECK) unapplied, persistence flag absent.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3623,3792 + layover_decision_persistence_enabled
- **Census lines read:** 3916 (§13.1 grp c), 1357
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:67 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: the overview stores ONE canonical certified computation for what it told the traveller; stored row = published answer
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L4 — Unknown critical facts reduce confidence and may fail closed for landside recommendations
- **Original requirement:** Unknown critical facts reduce confidence and may fail closed for landside recommendations (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Confidence is computed; the fail-closed half for unknown baggage needs the declared constraint set (layover_constraints, 2992) behind 3640's gate; #624's fail-closed closures run only there.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2992,3640 + layover_constraints_enabled
- **Census lines read:** 3439, 8148 (§45.4), 1359
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) cl:87 · **Production dependency:** owner press: 2700→2992 + 3640 (201) → layover_constraints_enabled ON
- **Evidence:** lane B1-P handback §2: an unknown critical fact (undeclared airport change) closes landside, confidence INSUFFICIENT, one question; declaring lifts it
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L5 — Every consequential recommendation is versioned, explainable and replayable
- **Original requirement:** Every consequential recommendation is versioned, explainable and replayable (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Version, inputHash and replayFeasibility exist; nothing is stored to version or replay.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3623,3792 + layover_decision_persistence_enabled
- **Census lines read:** 3916, 1360
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:67, :137, :148 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: versioned (engine, feasibility version, input hash, per-session snapshot_version), explainable (explain), replayable (replay)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L6 — All surfaces consume the same certified LayoverSnapshot/RecommendationContract; no duplicate time-budget logic
- **Original requirement:** All surfaces consume the same certified LayoverSnapshot/RecommendationContract; no duplicate time-budget logic (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Duplicate time-budget logic is gone; "all surfaces consume the same certified snapshot" needs a stored snapshot (consumerLayoverRecord reads it only when persisted).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3623,3792 + layover_decision_persistence_enabled
- **Census lines read:** 3916, 1361
- **Batch:** B1-P pressed-state verification
- **Required correction:** All public Layover surfaces use the stored canonical snapshot; production Discovery/Gems admission helpers preserve the same safety boundary.
- **Migration:** existing canonical chain; no new migration for this proof · **Tests:** layoverSurfaceConsistency.db.test.ts: 6/6 migrated HTTP/helper cases; curation and matrix neighbors 15/15; old blocked-card filter mutant killed · **Production dependency:** owner migration/flag press; final aggregate and independent acceptance pending
- **Evidence:** Continuation logs surface-consistency-expanded.log, surface-consistency-final.log and surface-mutant.log. Overview/safety/map/Compass/recommendations/experiences share the stored identity across later requests; changed departure creates a new identity and stale calls refuse. Foreign session calls refuse. Mutant killed with shared source hashes unchanged.
- **Status:** BUILT (cross-surface migrated evidence delivered; independent verification and production activation pending)

### L11 — Trips owns flight segments / itinerary relationships / trip context; must not own layover safety calculations
- **Original requirement:** Trips owns flight segments / itinerary relationships / trip context; must not own layover safety calculations (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** No flight-segment model owned by Trips that a session references; Trips legs are never populated by a product surface (census-trips: no surface issues ADD_LEG); session link needs segment columns (L21).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** Trips segment model (other lane) + L21 migration
- **Census lines read:** 409
- **Batch:** B1-F flight data
- **Required correction:** Trips owns flight segments (3826 + kernel ADD/RECORD_FLIGHT_STATUS); traveller entry in local time; approved-feed port (none bound); updates recalc sessions + replan
- **Migration:** 3826, 3827, 3828 (+ rollbacks; 21/21 proofs; order-independent, 0/24,989 keys differ) · **Tests:** layoverFlightConnections (unit 25), layoverFlightConnectionsRoutes (4), db/layoverFlightConnections.db.test.ts (17, full chain), client 12; 31 mutants killed · **Production dependency:** press 3826 then 3827; 3828 after 2700/2992/3623; trip_flight_segments_enabled + layover_flight_connections_enabled ON
- **Evidence:** Original B1-F proof plus scratchpad/l165-flight-terminal-handback.txt: real owned linked flight terminals now enter every session loader and canonical hash. Initial/idempotent creation, foreign ownership, ignored forged fields, unreadable/null observations, FALSE/absent zero source reads and terminal-only recertification pass PGlite2/2 and PostgreSQL17 terminal+harness5/5. Scoped timing closes after a mismatch; prior immutable decision remains.
- **Status:** BUILT (owned Trips flight/terminal context and canonical invalidation tested; licensed automatic feed, final verification and owner press pending)

### L12 — Layover Session owns lifecycle, constraints, snapshots and state; must not own a generic city content catalog
- **Original requirement:** Layover Session owns lifecycle, constraints, snapshots and state; must not own a generic city content catalog (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Lifecycle (3632), constraints (2992+3640) and snapshots (2700/2992/3623) are all built in code and all on unapplied storage/FALSE flags.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3623,3792,3640,3632 + persistence, constraints, lifecycle flags
- **Census lines read:** 410
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) cl:101 (+snap:67) · **Production dependency:** owner press: P1 + P2 + P3
- **Evidence:** lane B1-P handback §2: the session owns lifecycle (3632), constraints (2992+3640) and snapshots (2700/2992/3623) at once
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L14 — Airport Intelligence owns airport operational facts + provenance + TTL; must not own user social identity
- **Original requirement:** Airport Intelligence owns airport operational facts + provenance + TTL; must not own user social identity (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** airport_profiles facts are bare values (no provenance, no TTL). §13.1's "gated on 2700/2860" is stale (2860 applied); the gap is provenance+TTL on the facts the engine reads. Proposed 3874; C on press only if the admin airport writer stamps provenance and the lead accepts a TTL policy for static facts.
- **Root cause / class:** Needs new schema (a migration), then the press (triage class BUILDABLE-WITH-MIGRATION→W)
- **Files / gating artifact (triage):** new 3874 (airport_profiles source/observed_at/expires_at), routes/airport.ts admin profile writer, AirportProfileService.ts
- **Census lines read:** 412
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L15 — Experience Compiler owns executable plans from feasible actions; must not own visa/entry legal truth
- **Original requirement:** Experience Compiler owns executable plans from feasible actions; must not own visa/entry legal truth (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Stated W reason ("nothing reads entry_requirements/traveler_passports") is false: services/airport/layoverEntryGate.ts reads lib/entryRequirements (passport_entry_intelligence_enabled TRUE). Re-derive + pin that plan/plan-fit code imports no entry truth.
- **Root cause / class:** Buildable by code alone (not built, see reasons) (triage class BUILDABLE-NOW)
- **Files / gating artifact (triage):** census re-derivation (lead), test/layoverEntryGate.test.ts or test/layoverPlanFitUnknownLegs.test.ts (add a boundary case)
- **Census lines read:** 413
- **Batch:** B3-ENGINE lifecycle/timing/engine refactor/phrases
- **Required correction:** Experience Compiler owns selected/executing/refused immutable versions, locks the owned session and current snapshot/revision/stops, and starts only the exact reviewed executable contract after local cache readback.
- **Migration:** 3898 layover_experience_plan_versions; FALSE layover_experience_execution_enabled and existing canonical/lifecycle prerequisites · **Tests:** 38 API and migrated lifecycle tests,14 outdoor cases,8 client transport/storage cases; strengthened3898/3899 both-order whole-catalog/all-row rollback proofs16/16 · **Production dependency:** owner migration/flag press; final aggregate and independent verification
- **Evidence:** scratchpad/l165-l15-handback.txt and l165-l78-handback.txt. No fabricated AIRPORT_EXITED checkpoint; changed ownership/revision/snapshot, failed storage and stale plans refuse. Post-start cache failure reports the completed server transition and retry honestly. Offline-bypass mutant killed. Empty ACL and full function-attribute drift now refuse rollback; exact repeat/reapply restored the catalog and all public/auth non-ledger rows.
- **Status:** BUILT (executable lifecycle, client path and hardened rollback tests delivered; final aggregate and production press pending)

### L17 — Map visualises the certified envelope / recommendations / routes; must not own independent feasibility logic
- **Original requirement:** Map visualises the certified envelope / recommendations / routes; must not own independent feasibility logic (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Map draws the certified envelope ring; per-pin feasibility needs layover_stable_recommendation_ids_enabled ON and routes need the owner's routing-provider purchase (Q-R2-1).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider + flag layover_stable_recommendation_ids_enabled
- **Census lines read:** 415
- **Batch:** B2-MAP map and client
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing 3971/3856/2745 routing + applicable 3785/3633/canonical chain · **Tests:** actual adapter fixtures and mounted components, no paid provider calls · **Production dependency:** GOOGLE_MAPS_API_KEY, Routes API enablement, bounded route settings/flags and signed-device verification
- **Evidence:** scratchpad/l165-b2-map-handback.txt: 79 API tests plus 3 real Google adapter fixture tests, 107 client tests, 130 dashboard tests and focused cache/refresh/native tests. Eleven client and four API mutants killed; redundant/masked survivors disclosed. The finite sampled polygon is not a certified continuous interior (L61 remains open).
- **Status:** BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending)

### L20 — Normalised operational tables + immutable/versioned snapshots; no single JSON blob as source of truth; JSON only for provenance/reason detail
- **Original requirement:** Normalised operational tables + immutable/versioned snapshots; no single JSON blob as source of truth; JSON only for provenance/reason detail (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Normalised tables done; immutable/versioned snapshot half is 2700/2992/3623 (immutability triggers written), unapplied.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3623,3792 + persistence flag
- **Census lines read:** 423
- **Batch:** B1-P pressed-state verification
- **Required correction:** Canonical persisted snapshot selection, guarded compare-and-swap publication, immutable decision history and recommendation supersession are connected; failed history refuses regeneration and stale candidates cannot overwrite a newer version.
- **Migration:** 3871 + 3873 + 3896 and existing 2700/2992/3623/3828 dependencies · **Tests:** 196 targeted tests; 8 canonical migrated tests; rollback catalog/row round trips, repeat/reapply and refusal cases; pressed-final 17/17 · **Production dependency:** owner migration/flag press
- **Evidence:** scratchpad/l165-b2-recsa-handback.txt. PGlite interleaving proved; real two-connection PostgreSQL contention branch awaits CI evidence. Full surface identifier matrix and independent mutants remain open.
- **Status:** BUILT (canonical snapshot and history batch; independent verification and production press pending)

### L21 — layover_sessions (id, user_id, trip_id, airport_place_id, arrival/departure_segment_id, state, connection_type, detected_source, started_at, expires_at, active_snapshot_id, confidence_band)
- **Original requirement:** layover_sessions (id, user_id, trip_id, airport_place_id, arrival/departure_segment_id, state, connection_type, detected_source, started_at, expires_at, active_snapshot_id, confidence_band) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** layover_sessions lacks arrival/departure_segment_id, connection_type, detected_source, expires_at, active_snapshot_id, confidence_band, state. Proposed 3870. Not C on press: segment ids and detection have no producer (L11/L267).
- **Root cause / class:** Needs new schema (a migration), then the press (triage class BUILDABLE-WITH-MIGRATION→W)
- **Files / gating artifact (triage):** new 3870 (layover_sessions spec columns), LayoverSessionService.ts
- **Census lines read:** 424, 9328 (§55.4)
- **Batch:** B1-F flight data
- **Required correction:** layover_sessions: segment links, state, connection_type, detected_source, expires_at (3827); active_snapshot_id + confidence_band (3828); server-only writes
- **Migration:** 3826, 3827, 3828 (+ rollbacks; 21/21 proofs; order-independent, 0/24,989 keys differ) · **Tests:** layoverFlightConnections (unit 25), layoverFlightConnectionsRoutes (4), db/layoverFlightConnections.db.test.ts (17, full chain), client 12; 31 mutants killed · **Production dependency:** press 3826 then 3827; 3828 after 2700/2992/3623; trip_flight_segments_enabled + layover_flight_connections_enabled ON
- **Evidence:** lane B1-F handback §1; census-layover section 'lane B1-F'
- **Status:** BUILT (lane B1-F; independent verification pending; W until the press)

### L26 — layover_recommendations (snapshot_id, candidate_type, status, plan_json, utility_score, risk_band, confidence, expires_at)
- **Original requirement:** layover_recommendations (snapshot_id, candidate_type, status, plan_json, utility_score, risk_band, confidence, expires_at) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** layover_recommendations lacks plan_json, utility_score, risk_band, confidence, expires_at and a spec status (snapshot_id is 3623). Proposed 3871. Not C on press alone: needs 3623+persistence and the L78 objective out of legacy mode.
- **Root cause / class:** Needs new schema (a migration), then the press (triage class BUILDABLE-WITH-MIGRATION→W)
- **Files / gating artifact (triage):** new 3871, LayoverRecommendationService.ts
- **Census lines read:** 429, 9328
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** Canonical persisted snapshot selection, guarded compare-and-swap publication, immutable decision history and recommendation supersession are connected; failed history refuses regeneration and stale candidates cannot overwrite a newer version.
- **Migration:** 3871 + 3873 + 3896 and existing 2700/2992/3623/3828 dependencies · **Tests:** 196 targeted tests; 8 canonical migrated tests; rollback catalog/row round trips, repeat/reapply and refusal cases; pressed-final 17/17 · **Production dependency:** owner migration/flag press
- **Evidence:** scratchpad/l165-b2-recsa-handback.txt. PGlite interleaving proved; real two-connection PostgreSQL contention branch awaits CI evidence. Full surface identifier matrix and independent mutants remain open.
- **Status:** BUILT (canonical snapshot and history batch; independent verification and production press pending)

### L31 — layover_events (occurred_at, source, source_event_id, payload_json, dedup_key, processed_at)
- **Original requirement:** layover_events (occurred_at, source, source_event_id, payload_json, dedup_key, processed_at) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** The six members exist on layover_external_events (2860, applied) with writer and reader; W on the ingest flag (2981 unapplied). Lead's TABLE rule: also needs a producer (feed secret) to populate it.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2981 + layover_event_ingest_enabled (+ producer secret)
- **Census lines read:** 434, 7632 (§40.4)
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ext:73 · **Production dependency:** owner press: P7
- **Evidence:** lane B1-P handback §2: the six members on layover_external_events, written by the producer route
- **Status:** BLOCKED-EXTERNAL (producer feed + LAYOVER_EVENT_PRODUCER_SECRET; technical work complete)

### L33 — LayoverState — 17 members from DETECTED to EXPIRED
- **Original requirement:** LayoverState — 17 members from DETECTED to EXPIRED (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** The 17-state graph exists (LayoverLifecycle.ts) and is published only under 3632's FALSE flag; the stored status is still a 5-value CHECK. Proposed 3870 adds a lifecycle_state column written by the projection; C after press of 3870 + 3632 flip.
- **Root cause / class:** Needs new schema (a migration), then the press (triage class BUILDABLE-WITH-MIGRATION→W)
- **Files / gating artifact (triage):** new 3870, LayoverLifecycle.ts writer, 3632 + layover_lifecycle_machine_enabled
- **Census lines read:** 3910, 9328
- **Batch:** B1-F flight data
- **Required correction:** 17-state TEXT+CHECK column, CAS graph writes, stored placement + flight updates
- **Migration:** 3826, 3827, 3828 (+ rollbacks; 21/21 proofs; order-independent, 0/24,989 keys differ) · **Tests:** layoverFlightConnections (unit 25), layoverFlightConnectionsRoutes (4), db/layoverFlightConnections.db.test.ts (17, full chain), client 12; 31 mutants killed · **Production dependency:** press 3826 then 3827; 3828 after 2700/2992/3623; trip_flight_segments_enabled + layover_flight_connections_enabled ON
- **Evidence:** lane B1-F handback §1; census-layover section 'lane B1-F'
- **Status:** BUILT (lane B1-F; independent verification pending; W until the press). ABANDONED has no writer (no §5 edge)

### L35 — BaggageMode = CHECKED_THROUGH | COLLECT_RECHECK | CARRY_ON_ONLY | UNKNOWN
- **Original requirement:** BaggageMode = CHECKED_THROUGH | COLLECT_RECHECK | CARRY_ON_ONLY | UNKNOWN (verbatim from the original specification).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** BaggageMode with UNKNOWN is layover_constraints.baggage_mode (2992), behind 3640's gate.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2992,3640 + layover_constraints_enabled
- **Census lines read:** 443, 12151 (§80)
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) cl:60 · **Production dependency:** owner press: same as L4
- **Evidence:** lane B1-P handback §2: BaggageMode incl. UNKNOWN is a stored, versioned member; the CHECK refuses others
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L36 — RiskBand = LOW | MODERATE | HIGH | UNSAFE
- **Original requirement:** RiskBand = LOW | MODERATE | HIGH | UNSAFE (verbatim from the original specification).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Census reason stale: RISK_BANDS/riskBandFor exist (services/layover/LayoverDecisionStore.ts:155,198) and persist to layover_return_plans.risk_band (2992); unapplied, persistence flag absent.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2992,3792 + layover_decision_persistence_enabled
- **Census lines read:** 444, 9328
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:67, :123 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: risk band persisted on layover_return_plans in the spec vocabulary (LOW/MODERATE/HIGH/UNSAFE); the CHECK refuses others
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L37 — ConfidenceBand = HIGH | MEDIUM | LOW | INSUFFICIENT
- **Original requirement:** ConfidenceBand = HIGH | MEDIUM | LOW | INSUFFICIENT (verbatim from the original specification).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** ConfidenceBand is computed, published, and consumed by the envelope's planning edge (§19.6); the missing half is a stored decision that turns on it (2700/2992 confidence columns).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3792 + persistence flag
- **Census lines read:** 1362, 4921 (§19.6)
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:67 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: the confidence band is a stored decision column equal to the published certification (3828, lane B1-F, also copies it to layover_sessions.confidence_band)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L38 — RecommendationStatus = ELIGIBLE | TIGHT | BLOCKED | STALE | EXPIRED
- **Original requirement:** RecommendationStatus = ELIGIBLE | TIGHT | BLOCKED | STALE | EXPIRED (verbatim from the original specification).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** layover_recommendations.status is a moderation vocabulary; no ELIGIBLE/TIGHT/BLOCKED/STALE/EXPIRED column anywhere. Proposed 3871 (with L26). STALE needs 3623+persistence; C after that press.
- **Root cause / class:** Needs new schema (a migration), then the press (triage class BUILDABLE-WITH-MIGRATION→W)
- **Files / gating artifact (triage):** new 3871, LayoverRecommendationService.ts
- **Census lines read:** 446, 9328
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** Canonical persisted snapshot selection, guarded compare-and-swap publication, immutable decision history and recommendation supersession are connected; failed history refuses regeneration and stale candidates cannot overwrite a newer version.
- **Migration:** 3871 + 3873 + 3896 and existing 2700/2992/3623/3828 dependencies · **Tests:** 196 targeted tests; 8 canonical migrated tests; rollback catalog/row round trips, repeat/reapply and refusal cases; pressed-final 17/17 · **Production dependency:** owner migration/flag press
- **Evidence:** scratchpad/l165-b2-recsa-handback.txt. PGlite interleaving proved; real two-connection PostgreSQL contention branch awaits CI evidence. Full surface identifier matrix and independent mutants remain open.
- **Status:** BUILT (canonical snapshot and history batch; independent verification and production press pending)

### L39 — The declared state graph (DETECTED → … → COMPLETED, plus DISRUPTED/CANCELLED/EXPIRED)
- **Original requirement:** The declared state graph (DETECTED → … → COMPLETED, plus DISRUPTED/CANCELLED/EXPIRED) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** 17-state graph built and shadowed. Code part (groundwork): produce DEPARTURE_CANCELLED from POST /:id/disruption kind=cancellation and BOARDING_STARTED from the traveller's "I made my flight" close. Blocked: 3632 flag FALSE, DEPARTURE_CONFIRMED needs a flight feed. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverLifecycle.ts, routes/airport.ts; 3632 + layover_lifecycle_machine_enabled
- **Census lines read:** 9738
- **Batch:** B3-ENGINE lifecycle/timing/engine refactor/phrases
- **Required correction:** Unlinked traveller cancellation produces DEPARTURE_CANCELLED; owner flight-close records BOARDING_STARTED with source=traveller before closure; foreign close is refused.
- **Migration:** existing 3632 and 3827 lifecycle/flight gates; no new schema · **Tests:** ENGINE lifecycle/replay/freedom and migrated tests 44/44, including two actual database cases; source regression first failed then passed · **Production dependency:** owner lifecycle press; licensed feed remains necessary for automatic observed flight status
- **Evidence:** scratchpad/l165-b3-engine-handback.txt; lifecycle-db-red.log and lifecycle-db-green.log. Traveller confirmation is never presented as provider-observed departure.
- **Status:** BUILT (traveller lifecycle gaps repaired with migrated proof; independent verification and production press pending; automatic observations require approved feed)

### L40 — EVALUATING → LANDSIDE_AVAILABLE: guard = entry allowed + no critical unknowns + usable ≥ floor + return contract satisfiable; side effects = create snapshot + safe envelope + candidate set
- **Original requirement:** EVALUATING → LANDSIDE_AVAILABLE: guard = entry allowed + no critical unknowns + usable ≥ floor + return contract satisfiable; side effects = create snapshot + safe envelope + candidate set (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Guard built and fail-closed; snapshot it requires persists only behind 2992's gate, evaluation published only under 3632's FALSE flag.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2992 + persistence flag, 3632 + layover_lifecycle_machine_enabled
- **Census lines read:** 9739
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) cl:101 · **Production dependency:** owner press: P1 (persistence) + 3640/constraints flag + 3632 (199)/layover_lifecycle_machine_enabled — all three flags proved necessary
- **Evidence:** lane B1-P handback §2: EVALUATING → LANDSIDE_AVAILABLE only when the guard holds; its intents CREATE_SNAPSHOT/SAFE_ENVELOPE/CANDIDATE_SET each verified real (stored snapshot, envelope, cards)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L41 — EXECUTING → RETURN_SOON: threshold reached or risk worsened; side effects = high-priority notification, de-emphasise discovery
- **Original requirement:** EXECUTING → RETURN_SOON: threshold reached or risk worsened; side effects = high-priority notification, de-emphasise discovery (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Android high-priority built; iOS high priority needs the owner's Apple Time Sensitive entitlement, signed-build/device verification (LAY-4a), then PUSH_IOS_TIME_SENSITIVE_ENTITLED=true.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** owner Apple action + env PUSH_IOS_TIME_SENSITIVE_ENTITLED
- **Census lines read:** 3102, 10195 (§66.4), 10463
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) roll:129 · **Production dependency:** owner press: 3771 (248) + PUSH_IOS_TIME_SENSITIVE_ENTITLED=true per environment + APPLE: Time Sensitive Notifications capability on the App ID, signed build + device verification (LAY-4a)
- **Evidence:** lane B1-P handback §2: server half: RETURN_SOON sends the actionable warning at FCM-high/APNs-10 on the layover_return channel, and time-sensitive ONLY to the device that reported the entitlement (an older build stays ordinary)
- **Status:** BLOCKED-EXTERNAL (Apple Time Sensitive capability, signed device build, PUSH_IOS_TIME_SENSITIVE_ENTITLED; technical work complete)

### L44 — * → DISRUPTED: material disruption; side effects = invalidate stale recommendations, replan, preserve audit trail
- **Original requirement:** * → DISRUPTED: material disruption; side effects = invalidate stale recommendations, replan, preserve audit trail (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Replan invalidation built (lane 5). Needs the snapshot press + 3623's flag, and your ruling that clearing a card's citation counts as "invalidate".
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverReplanService.ts/LayoverEventReplanner.ts; 3623 + layover_recommendation_snapshot_enabled
- **Census lines read:** 2283
- **Batch:** B1-P pressed-state verification
- **Required correction:** Canonical persisted snapshot selection, guarded compare-and-swap publication, immutable decision history and recommendation supersession are connected; failed history refuses regeneration and stale candidates cannot overwrite a newer version.
- **Migration:** 3871 + 3873 + 3896 and existing 2700/2992/3623/3828 dependencies · **Tests:** 196 targeted tests; 8 canonical migrated tests; rollback catalog/row round trips, repeat/reapply and refusal cases; pressed-final 17/17 · **Production dependency:** owner migration/flag press
- **Evidence:** scratchpad/l165-b2-recsa-handback.txt. PGlite interleaving proved; real two-connection PostgreSQL contention branch awaits CI evidence. Full surface identifier matrix and independent mutants remain open.
- **Status:** BUILT (canonical snapshot and history batch; independent verification and production press pending)

### L46 — The subtraction ladder: scheduled − deplane − immigration/customs − baggage − exit friction − outbound − return (future conditions, not symmetric) − security/re-entry − terminal transfer − boarding buffer − contingency = usable
- **Original requirement:** The subtraction ladder: scheduled − deplane − immigration/customs − baggage − exit friction − outbound − return (future conditions, not symmetric) − security/re-entry − terminal transfer − boarding buffer − contingency = usable (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Code part: split estimateExitDelay into deplane/immigration/baggage/exit terms (groundwork). Blocked: outbound/return transport terms need a routed provider. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverSafetyEngine.ts; routing provider
- **Census lines read:** 464, 11609 (§75.7)
- **Batch:** B3-ENGINE lifecycle/timing/engine refactor/phrases
- **Required correction:** Implement the complete eleven-term subtraction ladder using legitimate per-stage sources and conservative estimates, without inventing distributions or double charging.
- **Migration:** 3881 sourced airport timing projection with service-only publication guard; existing3874 curation and canonical chain · **Tests:** focused API75/75, terminal/source/replay10/10, migrated timing/objective/execution neighbors21/21 plus both complete rollback cases2/2, client4/4 and10 isolated mutants · **Production dependency:** genuine reviewed airport/place/mode samples, owner press and final integrated verification
- **Evidence:** scratchpad/l165-timing-evidence-handback.txt. Eleven named stages carry actual observations, nearest-rank percentiles, source references, confidence and TTL. Joint percentiles use paired complete journey samples excluding dwell, not sums of marginal percentiles. Missing/stale/inapplicable terminal evidence refuses; measured values only tighten existing conservative allowances. Reviewed31-scenario golden changes contain identity/version fields only. No real airport sample population was invented.
- **Status:** BUILT (sourced stage and joint-journey timing reaches routing and execution; reviewed real data, final verification and production press pending)

### L48 — if entry_permission_state != CONFIRMED_ALLOWED: forbid_landside_recommendations()
- **Original requirement:** if entry_permission_state != CONFIRMED_ALLOWED: forbid_landside_recommendations() (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Entry state read and published; forbidding landside on not-CONFIRMED_ALLOWED is the owner's layover_entry_forbid_landside_enabled (3640, unapplied).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** ruling + 3640 flip
- **Census lines read:** 8114, 9749
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L50 — risk_band == UNSAFE ⇒ recommendation.status = BLOCKED
- **Original requirement:** risk_band == UNSAFE ⇒ recommendation.status = BLOCKED (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** UNSAFE⇒BLOCKED needs owner decision L50-a (is BLOCKED "not rendered" or "rendered as refused").
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** ruling L50-a
- **Census lines read:** 4424, 1279
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** Retain public unsafe landside recommendations as BLOCKED/unavailable with their reason, while every add/compile path refuses them; moderation and restricted-content filters still apply.
- **Migration:** existing 3871 status and canonical chain · **Tests:** layoverSurfaceConsistency.db.test.ts: 6/6; adjacent 15/15; old drop-all-landside behavior reproduced then killed as a mutant · **Production dependency:** owner migration/flag press
- **Evidence:** The actual HTTP route serves blocked airside and landside cards, preserving identity and explanation. Unsafe cards cannot be added or compiled. Production discovery/gems helper admission remains closed. Local migrated tests and in-memory mutation are logged under surface-consistency-* and surface-mutant.log.
- **Status:** BUILT (visible unavailable cards and refusal paths tested on migrated schema; independent verification and press pending)

### L54 — Estimate { valueMinutes, p50/p75/p90, confidence, sourceClass, observedAt, expiresAt, fallbackLevel, sourceRefs[] }
- **Original requirement:** Estimate { valueMinutes, p50/p75/p90, confidence, sourceClass, observedAt, expiresAt, fallbackLevel, sourceRefs[] } (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Estimate carries every member; distributions are degenerate because the only live term (liveConditions) has no producer. Feeding crowd observations into liveConditionsFrom is recorded as an owner decision (routes/airport.ts:2702); otherwise a feed purchase.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 1901
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Carry genuine per-stage estimate values, distributions, confidence, provenance, observation/expiry and fallback levels throughout the journey.
- **Migration:** 3881 sourced airport timing projection with service-only publication guard; existing3874 curation and canonical chain · **Tests:** focused API75/75, terminal/source/replay10/10, migrated timing/objective/execution neighbors21/21 plus both complete rollback cases2/2, client4/4 and10 isolated mutants · **Production dependency:** genuine reviewed airport/place/mode samples, owner press and final integrated verification
- **Evidence:** scratchpad/l165-timing-evidence-handback.txt. Eleven named stages carry actual observations, nearest-rank percentiles, source references, confidence and TTL. Joint percentiles use paired complete journey samples excluding dwell, not sums of marginal percentiles. Missing/stale/inapplicable terminal evidence refuses; measured values only tighten existing conservative allowances. Reviewed31-scenario golden changes contain identity/version fields only. No real airport sample population was invented.
- **Status:** BUILT (sourced stage and joint-journey timing reaches routing and execution; reviewed real data, final verification and production press pending)

### L55 — Safety-critical calculations use a configurable conservative percentile by data maturity/consequence; do not collapse to a single average
- **Original requirement:** Safety-critical calculations use a configurable conservative percentile by data maturity/consequence; do not collapse to a single average (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Same as L54: percentile selection is a no-op while every distribution is flat.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 1901
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Apply configurable conservative percentiles to genuine stage distributions by maturity and consequence while preserving explicit absence.
- **Migration:** 3881 sourced airport timing projection with service-only publication guard; existing3874 curation and canonical chain · **Tests:** focused API75/75, terminal/source/replay10/10, migrated timing/objective/execution neighbors21/21 plus both complete rollback cases2/2, client4/4 and10 isolated mutants · **Production dependency:** genuine reviewed airport/place/mode samples, owner press and final integrated verification
- **Evidence:** scratchpad/l165-timing-evidence-handback.txt. Eleven named stages carry actual observations, nearest-rank percentiles, source references, confidence and TTL. Joint percentiles use paired complete journey samples excluding dwell, not sums of marginal percentiles. Missing/stale/inapplicable terminal evidence refuses; measured values only tighten existing conservative allowances. Reviewed31-scenario golden changes contain identity/version fields only. No real airport sample population was invented.
- **Status:** BUILT (sourced stage and joint-journey timing reaches routing and execution; reviewed real data, final verification and production press pending)

### L56 — A generalised engine answering "what can this user do before they must be somewhere else"
- **Original requirement:** A generalised engine answering "what can this user do before they must be somewhere else" (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Code part: pass a current-position origin (airport point) into the engine (groundwork). Blocked: "world conditions" have no producer (L81 ruling). Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverTemporalFreedom.ts; live-signal ruling
- **Census lines read:** 4419
- **Batch:** B3-ENGINE lifecycle/timing/engine refactor/phrases
- **Required correction:** Use a consented measured traveller origin for current-position route/context evaluation; preserve unknown positions and conservative world-condition timing.
- **Migration:** none (the measured origin is request-local and never persisted) · **Tests:** ENGINE31 and dropped-origin mutant (airport origin); current-position unit 5/5, migrated DB 3/3, client 5/5, 7 mutants killed, late-fix client mutant killed · **Production dependency:** native-device location verification; the world-condition live feed stays blocked under L81
- **Evidence:** Validated airport coordinate replaces always-null generic origin for planning. `POST /api/airport/sessions/:id/current-position-check` takes one explicit foreground fix (≤2 min old, ≤1,000 m accuracy), binds it to owner/session/snapshot/request in a request-local WeakMap, routes current-origin outbound, current return and future return with no-store provider calls, and evaluates the Temporal Freedom Engine from that origin. It only preserves or tightens canonical constraints, risk, reasons and activity commitments; stored confidence outside HIGH/MEDIUM/LOW is the weakest grade and refuses. Raw GPS, geometry and coordinate-derived identity are never persisted. This is a temporary preview: saved experiences still start at the airport.
- **Status:** BUILT (traveller current-position preview delivered; native-device evidence and the L81 world-condition feed remain external)

### L58 — FreedomWindow { beginsAt, endsAt, origin, requiredDestination, usableMinutes, hardConstraints, softConstraints, riskBudget, uncertaintyBudget, confidence }
- **Original requirement:** FreedomWindow { beginsAt, endsAt, origin, requiredDestination, usableMinutes, hardConstraints, softConstraints, riskBudget, uncertaintyBudget, confidence } (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** 7 of 10 members reach the layover. uncertaintyBudget can be carried from ENVELOPE_UNCERTAINTY_BUDGET (LayoverEnvelope.ts:132, added after §18.8) - code. riskBudget and softConstraints have no definition: ruling. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverTemporalFreedom.ts, engine; ruling on riskBudget/softConstraints
- **Census lines read:** 491, 4529 (§18.8)
- **Batch:** B3-ENGINE lifecycle/timing/engine refactor/phrases
- **Required correction:** Project usableMinutes, soft preferences, zero permitted lateness, no unsafe actions and named uncertainty reserve into FreedomWindow; policy only narrows an already computed window.
- **Migration:** no new schema; feasibility shape 2026.10.19-1 names policy replay input · **Tests:** ENGINE31 timing/policy/incremental; lifecycle/replay44; ignored-uncertainty mutant killed; reviewed golden31 has only inputHash/snapshotId changes · **Production dependency:** owner existing canonical/lifecycle press and independent verification
- **Evidence:** scratchpad/l165-b3-engine-handback.txt. Two independent golden runs identical; no verdict, deadline or rule changes. Old input shape explicitly refuses RECORD_SHAPE_CHANGED.
- **Status:** BUILT (complete policy projection and replay evidence delivered; independent verification and press pending)

### L60 — Bidirectional reachability: airport→candidate and candidate→airport under future return-time conditions
- **Original requirement:** Bidirectional reachability: airport→candidate and candidate→airport under future return-time conditions (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Bidirectional corridor wired; production legs are unmeasured: owner purchase decision on Google Routes (LAYOVER_ROUTED_CORRIDOR_ENABLED, Q-R2-1 owner-held) + layover_discovery_mode_enabled FALSE.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider + flag
- **Census lines read:** 7443, 7483 (§39)
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3856_layover_routes_session_budget.sql (+3971, 2745 in the press) · **Tests:** layoverRoutedFeasibility / layoverRoutedRecommendationsRoute / layoverRoutedUniverse / layoverRoutedProviderContract / layoverRoutesSessionBudget (90 cases, 44 mutants) · **Production dependency:** Routes API enabled; LAYOVER_ROUTED_CORRIDOR_ENABLED + ROUTES_API_DAILY_*; 3971, 3856, 2745; layover_routed_corridor_enabled ON
- **Evidence:** lane B1-R1 handback §2; census-layover section "lanes B1-R1 and B1-P"
- **Status:** BUILT (lane B1-R1; independent verification pending; W until the Routes press)

### L61 — Time-based isochrone/envelope geometry, not a fixed radius
- **Original requirement:** Time-based isochrone/envelope geometry, not a fixed radius (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** A disc, outer bound only; an isochrone needs routed travel times.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 4425
- **Batch:** B1-R1 routing (server)
- **Required correction:** Generate continuous time-budget WALK coverage from actual outward/return network polygons, preserving holes/islands and canonical allocation; disclose unsupported future DRIVE.
- **Migration:** Existing routed capability; separate Isochrones API enablement, key and spend gates · **Tests:** 102 focused API plus12 follow-on; real-adapter10+2 request allocation;9 isolated map mutants · **Production dependency:** owner activation and original row-specific external evidence
- **Evidence:** l165-map-geometry-handback.txt. Official Google Isochrones FROM/TO contours intersected under one journey budget, no sampled hull; WALK implemented. Google preview eligibility/key/native build remain external; future DRIVE unsupported by provider contract.
- **Status:** IN PROGRESS (continuous WALK implementation tested; future DRIVE coverage unsupported and external provider validation pending)

### L63 — Envelope edges contract as confidence drops or return risk rises
- **Original requirement:** Envelope edges contract as confidence drops or return risk rises (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Risk half done; the planning edge contracts on confidence but the proved (blocking) edge cannot by design. Either rule the planning edge satisfies "envelope edges", or a routed provider.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** ruling or routing provider
- **Census lines read:** 4426, 4917 (§19.6)
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3856_layover_routes_session_budget.sql (+3971, 2745 in the press) · **Tests:** layoverRoutedFeasibility / layoverRoutedRecommendationsRoute / layoverRoutedUniverse / layoverRoutedProviderContract / layoverRoutesSessionBudget (90 cases, 44 mutants) · **Production dependency:** Routes API enabled; LAYOVER_ROUTED_CORRIDOR_ENABLED + ROUTES_API_DAILY_*; 3971, 3856, 2745; layover_routed_corridor_enabled ON
- **Evidence:** lane B1-R1 handback §2; census-layover section "lanes B1-R1 and B1-P"
- **Status:** BUILT (lane B1-R1; independent verification pending; W until the Routes press)

### L65 — candidate_feasible iff outbound_arrival + minimum_experience_duration + conservative_return_duration <= hard_return_by
- **Original requirement:** candidate_feasible iff outbound_arrival + minimum_experience_duration + conservative_return_duration <= hard_return_by (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** The travel term is an honest absence; a routed provider moves it.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 3438
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3856_layover_routes_session_budget.sql (+3971, 2745 in the press) · **Tests:** layoverRoutedFeasibility / layoverRoutedRecommendationsRoute / layoverRoutedUniverse / layoverRoutedProviderContract / layoverRoutesSessionBudget (90 cases, 44 mutants) · **Production dependency:** Routes API enabled; LAYOVER_ROUTED_CORRIDOR_ENABLED + ROUTES_API_DAILY_*; 3971, 3856, 2745; layover_routed_corridor_enabled ON; plus a minimum-experience (dwell) source
- **Evidence:** lane B1-R1 handback §2; census-layover section "lanes B1-R1 and B1-P"
- **Status:** BUILT (lane B1-R1; independent verification pending; W until the Routes press)

### L66 — SafeEnvelope = union(points satisfying the feasibility constraint)
- **Original requirement:** SafeEnvelope = union(points satisfying the feasibility constraint) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** SafeEnvelope is a superset, certifiedInward:false; the union needs routed geometry.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 4427
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3856_layover_routes_session_budget.sql (+3971, 2745 in the press) · **Tests:** layoverRoutedFeasibility / layoverRoutedRecommendationsRoute / layoverRoutedUniverse / layoverRoutedProviderContract / layoverRoutesSessionBudget (90 cases, 44 mutants) · **Production dependency:** Routes API enabled; LAYOVER_ROUTED_CORRIDOR_ENABLED + ROUTES_API_DAILY_*; 3971, 3856, 2745; layover_routed_corridor_enabled ON
- **Evidence:** lane B1-R1 handback §2; census-layover section "lanes B1-R1 and B1-P"
- **Status:** BUILT (lane B1-R1; independent verification pending; W until the Routes press)

### L67 — Map bands SAFE / TIGHT / BLOCKED
- **Original requirement:** Map bands SAFE / TIGHT / BLOCKED (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Server bands built; published only under 3633's FALSE flag, and SAFE rests on stated (not routed) minutes.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider + 3633 + layover_map_bands_enabled
- **Census lines read:** 9787
- **Batch:** B2-MAP map and client
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing 3971/3856/2745 routing + applicable 3785/3633/canonical chain · **Tests:** actual adapter fixtures and mounted components, no paid provider calls · **Production dependency:** GOOGLE_MAPS_API_KEY, Routes API enablement, bounded route settings/flags and signed-device verification
- **Evidence:** scratchpad/l165-b2-map-handback.txt: 79 API tests plus 3 real Google adapter fixture tests, 107 client tests, 130 dashboard tests and focused cache/refresh/native tests. Eleven client and four API mutants killed; redundant/masked survivors disclosed. The finite sampled polygon is not a certified continuous interior (L61 remains open).
- **Status:** BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending)

### L68 — Multiple independent return routes → increase robustness / candidate preference
- **Original requirement:** Multiple independent return routes → increase robustness / candidate preference (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** independentRouteCount reaches the verdict; no provider, probe or rollout enabled.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7444, 7483
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3856_layover_routes_session_budget.sql (+3971, 2745 in the press) · **Tests:** layoverRoutedFeasibility / layoverRoutedRecommendationsRoute / layoverRoutedUniverse / layoverRoutedProviderContract / layoverRoutesSessionBudget (90 cases, 44 mutants) · **Production dependency:** Routes API enabled; LAYOVER_ROUTED_CORRIDOR_ENABLED + ROUTES_API_DAILY_*; 3971, 3856, 2745; layover_routed_corridor_enabled ON
- **Evidence:** lane B1-R1 handback §2; census-layover section "lanes B1-R1 and B1-P"
- **Status:** BUILT (lane B1-R1; independent verification pending; W until the Routes press)

### L69 — Single fragile corridor → increase risk penalty
- **Original requirement:** Single fragile corridor → increase risk penalty (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Same wiring as L68.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7445, 7483
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3856_layover_routes_session_budget.sql (+3971, 2745 in the press) · **Tests:** layoverRoutedFeasibility / layoverRoutedRecommendationsRoute / layoverRoutedUniverse / layoverRoutedProviderContract / layoverRoutesSessionBudget (90 cases, 44 mutants) · **Production dependency:** Routes API enabled; LAYOVER_ROUTED_CORRIDOR_ENABLED + ROUTES_API_DAILY_*; 3971, 3856, 2745; layover_routed_corridor_enabled ON
- **Evidence:** lane B1-R1 handback §2; census-layover section "lanes B1-R1 and B1-P"
- **Status:** BUILT (lane B1-R1; independent verification pending; W until the Routes press)

### L70 — Non-interruptible transport/activity → increase risk penalty
- **Original requirement:** Non-interruptible transport/activity → increase risk penalty (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** routeInterruptibility reaches the verdict; no provider enabled.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7446, 10721
- **Batch:** B1-R1 routing (server)
- **Required correction:** Increase risk for sourced non-interruptible transport and activity; implement the missing per-place activity source without guessing from categories.
- **Migration:** 3907 extends3899 with activity_commitment and FALSE layover_activity_commitment_enabled; predecessor rollback restores exact kind CHECK · **Tests:** timing/objective/execution21/21, both migration rollback cases2/2, focused75/75, client4/4 and activity safety mutants · **Production dependency:** verified per-place activity evidence and owner press
- **Evidence:** scratchpad/l165-timing-evidence-handback.txt. Sourced interruptibility, minimum commitment and exit delay now affect candidate dwell, risk and the executable plan. Compilation reads sources again so retraction cannot survive in stored cards. Unknown/stale/conflicting/unreadable ON evidence refuses; OFF preserves prior behavior. No category or transport value substitutes for activity facts.
- **Status:** BUILT (transport and sourced activity commitment integrated and locally tested; source population, final verification and production press pending)

### L71 — Transfer count → increase plan complexity/uncertainty
- **Original requirement:** Transfer count → increase plan complexity/uncertainty (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** transferCountOf reaches the verdict; no provider enabled.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7447, 7483
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** Existing 3971/3856/2745 routing + applicable 3785/3633/canonical chain · **Tests:** actual adapter fixtures and mounted components, no paid provider calls · **Production dependency:** GOOGLE_MAPS_API_KEY, Routes API enablement, bounded route settings/flags and signed-device verification
- **Evidence:** scratchpad/l165-b2-map-handback.txt: 79 API tests plus 3 real Google adapter fixture tests, 107 client tests, 130 dashboard tests and focused cache/refresh/native tests. Eleven client and four API mutants killed; redundant/masked survivors disclosed. The finite sampled polygon is not a certified continuous interior (L61 remains open).
- **Status:** BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending)

### L73 — Offline risk → require cached route + deadline before departure where possible
- **Original requirement:** Offline risk → require cached route + deadline before departure where possible (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Deadline and plan/area cached before leaving. Code part: REQUIRE the cache before a landside departure (groundwork). Route half needs a routed provider. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** app/layover/[id].tsx, layoverPlanCache.ts; routing provider
- **Census lines read:** 8647
- **Batch:** B3-ENGINE lifecycle/timing/engine refactor/phrases
- **Required correction:** Cache and read back the exact reviewed ordered experience/return contract before Start; complete permitted offline route geometry without retaining provider-restricted data.
- **Migration:** 3898 executable lifecycle and existing cached bundle · **Tests:** ENGINE client20 plus L15 client8; write/readback/expiry mutants killed; account-boundary10 · **Production dependency:** permitted offline route geometry and device validation
- **Evidence:** Missing/stale/contradictory forecast, failed write or mismatched readback refuses Start. Saved bundle contains ordered hops, deadline, abort thresholds and expiry. Street navigation geometry remains absent; cached display states its limits. Already-left checkpoint remains reportable.
- **Status:** IN PROGRESS (offline contract readiness implemented; full offline navigation requirement remains open)

### L74 — The planner generates executable experiences, not place cards; a recommendation is a contract carrying time, return, risk and failure information
- **Original requirement:** The planner generates executable experiences, not place cards; a recommendation is a contract carrying time, return, risk and failure information (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Recommendations are typed cards, not contracts. Code part: put fallbackPlan/abortThreshold/failureModes/confidence/reasonCodes on the card (groundwork). departBy/leaveActivityBy/expectedAirportReturn need routed legs. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverRecommendationService.ts, LayoverPrivacyGuard.ts; routing provider
- **Census lines read:** 522, 12146 (§80)
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing canonical/routing chain; no new RECS-B migration · **Tests:** full migrated schema and actual owner HTTP endpoints · **Production dependency:** canonical/routing flags, approved provider and mature airport evidence
- **Evidence:** scratchpad/l165-b2-recsb-handback.txt: 195 adjacent tests; final executable and real-schema API tests 17/17. Actual future arbitrary-origin hops, canonical ownership, in-flight block refusal and second GET at +100ms are exercised. No real provider or production activation claim.
- **Status:** BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending)

### L76 — LayoverRecommendationContract { snapshotId, departBy, estimatedArrival, minExperienceMinutes, idealExperienceMinutes, leaveActivityBy, expectedAirportReturn, hardReturnBy, returnBufferMinutes, riskBand, confidence, fallbackPlan, abortThreshold, failureModes[], reasonCodes[] }
- **Original requirement:** LayoverRecommendationContract { snapshotId, departBy, estimatedArrival, minExperienceMinutes, idealExperienceMinutes, leaveActivityBy, expectedAirportReturn, hardReturnBy, returnBufferMinutes, riskBand, confidence, fallbackPlan, abortThreshold, failureModes[], reasonCodes[] } (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Same contract: 7 members absent; 5 computable from the certified record now, the travel-derived ones need routing, snapshotId needs 3623. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverPrivacyGuard.ts (SafeRecommendation), LayoverRecommendationService.ts; routing + 3623
- **Census lines read:** 524, 10937 (§72.5)
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing canonical/routing chain; no new RECS-B migration · **Tests:** full migrated schema and actual owner HTTP endpoints · **Production dependency:** canonical/routing flags, approved provider and mature airport evidence
- **Evidence:** scratchpad/l165-b2-recsb-handback.txt: 195 adjacent tests; final executable and real-schema API tests 17/17. Actual future arbitrary-origin hops, canonical ownership, in-flight block refusal and second GET at +100ms are exercised. No real provider or production activation claim.
- **Status:** BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending)

### L77 — HARD GATE: eligibility + entry + time + safety, before any optimisation
- **Original requirement:** HARD GATE: eligibility + entry + time + safety, before any optimisation (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Hard gate is eligibility+time+safety; the entry term is the owner's layover_entry_forbid_landside_enabled.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** ruling + 3640 flip
- **Census lines read:** 2670
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L78 — Optimise preference_fit + local_uniqueness + opportunity_scarcity + social_value + experience_density + memory_value − monetary_cost − energy_cost − uncertainty − stress − return_risk
- **Original requirement:** Optimise preference_fit + local_uniqueness + opportunity_scarcity + social_value + experience_density + memory_value − monetary_cost − energy_cost − uncertainty − stress − return_risk (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** §9.1 objective built, seeded legacy (3784 unapplied); 7 of 11 terms UNKNOWN by construction, 2 by OQ-6; scales are OQ-L78-1.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** OQ-6, OQ-L78-1 + 3784 + layover_ranking_mode
- **Census lines read:** 12030
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** All eleven objective terms have real input paths; authorized source facts and explicit private traveller preferences supply the five formerly hard-UNKNOWN terms. No unsourced price, presence, private memories, sponsorship or revenue enters ranking.
- **Migration:** 3899; FALSE layover_objective_evidence_enabled · **Tests:** 55/55 server,5/5 client,16/16 final experience/objective rollback proofs; curator-erasure15 unit+2 migrated cases · **Production dependency:** owner activation and original row-specific external evidence
- **Evidence:** l165-l78-handback.txt. Actual admin/owner writers feed the real migrated generator; incomplete, expired, conflicting or mismatched cost evidence remains UNKNOWN. Source erasure nulls only the departing curator before profile tombstoning, with permission errors retryable.
- **Status:** BUILT (sourced producers, UI, migrated ranking and rollback evidence; independent acceptance and production activation pending)

### L79 — Static topology — terminal, gate, checkpoint, walking link; weeks/months, invalidated on authoritative change
- **Original requirement:** Static topology — terminal, gate, checkpoint, walking link; weeks/months, invalidated on authoritative change (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Topology types + TTL exist. Code part: invalidate on authoritative change (admin edit) - groundwork. Blocked: terminal_info null on all 3,206 production airports (data curation). Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverAirportTruth.ts, AirportProfileService.ts; airport data source
- **Census lines read:** 1898
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Publish evidence-backed airport curation only after actual source review; do not fabricate transit, terminal, visa or overnight facts to fill the launch packet.
- **Migration:** 3874 + 3880 where applicable · **Tests:** validation, publication, expiry and rollback workflow exercised on the migrated schema · **Production dependency:** reviewed source facts and authorized publication for launch airports
- **Evidence:** scratchpad/l165-b2-curate-handback.txt and docs/ops/airport-curation/. FLL/DAD packets remain empty or unreachable; HND/NRT facts remain incomplete. Workflow is built; human review is not claimed.
- **Status:** BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented)

### L80 — Operational semi-live — security layout, lounge hours, transport schedules; hours/days
- **Original requirement:** Operational semi-live — security layout, lounge hours, transport schedules; hours/days (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** No producer of security layout / lounge hours / transport schedules (operator data source).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** data-source decision
- **Census lines read:** 1831
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Publish evidence-backed airport curation only after actual source review; do not fabricate transit, terminal, visa or overnight facts to fill the launch packet.
- **Migration:** 3874 + 3880 where applicable · **Tests:** validation, publication, expiry and rollback workflow exercised on the migrated schema · **Production dependency:** reviewed source facts and authorized publication for launch airports
- **Evidence:** scratchpad/l165-b2-curate-handback.txt and docs/ops/airport-curation/. FLL/DAD packets remain empty or unreachable; HND/NRT facts remain incomplete. Workflow is built; human review is not claimed.
- **Status:** BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented)

### L81 — Fast live — security wait, immigration wait, taxi queue, disruption; minutes
- **Original requirement:** Fast live — security wait, immigration wait, taxi queue, disruption; minutes (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Fast-live facts reach the buffer via liveConditionsFrom, but nothing produces them; crowd->liveConditions is an owner decision, otherwise a feed.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 1832
- **Batch:** B2-LIVE live intelligence
- **Required correction:** _to be filled by the lane_
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** _none yet_
- **Status:** BLOCKED-EXTERNAL (licensed official/operator live feed endpoint and credentials; crowd evidence alone does not satisfy the whole fast-live requirement)

### L82 — Traveler observation — checkpoint timing, queue report, closure; confidence-weighted
- **Original requirement:** Traveler observation — checkpoint timing, queue report, closure; confidence-weighted (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Traveller observation channel exists (POST/GET /:id/observations; 2982/2983 applied); both routes sit behind layover_crowd_reports_enabled (3513 unapplied). "No submission surface" is stale.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 3513 + layover_crowd_reports_enabled (§53.2 also names 2981)
- **Census lines read:** 1833, 8961 (§53.2), 12155
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:84, :105 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: a traveller's report is screened and stored, confidence-weighted (community 0.3 → LOW; one observer below the floor → no truth)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L83 — Historical model — time-of-day distributions, recalibrated
- **Original requirement:** Historical model — time-of-day distributions, recalibrated (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Bands built; "recalibrated" not built. Code part: recalibration from measured error (groundwork). Blocked: no observations (3513) and no outcomes (2992). Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverAirportTruth.ts; 3513, 2992
- **Census lines read:** 1834
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L84 — TruthValue<T> { value, confidence, conflict, sourceClass, sourceRefs[], observedAt, expiresAt, fallbackLevel }
- **Original requirement:** TruthValue<T> { value, confidence, conflict, sourceClass, sourceRefs[], observedAt, expiresAt, fallbackLevel } (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** False green taken down: reachable only through the crowd-reports channel, closed until 3513 is applied.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:105 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: TruthValue carries value, confidence, conflict, sourceClass, sourceRefs[], observedAt, expiresAt, fallbackLevel (all eight asserted)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L85 — Never silently merge contradictory gate/terminal/queue facts
- **Original requirement:** Never silently merge contradictory gate/terminal/queue facts (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** As L84: inside `reconcile`, reachable only through the crowd-reports channel (3513).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:125 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: a 15 vs 55 contradiction is flagged (conflict, conflictBetween), never averaged (value 55 not 35), both sources kept
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L86 — Preserve source provenance and a conflict flag
- **Original requirement:** Preserve source provenance and a conflict flag (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** As L84 (3513).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:105, :125 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: sourceRefs of every accepted reading + the conflict flag on the wire
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L87 — For safety calculations, prefer conservative values when credible sources disagree
- **Original requirement:** For safety calculations, prefer conservative values when credible sources disagree (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** As L84 (3513).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:105, :125 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: the conservative (largest) delay wins when credible sources disagree
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L88 — Community observations require plausibility checks, corroboration and decay
- **Original requirement:** Community observations require plausibility checks, corroboration and decay (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** As L84 (3513).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:84, :105, :155, :175 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: plausibility (900/-5 rejected), corroboration (1 observer → no truth, 2 → truth), decay (official 30 min old → LOW; past TTL → absent)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L89 — Official data is not automatically truth when fresh contradictory evidence exists; contradiction increases uncertainty
- **Original requirement:** Official data is not automatically truth when fresh contradictory evidence exists; contradiction increases uncertainty (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** As L84 (3513).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:139, :125 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: an official 10 is not truth against fresh corroborated 45s: 45 chosen, confidence HIGH → MEDIUM
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L92 — Normalise and deduplicate the external/internal event
- **Original requirement:** Normalise and deduplicate the external/internal event (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Code wired in round 2 (validate + dedupe on the external path). Needs 2981, the ingest flag on, and the producer secret.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** External-event fan-out no longer puts an IATA code into a uuid airport_id list (22P02 on the real schema).
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ext:89, :127 · **Production dependency:** owner press: P7
- **Evidence:** lane B1-P handback §2: normalise + dedupe (source key; content key, "Z" = "+00:00"); first occurrence wins at the drain
- **Status:** BUILT (pressed-path defect fixed by B1-P; independent verification pending; awaits the press)

### L93 — Identify impacted active sessions
- **Original requirement:** Identify impacted active sessions (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Census reason stale: LayoverExternalReplanPort.ts fans out impacted sessions by airport (2986 indexes); the path is reachable only with 2981's flag ON and 2986 applied, and a producer.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2981 + layover_event_ingest_enabled, 2986
- **Census lines read:** 2284
- **Batch:** B1-P pressed-state verification
- **Required correction:** External-event fan-out no longer puts an IATA code into a uuid airport_id list (22P02 on the real schema).
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ext:127 · **Production dependency:** owner press: P7
- **Evidence:** lane B1-P handback §2: impacted ACTIVE sessions at the event's airport identified and replanned, others untouched
- **Status:** BUILT (pressed-path defect fixed by B1-P; independent verification pending; awaits the press)

### L94 — Recompute only the affected constraint nodes
- **Original requirement:** Recompute only the affected constraint nodes (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Node map and skip are real; recompute re-certifies the whole record (one atomic derivation). Decompose certification into node-level recomputation. One row for a large refactor of the safety derivation; not laned.
- **Root cause / class:** Buildable by code alone (not built, see reasons) (triage class BUILDABLE-NOW)
- **Files / gating artifact (triage):** LayoverEventReplanner.ts, LayoverFeasibility.ts, LayoverSafetyEngine.ts
- **Census lines read:** 2285
- **Batch:** B3-ENGINE lifecycle/timing/engine refactor/phrases
- **Required correction:** Reuse unchanged private dependency nodes and recompute only affected constraint derivations; persisted/copied/publicly mutated records cannot supply private cached values.
- **Migration:** no schema; named feasibility shape version updated · **Tests:** 90 incremental/event/live/monotonicity;31 timing; seven API mutants including ignored keys, disabled reuse and public-cache poison killed · **Production dependency:** independent acceptance and owner existing rollout press
- **Evidence:** Request-local DAG retains actual buffer/deadline/exit/envelope/assessment/entry/estimate values with full structural dependency keys. Queue/schedule/baggage/entry/clock incremental outputs equal complete recertification; trace discloses node names only.
- **Status:** BUILT (incremental derivation and poison resistance tested; independent verification and press pending)

### L97 — Invalidate recommendations whose snapshot is stale or no longer feasible
- **Original requirement:** Invalidate recommendations whose snapshot is stale or no longer feasible (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Staleness and feasibility tests exist; nothing applies them. Code part: apply noLongerFeasible (groundwork). Stale half needs snapshot_id (3623) and layover_stable_recommendation_ids_enabled. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverRecommendationService.ts; 3623 + flags
- **Census lines read:** 2286
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** Canonical persisted snapshot selection, guarded compare-and-swap publication, immutable decision history and recommendation supersession are connected; failed history refuses regeneration and stale candidates cannot overwrite a newer version.
- **Migration:** 3871 + 3873 + 3896 and existing 2700/2992/3623/3828 dependencies · **Tests:** 196 targeted tests; 8 canonical migrated tests; rollback catalog/row round trips, repeat/reapply and refusal cases; pressed-final 17/17 · **Production dependency:** owner migration/flag press
- **Evidence:** scratchpad/l165-b2-recsa-handback.txt. PGlite interleaving proved; real two-connection PostgreSQL contention branch awaits CI evidence. Full surface identifier matrix and independent mutants remain open.
- **Status:** BUILT (canonical snapshot and history batch; independent verification and production press pending)

### L100 — Compass is an orchestrator and explainer: asks the minimum useful clarifying question, compares certified plans, personalises wording, invokes deterministic tools
- **Original requirement:** Compass is an orchestrator and explainer: asks the minimum useful clarifying question, compares certified plans, personalises wording, invokes deterministic tools (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Compass orchestration removed from the layover door by lead ruling L-CL02d (certified-only by construction).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9665
- **Batch:** B1-C assistant
- **Required correction:** Model orchestrates the twelve §12 tools on POST /airport/sessions/:id/compass (LayoverCompassAssistant.ts answerLayoverQuestionWithAssistant), compares plans from the certified record, asks §12.1's clarifying question (now plan-aware), explains; CL-02 held by four fail-closed layers.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L102 — Tool getLayoverContext(sessionId)
- **Original requirement:** Tool getLayoverContext(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed from the layover door by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9666
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L103 — getConnectionState(sessionId)
- **Original requirement:** getConnectionState(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9667
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L104 — getTimeWallet(sessionId)
- **Original requirement:** getTimeWallet(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9668
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L105 — getSafeEnvelope(sessionId)
- **Original requirement:** getSafeEnvelope(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9669
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L106 — getReachableExperiences(sessionId) (≡ §18 getCandidates… counted here as the tool; the service method is L182)
- **Original requirement:** getReachableExperiences(sessionId) (≡ §18 getCandidates… counted here as the tool; the service method is L182) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9670
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L107 — simulatePlan(sessionId, candidateSet)
- **Original requirement:** simulatePlan(sessionId, candidateSet) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9671
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L108 — getReturnContract(sessionId)
- **Original requirement:** getReturnContract(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9672
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L109 — getAirportState(sessionId)
- **Original requirement:** getAirportState(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9673
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L110 — getCrewCandidates(sessionId)
- **Original requirement:** getCrewCandidates(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9674
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L111 — requestConstraintClarification(sessionId, field)
- **Original requirement:** requestConstraintClarification(sessionId, field) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9675
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L112 — replan(sessionId, trigger)
- **Original requirement:** replan(sessionId, trigger) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** replan no longer exists on the layover door (L-CL02d); last row line (3917) still says "one flag decision".
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 3917, 9679 (§56.3)
- **Batch:** B1-C assistant
- **Required correction:** Explicit UI action rechecks the saved current facts through canonical evaluation, supersession and regeneration. Owner, snapshot, session revision, expiry and atomic claim prevent stale or duplicate execution; immutable durable outcomes distinguish partial failure from success.
- **Migration:** 3897 FALSE rollout + rollback · **Tests:** 12 migrated action/rollback tests and 11 client tests; API types at 860/113 baseline · **Production dependency:** canonical/assistant/action rollout
- **Evidence:** scratchpad/l165-l112-handback.txt; this is an executed recheck with the saved details, not a model-authored schedule edit. No preview-only completion claim.
- **Status:** BUILT (explicit authorized recheck execution, database and client evidence; independent acceptance and production press pending)

### L113 — explainDecision(snapshotId | recommendationId)
- **Original requirement:** explainDecision(snapshotId | recommendationId) (verbatim from the original specification).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tool removed by L-CL02d.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 9676
- **Batch:** B1-C assistant
- **Required correction:** Tool rebuilt in LayoverCompassAssistant.ts; reads only the certified record or owner-scoped route reads, scrubbed of coordinates and identities.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L115 — Map consumes the active snapshot and envelope geometry; does not recalculate feasibility
- **Original requirement:** Map consumes the active snapshot and envelope geometry; does not recalculate feasibility (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Map consumes the return posture; no envelope geometry (needs routing) and no active snapshot (2700).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider + 2700 press
- **Census lines read:** 3099, 11815
- **Batch:** B2-MAP map and client
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing 3971/3856/2745 routing + applicable 3785/3633/canonical chain · **Tests:** actual adapter fixtures and mounted components, no paid provider calls · **Production dependency:** GOOGLE_MAPS_API_KEY, Routes API enablement, bounded route settings/flags and signed-device verification
- **Evidence:** scratchpad/l165-b2-map-handback.txt: 79 API tests plus 3 real Google adapter fixture tests, 107 client tests, 130 dashboard tests and focused cache/refresh/native tests. Eleven client and four API mutants killed; redundant/masked survivors disclosed. The finite sampled polygon is not a certified continuous interior (L61 remains open).
- **Status:** BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending)

### L116 — Show safe/tight/blocked geography from certified envelope versions
- **Original requirement:** Show safe/tight/blocked geography from certified envelope versions (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Only BLOCKED/UNCERTIFIED have a producer; SAFE/TIGHT on the envelope need routed travel time.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7754, 9795
- **Batch:** B2-MAP map and client
- **Required correction:** _to be filled by the lane_
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** scratchpad/l165-b2-map-handback.txt. Actual server coordinates and bands, exact snapshot/expiry, dashed unfilled sampled boundary, explicit unknown sectors, cached selected/abort return contracts without expiry renewal. Native integration and regression mutants pass locally; continuous isochrone is not claimed.
- **Status:** BUILT (server-owned geographic display and persistent cache tested; independent acceptance and applicable production/device evidence pending)

### L117 — Pins outside the certified action universe are hidden or visibly blocked
- **Original requirement:** Pins outside the certified action universe are hidden or visibly blocked (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Blocked pins render; the band joins on rec.id, which exists only with layover_stable_recommendation_ids_enabled ON (2410 applied, flag FALSE). Plan stops can only come from a rec with an id, so no code-only join fixes it.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** flag layover_stable_recommendation_ids_enabled
- **Census lines read:** 7755, 11819
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ids:61, :73 · **Production dependency:** owner press: P4
- **Evidence:** lane B1-P handback §2: every card carries its id + feasibility, so the screen's join (app/layover/[id].tsx:397) bands EVERY pin; a place outside the envelope is not offered
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L118 — Changing time-budget chips triggers simulation/replanning, not local visual filtering alone
- **Original requirement:** Changing time-budget chips triggers simulation/replanning, not local visual filtering alone (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Server simulation built; flags 3785/3633 FALSE and the minutes behind a band are stated, not routed (+ OQ-L118-3/4/5 defaults).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider + 3785,3633 + flags
- **Census lines read:** 11809
- **Batch:** B2-MAP map and client
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing 3971/3856/2745 routing + applicable 3785/3633/canonical chain · **Tests:** actual adapter fixtures and mounted components, no paid provider calls · **Production dependency:** GOOGLE_MAPS_API_KEY, Routes API enablement, bounded route settings/flags and signed-device verification
- **Evidence:** scratchpad/l165-b2-map-handback.txt: 79 API tests plus 3 real Google adapter fixture tests, 107 client tests, 130 dashboard tests and focused cache/refresh/native tests. Eleven client and four API mutants killed; redundant/masked survivors disclosed. The finite sampled polygon is not a certified continuous interior (L61 remains open).
- **Status:** BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending)

### L119 — The primary route always includes the return leg and the return deadline
- **Original requirement:** The primary route always includes the return leg and the return deadline (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Return leg and deadline render; no line without a routed provider.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7756
- **Batch:** B2-MAP map and client
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing 3971/3856/2745 routing + applicable 3785/3633/canonical chain · **Tests:** actual adapter fixtures and mounted components, no paid provider calls · **Production dependency:** GOOGLE_MAPS_API_KEY, Routes API enablement, bounded route settings/flags and signed-device verification
- **Evidence:** scratchpad/l165-b2-map-handback.txt: 79 API tests plus 3 real Google adapter fixture tests, 107 client tests, 130 dashboard tests and focused cache/refresh/native tests. Eleven client and four API mutants killed; redundant/masked survivors disclosed. The finite sampled polygon is not a certified continuous interior (L61 remains open).
- **Status:** BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending)

### L120 — When RETURN_NOW is active, suppress exploration-first affordances and prioritise airport route/gate
- **Original requirement:** When RETURN_NOW is active, suppress exploration-first affordances and prioritise airport route/gate (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Suppression + CTA + directions built; gate/terminal context is null on every production airport (data).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** airport data source
- **Census lines read:** 3101, 9395 (§55.9)
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Publish evidence-backed airport curation only after actual source review; do not fabricate transit, terminal, visa or overnight facts to fill the launch packet.
- **Migration:** 3874 + 3880 where applicable · **Tests:** validation, publication, expiry and rollback workflow exercised on the migrated schema · **Production dependency:** reviewed source facts and authorized publication for launch airports
- **Evidence:** scratchpad/l165-b2-curate-handback.txt and docs/ops/airport-curation/. FLL/DAD packets remain empty or unreachable; HND/NRT facts remain incomplete. Workflow is built; human review is not claimed.
- **Status:** BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented)

### L121 — Map element Safe envelope — dynamic isochrone/polygon that contracts as conditions worsen
- **Original requirement:** Map element Safe envelope — dynamic isochrone/polygon that contracts as conditions worsen (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Two-ring diagram; an isochrone/polygon needs routing.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7757, 11816
- **Batch:** B2-MAP map and client
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing 3971/3856/2745 routing + applicable 3785/3633/canonical chain · **Tests:** actual adapter fixtures and mounted components, no paid provider calls · **Production dependency:** GOOGLE_MAPS_API_KEY, Routes API enablement, bounded route settings/flags and signed-device verification
- **Evidence:** scratchpad/l165-b2-map-handback.txt: 79 API tests plus 3 real Google adapter fixture tests, 107 client tests, 130 dashboard tests and focused cache/refresh/native tests. Eleven client and four API mutants killed; redundant/masked survivors disclosed. The finite sampled polygon is not a certified continuous interior (L61 remains open).
- **Status:** BLOCKED-EXTERNAL (implemented and locally tested; exact Google Routes deployment/credentials, migration and flag press plus applicable native-device evidence pending)

### L122 — Map element Candidate pin — carries feasibility state from the recommendation contract
- **Original requirement:** Map element Candidate pin — carries feasibility state from the recommendation contract (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Same ceiling as L117 (join keyed on an id production does not issue).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** flag layover_stable_recommendation_ids_enabled
- **Census lines read:** 7758
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ids:61 · **Production dependency:** owner press: P4
- **Evidence:** lane B1-P handback §2: the pin carries the contract's feasibility state
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L125 — Map element Blocked area — explain the reason, never imply safe fit
- **Original requirement:** Map element Blocked area — explain the reason, never imply safe fit (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Reachable only once a pin is banded (L117's flag).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** flag layover_stable_recommendation_ids_enabled
- **Census lines read:** 7759
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ids:73 · **Production dependency:** owner press: P4
- **Evidence:** lane B1-P handback §2: no banded pin implies a fit it was not certified for; BLOCKED explains itself (UNCERTIFIED carries no reason by LayoverEnvelope's own contract); the blocked-area rendering is pinned client-side (travel-buddy-standalone LayoverMapCard.envelope.component.test.tsx:239). With routing dark the out-of-rea
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L127 — Aggregate presence is the default; identity and precise location are progressively disclosed only with consent
- **Original requirement:** Aggregate presence is the default; identity and precise location are progressively disclosed only with consent (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Consent gate enforced both sides; aggregate-first default needs 2740 + layover_presence_ladder_enabled. (Identity disclosure "only with consent" still leans on L130's mutual model.)
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2740 + layover_presence_ladder_enabled
- **Census lines read:** 1424, 9542
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) pres:64, :83 · **Production dependency:** owner press: 2740 (056) → layover_presence_ladder_enabled
- **Evidence:** lane B1-P handback §2: aggregate is the default (L0, nobody named); consent both sides (a non-sharer sees nothing; the gate counts only publishable travellers). Identity disclosure under consent (L2 mutual) is L130's model, not exercised
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L128 — L0 aggregate only — "14 travelers connecting here"
- **Original requirement:** L0 aggregate only — "14 travelers connecting here" (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** disclosePresence serves aggregate-only only when the ladder flag is ON; 2740 unapplied.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2740 + layover_presence_ladder_enabled
- **Census lines read:** 1423
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) pres:64, :75 · **Production dependency:** owner press: as L127
- **Evidence:** lane B1-P handback §2: "6 travellers connecting here"; below k (5) withheld, never a small number
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L130 — L2 mutual discovery — profiles visible under policy
- **Original requirement:** L2 mutual discovery — profiles visible under policy (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Reciprocity is one global toggle; a per-pair mutual opt-in needs a pair-consent table whose design (request/accept vs intent match) is a product decision. If built on layover_presence (3900) it cannot use 3870-3899; key it on layover_sessions.
- **Root cause / class:** Needs a schema decision from you first (triage class NEEDS-MIGRATION)
- **Files / gating artifact (triage):** new table (design ruling first)
- **Census lines read:** 1424, 623
- **Batch:** B2-CREW crew/consent/sensing/rides
- **Required correction:** Mutual consent and visibility, certified split plans, scoped presence, expiring offline proximity, adaptive sensing and standing abort authorization are enforced on reachable paths. Crew certification consumes the same live conditions.
- **Migration:** 3872 + 3875 plus existing crew/consent chain · **Tests:** 55/55 migrated crew tests; 32 client suites/237 tests plus 48 cadence tests; isolated N1–N6 mutants killed · **Production dependency:** owner press and signed-device battery/location validation where applicable
- **Evidence:** scratchpad/l165-b2-crew-handback.txt; P10 proves an official live queue shifts all crew/solo return deadlines by the same 40 minutes and invalidates an older split. Battery package matches Expo 54; device behavior remains unclaimed.
- **Status:** BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending)

### L134 — Explicit split plans (A leaves at T1, B/C continue to T2)
- **Original requirement:** Explicit split plans (A leaves at T1, B/C continue to T2) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Solver supports split plans; crews are live (2984 applied, §68), so the "no crew" limit is stale. Missing: a crew itinerary/branch store and a surface to propose a split. Proposed 3872. C after press if the crew card ships with it.
- **Root cause / class:** Needs new schema (a migration), then the press (triage class BUILDABLE-WITH-MIGRATION→W)
- **Files / gating artifact (triage):** new 3872 (layover_crew_plans/branches, FK 2984), routes/airport.ts crew routes, LayoverCrewStore.ts, client crew section
- **Census lines read:** 1381, 10299 (§68)
- **Batch:** B2-CREW crew/consent/sensing/rides
- **Required correction:** Mutual consent and visibility, certified split plans, scoped presence, expiring offline proximity, adaptive sensing and standing abort authorization are enforced on reachable paths. Crew certification consumes the same live conditions.
- **Migration:** 3872 + 3875 plus existing crew/consent chain · **Tests:** 55/55 migrated crew tests; 32 client suites/237 tests plus 48 cadence tests; isolated N1–N6 mutants killed · **Production dependency:** owner press and signed-device battery/location validation where applicable
- **Evidence:** scratchpad/l165-b2-crew-handback.txt; P10 proves an official live queue shifts all crew/solo return deadlines by the same 40 minutes and invalidates an older split. Battery package matches Expo 54; device behavior remains unclaimed.
- **Status:** BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending)

### L135 — Crew plan certified against every member branch
- **Original requirement:** Crew plan certified against every member branch (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** certifyCrewPlan runs live only on the EMPTY unsplit plan; a real crew plan needs the same 3872 store. C after press with L134.
- **Root cause / class:** Needs new schema (a migration), then the press (triage class BUILDABLE-WITH-MIGRATION→W)
- **Files / gating artifact (triage):** new 3872 + same files as L134
- **Census lines read:** 1382, 10299
- **Batch:** B2-CREW crew/consent/sensing/rides
- **Required correction:** Mutual consent and visibility, certified split plans, scoped presence, expiring offline proximity, adaptive sensing and standing abort authorization are enforced on reachable paths. Crew certification consumes the same live conditions.
- **Migration:** 3872 + 3875 plus existing crew/consent chain · **Tests:** 55/55 migrated crew tests; 32 client suites/237 tests plus 48 cadence tests; isolated N1–N6 mutants killed · **Production dependency:** owner press and signed-device battery/location validation where applicable
- **Evidence:** scratchpad/l165-b2-crew-handback.txt; P10 proves an official live queue shifts all crew/solo return deadlines by the same 40 minutes and invalidates an older split. Battery package matches Expo 54; device behavior remains unclaimed.
- **Status:** BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending)

### L137 — Crew location sharing expires on dissolution, re-entry, boarding, session expiry or revocation
- **Original requirement:** Crew location sharing expires on dissolution, re-entry, boarding, session expiry or revocation (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** All five terminators + TTL now enforced by the wave-4 grant store (3996, unapplied, flag FALSE).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 3996 + layover_crew_location_enabled
- **Census lines read:** 1384, 12220
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crewloc:73-123 · **Production dependency:** owner press: 3996 (addendum step 297) → layover_crew_location_enabled; RE-ENTRY also needs 2700→2992 + persistence flag (crewloc-off-persist.log: K3 red alone)
- **Evidence:** lane B1-P handback §2: crew location ends on revocation, dissolution (member-left trigger), re-entry, boarding (capped), session end, TTL
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L139 — Shared rides require opt-in and must avoid revealing the full itinerary to unrelated users
- **Original requirement:** Shared rides require opt-in and must avoid revealing the full itinerary to unrelated users (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** sharedRideDisclosure exists; there is no shared-ride concept in the product to disclose. Product decision (and schema if yes).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** product ruling
- **Census lines read:** 1386
- **Batch:** B2-CREW crew/consent/sensing/rides
- **Required correction:** _to be filled by the lane_
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Crew handback implements an honest unavailable shared-ride contract without exposing itineraries. A real shared-ride product/provider contract is absent.
- **Status:** BLOCKED-EXTERNAL (actual shared-ride provider/product contract; unavailable is not a completed opt-in ride)

### L143 — …terminal/gate context is pinned
- **Original requirement:** …terminal/gate context is pinned (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Pinning code reaches the API; 0 of 3,206 production airports carry terminal_info (data curation).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** airport data source
- **Census lines read:** 1388
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Publish evidence-backed airport curation only after actual source review; do not fabricate transit, terminal, visa or overnight facts to fill the launch packet.
- **Migration:** 3874 + 3880 where applicable · **Tests:** validation, publication, expiry and rollback workflow exercised on the migrated schema · **Production dependency:** reviewed source facts and authorized publication for launch airports
- **Evidence:** scratchpad/l165-b2-curate-handback.txt and docs/ops/airport-curation/. FLL/DAD packets remain empty or unreachable; HND/NRT facts remain incomplete. Workflow is built; human review is not claimed.
- **Status:** BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented)

### L144 — …crew/buddy is notified if policy + settings allow
- **Original requirement:** …crew/buddy is notified if policy + settings allow (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Built behind layover_crew_abort_notify_enabled (3786, FALSE); the disclosure itself is open owner question OQ-3; buddy half has no layover↔booking link.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** OQ-3 + 3786 flip
- **Census lines read:** 11353
- **Batch:** B2-CREW crew/consent/sensing/rides
- **Required correction:** Require a separate explicit choice for crew and booked Buddy abort notices. Resolve only current owned accepted bookings, check both-direction blocks and current sharing, and deduplicate atomically without disclosing identity, location or timing.
- **Migration:** Existing3894 booking linkage and existing crew/specialist/Rent-a-Buddy flags; no new migration · **Tests:** 12 migrated specialist/notice cases,37 client cases,111 neighbors,7 isolated mutants killed; API/client production types clean and test baselines unchanged · **Production dependency:** owner activation, actual device delivery and applicable verified identity/payment configuration
- **Evidence:** scratchpad/l165-b2-buddy-abort-handback.txt. Unticked tellBuddy choice is bound to this abort; five concurrent retries create one generic in-app notice. Wrong ownership/status, blocks, privacy failures, unreadable prerequisites, collision and late cancellation refuse. Notice failure leaves the return contract usable and reports an unconfirmed result honestly.
- **Status:** BUILT (crew and booked Buddy authorization, delivery and client paths tested locally; final aggregate and production verification pending)

### L147 — The abort action cancels optional itinerary state, marks the session RETURNING, surfaces the fastest certified route, notifies crew/buddy flows, preserves the offline route/deadline, and records the transition in the decision ledger
- **Original requirement:** The abort action cancels optional itinerary state, marks the session RETURNING, surfaces the fastest certified route, notifies crew/buddy flows, preserves the offline route/deadline, and records the transition in the decision ledger (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Abort built; RETURNING needs layover_safe_return_status_enabled ON (2741 applied, flag FALSE); ledger record needs 2700/2992; crew notify needs 3786 (+OQ-3).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** flag layover_safe_return_status_enabled; 2700/2992 + persistence; 3786
- **Census lines read:** 1601
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) abort:63-85 · **Production dependency:** owner press: flip layover_safe_return_status_enabled (2741 applied) + 3786 (255) → layover_crew_abort_notify_enabled AFTER ruling R9/OQ-3
- **Evidence:** lane B1-P handback §2: abort: RETURNING in the table, landside stops cancelled (airside kept), crewmate notified, return contract + ledger row with certification, offline bundle survives
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L151 — Map — cache airport + selected route/area
- **Original requirement:** Map — cache airport + selected route/area (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Airport + certified area cached and rendered offline; no route half without a routed provider.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7761
- **Batch:** B2-MAP map and client
- **Required correction:** _to be filled by the lane_
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** scratchpad/l165-b2-map-handback.txt. Actual server coordinates and bands, exact snapshot/expiry, dashed unfilled sampled boundary, explicit unknown sectors, cached selected/abort return contracts without expiry renewal. Native integration and regression mutants pass locally; continuous isochrone is not claimed.
- **Status:** BUILT (server-owned geographic display and persistent cache tested; independent acceptance and applicable production/device evidence pending)

### L154 — Crew — cache meeting point; optional peer proximity
- **Original requirement:** Crew — cache meeting point; optional peer proximity (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Meeting point cached (spec: "optional peer proximity if enabled"). Peer proximity now exists online behind 3996 (FALSE). Code part: cache the proximity bucket when enabled (groundwork). Code alone does NOT move it; lead may re-read "if enabled".
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** layoverPlanCache.ts; 3996 + layover_crew_location_enabled
- **Census lines read:** 8508
- **Batch:** B2-CREW crew/consent/sensing/rides
- **Required correction:** Mutual consent and visibility, certified split plans, scoped presence, expiring offline proximity, adaptive sensing and standing abort authorization are enforced on reachable paths. Crew certification consumes the same live conditions.
- **Migration:** 3872 + 3875 plus existing crew/consent chain · **Tests:** 55/55 migrated crew tests; 32 client suites/237 tests plus 48 cadence tests; isolated N1–N6 mutants killed · **Production dependency:** owner press and signed-device battery/location validation where applicable
- **Evidence:** scratchpad/l165-b2-crew-handback.txt; P10 proves an official live queue shifts all crew/solo return deadlines by the same 40 minutes and invalidates an older split. Battery package matches Expo 54; device behavior remains unclaimed.
- **Status:** BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending)

### L155 — Translation — cache context phrases required by the active plan
- **Original requirement:** Translation — cache context phrases required by the active plan (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Static phrase catalogue exists; W only for coverage (single-language countries) and phrases keyed to the return, not each stop. Add per-stop phrases from the plan's stops and a policy for multi-language countries.
- **Root cause / class:** Buildable by code alone (not built, see reasons) (triage class BUILDABLE-NOW)
- **Files / gating artifact (triage):** services/airport/layoverPhrases.ts, services/airport/LayoverDegradedService.ts, client LayoverOfflinePlanCard.tsx, layoverReturnFacts.ts
- **Census lines read:** 9336
- **Batch:** B3-ENGINE lifecycle/timing/engine refactor/phrases
- **Required correction:** Provide localized per-stop destination and help phrases with explicit language choice, preserve proper names, and cache them with the active plan; obtain qualified review.
- **Migration:** none · **Tests:** 49 API phrase/degraded/timing/policy tests;20 client cache/language tests; stop-context and language-selector mutants killed · **Production dependency:** qualified native-language reviewers for14 supported locales including English
- **Evidence:** Review packet scratchpad/l165-b3-engine/review/native-language-review.json contains every template and sample context, with reviewer=null. Multilingual countries offer choices and unavailable languages remain unavailable. No qualified review was available or claimed.
- **Status:** BLOCKED-EXTERNAL (localization and cache/UI tests delivered; actual qualified language review remains required)

### L157 — Adaptive sensing: low frequency when safe/stationary, moderate near decision boundaries, navigation-appropriate during RETURNING; avoid continuous GPS
- **Original requirement:** Adaptive sensing: low frequency when safe/stationary, moderate near decision boundaries, navigation-appropriate during RETURNING; avoid continuous GPS (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** sensingPolicy exists; the layover surface does no sensing, and lead ruling L164 keeps it off the location prompt. Adaptive sensing contradicts that ruling unless revisited.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L164 ruling
- **Census lines read:** 1394, 10540
- **Batch:** B2-CREW crew/consent/sensing/rides
- **Required correction:** Mutual consent and visibility, certified split plans, scoped presence, expiring offline proximity, adaptive sensing and standing abort authorization are enforced on reachable paths. Crew certification consumes the same live conditions.
- **Migration:** 3872 + 3875 plus existing crew/consent chain · **Tests:** 55/55 migrated crew tests; 32 client suites/237 tests plus 48 cadence tests; isolated N1–N6 mutants killed · **Production dependency:** owner press and signed-device battery/location validation where applicable
- **Evidence:** scratchpad/l165-b2-crew-handback.txt; P10 proves an official live queue shifts all crew/solo return deadlines by the same 40 minutes and invalidates an older split. Battery package matches Expo 54; device behavior remains unclaimed.
- **Status:** BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending)

### L163 — Decision ledger — retained per safety/diagnostic policy; minimise direct personal data
- **Original requirement:** Decision ledger — retained per safety/diagnostic policy; minimise direct personal data (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Erasure + retention built; stays W until 3621 is applied (lead ruling), 3622 depends on it.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 3621, 3622 (+ layover_events_post_session_pseudonymisation_enabled)
- **Census lines read:** 1405, 9478
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) eras:49-96 · **Production dependency:** owner press: 3621 (195) → 3622 (196) → layover_events_post_session_pseudonymisation_enabled
- **Evidence:** lane B1-P handback §2: the REAL executeAccountDeletion keeps the ledger only pseudonymised (no user, no session, one pseudonym, emptied metadata, ≤12 months); the CHECK refuses half-states; post-session pass after 30 days; retention sweep
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L172 — LayoverSessionService.updateConstraint(sessionId, patch)
- **Original requirement:** LayoverSessionService.updateConstraint(sessionId, patch) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** updateConstraint built; constraint entity is 2992 behind 3640.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2992,3640 + layover_constraints_enabled
- **Census lines read:** 2288, 12151
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) cl:60 · **Production dependency:** owner press: as L4
- **Evidence:** lane B1-P handback §2: updateConstraint appends a version; a repeat appends nothing; the store refuses UPDATE
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L174 — LayoverSessionService.close(sessionId, outcome)
- **Original requirement:** LayoverSessionService.close(sessionId, outcome) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Outcome arrives from the traveller and recordLayoverOutcome writes layover_outcomes (2992) behind the persistence gate.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2992 + layover_decision_persistence_enabled
- **Census lines read:** 3908, 8656
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) cl:145 · **Production dependency:** owner press: 2700→2992 + persistence flag
- **Evidence:** lane B1-P handback §2: close(sessionId, outcome) stores the outcome in layover_outcomes
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L175 — LayoverFeasibilityService.evaluate(sessionId)
- **Original requirement:** LayoverFeasibilityService.evaluate(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** /safety certifies through evaluate() (round 2). Also needs /overview to do the same (a lead decision with hot-path costs), then the press.
- **Root cause / class:** Waits on a decision from you (triage class MIXED)
- **Files / gating artifact (triage):** new LayoverFeasibilityService entry; 2700/2992/3792 + persistence
- **Census lines read:** 711
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** The dashboard main route must call the shared evaluation service and reuse its persisted canonical identity across later safety/dashboard reads.
- **Migration:** 3873/3896 plus existing canonical chain · **Tests:** Independent dashboard/vocabulary5/5; bypass-evaluate isolated router mutant killed; canonical rollback8/8 plus14 existing tests · **Production dependency:** owner activation and original row-specific external evidence
- **Evidence:** l165-canonical-verification-handback.txt. Actual migrated HTTP stores exactly one row matching snapshotId/inputHash; later reads reuse it and foreign owner refuses. Mutant emits200 but no stored row and fails the same invariant.
- **Status:** BUILT (independent local shared-evaluation proof passed; real PostgreSQL CI and production activation pending)

### L176 — LayoverFeasibilityService.certifyRecommendation(sessionId, candidatePlan)
- **Original requirement:** LayoverFeasibilityService.certifyRecommendation(sessionId, candidatePlan) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Code part: certifyRecommendation(sessionId, candidatePlan) entry point (groundwork). Per-recommendation stored contract needs 3623 + layover_recommendation_snapshot_enabled. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverRecommendationService.ts; 3623 + flags
- **Census lines read:** 1395
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing canonical/routing chain; no new RECS-B migration · **Tests:** full migrated schema and actual owner HTTP endpoints · **Production dependency:** canonical/routing flags, approved provider and mature airport evidence
- **Evidence:** scratchpad/l165-b2-recsb-handback.txt: 195 adjacent tests; final executable and real-schema API tests 17/17. Actual future arbitrary-origin hops, canonical ownership, in-flight block refusal and second GET at +100ms are exercised. No real provider or production activation claim.
- **Status:** BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending)

### L178 — TemporalFreedomService.calculateCommitmentEnvelope(context)
- **Original requirement:** TemporalFreedomService.calculateCommitmentEnvelope(context) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** calculateCommitmentEnvelope has no production caller by §18's own refusal; §23.3 files it as an owner decision. If ruled "route the published [hardReturnTime, cutoff] band through it", S work in Lane A's files.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** ruling (lead)
- **Census lines read:** 4423, 5742 (§23.3)
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing canonical/routing chain; no new RECS-B migration · **Tests:** full migrated schema and actual owner HTTP endpoints · **Production dependency:** canonical/routing flags, approved provider and mature airport evidence
- **Evidence:** scratchpad/l165-b2-recsb-handback.txt: 195 adjacent tests; final executable and real-schema API tests 17/17. Actual future arbitrary-origin hops, canonical ownership, in-flight block refusal and second GET at +100ms are exercised. No real provider or production activation claim.
- **Status:** BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending)

### L180 — AirportTruthService.getTruth(subject, factType, atTime)
- **Original requirement:** AirportTruthService.getTruth(subject, factType, atTime) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Store-reading getTruth built (lane 5). Needs 3513 and your L81 ruling on whether stored observations feed the safety path.
- **Root cause / class:** Waits on a decision from you (triage class MIXED)
- **Files / gating artifact (triage):** LayoverAirportTruth.ts, LayoverObservationService.ts; 3513
- **Census lines read:** 1839
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Screened live signals, freshness/conflict handling and traffic estimation feed certified decisions. Compass and crew now retain the same live certification; stale or conflicting evidence cannot silently improve confidence.
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Saved B2-LIVE handback plus root live-compass-red/green logs (10/10 migrated tests) and crew P10. E9 failed with a 40-minute unsafe deadline difference before the fix; shared certified records and clarification counterfactuals now preserve live conditions.
- **Status:** BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending)

### L181 — AirportTruthService.reconcile(observations)
- **Original requirement:** AirportTruthService.reconcile(observations) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Observation routes refuse unless layover_crowd_reports_enabled is on; 3513 seeds it and is unapplied.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:84, :105 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: reconcile(observations) over the STORED corpus, published by GET and POST /observations
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L182 — LayoverExperienceService.getCandidates(sessionId)
- **Original requirement:** LayoverExperienceService.getCandidates(sessionId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** getCandidates exists; §17.6: a disclosed provenance is not an executable-experience contract. Moves with the L76 contract (routing-blocked). Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverRecommendationService.ts; routing
- **Census lines read:** 3918
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing canonical/routing chain; no new RECS-B migration · **Tests:** full migrated schema and actual owner HTTP endpoints · **Production dependency:** canonical/routing flags, approved provider and mature airport evidence
- **Evidence:** scratchpad/l165-b2-recsb-handback.txt: 195 adjacent tests; final executable and real-schema API tests 17/17. Actual future arbitrary-origin hops, canonical ownership, in-flight block refusal and second GET at +100ms are exercised. No real provider or production activation claim.
- **Status:** BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending)

### L183 — LayoverExperienceService.compile(sessionId, candidateIds)
- **Original requirement:** LayoverExperienceService.compile(sessionId, candidateIds) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** compile builds an ordered itinerary + fit; abortThreshold/fallback are code (groundwork), route/departBy need routing. Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** routes/airport.ts stops, LayoverPlanFit.ts; routing
- **Census lines read:** 3918, 719
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** _to be filled by the lane_
- **Migration:** Existing canonical/routing chain; no new RECS-B migration · **Tests:** full migrated schema and actual owner HTTP endpoints · **Production dependency:** canonical/routing flags, approved provider and mature airport evidence
- **Evidence:** scratchpad/l165-b2-recsb-handback.txt: 195 adjacent tests; final executable and real-schema API tests 17/17. Actual future arbitrary-origin hops, canonical ownership, in-flight block refusal and second GET at +100ms are exercised. No real provider or production activation claim.
- **Status:** BUILT (executable contracts and ordered experience compilation pass local migrated-schema tests; independent acceptance and production press pending)

### L187 — LayoverCrewService.updatePresence(sessionId, input)
- **Original requirement:** LayoverCrewService.updatePresence(sessionId, input) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** updatePresence sets the spec's record (3900) behind layover_presence_intents_enabled + ladder flag, both FALSE.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 3900 + layover_presence_intents_enabled, 2740 + ladder flag
- **Census lines read:** 723, 9542
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) pres:92 · **Production dependency:** owner press: 3900 (269) → layover_presence_intents_enabled (+ ladder for counts)
- **Evidence:** lane B1-P handback §2: updatePresence: intents stored in layover_presence (one row per session), read back, precise location never stored, out-of-window refused
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L189 — LayoverDecisionService.explain(snapshotId)
- **Original requirement:** LayoverDecisionService.explain(snapshotId) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** explain route, app card and code built (round 2). Needs 2700 → 2992 → 3792 + the persistence flag.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class MIXED)
- **Files / gating artifact (triage):** services/layover/LayoverDecisionService.ts; 2700/2992/3792 + persistence
- **Census lines read:** 725
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:137, :163 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: explain(snapshotId): the stored snapshot explained only after its stored inputs replay to its stored columns; a tampered row is "not_explained replay_mismatch"
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L191 — LayoverDecisionService.replay(sessionId, engineVersion)
- **Original requirement:** LayoverDecisionService.replay(sessionId, engineVersion) (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** replay route and code built (round 2). Same press as L189.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class MIXED)
- **Files / gating artifact (triage):** services/layover/LayoverDecisionService.ts; 2700/2992/3792 + persistence
- **Census lines read:** 3916, 10940 (§72.5)
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:148 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: replay(sessionId, engineVersion): every recorded decision replays (read = replayed = matched, 0 mismatched); a non-running engine is refused
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L192 — 1. Create enum types and the core layover_sessions table with RLS
- **Original requirement:** 1. Create enum types and the core layover_sessions table with RLS (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** "Create enum types": every vocabulary is TEXT+CHECK by repo convention. Converting live tables to PostgreSQL enum types is a schema-convention decision for the owner/lead (and a 22P02 risk class).
- **Root cause / class:** Needs a schema decision from you first (triage class NEEDS-MIGRATION)
- **Files / gating artifact (triage):** schema decision
- **Census lines read:** 733
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** Use TEXT with complete CHECK vocabularies and RLS, per the owner directive; reject invalid values and unauthorized reads/writes on the real schema.
- **Migration:** Existing core/session migrations including3827; no new enum type · **Tests:** Independent dashboard/vocabulary5/5; dropped-CHECK and opened-policy mutants killed/restored · **Production dependency:** owner activation and original row-specific external evidence
- **Evidence:** l165-canonical-verification-handback.txt. All seven vocabulary columns and17 lifecycle states checked; actual invalid inserts refused, own read succeeds, foreign read is empty and protected-state client writes refuse.
- **Status:** BUILT (independent migrated vocabulary/RLS proof passed; final PostgreSQL CI and production verification pending)

### L194 — 3. Create events + checkpoints with dedup indexes
- **Original requirement:** 3. Create events + checkpoints with dedup indexes (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** External events dedup index applied and proven (2860); checkpoints with UNIQUE(session_id, dedup_key) are 2992, unapplied.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2992 (+ checkpoint gate)
- **Census lines read:** 1900, 7635 (§40.4)
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) cl:126 · **Production dependency:** owner press: 2700→2992 + persistence flag (the checkpoint writer is behind it)
- **Evidence:** lane B1-P handback §2: checkpoints stored with their dedup key; a retried tap is one row; the unique index refuses a duplicate (23505)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L195 — 4. Create recommendations + outcome tables
- **Original requirement:** 4. Create recommendations + outcome tables (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Recommendations exist; layover_outcomes is 2992 with a writer behind the persistence gate.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2992 + layover_decision_persistence_enabled
- **Census lines read:** 736, 8656
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) cl:145 · **Production dependency:** owner press: as L174
- **Evidence:** lane B1-P handback §2: the outcomes table populated by the close
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L196 — 5. Create presence/crew tables with restrictive policies and expiration jobs
- **Original requirement:** 5. Create presence/crew tables with restrictive policies and expiration jobs (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Presence expiry sweep built (lane 5). Needs 3900 + layover_presence_intents_enabled.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class MIXED)
- **Files / gating artifact (triage):** new lib/layoverPresenceExpiryScheduler.ts, index.ts; 3900 + flags
- **Census lines read:** 7076
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) pres:114, :175 (absent arm) · **Production dependency:** owner press: 3900 (+ intents flag so it is populated)
- **Evidence:** lane B1-P handback §2: restrictive table (no client privilege at all), expired rows swept, live rows kept; without 3900 the sweep refuses
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L197 — 6. Create airport intelligence observation/truth tables if the existing intelligence schema cannot represent the required TTL/provenance cleanly
- **Original requirement:** 6. Create airport intelligence observation/truth tables if the existing intelligence schema cannot represent the required TTL/provenance cleanly (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** The table's only writer is the closed observation route (3513).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:84 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: the observation table is populated by the product surface (de-identified handle, channel source_ref, class TTL)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L198 — 7. Indexes for active-session lookup, session event ordering, unexpired presence, snapshot versioning and impacted-session event fanout
- **Original requirement:** 7. Indexes for active-session lookup, session event ordering, unexpired presence, snapshot versioning and impacted-session event fanout (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** All five index families are written: airport fanout 2986, snapshot versioning 3623, unexpired presence 3900; none applied.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2986, 3623, 3900
- **Census lines read:** 1900, 7643
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) pres:127 · **Production dependency:** owner press: 2986 (087), 3623 (197), 3900 (269); 0127's two
- **Evidence:** lane B1-P handback §2: all five index families on the chain AND chosen by the planner for the reads the code issues
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L199 — 8. Migration postconditions and authorization-contract tests for every client-writable table
- **Original requirement:** 8. Migration postconditions and authorization-contract tests for every client-writable table (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Postconditions/contracts built; applying 3620 is owner decision L199-b, applied nowhere.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 3620
- **Census lines read:** 3441, 9189
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) wb:95, :107 · **Production dependency:** owner press: 3620 (194) — owner decision L199-b. No flag
- **Evidence:** lane B1-P handback §2: the authorization contract on the chain for all four tables + 3620's own $post$ re-run
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L200 — Users may read/write their own session inputs within allowed fields
- **Original requirement:** Users may read/write their own session inputs within allowed fields (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Column-level write boundary is 3620, applied nowhere.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 3620
- **Census lines read:** 746, 9189
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) wb:50, :62, :75, :85 · **Production dependency:** owner press: 3620
- **Evidence:** lane B1-P handback §2: the traveller's PostgREST client cannot write status/reminder/sharing/stops/events/delete; the route accepts inputs, ignores non-inputs; reads owner-scoped
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L202 — Presence is readable only according to visibility scope and safety policy
- **Original requirement:** Presence is readable only according to visibility scope and safety policy (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Presence scope is app-level on the service client; lead ruling 2026-10-07 (L205): no user-scoped PostgREST client this release.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** ruling (revisit L205)
- **Census lines read:** 748, 9328
- **Batch:** B2-CREW crew/consent/sensing/rides
- **Required correction:** Mutual consent and visibility, certified split plans, scoped presence, expiring offline proximity, adaptive sensing and standing abort authorization are enforced on reachable paths. Crew certification consumes the same live conditions.
- **Migration:** 3872 + 3875 plus existing crew/consent chain · **Tests:** 55/55 migrated crew tests; 32 client suites/237 tests plus 48 cadence tests; isolated N1–N6 mutants killed · **Production dependency:** owner press and signed-device battery/location validation where applicable
- **Evidence:** scratchpad/l165-b2-crew-handback.txt; P10 proves an official live queue shifts all crew/solo return deadlines by the same 40 minutes and invalidates an older split. Battery package matches Expo 54; device behavior remains unclaimed.
- **Status:** BUILT (crew code and schema/client tests; independent verification and applicable device/production evidence pending)

### L204 — Aggregated airport intelligence must not leak raw user identifiers
- **Original requirement:** Aggregated airport intelligence must not leak raw user identifiers (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Aggregate carries its own no-identifier guard; its only consumer is the maturity gate behind 2977 (unapplied) whose flip is the L243 owner decision.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L243 ruling + 2977
- **Census lines read:** 7763, 7782
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L205 — Service-role processing should be narrow and auditable
- **Original requirement:** Service-role processing should be narrow and auditable (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Lead ruling 2026-10-07: no architecture change this release; service client with per-route authorization.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** ruling (revisit)
- **Census lines read:** 751, 9480
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Verified HTTP identity or explicit system identity accompanies protected service writes. Migration 3890 installs atomic minimal service audit triggers on all present layover tables when activated, refuses unscoped writes, scrubs deleted accounts, and expires records after 30 days.
- **Migration:** 3890 FALSE audit rollout with guarded activation after all tables exist, plus refusing rollback · **Tests:** independent audit boundary/retention36/36 including7 new actual database cases; rollback/full catalog9/9;23 forged foreign HTTP probes and removed-filter mutant · **Production dependency:** owner press and final PostgreSQL/CI verification
- **Evidence:** scratchpad/l165-l205-independent-handback.txt. Reusing a previously awaited service builder outside its actor context reproduced an unauthorized write; headers now overwrite/clear on every await. Foreign requests have zero effects, concurrent actors retain separate identity, trigger activation is atomic, and actual account erasure scrubs actor/session identifiers while preserving unrelated audit records. Audit activation covers tables present at activation and must run after schema completion.
- **Status:** BUILT (independent service-boundary, actor-scope and deletion proofs passed; final PostgreSQL/CI and production activation pending)

### L206 — Every material recomputation creates a deterministic snapshot and decision record
- **Original requirement:** Every material recomputation creates a deterministic snapshot and decision record (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Record computed and published on /overview; storage refused (2700/2992 unapplied, persistence flag absent).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3792 + persistence flag
- **Census lines read:** 7979
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:105 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: a window edit creates a new snapshot (new input hash, snapshot_version n+1); the replan's ledger row cites it
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L207 — DecisionRecord { sessionId, snapshotId, engineVersion, inputHash, inputFacts[], sourceRefs[], rulesApplied[], result, reasonCodes[], computedAt }
- **Original requirement:** DecisionRecord { sessionId, snapshotId, engineVersion, inputHash, inputFacts[], sourceRefs[], rulesApplied[], result, reasonCodes[], computedAt } (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Code half built (lane 5): the replan cites the stored snapshot. Needs 2700 → 2992 → 3792 + the persistence flag.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverReplanService.ts; 2700/2992/3792 + persistence
- **Census lines read:** 7980, 2282
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:67, :105, :137, :202 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: DecisionRecord's ten members on the row / on explain; the replan cites the stored snapshot
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L208 — Metric layover_sessions_detected
- **Original requirement:** Metric layover_sessions_detected (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Counter derivable and reported on the admin route; no exporter bound (OQ-8).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** OQ-8
- **Census lines read:** 759, 12158
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Use distinct eligible sessions for replan rates, actual return-start and airport-arrival evidence, stale provenance and contract-violation counts. Unknown/truncated sources remain unproducible; bounded periodic collection exports replacing window gauges and sends deduplicated zero-target alerts with visible scheduler health.
- **Migration:** Existing 2992 and 3893 measured schema readiness · **Tests:** 7/7 migrated metrics, 9 value/monitoring tests, 39 window-read checks and scheduler integration tests · **Production dependency:** deployed scheduler plus configured Sentry and/or Pushgateway destination
- **Evidence:** /private/tmp/codex-layover-resume-20261019/metrics-db-final.log and platform-inventory-health-final.log. Actual route/return/reentry/replan rows and contract violations exercised. External delivery remains not_configured/log_only where credentials are absent.
- **Status:** BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending)

### L212 — Metric replan_rate
- **Original requirement:** Metric replan_rate (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Replan ledger rows carry counts.replanned; the route still answers UNPRODUCIBLE (no replan literal) and nothing exports (OQ-8). Computing the rate from ledger metadata is code, but does not move it without OQ-8.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** OQ-8 (+ code in layoverObservability.ts)
- **Census lines read:** 2287
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Use distinct eligible sessions for replan rates, actual return-start and airport-arrival evidence, stale provenance and contract-violation counts. Unknown/truncated sources remain unproducible; bounded periodic collection exports replacing window gauges and sends deduplicated zero-target alerts with visible scheduler health.
- **Migration:** Existing 2992 and 3893 measured schema readiness · **Tests:** 7/7 migrated metrics, 9 value/monitoring tests, 39 window-read checks and scheduler integration tests · **Production dependency:** deployed scheduler plus configured Sentry and/or Pushgateway destination
- **Evidence:** /private/tmp/codex-layover-resume-20261019/metrics-db-final.log and platform-inventory-health-final.log. Actual route/return/reentry/replan rows and contract violations exercised. External delivery remains not_configured/log_only where credentials are absent.
- **Status:** BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending)

### L214 — Metric safe_return_completion_rate
- **Original requirement:** Metric safe_return_completion_rate (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Needs a return-completion record (layover_outcomes, 2992 + persistence) AND an exporter (OQ-8).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** OQ-8 + 2992 press
- **Census lines read:** 3909
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Use distinct eligible sessions for replan rates, actual return-start and airport-arrival evidence, stale provenance and contract-violation counts. Unknown/truncated sources remain unproducible; bounded periodic collection exports replacing window gauges and sends deduplicated zero-target alerts with visible scheduler health.
- **Migration:** Existing 2992 and 3893 measured schema readiness · **Tests:** 7/7 migrated metrics, 9 value/monitoring tests, 39 window-read checks and scheduler integration tests · **Production dependency:** deployed scheduler plus configured Sentry and/or Pushgateway destination
- **Evidence:** /private/tmp/codex-layover-resume-20261019/metrics-db-final.log and platform-inventory-health-final.log. Actual route/return/reentry/replan rows and contract violations exercised. External delivery remains not_configured/log_only where credentials are absent.
- **Status:** BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending)

### L215 — Metric stale_fallback_rate
- **Original requirement:** Metric stale_fallback_rate (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Emission + admin rate built; no exporter (OQ-8); rate half needs persistence.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** OQ-8 + 2700/2992 press
- **Census lines read:** 9788
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Use distinct eligible sessions for replan rates, actual return-start and airport-arrival evidence, stale provenance and contract-violation counts. Unknown/truncated sources remain unproducible; bounded periodic collection exports replacing window gauges and sends deduplicated zero-target alerts with visible scheduler health.
- **Migration:** Existing 2992 and 3893 measured schema readiness · **Tests:** 7/7 migrated metrics, 9 value/monitoring tests, 39 window-read checks and scheduler integration tests · **Production dependency:** deployed scheduler plus configured Sentry and/or Pushgateway destination
- **Evidence:** /private/tmp/codex-layover-resume-20261019/metrics-db-final.log and platform-inventory-health-final.log. Actual route/return/reentry/replan rows and contract violations exercised. External delivery remains not_configured/log_only where credentials are absent.
- **Status:** BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending)

### L216 — Metric recommendation_contract_violation, target 0
- **Original requirement:** Metric recommendation_contract_violation, target 0 (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Monitor checks every generated card; no exporter (OQ-8, OQ-L216-1), only the card's subset of L76, snapshot half needs 3623 ON.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** OQ-8 + 3623 press
- **Census lines read:** 10917
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Use distinct eligible sessions for replan rates, actual return-start and airport-arrival evidence, stale provenance and contract-violation counts. Unknown/truncated sources remain unproducible; bounded periodic collection exports replacing window gauges and sends deduplicated zero-target alerts with visible scheduler health.
- **Migration:** Existing 2992 and 3893 measured schema readiness · **Tests:** 7/7 migrated metrics, 9 value/monitoring tests, 39 window-read checks and scheduler integration tests · **Production dependency:** deployed scheduler plus configured Sentry and/or Pushgateway destination
- **Evidence:** /private/tmp/codex-layover-resume-20261019/metrics-db-final.log and platform-inventory-health-final.log. Actual route/return/reentry/replan rows and contract violations exercised. External delivery remains not_configured/log_only where credentials are absent.
- **Status:** BUILT (operational metrics, protected export, scheduler and alerts pass local tests; independent and deployment verification pending)

### L220 — 4h international, visa allowed → potential landside depending on airport model
- **Original requirement:** 4h international, visa allowed → potential landside depending on airport model (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** §21.1 scenario holds on the engine; no production airport is curated (data).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** airport data source
- **Census lines read:** 9025
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Publish evidence-backed airport curation only after actual source review; do not fabricate transit, terminal, visa or overnight facts to fill the launch packet.
- **Migration:** 3874 + 3880 where applicable · **Tests:** validation, publication, expiry and rollback workflow exercised on the migrated schema · **Production dependency:** reviewed source facts and authorized publication for launch airports
- **Evidence:** scratchpad/l165-b2-curate-handback.txt and docs/ops/airport-curation/. FLL/DAD packets remain empty or unreachable; HND/NRT facts remain incomplete. Workflow is built; human review is not claimed.
- **Status:** BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented)

### L221 — 6h visa-free → landside + return contract
- **Original requirement:** 6h visa-free → landside + return contract (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Return contract published; route is hard-null (no routing provider).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7753
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3893 FALSE product rollout and rollback · **Tests:** 16 migrated product/abort tests, 64 client tests, 207 adjacent tests, 15 isolated mutants killed; rollback in two orders · **Production dependency:** owner press, live Routes for measured abort routes and existing explicit contact-consent flow
- **Evidence:** scratchpad/l165-b2-buddy-handback.txt: actual fresh origin, fixed canonical deadline, explicit consent, pending-to-active return start, no generic extend/confirm bypass, airport-reentry close, scheduler due-claim and deadline tightening. Missing provider/expiry stays unavailable without preventing abort.
- **Status:** BUILT (routed abort and certified linked Safe Return implemented; independent acceptance and provider/production evidence pending)

### L223 — Overnight → overnight state / expanded options
- **Original requirement:** Overnight → overnight state / expanded options (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Overnight state covered; "expanded options" need lodging/lounge data (none in discovery_places or airport_profiles).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** data-source decision
- **Census lines read:** 784, 9403 (§55.9)
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Publish evidence-backed airport curation only after actual source review; do not fabricate transit, terminal, visa or overnight facts to fill the launch packet.
- **Migration:** 3874 + 3880 where applicable · **Tests:** validation, publication, expiry and rollback workflow exercised on the migrated schema · **Production dependency:** reviewed source facts and authorized publication for launch airports
- **Evidence:** scratchpad/l165-b2-curate-handback.txt and docs/ops/airport-curation/. FLL/DAD packets remain empty or unreachable; HND/NRT facts remain incomplete. Workflow is built; human review is not claimed.
- **Status:** BLOCKED-EXTERNAL (actual reviewed airport facts and publication; no substitute facts or reviewer evidence invented)

### L227 — Security spike → envelope contracts monotonically
- **Original requirement:** Security spike → envelope contracts monotonically (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Contraction swept on the solver; no security wait reaches a session (live producer).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 1843
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Screened live signals, freshness/conflict handling and traffic estimation feed certified decisions. Compass and crew now retain the same live certification; stale or conflicting evidence cannot silently improve confidence.
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Saved B2-LIVE handback plus root live-compass-red/green logs (10/10 migrated tests) and crew P10. E9 failed with a 40-minute unsafe deadline difference before the fix; shared certified records and clarification counterfactuals now preserve live conditions.
- **Status:** BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending)

### L228 — Traffic spike → return deadline moves earlier
- **Original requirement:** Traffic spike → return deadline moves earlier (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Separate live traffic term built; no producer.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 1844
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Screened live signals, freshness/conflict handling and traffic estimation feed certified decisions. Compass and crew now retain the same live certification; stale or conflicting evidence cannot silently improve confidence.
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Saved B2-LIVE handback plus root live-compass-red/green logs (10/10 migrated tests) and crew P10. E9 failed with a 40-minute unsafe deadline difference before the fix; shared certified records and clarification counterfactuals now preserve live conditions.
- **Status:** BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending)

### L233 — Offline after leaving → cached return plan remains visible with a stale indicator
- **Original requirement:** Offline after leaving → cached return plan remains visible with a stale indicator (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Cached plan visible offline with staleness; census holds it in the snapshot family on 2700.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700 (+2992/3792 + persistence)
- **Census lines read:** 7762
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:254 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: the plan the phone caches offline is a stored, replayable snapshot (its input hash names a stored computation with a stored return plan) and carries its own staleness
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L236 — Database tests against a real CI schema for column names, enum literals, RLS and migration postconditions
- **Original requirement:** Database tests against a real CI schema for column names, enum literals, RLS and migration postconditions (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** layoverClientBoundary.db.test.ts is registered and runs in CI's api-server-local-db job; whether that local replay counts as "a real CI schema" is the lead's U-1 call (§40.4 says a replay is not). Also needs a green CI run.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** lead U-1 ruling + CI evidence
- **Census lines read:** 12318
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Generate query/select/literal/route inventories from production source. Against the full migrated schema, execute every resolved select variant, validate write-column shapes, catalog literals and RLS; refuse stale inventories, unresolved queries and missing initial authorization.
- **Migration:** Complete local migration chain through 3999 · **Tests:** 5/5 actual schema/select/write-shape/literal/RLS tests, 2/2 inventory controls, 87 unauthorized endpoint checks · **Production dependency:** green real PostgreSQL CI and independent full-path acceptance
- **Evidence:** /private/tmp/codex-layover-resume-20261019/query-schema-final.log, query-inventory-guard.log, service-auth-routes-final.log. Runtime payloads, every RPC execution and every ownership path are not inferred from catalog checks. PGlite is actual schema evidence, not claimed as a green production/CI run.
- **Status:** IN PROGRESS (local schema/query evidence complete at recorded stage; real PostgreSQL CI and full-path independent verification pending)

### L238 — Integration tests for event → replan → snapshot → invalidation → notification
- **Original requirement:** Integration tests for event → replan → snapshot → invalidation → notification (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Event→replan→invalidation→notification tested end to end; the snapshot stage needs 2700.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3792 + persistence
- **Census lines read:** 3916, 7657
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:202 (+:233) · **Production dependency:** owner press: P1 incl. recommendation snapshot flag
- **Evidence:** lane B1-P handback §2: event → replan → snapshot → invalidation → notification, end to end on the real tables
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L239 — E2E tests for detection → evaluation → plan → execution → return → completion
- **Original requirement:** E2E tests for detection → evaluation → plan → execution → return → completion (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Five of six stages over the real router; detection has no producer (flight feed or Trips-leg connection detection).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** flight-data / detection decision
- **Census lines read:** 7752
- **Batch:** B1-F flight data
- **Required correction:** Detection has a producer; one session walks detection→completion on the real router over the migrated chain
- **Migration:** 3826, 3827, 3828 (+ rollbacks; 21/21 proofs; order-independent, 0/24,989 keys differ) · **Tests:** layoverFlightConnections (unit 25), layoverFlightConnectionsRoutes (4), db/layoverFlightConnections.db.test.ts (17, full chain), client 12; 31 mutants killed · **Production dependency:** press 3826 then 3827; 3828 after 2700/2992/3623; trip_flight_segments_enabled + layover_flight_connections_enabled ON
- **Evidence:** lane B1-F handback §1; census-layover section 'lane B1-F'
- **Status:** BUILT (lane B1-F; independent verification pending; W until the press)

### L240 — Deterministic replay tests for recorded sessions
- **Original requirement:** Deterministic replay tests for recorded sessions (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Replay tests run on synthesised inputs; no recorded session (2700).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3792 + persistence
- **Census lines read:** 3916, 1402
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:148, :163 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: deterministic replay of recorded sessions; falsifiable (a tampered row counts as a mismatch)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L241 — Decision-diff CI comparing old/new engine behaviour over historical/synthetic corpora
- **Original requirement:** Decision-diff CI comparing old/new engine behaviour over historical/synthetic corpora (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Synthetic decision-diff CI runs in check:all; historical half needs stored decisions.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2700,2992,3792 + persistence
- **Census lines read:** 8645
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) snap:174, :181 · **Production dependency:** owner press: P1
- **Evidence:** lane B1-P handback §2: historical decision diff: two stored decisions diffed (snap:174); the admin metrics replay EVERY stored decision in the window under the running engine and count a behaviour change (snap:181)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L242 — Shadow mode in real environments before high-confidence rollout
- **Original requirement:** Shadow mode in real environments before high-confidence rollout (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Rollout modes built; 3784 unapplied, seeded legacy; shadow cohort is the owner's flip (OQ-L242-1, OQ-7).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 3784 + layover_ranking_mode=shadow (cohort)
- **Census lines read:** 12029
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) roll:84 · **Production dependency:** owner press: 3784 (253) → layover_ranking_mode enabled=true, metadata {"mode":"shadow","cohort":{"kind":"users","userIds":[…]}} (OQ-L242-1 / OQ-7: who)
- **Evidence:** lane B1-P handback §2: shadow for a tester cohort: compared and counted in the generation event; nothing it produced is served; others not shadowed
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L243 — L0 Generic — static airport + conservative generic timing; airport-side guidance only by default
- **Original requirement:** L0 Generic — static airport + conservative generic timing; airport-side guidance only by default (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Should the generic rung WITHHOLD landside guidance (every production airport is L0)?
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L243 owner decision
- **Census lines read:** 5730, 5758
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L246 — L3 Portava observed — recent Portava operational observations available
- **Original requirement:** L3 Portava observed — recent Portava operational observations available (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Portava-observation count reaches the ladder behind the absent maturity flag (2977); external live signals still zero.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L243 ruling + 2977; live producer
- **Census lines read:** 7764
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L247 — L4 Calibrated — prediction errors measured, model calibrated by airport/time band
- **Original requirement:** L4 Calibrated — prediction errors measured, model calibrated by airport/time band (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** measureCalibration measures only. Code part: apply calibration (groundwork). Blocked: no outcomes (2992) and no observations (3513) to calibrate against. Code alone does NOT move it. (§72.5 prose says "L247 stays N" — inconsistent with its W row.)
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverAirportTruth.ts; 2992, 3513
- **Census lines read:** 1845, 10943
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L249 — Enable features per airport maturity
- **Original requirement:** Enable features per airport maturity (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** featureAllowedAt consumed; enabling it IS the L243 decision (flag via 2977, unapplied).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L243 ruling + 2977
- **Census lines read:** 7765
- **Batch:** B2-CURATE curation/maturity/entry
- **Required correction:** Validated provenance, expiry and conflict-aware curation; confirmed entry facts; live evidence and time-band calibration feed actual maturity admission. Missing schema explicitly refuses feature queries.
- **Migration:** 3874 + 3880 and existing prerequisite chain · **Tests:** curation agent handback; 74 focused and 15 migrated workflow/rollback tests; root readiness boundary 5 unit tests and workflow W15 (16/16 total) · **Production dependency:** owner press, validated airport facts and existing live-provider dependencies
- **Evidence:** scratchpad/l165-b2-curate-handback.txt; curation readiness logs in /private/tmp/codex-layover-resume-20261019/; three isolated curation mutants killed. Real route reaches L4 only with qualifying official, crowd and calibrated evidence.
- **Status:** BUILT (curation implementation and migrated tests; independent acceptance verification and production press pending)

### L251 — Rate-limit and trust-weight community operational observations
- **Original requirement:** Rate-limit and trust-weight community operational observations (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Observation-channel rate limit and trust weighting: the channel is closed until 3513.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:105, :139, :166 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: rate limit (4th report in 15 min → 429, not stored) and trust weighting (community LOW, official HIGH)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L252 — Outlier detection for implausible queue/transport claims
- **Original requirement:** Outlier detection for implausible queue/transport claims (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Outlier rejection inside `reconcile`: as L84 (3513).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:175 · **Production dependency:** owner press: 3513
- **Evidence:** lane B1-P handback §2: outliers rejected before any write
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L254 — Verified/trusted requirements for high-risk Buddy/marketplace interactions
- **Original requirement:** Verified/trusted requirements for high-risk Buddy/marketplace interactions (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** The buddies list sits behind rent_buddy_enabled, which is FALSE in production.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) roll:103 · **Production dependency:** owner press: the owner's Rent-a-Buddy activation (never by this program)
- **Evidence:** lane B1-P handback §2: a high-risk (night) layover lists only verified, non-new buddies; a daytime one the rest too. rent_buddy_enabled ON IN THE TEST DATABASE ONLY
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L257 — Validate all external event payloads and deduplicate by stable source keys
- **Original requirement:** Validate all external event payloads and deduplicate by stable source keys (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** As L92: 2981 + ingest flag + producer secret.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** External-event fan-out no longer puts an IATA code into a uuid airport_id list (22P02 on the real schema).
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ext:89, :110, :127 · **Production dependency:** owner press: P7
- **Evidence:** lane B1-P handback §2: every payload validated (5 named refusals, nothing stored); stable source keys; tampered row refused at the last door
- **Status:** BUILT (pressed-path defect fixed by B1-P; independent verification pending; awaits the press)

### L259 — Replan fanout — index active sessions by airport/route/flight subjects; recompute impacted sessions only
- **Original requirement:** Replan fanout — index active sessions by airport/route/flight subjects; recompute impacted sessions only (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Airport axis indexed (2986); route/flight subjects need session route/flight columns that nothing can populate (no flight data). Census: inventing one is the wrong order.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** flight-data decision, then migration
- **Census lines read:** 7892
- **Batch:** B1-F flight data
- **Required correction:** Maintain atomic opaque route watches alongside recommendation and stop writes; index airport, route and flight subjects and recompute affected active/returning sessions. Complete durable high-fanout continuation.
- **Migration:** 3895 FALSE layover_route_subjects_enabled; stable private LAYOVER_ROUTE_SUBJECT_HMAC_SECRET; 3908 FALSE layover_route_fanout_enabled (requires seven existing route/canonical flags), private RLS tables layover_route_dispatches/layover_route_work, guarded definer RPC writes · **Tests:** 10/10 unit+migrated, 92/92 neighbors, 7 mutants (3895); route fanout 24/24 on PostgreSQL 17, 10 mutants killed with source bytes restored; registered full-catalog rollbacks for 3895 and 3908 in both installation orders 4/4 (`layoverRouteMigrations.db.test.ts`) · **Production dependency:** owner activation and original row-specific external evidence
- **Evidence:** l165-b2-route-handback.txt. Watches survive snapshot changes, source recommendation deletion and compaction; failed watch write rolls back its recommendation. 3908 replaces the >200-match refusal with durable fanout: at most 200 preparations per tick, keyset paging, leased work with retry/backoff and expired-lease recovery, owner/session/watch revision checks and explicit obsolete reasons. Canonical computation, children, supersession, event ledger and work checkpoint commit atomically; a source event settles only after a complete scan. Mixed route/non-route envelopes stay refused and unclaimed. `completed.notifications` counts notification decisions, not deliveries.
- **Status:** BUILT (atomic route dependency, durable bounded fanout and retry proved on PostgreSQL 17; production activation pending)

### L260 — Candidate explosion — pre-filter by envelope/time/category before expensive ranking
- **Original requirement:** Candidate explosion — pre-filter by envelope/time/category before expensive ranking (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Pre-filter is on the certified envelope; the "envelope geometry" half needs routing, and the ranking it protects (L78) is seeded legacy (3784).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider + 3784
- **Census lines read:** 3918, 6072
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3856_layover_routes_session_budget.sql (+3971, 2745 in the press) · **Tests:** layoverRoutedFeasibility / layoverRoutedRecommendationsRoute / layoverRoutedUniverse / layoverRoutedProviderContract / layoverRoutesSessionBudget (90 cases, 44 mutants) · **Production dependency:** Routes API enabled; LAYOVER_ROUTED_CORRIDOR_ENABLED + ROUTES_API_DAILY_*; 3971, 3856, 2745; layover_routed_corridor_enabled ON
- **Evidence:** lane B1-R1 handback §2; census-layover section "lanes B1-R1 and B1-P"
- **Status:** BUILT (lane B1-R1; independent verification pending; W until the Routes press)

### L263 — Duplicate events — unique dedup key / source event id
- **Original requirement:** Duplicate events — unique dedup key / source event id (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Dedup index applied and proven; W on the ingest flag (2981 unapplied).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2981 + layover_event_ingest_enabled
- **Census lines read:** 3916, 7639
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ext:89 · **Production dependency:** owner press: P7
- **Evidence:** lane B1-P handback §2: the unique dedup key refuses a duplicate in the table itself
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L264 — Race conditions — version/compare-and-swap the active snapshot; reject stale writes
- **Original requirement:** Race conditions — version/compare-and-swap the active snapshot; reject stale writes (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** .eq("status","active") guard exists; no CAS on an active snapshot. Proposed 3873: active_snapshot pointer + expected-version insert (depends on 2700/2992/3623, all below). C after press of 2700/2992/3623/3792/3873 + persistence.
- **Root cause / class:** Needs new schema (a migration), then the press (triage class BUILDABLE-WITH-MIGRATION→W)
- **Files / gating artifact (triage):** new 3873, LayoverDecisionStore.ts persistDecision
- **Census lines read:** 845
- **Batch:** B2-RECS recommendations/snapshots/contracts
- **Required correction:** Canonical persisted snapshot selection, guarded compare-and-swap publication, immutable decision history and recommendation supersession are connected; failed history refuses regeneration and stale candidates cannot overwrite a newer version.
- **Migration:** 3871 + 3873 + 3896 and existing 2700/2992/3623/3828 dependencies · **Tests:** 196 targeted tests; 8 canonical migrated tests; rollback catalog/row round trips, repeat/reapply and refusal cases; pressed-final 17/17 · **Production dependency:** owner migration/flag press
- **Evidence:** scratchpad/l165-b2-recsa-handback.txt. PGlite interleaving proved; real two-connection PostgreSQL contention branch awaits CI evidence. Full surface identifier matrix and independent mutants remain open.
- **Status:** BUILT (canonical snapshot and history batch; independent verification and production press pending)

### L267 — Trips — detect connection; show Layover card/status; pass flight segments into session creation
- **Original requirement:** Trips — detect connection; show Layover card/status; pass flight segments into session creation (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Card, pill and trip link built; nothing detects a connection and no flight segment exists to pass (Trips legs unpopulated).
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** Trips segment/detection decision
- **Census lines read:** 853, 8523
- **Batch:** B1-F flight data
- **Required correction:** Trips detects connections, shows the Layover card, passes both segments into session creation (server re-detects)
- **Migration:** 3826, 3827, 3828 (+ rollbacks; 21/21 proofs; order-independent, 0/24,989 keys differ) · **Tests:** layoverFlightConnections (unit 25), layoverFlightConnectionsRoutes (4), db/layoverFlightConnections.db.test.ts (17, full chain), client 12; 31 mutants killed · **Production dependency:** press 3826 then 3827; 3828 after 2700/2992/3623; trip_flight_segments_enabled + layover_flight_connections_enabled ON
- **Evidence:** Original B1-F connection/card proof plus scratchpad/l165-flight-terminal-handback.txt: initial and idempotent connection responses project only owned current linked flight observations; terminal-only updates recertify the session and invalidate inapplicable timing. PGlite2/2 and PostgreSQL17 terminal+harness5/5 pass; no licensed status feed or deployment claimed.
- **Status:** BUILT (lane B1-F; independent verification pending; W until the press)

### L268 — Compass — tool access to certified context; proactive OpportunityEvents; explanation/clarification
- **Original requirement:** Compass — tool access to certified context; proactive OpportunityEvents; explanation/clarification (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Tools removed from the layover door by L-CL02d; OpportunityEvents (L98) and clarification (L114) are C.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** L-CL02d
- **Census lines read:** 854
- **Batch:** B1-C assistant
- **Required correction:** Tool access, proactive operational events and explanation/clarification on the layover door.
- **Migration:** 3846_layover_compass_assistant_flag.sql (flag seeded FALSE; rollback db/rollback/2026-10-18-3846-layover-compass-assistant-flag-rollback.sql, proven on PGlite) · **Tests:** layoverCompassAssistant.test.ts 356/356; layoverCompassToolLoop.test.ts 51/51 (10 flag-ON); six older compass suites unchanged; real-schema src/test/db/layoverCompassAssistant.db.test.ts 6/6 pressed, flag-off/absent arms red (lands with the shared harness); 23 mutants killed · **Production dependency:** owner press: apply 3846, turn layover_compass_assistant_enabled ON; AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY (already used by Compass)
- **Evidence:** Original B1-C handback/commit f87a92e3f plus root assistant-safety-handback.txt: six isolated regression mutants killed; 370 assistant tests pass including live-record continuity. Earlier verifier holes were repaired; independent rerun still pending.
- **Status:** BUILT (assistant safety repairs tested; independent re-verification and production press pending)

### L269 — Discovery — only show experiences from the certified action universe in Layover mode
- **Original requirement:** Discovery — only show experiences from the certified action universe in Layover mode (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Certified action universe gates Discovery; layover_discovery_mode_enabled FALSE (2971 applied) pending deployment verification.
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** flip layover_discovery_mode_enabled
- **Census lines read:** 3918, 7188 (§35)
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) roll:66, :185 · **Production dependency:** owner press: flip layover_discovery_mode_enabled (2971 applied) after deployment verification. Proven at lib/discoveryLayoverMode.ts's gate (called by routes/discovery.ts GET /discovery and /discovery/community), not by driving GET /discovery
- **Evidence:** lane B1-P handback §2: in a live layover Discovery's gate admits only the certified universe; unmeasured places withheld with their reason; unreadable flag refuses
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L270 — Map — safe envelope, plan route, return state, airport digital-twin layers
- **Original requirement:** Map — safe envelope, plan route, return state, airport digital-twin layers (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Map has envelope ring and return state; plan route needs routing; digital-twin layers need airport topology data.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing + airport data
- **Census lines read:** 856
- **Batch:** B2-MAP map and client
- **Required correction:** Render measured Google route/envelope geometry and independent sourced airport terminal/gate/checkpoint layouts with expiry and selection; complete missing between-stop and indoor navigation paths.
- **Migration:** Existing airport curation projection; provider SDK keys and rebuilt native app · **Tests:** Curation18/18 migrated; geometry persistence1/1; client20 plus10 cache/map;9 mutants · **Production dependency:** owner activation and original row-specific external evidence
- **Evidence:** l165-map-geometry-handback.txt. Layout producer validates sourced coordinates and paths; fresh Google geometry uses Google maps and is stripped from persistent stores. Between-stop geometry: `GET .../experiences/plan/map` returns owner-only, no-store Google geometry for every ordered hop and the final return of the exact selected plan version. Compile writes a SHA-256 `routeInputHash` over ordered candidate keys, positions, dwell and activity commitment; geometry refuses a plan without it (`plan_review_required`) and a moved place before or after routing (`candidate_changed`). Migrated DB 7/7, client 5/5, 6 binding mutants plus a card fall-through mutant killed; activity commitment source refs are sorted so the hash is row-order independent. Real-airport source coordinates and the full indoor twin remain absent.
- **Status:** IN PROGRESS (route, between-stop and sourced airport-layout paths built; full indoor twin and device evidence remain open)

### L272 — Safe Return — reuse escalation/return UX; Layover provides certified deadlines and state
- **Original requirement:** Safe Return — reuse escalation/return UX; Layover provides certified deadlines and state (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Return alerts + return-now exist; reuse of the Safe Return PRODUCT's escalation UX is not built. Code part (L): offer a Safe Return session from a landside layover using the certified deadline. Blocked: returning state needs layover_safe_return_status_enabled; contacting trusted contacts from a layover is a product call. Code alone likely does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** services/safeReturn/*, routes/airport.ts; flag + product ruling
- **Census lines read:** 858, 10196
- **Batch:** B2-BUDDY Rent-a-Buddy specialist/Safe Return
- **Required correction:** _to be filled by the lane_
- **Migration:** 3893 FALSE product rollout and rollback · **Tests:** 16 migrated product/abort tests, 64 client tests, 207 adjacent tests, 15 isolated mutants killed; rollback in two orders · **Production dependency:** owner press, live Routes for measured abort routes and existing explicit contact-consent flow
- **Evidence:** scratchpad/l165-b2-buddy-handback.txt: actual fresh origin, fixed canonical deadline, explicit consent, pending-to-active return start, no generic extend/confirm bypass, airport-reentry close, scheduler due-claim and deadline tightening. Missing provider/expiry stays unavailable without preventing abort.
- **Status:** BUILT (routed abort and certified linked Safe Return implemented; independent acceptance and provider/production evidence pending)

### L273 — Rent a Buddy — layover-specialist services after the safety/time gate; strict boundaries
- **Original requirement:** Rent a Buddy — layover-specialist services after the safety/time gate; strict boundaries (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Gate built; no `layover` category in Rent-a-Buddy's vocabulary (text[] column, no migration needed) - adding/granting one is the Rent-a-Buddy owner's call; rent_buddy_enabled FALSE.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** Rent-a-Buddy ruling
- **Census lines read:** 5727, 10093
- **Batch:** B2-BUDDY Rent-a-Buddy specialist/Safe Return
- **Required correction:** Require verified identity, trust, payment readiness, availability and a canonical safety/time contract before a private booking-bound specialist offer can be created, accepted or started.
- **Migration:** 3894; FALSE layover_buddy_specialist_enabled and existing identity/payment/safety gates · **Tests:** 58/58 server incl actual migrated cases,30/30 client,9 mutants;3893/3894/3895 full-catalog rollback6/6 in both orders · **Production dependency:** owner activation and original row-specific external evidence
- **Evidence:** l165-b2-buddy-specialist-audit-handback.txt. Atomic create and accept/start recertification, opposite-party shortening and public meeting-place boundary. Missing provider_mode and unreadable payment recipient refuse. No production verification or payment activation claimed.
- **Status:** BUILT (specialist product path and migrated boundaries tested; real verification/payment configuration and production acceptance pending)

### L276 — Live Intelligence — consume crowd/queue/mobility signals; publish de-identified airport observations
- **Original requirement:** Live Intelligence — consume crowd/queue/mobility signals; publish de-identified airport observations (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Publish limb live (now behind 3513); consume limb behind layover_live_intersection_enabled (2851 unapplied).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (triage class NEEDS-PRESS)
- **Files / gating artifact (triage):** 2851 + layover_live_intersection_enabled; 3513
- **Census lines read:** 7249, 12155
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) crowd:196, roll:149 · **Production dependency:** owner press: 3513 (publish) + 2851 (step 070) → layover_live_intersection_enabled ON (consume); the Live gates it reads behind (intel_live_label_crowd, intel_claim_projection_crowd, intel_capture_quick_signal, intel_limited_live) are TRUE in production already
- **Evidence:** lane B1-P handback §2: publish limb: what is published carries no user id or handle; clients read handles only, cannot write; 2860's CHECK refuses a profile id (crowd:196). consume limb: a promoted live unsafe-density reading at a place drops its card; a place with no reading is untouched (roll:149)
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

### L281 — SECURITY_WAIT_HIGH
- **Original requirement:** SECURITY_WAIT_HIGH (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** SECURITY_WAIT_HIGH is emitted only by liveConditionsFrom, which no production producer feeds.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 2289
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Screened live signals, freshness/conflict handling and traffic estimation feed certified decisions. Compass and crew now retain the same live certification; stale or conflicting evidence cannot silently improve confidence.
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Saved B2-LIVE handback plus root live-compass-red/green logs (10/10 migrated tests) and crew P10. E9 failed with a 40-minute unsafe deadline difference before the fix; shared certified records and clarification counterfactuals now preserve live conditions.
- **Status:** BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending)

### L282 — RETURN_ROUTE_UNRELIABLE
- **Original requirement:** RETURN_ROUTE_UNRELIABLE (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** RETURN_ROUTE_UNRELIABLE wired; no provider/probe enabled.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** routing provider
- **Census lines read:** 7448, 7483
- **Batch:** B1-R1 routing (server)
- **Required correction:** Google Routes wired on GET /recommendations and the Discovery universe with §8 routed terms (LayoverRoutedFeasibility.ts).
- **Migration:** 3856_layover_routes_session_budget.sql (+3971, 2745 in the press) · **Tests:** layoverRoutedFeasibility / layoverRoutedRecommendationsRoute / layoverRoutedUniverse / layoverRoutedProviderContract / layoverRoutesSessionBudget (90 cases, 44 mutants) · **Production dependency:** Routes API enabled; LAYOVER_ROUTED_CORRIDOR_ENABLED + ROUTES_API_DAILY_*; 3971, 3856, 2745; layover_routed_corridor_enabled ON
- **Evidence:** lane B1-R1 handback §2; census-layover section "lanes B1-R1 and B1-P"
- **Status:** BUILT (lane B1-R1; independent verification pending; W until the Routes press)

### L285 — DATA_STALE
- **Original requirement:** DATA_STALE (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** DATA_STALE emitted only from liveConditionsFrom (LayoverAirportTruth.ts:681); no producer.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 2289
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Screened live signals, freshness/conflict handling and traffic estimation feed certified decisions. Compass and crew now retain the same live certification; stale or conflicting evidence cannot silently improve confidence.
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Saved B2-LIVE handback plus root live-compass-red/green logs (10/10 migrated tests) and crew P10. E9 failed with a 40-minute unsafe deadline difference before the fix; shared certified records and clarification counterfactuals now preserve live conditions.
- **Status:** BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending)

### L286 — SOURCE_CONFLICT
- **Original requirement:** SOURCE_CONFLICT (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** SOURCE_CONFLICT emitted only from liveConditionsFrom (:679); no producer.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 2289
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Screened live signals, freshness/conflict handling and traffic estimation feed certified decisions. Compass and crew now retain the same live certification; stale or conflicting evidence cannot silently improve confidence.
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Saved B2-LIVE handback plus root live-compass-red/green logs (10/10 migrated tests) and crew P10. E9 failed with a 40-minute unsafe deadline difference before the fix; shared certified records and clarification counterfactuals now preserve live conditions.
- **Status:** BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending)

### L287 — TRAFFIC_DEGRADED
- **Original requirement:** TRAFFIC_DEGRADED (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** TRAFFIC_DEGRADED emitted only from liveConditionsFrom (:678); no producer.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** live-signal producer decision
- **Census lines read:** 2289
- **Batch:** B2-LIVE live intelligence
- **Required correction:** Screened live signals, freshness/conflict handling and traffic estimation feed certified decisions. Compass and crew now retain the same live certification; stale or conflicting evidence cannot silently improve confidence.
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Saved B2-LIVE handback plus root live-compass-red/green logs (10/10 migrated tests) and crew P10. E9 failed with a 40-minute unsafe deadline difference before the fix; shared certified records and clarification counterfactuals now preserve live conditions.
- **Status:** BUILT (live processing and continuity tests; independent verification and required live feed/production evidence pending)

### L294 — C2. Never swallow a schema/data error into plausible empty operational state without structured logging and degraded confidence
- **Original requirement:** C2. Never swallow a schema/data error into plausible empty operational state without structured logging and degraded confidence (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Typed read convention + guard; 8 of 12 reads migrated. Code part: markReturning and readLayoverLive (no client-visible change) - groundwork. evaluateSharingGate and landsideMaturityDecision change served meaning (owner item, wave5 doc). Code alone does NOT move it.
- **Root cause / class:** Needs both code and the press (code half not yet built) (triage class MIXED)
- **Files / gating artifact (triage):** LayoverPrivacyGuard.ts, routes/airport.ts, layoverMaturityGate.ts; owner ruling
- **Census lines read:** 12317
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Convert all four remaining readers to typed outcomes: markReturning, readLayoverLive, evaluateSharingGate and landsideMaturityDecision. Callers explicitly retain degraded/refused results and structured failure logs.
- **Migration:** _to be filled_ · **Tests:** _to be filled_ · **Production dependency:** _to be filled_
- **Evidence:** Latest combined read/guard/metric checks 59/59; no reader exemption remains. Mark-returning throws, sharing failures, typed live disclosure and maturity failures retain named degraded/refused outcomes with structured logs.
- **Status:** BUILT (all four legacy readers converted, no reader exemptions; final independent acceptance and production press pending)

### L295 — C3. Never let a test fixture assert impossible production joins; live-schema/literal checks must cover safety-critical query paths
- **Original requirement:** C3. Never let a test fixture assert impossible production joins; live-schema/literal checks must cover safety-critical query paths (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Fixture half closed (embed guard incl. PGRST201); the real-CI-schema half is the lead's U-1 grading call.
- **Root cause / class:** Waits on a decision from you (triage class NEEDS-RULING)
- **Files / gating artifact (triage):** lead U-1 ruling
- **Census lines read:** 12316, 12370
- **Batch:** B2-PLATFORM metrics/audit/real-schema/typed reads
- **Required correction:** Generate query/select/literal/route inventories from production source. Against the full migrated schema, execute every resolved select variant, validate write-column shapes, catalog literals and RLS; refuse stale inventories, unresolved queries and missing initial authorization.
- **Migration:** Complete local migration chain through 3999 · **Tests:** 5/5 actual schema/select/write-shape/literal/RLS tests, 2/2 inventory controls, 87 unauthorized endpoint checks · **Production dependency:** green real PostgreSQL CI and independent full-path acceptance
- **Evidence:** /private/tmp/codex-layover-resume-20261019/query-schema-final.log, query-inventory-guard.log, service-auth-routes-final.log. Runtime payloads, every RPC execution and every ownership path are not inferred from catalog checks. PGlite is actual schema evidence, not claimed as a green production/CI run.
- **Status:** IN PROGRESS (local schema/query evidence complete at recorded stage; real PostgreSQL CI and full-path independent verification pending)

### L296 — C5. Never certify a recommendation against a snapshot other than the one returned with it
- **Original requirement:** C5. Never certify a recommendation against a snapshot other than the one returned with it (the census body row quotes the spec; the full wording is at the row's census line).
- **Acceptance criteria:** the requirement's spec words, met on a production-reachable path, with a falsifying test (the rule above).
- **Why it fails today:** Snapshot pairing is built; cards carry no id until layover_stable_recommendation_ids_enabled is turned on (no migration).
- **Root cause / class:** Code is ready; it waits on your production press (migrations and flags) (moved to W on 2026-10-18 under the reachability rule, or N→W)
- **Files / gating artifact (triage):** see the census section of 2026-10-18
- **Census lines read:** census-layover foot sections, 2026-10-18
- **Batch:** B1-P pressed-state verification
- **Required correction:** Proven pressed on the real migrated chain through the real router; red with the flag off / migration absent.
- **Migration:** none new (existing unapplied chain) · **Tests:** pressed-state suites (src/test/db/layoverPressed*.db.test.ts) ids:94 · **Production dependency:** owner press: P4
- **Evidence:** lane B1-P handback §2: Add to plan certified against the card's own snapshot; stale → 409 RECOMMENDATION_EXPIRED, nothing written
- **Status:** BUILT (proven pressed on the real chain by B1-P; independent verification pending; awaits the press)

