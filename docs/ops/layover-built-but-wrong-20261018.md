# Layover: the 165 requirements graded built but wrong (2026-10-18)

Source: the census-integrity parser's current grades (`CENSUS_INTEGRITY_DUMP=W`), each row's requirement from docs/architecture/census-layover.md, and its blocker from the 2026-10-18 W-row triage, updated for every move since.
"Built but wrong" means the code exists but the requirement, in the spec's words, is not met on a path production reaches.

| Group | Rows |
| --- | ---: |
| Code is ready; it waits on your production press (migrations and flags) | 58 |
| Waits on a decision from you | 77 |
| Needs both code and the press (code half not yet built) | 17 |
| Needs new schema (a migration), then the press | 8 |
| Needs a schema decision from you first | 2 |
| Buildable by code alone (not built, see reasons) | 3 |
| **Total** | **165** |

## 1. Code is ready; it waits on your production press (migrations and flags) (58)

| Row | Requirement | Waits on |
| --- | --- | --- |
| L1 | A dedicated Layover domain with one canonical operational truth | One canonical truth is derived (certifySessionFeasibility) but never persisted; storage 2700+2992 (+3623, +3792 which widens 2700's verdict CHECK) unapplied, persistence flag absent. |
| L4 | Unknown critical facts reduce confidence and may fail closed for landside recommendations | Confidence is computed; the fail-closed half for unknown baggage needs the declared constraint set (layover_constraints, 2992) behind 3640's gate; #624's fail-closed closures run only there. |
| L5 | Every consequential recommendation is versioned, explainable and replayable | Version, inputHash and replayFeasibility exist; nothing is stored to version or replay. |
| L6 | All surfaces consume the same certified LayoverSnapshot/RecommendationContract; no duplicate time-budget logic | Duplicate time-budget logic is gone; "all surfaces consume the same certified snapshot" needs a stored snapshot (consumerLayoverRecord reads it only when persisted). |
| L12 | Layover Session owns lifecycle, constraints, snapshots and state; must not own a generic city content catalog | Lifecycle (3632), constraints (2992+3640) and snapshots (2700/2992/3623) are all built in code and all on unapplied storage/FALSE flags. |
| L20 | Normalised operational tables + immutable/versioned snapshots; no single JSON blob as source of truth; JSON only for provenance/reason detail | Normalised tables done; immutable/versioned snapshot half is 2700/2992/3623 (immutability triggers written), unapplied. |
| L31 | layover_events (occurred_at, source, source_event_id, payload_json, dedup_key, processed_at) | The six members exist on layover_external_events (2860, applied) with writer and reader; W on the ingest flag (2981 unapplied). Lead's TABLE rule: also needs a producer (feed secret) to populate it. |
| L35 | BaggageMode = CHECKED_THROUGH \ | BaggageMode with UNKNOWN is layover_constraints.baggage_mode (2992), behind 3640's gate. |
| L36 | RiskBand = LOW \ | Census reason stale: RISK_BANDS/riskBandFor exist (services/layover/LayoverDecisionStore.ts:155,198) and persist to layover_return_plans.risk_band (2992); unapplied, persistence flag absent. |
| L37 | ConfidenceBand = HIGH \ | ConfidenceBand is computed, published, and consumed by the envelope's planning edge (§19.6); the missing half is a stored decision that turns on it (2700/2992 confidence columns). |
| L40 | EVALUATING → LANDSIDE_AVAILABLE: guard = entry allowed + no critical unknowns + usable ≥ floor + return contract satisfiable; side effects = create snapshot + safe envelope + candidate set | Guard built and fail-closed; snapshot it requires persists only behind 2992's gate, evaluation published only under 3632's FALSE flag. |
| L41 | EXECUTING → RETURN_SOON: threshold reached or risk worsened; side effects = high-priority notification, de-emphasise discovery | Android high-priority built; iOS high priority needs the owner's Apple Time Sensitive entitlement, signed-build/device verification (LAY-4a), then PUSH_IOS_TIME_SENSITIVE_ENTITLED=true. |
| L44 | * → DISRUPTED: material disruption; side effects = invalidate stale recommendations, replan, preserve audit trail | Replan invalidation built (lane 5). Needs the snapshot press + 3623's flag, and your ruling that clearing a card's citation counts as "invalidate". |
| L82 | Traveler observation — checkpoint timing, queue report, closure; confidence-weighted | Traveller observation channel exists (POST/GET /:id/observations; 2982/2983 applied); both routes sit behind layover_crowd_reports_enabled (3513 unapplied). "No submission surface" is stale. |
| L84 | TruthValue<T> { value, confidence, conflict, sourceClass, sourceRefs[], observedAt, expiresAt, fallbackLevel } | False green taken down: reachable only through the crowd-reports channel, closed until 3513 is applied. |
| L85 | Never silently merge contradictory gate/terminal/queue facts | As L84: inside `reconcile`, reachable only through the crowd-reports channel (3513). |
| L86 | Preserve source provenance and a conflict flag | As L84 (3513). |
| L87 | For safety calculations, prefer conservative values when credible sources disagree | As L84 (3513). |
| L88 | Community observations require plausibility checks, corroboration and decay | As L84 (3513). |
| L89 | Official data is not automatically truth when fresh contradictory evidence exists; contradiction increases uncertainty | As L84 (3513). |
| L92 | Normalise and deduplicate the external/internal event | Code wired in round 2 (validate + dedupe on the external path). Needs 2981, the ingest flag on, and the producer secret. |
| L93 | Identify impacted active sessions | Census reason stale: LayoverExternalReplanPort.ts fans out impacted sessions by airport (2986 indexes); the path is reachable only with 2981's flag ON and 2986 applied, and a producer. |
| L117 | Pins outside the certified action universe are hidden or visibly blocked | Blocked pins render; the band joins on rec.id, which exists only with layover_stable_recommendation_ids_enabled ON (2410 applied, flag FALSE). Plan stops can only come from a rec with an id, so no code-only join fixes it. |
| L122 | Map element Candidate pin — carries feasibility state from the recommendation contract | Same ceiling as L117 (join keyed on an id production does not issue). |
| L125 | Map element Blocked area — explain the reason, never imply safe fit | Reachable only once a pin is banded (L117's flag). |
| L127 | Aggregate presence is the default; identity and precise location are progressively disclosed only with consent | Consent gate enforced both sides; aggregate-first default needs 2740 + layover_presence_ladder_enabled. (Identity disclosure "only with consent" still leans on L130's mutual model.) |
| L128 | L0 aggregate only — "14 travelers connecting here" | disclosePresence serves aggregate-only only when the ladder flag is ON; 2740 unapplied. |
| L137 | Crew location sharing expires on dissolution, re-entry, boarding, session expiry or revocation | All five terminators + TTL now enforced by the wave-4 grant store (3996, unapplied, flag FALSE). |
| L147 | The abort action cancels optional itinerary state, marks the session RETURNING, surfaces the fastest certified route, notifies crew/buddy flows, preserves the offline route/deadline, and records the transition in the decision ledger | Abort built; RETURNING needs layover_safe_return_status_enabled ON (2741 applied, flag FALSE); ledger record needs 2700/2992; crew notify needs 3786 (+OQ-3). |
| L163 | Decision ledger — retained per safety/diagnostic policy; minimise direct personal data | Erasure + retention built; stays W until 3621 is applied (lead ruling), 3622 depends on it. |
| L172 | LayoverSessionService.updateConstraint(sessionId, patch) | updateConstraint built; constraint entity is 2992 behind 3640. |
| L174 | LayoverSessionService.close(sessionId, outcome) | Outcome arrives from the traveller and recordLayoverOutcome writes layover_outcomes (2992) behind the persistence gate. |
| L181 | AirportTruthService.reconcile(observations) | Observation routes refuse unless layover_crowd_reports_enabled is on; 3513 seeds it and is unapplied. |
| L187 | LayoverCrewService.updatePresence(sessionId, input) | updatePresence sets the spec's record (3900) behind layover_presence_intents_enabled + ladder flag, both FALSE. |
| L189 | LayoverDecisionService.explain(snapshotId) | explain route, app card and code built (round 2). Needs 2700 → 2992 → 3792 + the persistence flag. |
| L191 | LayoverDecisionService.replay(sessionId, engineVersion) | replay route and code built (round 2). Same press as L189. |
| L194 | 3. Create events + checkpoints with dedup indexes | External events dedup index applied and proven (2860); checkpoints with UNIQUE(session_id, dedup_key) are 2992, unapplied. |
| L195 | 4. Create recommendations + outcome tables | Recommendations exist; layover_outcomes is 2992 with a writer behind the persistence gate. |
| L196 | 5. Create presence/crew tables with restrictive policies and expiration jobs | Presence expiry sweep built (lane 5). Needs 3900 + layover_presence_intents_enabled. |
| L197 | 6. Create airport intelligence observation/truth tables if the existing intelligence schema cannot represent the required TTL/provenance cleanly | The table's only writer is the closed observation route (3513). |
| L198 | 7. Indexes for active-session lookup, session event ordering, unexpired presence, snapshot versioning and impacted-session event fanout | All five index families are written: airport fanout 2986, snapshot versioning 3623, unexpired presence 3900; none applied. |
| L199 | 8. Migration postconditions and authorization-contract tests for every client-writable table | Postconditions/contracts built; applying 3620 is owner decision L199-b, applied nowhere. |
| L200 | Users may read/write their own session inputs within allowed fields | Column-level write boundary is 3620, applied nowhere. |
| L206 | Every material recomputation creates a deterministic snapshot and decision record | Record computed and published on /overview; storage refused (2700/2992 unapplied, persistence flag absent). |
| L207 | DecisionRecord { sessionId, snapshotId, engineVersion, inputHash, inputFacts[], sourceRefs[], rulesApplied[], result, reasonCodes[], computedAt } | Code half built (lane 5): the replan cites the stored snapshot. Needs 2700 → 2992 → 3792 + the persistence flag. |
| L233 | Offline after leaving → cached return plan remains visible with a stale indicator | Cached plan visible offline with staleness; census holds it in the snapshot family on 2700. |
| L238 | Integration tests for event → replan → snapshot → invalidation → notification | Event→replan→invalidation→notification tested end to end; the snapshot stage needs 2700. |
| L240 | Deterministic replay tests for recorded sessions | Replay tests run on synthesised inputs; no recorded session (2700). |
| L241 | Decision-diff CI comparing old/new engine behaviour over historical/synthetic corpora | Synthetic decision-diff CI runs in check:all; historical half needs stored decisions. |
| L242 | Shadow mode in real environments before high-confidence rollout | Rollout modes built; 3784 unapplied, seeded legacy; shadow cohort is the owner's flip (OQ-L242-1, OQ-7). |
| L251 | Rate-limit and trust-weight community operational observations | Observation-channel rate limit and trust weighting: the channel is closed until 3513. |
| L252 | Outlier detection for implausible queue/transport claims | Outlier rejection inside `reconcile`: as L84 (3513). |
| L254 | Verified/trusted requirements for high-risk Buddy/marketplace interactions | The buddies list sits behind rent_buddy_enabled, which is FALSE in production. |
| L257 | Validate all external event payloads and deduplicate by stable source keys | As L92: 2981 + ingest flag + producer secret. |
| L263 | Duplicate events — unique dedup key / source event id | Dedup index applied and proven; W on the ingest flag (2981 unapplied). |
| L269 | Discovery — only show experiences from the certified action universe in Layover mode | Certified action universe gates Discovery; layover_discovery_mode_enabled FALSE (2971 applied) pending deployment verification. |
| L276 | Live Intelligence — consume crowd/queue/mobility signals; publish de-identified airport observations | Publish limb live (now behind 3513); consume limb behind layover_live_intersection_enabled (2851 unapplied). |
| L296 | C5. Never certify a recommendation against a snapshot other than the one returned with it | Snapshot pairing is built; cards carry no id until layover_stable_recommendation_ids_enabled is turned on (no migration). |

## 2. Waits on a decision from you (77)

| Row | Requirement | Waits on |
| --- | --- | --- |
| L11 | Trips owns flight segments / itinerary relationships / trip context; must not own layover safety calculations | No flight-segment model owned by Trips that a session references; Trips legs are never populated by a product surface (census-trips: no surface issues ADD_LEG); session link needs segment columns (L21). |
| L17 | Map visualises the certified envelope / recommendations / routes; must not own independent feasibility logic | Map draws the certified envelope ring; per-pin feasibility needs layover_stable_recommendation_ids_enabled ON and routes need the owner's routing-provider purchase (Q-R2-1). |
| L48 | if entry_permission_state != CONFIRMED_ALLOWED: forbid_landside_recommendations() | Entry state read and published; forbidding landside on not-CONFIRMED_ALLOWED is the owner's layover_entry_forbid_landside_enabled (3640, unapplied). |
| L50 | risk_band == UNSAFE ⇒ recommendation.status = BLOCKED | UNSAFE⇒BLOCKED needs owner decision L50-a (is BLOCKED "not rendered" or "rendered as refused"). |
| L54 | Estimate { valueMinutes, p50/p75/p90, confidence, sourceClass, observedAt, expiresAt, fallbackLevel, sourceRefs[] } | Estimate carries every member; distributions are degenerate because the only live term (liveConditions) has no producer. Feeding crowd observations into liveConditionsFrom is recorded as an owner decision (routes/airport.ts:2702); otherwise a feed purchase. |
| L55 | Safety-critical calculations use a configurable conservative percentile by data maturity/consequence; do not collapse to a single average | Same as L54: percentile selection is a no-op while every distribution is flat. |
| L60 | Bidirectional reachability: airport→candidate and candidate→airport under future return-time conditions | Bidirectional corridor wired; production legs are unmeasured: owner purchase decision on Google Routes (LAYOVER_ROUTED_CORRIDOR_ENABLED, Q-R2-1 owner-held) + layover_discovery_mode_enabled FALSE. |
| L61 | Time-based isochrone/envelope geometry, not a fixed radius | A disc, outer bound only; an isochrone needs routed travel times. |
| L63 | Envelope edges contract as confidence drops or return risk rises | Risk half done; the planning edge contracts on confidence but the proved (blocking) edge cannot by design. Either rule the planning edge satisfies "envelope edges", or a routed provider. |
| L65 | candidate_feasible iff outbound_arrival + minimum_experience_duration + conservative_return_duration <= hard_return_by | The travel term is an honest absence; a routed provider moves it. |
| L66 | SafeEnvelope = union(points satisfying the feasibility constraint) | SafeEnvelope is a superset, certifiedInward:false; the union needs routed geometry. |
| L67 | Map bands SAFE / TIGHT / BLOCKED | Server bands built; published only under 3633's FALSE flag, and SAFE rests on stated (not routed) minutes. |
| L68 | Multiple independent return routes → increase robustness / candidate preference | independentRouteCount reaches the verdict; no provider, probe or rollout enabled. |
| L69 | Single fragile corridor → increase risk penalty | Same wiring as L68. |
| L70 | Non-interruptible transport/activity → increase risk penalty | routeInterruptibility reaches the verdict; no provider enabled. |
| L71 | Transfer count → increase plan complexity/uncertainty | transferCountOf reaches the verdict; no provider enabled. |
| L77 | HARD GATE: eligibility + entry + time + safety, before any optimisation | Hard gate is eligibility+time+safety; the entry term is the owner's layover_entry_forbid_landside_enabled. |
| L78 | Optimise preference_fit + local_uniqueness + opportunity_scarcity + social_value + experience_density + memory_value − monetary_cost − energy_cost − uncertainty − stress − return_risk | §9.1 objective built, seeded legacy (3784 unapplied); 7 of 11 terms UNKNOWN by construction, 2 by OQ-6; scales are OQ-L78-1. |
| L80 | Operational semi-live — security layout, lounge hours, transport schedules; hours/days | No producer of security layout / lounge hours / transport schedules (operator data source). |
| L81 | Fast live — security wait, immigration wait, taxi queue, disruption; minutes | Fast-live facts reach the buffer via liveConditionsFrom, but nothing produces them; crowd->liveConditions is an owner decision, otherwise a feed. |
| L100 | Compass is an orchestrator and explainer: asks the minimum useful clarifying question, compares certified plans, personalises wording, invokes deterministic tools | Compass orchestration removed from the layover door by lead ruling L-CL02d (certified-only by construction). |
| L102 | Tool getLayoverContext(sessionId) | Tool removed from the layover door by L-CL02d. |
| L103 | getConnectionState(sessionId) | Tool removed by L-CL02d. |
| L104 | getTimeWallet(sessionId) | Tool removed by L-CL02d. |
| L105 | getSafeEnvelope(sessionId) | Tool removed by L-CL02d. |
| L106 | getReachableExperiences(sessionId) (≡ §18 getCandidates… counted here as the tool; the service method is L182) | Tool removed by L-CL02d. |
| L107 | simulatePlan(sessionId, candidateSet) | Tool removed by L-CL02d. |
| L108 | getReturnContract(sessionId) | Tool removed by L-CL02d. |
| L109 | getAirportState(sessionId) | Tool removed by L-CL02d. |
| L110 | getCrewCandidates(sessionId) | Tool removed by L-CL02d. |
| L111 | requestConstraintClarification(sessionId, field) | Tool removed by L-CL02d. |
| L112 | replan(sessionId, trigger) | replan no longer exists on the layover door (L-CL02d); last row line (3917) still says "one flag decision". |
| L113 | explainDecision(snapshotId \ | Tool removed by L-CL02d. |
| L115 | Map consumes the active snapshot and envelope geometry; does not recalculate feasibility | Map consumes the return posture; no envelope geometry (needs routing) and no active snapshot (2700). |
| L116 | Show safe/tight/blocked geography from certified envelope versions | Only BLOCKED/UNCERTIFIED have a producer; SAFE/TIGHT on the envelope need routed travel time. |
| L118 | Changing time-budget chips triggers simulation/replanning, not local visual filtering alone | Server simulation built; flags 3785/3633 FALSE and the minutes behind a band are stated, not routed (+ OQ-L118-3/4/5 defaults). |
| L119 | The primary route always includes the return leg and the return deadline | Return leg and deadline render; no line without a routed provider. |
| L120 | When RETURN_NOW is active, suppress exploration-first affordances and prioritise airport route/gate | Suppression + CTA + directions built; gate/terminal context is null on every production airport (data). |
| L121 | Map element Safe envelope — dynamic isochrone/polygon that contracts as conditions worsen | Two-ring diagram; an isochrone/polygon needs routing. |
| L139 | Shared rides require opt-in and must avoid revealing the full itinerary to unrelated users | sharedRideDisclosure exists; there is no shared-ride concept in the product to disclose. Product decision (and schema if yes). |
| L143 | …terminal/gate context is pinned | Pinning code reaches the API; 0 of 3,206 production airports carry terminal_info (data curation). |
| L144 | …crew/buddy is notified if policy + settings allow | Built behind layover_crew_abort_notify_enabled (3786, FALSE); the disclosure itself is open owner question OQ-3; buddy half has no layover↔booking link. |
| L151 | Map — cache airport + selected route/area | Airport + certified area cached and rendered offline; no route half without a routed provider. |
| L157 | Adaptive sensing: low frequency when safe/stationary, moderate near decision boundaries, navigation-appropriate during RETURNING; avoid continuous GPS | sensingPolicy exists; the layover surface does no sensing, and lead ruling L164 keeps it off the location prompt. Adaptive sensing contradicts that ruling unless revisited. |
| L175 | LayoverFeasibilityService.evaluate(sessionId) | /safety certifies through evaluate() (round 2). Also needs /overview to do the same (a lead decision with hot-path costs), then the press. |
| L178 | TemporalFreedomService.calculateCommitmentEnvelope(context) | calculateCommitmentEnvelope has no production caller by §18's own refusal; §23.3 files it as an owner decision. If ruled "route the published [hardReturnTime, cutoff] band through it", S work in Lane A's files. |
| L180 | AirportTruthService.getTruth(subject, factType, atTime) | Store-reading getTruth built (lane 5). Needs 3513 and your L81 ruling on whether stored observations feed the safety path. |
| L202 | Presence is readable only according to visibility scope and safety policy | Presence scope is app-level on the service client; lead ruling 2026-10-07 (L205): no user-scoped PostgREST client this release. |
| L204 | Aggregated airport intelligence must not leak raw user identifiers | Aggregate carries its own no-identifier guard; its only consumer is the maturity gate behind 2977 (unapplied) whose flip is the L243 owner decision. |
| L205 | Service-role processing should be narrow and auditable | Lead ruling 2026-10-07: no architecture change this release; service client with per-route authorization. |
| L208 | Metric layover_sessions_detected | Counter derivable and reported on the admin route; no exporter bound (OQ-8). |
| L212 | Metric replan_rate | Replan ledger rows carry counts.replanned; the route still answers UNPRODUCIBLE (no replan literal) and nothing exports (OQ-8). Computing the rate from ledger metadata is code, but does not move it without OQ-8. |
| L214 | Metric safe_return_completion_rate | Needs a return-completion record (layover_outcomes, 2992 + persistence) AND an exporter (OQ-8). |
| L215 | Metric stale_fallback_rate | Emission + admin rate built; no exporter (OQ-8); rate half needs persistence. |
| L216 | Metric recommendation_contract_violation, target 0 | Monitor checks every generated card; no exporter (OQ-8, OQ-L216-1), only the card's subset of L76, snapshot half needs 3623 ON. |
| L220 | 4h international, visa allowed → potential landside depending on airport model | §21.1 scenario holds on the engine; no production airport is curated (data). |
| L221 | 6h visa-free → landside + return contract | Return contract published; route is hard-null (no routing provider). |
| L223 | Overnight → overnight state / expanded options | Overnight state covered; "expanded options" need lodging/lounge data (none in discovery_places or airport_profiles). |
| L227 | Security spike → envelope contracts monotonically | Contraction swept on the solver; no security wait reaches a session (live producer). |
| L228 | Traffic spike → return deadline moves earlier | Separate live traffic term built; no producer. |
| L236 | Database tests against a real CI schema for column names, enum literals, RLS and migration postconditions | layoverClientBoundary.db.test.ts is registered and runs in CI's api-server-local-db job; whether that local replay counts as "a real CI schema" is the lead's U-1 call (§40.4 says a replay is not). Also needs a green CI run. |
| L239 | E2E tests for detection → evaluation → plan → execution → return → completion | Five of six stages over the real router; detection has no producer (flight feed or Trips-leg connection detection). |
| L243 | L0 Generic — static airport + conservative generic timing; airport-side guidance only by default | Should the generic rung WITHHOLD landside guidance (every production airport is L0)? |
| L246 | L3 Portava observed — recent Portava operational observations available | Portava-observation count reaches the ladder behind the absent maturity flag (2977); external live signals still zero. |
| L249 | Enable features per airport maturity | featureAllowedAt consumed; enabling it IS the L243 decision (flag via 2977, unapplied). |
| L259 | Replan fanout — index active sessions by airport/route/flight subjects; recompute impacted sessions only | Airport axis indexed (2986); route/flight subjects need session route/flight columns that nothing can populate (no flight data). Census: inventing one is the wrong order. |
| L260 | Candidate explosion — pre-filter by envelope/time/category before expensive ranking | Pre-filter is on the certified envelope; the "envelope geometry" half needs routing, and the ranking it protects (L78) is seeded legacy (3784). |
| L267 | Trips — detect connection; show Layover card/status; pass flight segments into session creation | Card, pill and trip link built; nothing detects a connection and no flight segment exists to pass (Trips legs unpopulated). |
| L268 | Compass — tool access to certified context; proactive OpportunityEvents; explanation/clarification | Tools removed from the layover door by L-CL02d; OpportunityEvents (L98) and clarification (L114) are C. |
| L270 | Map — safe envelope, plan route, return state, airport digital-twin layers | Map has envelope ring and return state; plan route needs routing; digital-twin layers need airport topology data. |
| L273 | Rent a Buddy — layover-specialist services after the safety/time gate; strict boundaries | Gate built; no `layover` category in Rent-a-Buddy's vocabulary (text[] column, no migration needed) - adding/granting one is the Rent-a-Buddy owner's call; rent_buddy_enabled FALSE. |
| L281 | SECURITY_WAIT_HIGH | SECURITY_WAIT_HIGH is emitted only by liveConditionsFrom, which no production producer feeds. |
| L282 | RETURN_ROUTE_UNRELIABLE | RETURN_ROUTE_UNRELIABLE wired; no provider/probe enabled. |
| L285 | DATA_STALE | DATA_STALE emitted only from liveConditionsFrom (LayoverAirportTruth.ts:681); no producer. |
| L286 | SOURCE_CONFLICT | SOURCE_CONFLICT emitted only from liveConditionsFrom (:679); no producer. |
| L287 | TRAFFIC_DEGRADED | TRAFFIC_DEGRADED emitted only from liveConditionsFrom (:678); no producer. |
| L295 | C3. Never let a test fixture assert impossible production joins; live-schema/literal checks must cover safety-critical query paths | Fixture half closed (embed guard incl. PGRST201); the real-CI-schema half is the lead's U-1 grading call. |

## 3. Needs both code and the press (code half not yet built) (17)

| Row | Requirement | Waits on |
| --- | --- | --- |
| L39 | The declared state graph (DETECTED → … → COMPLETED, plus DISRUPTED/CANCELLED/EXPIRED) | 17-state graph built and shadowed. Code part (groundwork): produce DEPARTURE_CANCELLED from POST /:id/disruption kind=cancellation and BOARDING_STARTED from the traveller's "I made my flight" close. Blocked: 3632 flag FALSE, DEPARTURE_CONFIRMED needs a flight feed. Code alone does NOT move it. |
| L46 | The subtraction ladder: scheduled − deplane − immigration/customs − baggage − exit friction − outbound − return (future conditions, not symmetric) − security/re-entry − terminal transfer − boarding buffer − contingency = usable | Code part: split estimateExitDelay into deplane/immigration/baggage/exit terms (groundwork). Blocked: outbound/return transport terms need a routed provider. Code alone does NOT move it. |
| L56 | A generalised engine answering "what can this user do before they must be somewhere else" | Code part: pass a current-position origin (airport point) into the engine (groundwork). Blocked: "world conditions" have no producer (L81 ruling). Code alone does NOT move it. |
| L58 | FreedomWindow { beginsAt, endsAt, origin, requiredDestination, usableMinutes, hardConstraints, softConstraints, riskBudget, uncertaintyBudget, confidence } | 7 of 10 members reach the layover. uncertaintyBudget can be carried from ENVELOPE_UNCERTAINTY_BUDGET (LayoverEnvelope.ts:132, added after §18.8) - code. riskBudget and softConstraints have no definition: ruling. Code alone does NOT move it. |
| L73 | Offline risk → require cached route + deadline before departure where possible | Deadline and plan/area cached before leaving. Code part: REQUIRE the cache before a landside departure (groundwork). Route half needs a routed provider. Code alone does NOT move it. |
| L74 | The planner generates executable experiences, not place cards; a recommendation is a contract carrying time, return, risk and failure information | Recommendations are typed cards, not contracts. Code part: put fallbackPlan/abortThreshold/failureModes/confidence/reasonCodes on the card (groundwork). departBy/leaveActivityBy/expectedAirportReturn need routed legs. Code alone does NOT move it. |
| L76 | LayoverRecommendationContract { snapshotId, departBy, estimatedArrival, minExperienceMinutes, idealExperienceMinutes, leaveActivityBy, expectedAirportReturn, hardReturnBy, returnBufferMinutes, riskBand, confidence, fallbackPlan, abortThreshold, failureModes[], reasonCodes[] } | Same contract: 7 members absent; 5 computable from the certified record now, the travel-derived ones need routing, snapshotId needs 3623. Code alone does NOT move it. |
| L79 | Static topology — terminal, gate, checkpoint, walking link; weeks/months, invalidated on authoritative change | Topology types + TTL exist. Code part: invalidate on authoritative change (admin edit) - groundwork. Blocked: terminal_info null on all 3,206 production airports (data curation). Code alone does NOT move it. |
| L83 | Historical model — time-of-day distributions, recalibrated | Bands built; "recalibrated" not built. Code part: recalibration from measured error (groundwork). Blocked: no observations (3513) and no outcomes (2992). Code alone does NOT move it. |
| L97 | Invalidate recommendations whose snapshot is stale or no longer feasible | Staleness and feasibility tests exist; nothing applies them. Code part: apply noLongerFeasible (groundwork). Stale half needs snapshot_id (3623) and layover_stable_recommendation_ids_enabled. Code alone does NOT move it. |
| L154 | Crew — cache meeting point; optional peer proximity | Meeting point cached (spec: "optional peer proximity if enabled"). Peer proximity now exists online behind 3996 (FALSE). Code part: cache the proximity bucket when enabled (groundwork). Code alone does NOT move it; lead may re-read "if enabled". |
| L176 | LayoverFeasibilityService.certifyRecommendation(sessionId, candidatePlan) | Code part: certifyRecommendation(sessionId, candidatePlan) entry point (groundwork). Per-recommendation stored contract needs 3623 + layover_recommendation_snapshot_enabled. Code alone does NOT move it. |
| L182 | LayoverExperienceService.getCandidates(sessionId) | getCandidates exists; §17.6: a disclosed provenance is not an executable-experience contract. Moves with the L76 contract (routing-blocked). Code alone does NOT move it. |
| L183 | LayoverExperienceService.compile(sessionId, candidateIds) | compile builds an ordered itinerary + fit; abortThreshold/fallback are code (groundwork), route/departBy need routing. Code alone does NOT move it. |
| L247 | L4 Calibrated — prediction errors measured, model calibrated by airport/time band | measureCalibration measures only. Code part: apply calibration (groundwork). Blocked: no outcomes (2992) and no observations (3513) to calibrate against. Code alone does NOT move it. (§72.5 prose says "L247 stays N" — inconsistent with its W row.) |
| L272 | Safe Return — reuse escalation/return UX; Layover provides certified deadlines and state | Return alerts + return-now exist; reuse of the Safe Return PRODUCT's escalation UX is not built. Code part (L): offer a Safe Return session from a landside layover using the certified deadline. Blocked: returning state needs layover_safe_return_status_enabled; contacting trusted contacts from a layover is a product call. Code alone likely does NOT move it. |
| L294 | C2. Never swallow a schema/data error into plausible empty operational state without structured logging and degraded confidence | Typed read convention + guard; 8 of 12 reads migrated. Code part: markReturning and readLayoverLive (no client-visible change) - groundwork. evaluateSharingGate and landsideMaturityDecision change served meaning (owner item, wave5 doc). Code alone does NOT move it. |

## 4. Needs new schema (a migration), then the press (8)

| Row | Requirement | Waits on |
| --- | --- | --- |
| L14 | Airport Intelligence owns airport operational facts + provenance + TTL; must not own user social identity | airport_profiles facts are bare values (no provenance, no TTL). §13.1's "gated on 2700/2860" is stale (2860 applied); the gap is provenance+TTL on the facts the engine reads. Proposed 3874; C on press only if the admin airport writer stamps provenance and the lead accepts a TTL policy for static facts. |
| L21 | layover_sessions (id, user_id, trip_id, airport_place_id, arrival/departure_segment_id, state, connection_type, detected_source, started_at, expires_at, active_snapshot_id, confidence_band) | layover_sessions lacks arrival/departure_segment_id, connection_type, detected_source, expires_at, active_snapshot_id, confidence_band, state. Proposed 3870. Not C on press: segment ids and detection have no producer (L11/L267). |
| L26 | layover_recommendations (snapshot_id, candidate_type, status, plan_json, utility_score, risk_band, confidence, expires_at) | layover_recommendations lacks plan_json, utility_score, risk_band, confidence, expires_at and a spec status (snapshot_id is 3623). Proposed 3871. Not C on press alone: needs 3623+persistence and the L78 objective out of legacy mode. |
| L33 | LayoverState — 17 members from DETECTED to EXPIRED | The 17-state graph exists (LayoverLifecycle.ts) and is published only under 3632's FALSE flag; the stored status is still a 5-value CHECK. Proposed 3870 adds a lifecycle_state column written by the projection; C after press of 3870 + 3632 flip. |
| L38 | RecommendationStatus = ELIGIBLE \ | layover_recommendations.status is a moderation vocabulary; no ELIGIBLE/TIGHT/BLOCKED/STALE/EXPIRED column anywhere. Proposed 3871 (with L26). STALE needs 3623+persistence; C after that press. |
| L134 | Explicit split plans (A leaves at T1, B/C continue to T2) | Solver supports split plans; crews are live (2984 applied, §68), so the "no crew" limit is stale. Missing: a crew itinerary/branch store and a surface to propose a split. Proposed 3872. C after press if the crew card ships with it. |
| L135 | Crew plan certified against every member branch | certifyCrewPlan runs live only on the EMPTY unsplit plan; a real crew plan needs the same 3872 store. C after press with L134. |
| L264 | Race conditions — version/compare-and-swap the active snapshot; reject stale writes | .eq("status","active") guard exists; no CAS on an active snapshot. Proposed 3873: active_snapshot pointer + expected-version insert (depends on 2700/2992/3623, all below). C after press of 2700/2992/3623/3792/3873 + persistence. |

## 5. Needs a schema decision from you first (2)

| Row | Requirement | Waits on |
| --- | --- | --- |
| L130 | L2 mutual discovery — profiles visible under policy | Reciprocity is one global toggle; a per-pair mutual opt-in needs a pair-consent table whose design (request/accept vs intent match) is a product decision. If built on layover_presence (3900) it cannot use 3870-3899; key it on layover_sessions. |
| L192 | 1. Create enum types and the core layover_sessions table with RLS | "Create enum types": every vocabulary is TEXT+CHECK by repo convention. Converting live tables to PostgreSQL enum types is a schema-convention decision for the owner/lead (and a 22P02 risk class). |

## 6. Buildable by code alone (not built, see reasons) (3)

| Row | Requirement | Waits on |
| --- | --- | --- |
| L15 | Experience Compiler owns executable plans from feasible actions; must not own visa/entry legal truth | Stated W reason ("nothing reads entry_requirements/traveler_passports") is false: services/airport/layoverEntryGate.ts reads lib/entryRequirements (passport_entry_intelligence_enabled TRUE). Re-derive + pin that plan/plan-fit code imports no entry truth. |
| L94 | Recompute only the affected constraint nodes | Node map and skip are real; recompute re-certifies the whole record (one atomic derivation). Decompose certification into node-level recomputation. One row for a large refactor of the safety derivation; not laned. |
| L155 | Translation — cache context phrases required by the active plan | Static phrase catalogue exists; W only for coverage (single-language countries) and phrases keyed to the return, not each stop. Add per-stop phrases from the plan's stops and a policy for multi-language countries. |
