# LANE REPORT — LO-SERVER

Worktree `/home/user/wt-lo-server`, branch `lane/lo-server`, based on `561a0a7b0`.

**Current verdicts are NOT read out of the census body.** Every value in the
"current" column is the output of the census's own parser, which takes the LAST
statement of a row in an append-only document:

```
cd artifacts/api-server
CENSUS_INTEGRITY_DUMP=ALL npm run check:census-integrity 2>/dev/null | grep '^layover|'
```

296 rows parsed, 296 expected. I did not edit `docs/architecture/census-layover.md`
(it is outside my ownership), so a second dump is byte-identical to the first;
the moves below are proposals for whoever owns that document, not edits I made.

**Production facts used, with their source — I hold no database credentials.**
`src/lib/capability/snapshots/20260922-production-schema.json` (watermark
`20260922155706`, 497 tables, 201 flags) and
`src/lib/capability/production-applied-migrations.json`. Measured from those:
2860, 2982, 2983, 2984, 2985, 2971, 2741, 2335, 2410, 2510 **applied**;
2700, 2740, 2851, 2992, 2993, 2994 **not applied**. `airport_fact_observations`
is live with `observed_at`, `expires_at`, `observer_kind`, `observer_id`,
`observer_trust`, `source_ref` and `submission_token`.
`layover_recommendations` has no snapshot, hash or version column.

---

## VERDICT TABLE

| row | current | mine | evidence |
| --- | --- | --- | --- |
| L5 | W | W | No version/hash column on `layover_recommendations` in the production snapshot (`snapshots/20260922-production-schema.json`); 2700 unapplied. Unchanged. |
| L14 | W | W | **Reason corrected.** "It holds no provenance and no TTL" is true of `airport_profiles` only — Airport Intelligence now owns an APPLIED fact store with both (`airport_fact_observations`: `observer_kind`/`source_ref`/`expires_at`). The buffers a deadline uses still come from `airport_profiles`, which has neither. |
| L15 | W | W | Entry truth still unread anywhere under `services/airport/` or `routes/airport.ts`. Unchanged. |
| L27 | N | N | Re-tested: no `layover_presence` table in any migration; `2740_layover_presence_ladder_flag.sql:1` is a flag, not storage. |
| L33 | W | W | `layover_safe_return_status_enabled` is FALSE in the production snapshot. Unchanged. |
| L35 | W | W | `layover_sessions.checked_bags` is still a boolean in the production snapshot — `UNKNOWN` unrepresentable. |
| L36 | W | W | `SafetyRating` unchanged (`LayoverSafetyEngine.ts:11-15`). |
| L37 | W | W | `ESTIMATE_CONFIDENCES` still published and consumed by no decision. |
| L38 | W | W | `layover_recommendations.status` vocabulary unchanged in the snapshot. |
| L39 | N | N | Three transitions of a 17-state graph. Unchanged. |
| L40 | N | N | No state, no guard, no snapshot. The landside gate now reads `usableMinutes` and maturity, still not an entry guard (`LayoverRecommendationService.ts:502`). |
| L41 | W | W | Nothing fires at RETURN_SOON. Unchanged. |
| L43 | N | N | No checkpoint model — `layover_checkpoints` exists only in unapplied 2992 (`LayoverDecisionStore.ts:7`). |
| L44 | W | W | `invalidateRecommendations` still DECIDES with nothing to apply it against (no snapshot column). My replan port passes NO held recommendations for exactly that reason (`LayoverExternalReplanPort.ts` header). |
| L46 | W | W | Ladder terms unchanged. |
| L48 | N | N | Re-tested: no read of `entry_requirements` or `traveler_passports` under `services/airport/` or `routes/airport.ts`. |
| L49 | N | N | Same family. |
| L50 | W | W | Envelope blocks the certainly-unreachable; `not_recommended` cards still generated. Unchanged. |
| L54 | W | W | Provenance is still `STATIC_DEFAULT` everywhere. |
| L55 | W | W | Same. |
| L56 | W | W | Engine adapter unchanged. |
| L57 | W | W | `EngineCommitment` unchanged. |
| L58 | W | W | `LayoverWindow` unchanged. |
| L59 | W | W | Adapter boundary unchanged. |
| L60 | W | W | `LAYOVER_ROUTED_CORRIDOR_ENABLED` affirmative nowhere; my gate reads the same env through the same helper (`layoverMaturityGate.ts#routedTransportModelAvailable`). |
| L61 | W | W | Disc, not isochrone. Unchanged. |
| L63 | W | W | Edge still does not read confidence. |
| L64 | N | N | No snapshot/version column on `layover_recommendations` (production snapshot). I did NOT add one: a column from an unapplied 2977 would fail at runtime on every live database. |
| L65 | W | W | Travel term still `unmeasured`. |
| L66 | W | W | `certifiedInward: false` unchanged. |
| L67 | N | N | Client map bands — out of my ownership (`travel-buddy-standalone/**`). |
| L68 | W | W | Wired and gated; unchanged by this lane. |
| L69 | W | W | Same. |
| L70 | W | W | Same. |
| L71 | W | W | Same. |
| L72 | N | N | Return is asked as its own corridor only when the corridor provider is enabled, which it is nowhere. Unchanged. |
| L73 | N | N | Nothing cached. Unchanged. |
| L74 | W | W | Recommendations are still cards. Unchanged. |
| L75 | N | N | `rec_type` CHECK unchanged in the snapshot. |
| L76 | W | W | `SafeRecommendation` unchanged. |
| L77 | W | W | Gate is now eligibility + time + safety + **maturity** (`LayoverRecommendationService.ts:495,502`) and still not ENTRY. Three of four is not four; the row's own rule holds it at W. |
| L78 | N | N | Still a sort key, not an objective function. |
| L79 | W | W | Re-tested: `terminal_info` has NO writer anywhere under `src/` (only reads, `AirportProfileService.ts:146`). |
| L80 | W | W | Re-tested: no producer of `security_layout` / `lounge_hours` / `transport_schedule`. |
| L81 | W | W | Re-tested: `liveConditionsFrom` has NO caller outside `src/test/`. Travellers may submit only the three `TRAVELER_OBSERVATION` types, which do not feed it. |
| L82 | W | W | **Reason is FALSE and corrected.** "There is NO SUBMISSION SURFACE — no route" — there is: `routes/airport.ts:2768` POST, gated only by `airport_mode_enabled` (TRUE in production), plus a live reconciled GET at `:2731`. Held at W because the class still reaches no decision (L81) and I could not verify a client screen (`travel-buddy-standalone/**` is outside my ownership). |
| L83 | W | W | **Evidence corrected**: `buildHistoricalModel` now has a non-test caller (`LayoverObservationAggregate.ts:276`) over a real corpus. Still W: "recalibrated" is not built — `measureCalibration` adjusts nothing and has no caller. |
| L93 | W | W | The airport FANOUT the row says is missing is now built (`LayoverExternalReplanPort.ts#readGroups`) and tested, but has no caller at my HEAD — the consumer is on another lane's branch. W, unchanged, with the half that moved named. |
| L94 | W | W | Node map unchanged; my port supplies inputs only. |
| L97 | W | W | Still wholesale delete-and-reinsert; no per-card certification to invalidate against (L64). |
| L99 | W | W | `shouldNotify` decides; my port reports the count and delivers nothing. |
| L112 | W | W | `replan(sessionId, trigger)` still has no named entry point; the external trigger now has an implementation and no caller. |
| L127 | W | W | Presence is not aggregate-first. Unchanged. |
| L128 | W | W | `layover_presence_ladder_enabled` has no row (2740 unapplied). Unchanged — and it is the convention I graded L204/L246/L249 by. |
| L129 | N | N | No intent model. Unchanged. |
| L130 | W | W | Reciprocity still a single global toggle. |
| L131 | N | N | `layover_crews` exists (2984 applied) but this row is chat/meeting point. Unchanged. |
| L132 | N | N | No location sharing in the layover path. |
| L133 | W | W | `sharedReturnBy` unchanged. |
| L134 | W | W | `CrewBranch` unchanged. |
| L135 | W | W | `certifyCrewPlan` unchanged. |
| L137 | W | W | `CrewShareEndReason` unchanged. |
| L139 | W | W | `sharedRideDisclosure` unchanged. |
| L147 | W | W | Flag FALSE in the production snapshot. |
| L148 | W | W | `DISRUPTION_STATES` unchanged. |
| L149 | W | W | `recomputeForDisruption` unchanged. |
| L158 | N | N | No precise location data. Unchanged. |
| L159 | N | N | No checkpoints (2992 unapplied). |
| L160 | N | N | No flight cache — the flight port refuses everywhere (`lib/providers/flightItineraryProvider.ts`). |
| L161 | N | N | **Reason narrowed, verdict held.** "No aggregate airport timing is ever produced" is now false — `LayoverObservationAggregate` produces per-local-hour p50/p75/p90 bands. It is not RETAINED after de-identification: the bands are computed per request and stored nowhere, so the retention rung this row scores is still absent. |
| L163 | W | W | `layover_events.user_id` still NOT NULL REFERENCES profiles. Unchanged. |
| L164 | N | N | No location permission request in the layover path. |
| L166 | N | N | No precise sharing to control. |
| L168 | N | N | Unguarded absence, unchanged. |
| L169 | N | N | Re-tested: `flightItineraryProvider` is a port in `lib/` whose only importer is `src/test/flightFeedContract.test.ts`. No feature-surface caller ⇒ N by the stated rule. |
| L172 | W | W | No constraint entity. Unchanged. |
| L173 | N | N | `recordCheckpoint` has no store — 2992 unapplied. |
| L174 | W | W | `layover_outcomes` absent. Unchanged. |
| L175 | W | W | No session-scoped `evaluate`. Unchanged. |
| L176 | W | W | No `certifyRecommendation` entry point. Unchanged. |
| L178 | W | W | `calculateCommitmentEnvelope` still has no caller outside `src/test/`. |
| L180 | W | W | Re-tested: `getTruth(` appears outside `LayoverAirportTruth.ts` only at `src/test/layoverAirportTruth.test.ts:515`. No caller ⇒ W holds. |
| L181 | W | **C** | The row's ONLY stated reason for W is "a named service operation with no caller". **It has one, and it is reachable in production**: `reconcileAirportFact` (`LayoverObservationService.ts:308`) calls `reconcile`, and `routes/airport.ts:2747` calls it inside `GET /airport/sessions/:id/observations`, whose only gate is `airport_mode_enabled` (`routes/airport.ts:2359`), TRUE in the production snapshot. The five §10.1 rules and the signature match are the census's own measurement and are unchanged. |
| L182 | W | W | Still a candidate set of cards. Unchanged. |
| L183 | W | W | Compiles no route. Unchanged. |
| L187 | W | W | `setShareStatus` updates one boolean. Unchanged. |
| L189 | W | W | Explains a live computation, not a snapshot. |
| L190 | N | N | No snapshots — 2700 unapplied. |
| L191 | W | W | No stored ledger row to replay from. |
| L197 | W | **C** | The requirement is *"create airport intelligence observation/truth tables IF the existing intelligence schema cannot represent the required TTL/provenance cleanly"*. `airport_fact_observations` is that table, it is **APPLIED to production** (manifest + schema snapshot), and it carries TTL (`observed_at`/`expires_at`, with the class TTL applied on top by `screenObservations`) and provenance (`observer_kind`, `observer_id`, `observer_trust`, `source_ref`). It has a live writer (`routes/airport.ts:2797`) and a live reader (`:2747`). The current W reason — §17.5's "Gated on 2700 or 2860" — is FALSE for the 2860 half. |
| L202 | W | W | Presence policy still application-level only. Unchanged. |
| L203 | N | N | Crew tables exist (2984) but no location grant store. Unchanged. |
| L204 | N | **W** | **Built.** `services/layover/LayoverObservationAggregate.ts` is the aggregate and its guard: a type with no member that can hold an identity, `assertNoObserverIdentifiers` (`:166`) throwing on a `tv1-` handle / bare UUID / row id under ANY key with `airportRef` exempted by path, and a distinct-observer floor (`:98`) above the sample floor. The prohibition is no longer an UNGUARDED absence. `W` and not `C` because the aggregate's only feature-surface consumer is the maturity gate, which is behind `layover_maturity_gate_enabled` seeded FALSE — L128's convention, restated in §38. |
| L206 | W | W | 2700 unapplied. Unchanged. |
| L207 | W | W | Same. |
| L208 | W | W | Still no emitter, exporter or `report*` script for layover. |
| L209 | N | N | Nothing certified is stored to count. |
| L210 | N | N | `computeLayoverMetrics` has no caller outside `src/test/` (re-tested); no critical-unknown decision is recorded. |
| L211 | N | N | Same. |
| L212 | W | W | Unchanged. |
| L213 | N | N | Same as L210 — no stored decision to count over. |
| L214 | W | W | Unchanged. |
| L215 | N | N | `stale_fallback_rate` needs a stored decision with `inputFacts`; 2700 unapplied. |
| L216 | N | N | Re-measured directly: `layover_recommendations` in the production snapshot has no snapshot/hash/version column, so there is no contract to violate. |
| L217 | N | N | No stored ledger rows to replay. |
| L227 | W | W | Unchanged. |
| L228 | W | W | Unchanged. |
| L231 | W | W | Unchanged. |
| L232 | W | W | Unchanged. |
| L233 | N | N | Client offline cache — outside my ownership. |
| L240 | W | W | Replay over synthesised inputs only; nothing recorded to replay from. |
| L243 | W | W | **Reason is FALSE and corrected.** "`LayoverRecommendationService.ts:244-246` gates on time and preference, NEVER on data maturity" — it gates on maturity now (`:495`, `:502`, `:520`). Held at W: the gate is seeded FALSE, so a generic airport still gets landside cards on every database. |
| L244 | N | N | Re-tested: nothing writes `terminal_info`; no transport model (corridor provider enabled nowhere). |
| L245 | N | N | Re-tested: nothing produces `LiveConditions` outside tests; `airport_profiles` has no feed column. |
| L246 | N | **W** | The L3 signal is now PRODUCED and CONSUMED: `AirportObservationAggregate.maturityObservationCount` (`LayoverObservationAggregate.ts:138,301`) reaches `MaturitySignals.portavaObservationCount` through `maturitySignalsFor` (`layoverMaturityGate.ts:141`), and `MATURITY_LEVEL_REACHABILITY.L3_PORTAVA_OBSERVED` is now `reachable: true` on measured grounds (`layoverMaturity.ts:190`). W not C: the consumption is behind the FALSE flag, and I cannot measure how many observation rows production actually holds. |
| L247 | W | W | Re-tested: `measureCalibration(` outside its own file appears only at `src/test/layoverAirportTruth.test.ts:664,667`. Still measures only. |
| L248 | N | N | One self-reported input is not dense live intelligence. Unchanged. |
| L249 | N | **W** | **Built.** `layoverMaturityGate.landsideMaturityDecision` (`layoverMaturityGate.ts:195`) is the first consumer `featureAllowedAt` has ever had, and `generateRecommendations` applies it to BOTH landside gates (`LayoverRecommendationService.ts:495, 502, 520`) and records the rung in the audit event (`:847`). Behind `layover_maturity_gate_enabled`, seeded FALSE by `2977_layover_maturity_gate_flag.sql` ⇒ W, not C. |
| L259 | W | W | The fanout now exists (`LayoverExternalReplanPort.ts#readGroups`); the INDEX does not. `layover_sessions` has `(user_id, status)` and `(departure_time)` only — no airport-subject index. See NOT DONE (b). |
| L260 | W | W | Pre-filter is on the certified envelope; no envelope geometry. Unchanged. |
| L264 | W | W | Re-tested: no `CREATE TABLE layover_snapshots` in `src/migrations/`. CAS guard unchanged. |
| L276 | W | W | Unchanged (§36's move stands; both limbs verified again at this commit). |
| L277 | N | N | No crew proximity. Unchanged. |
| L279 | N | N | `BAGGAGE_STATUS_CRITICAL_UNKNOWN` is still unemittable: `layover_sessions.checked_bags` is a NOT NULL boolean in the production snapshot, so "unknown" has no representation. I did NOT invent one. |
| L281 | W | W | `SECURITY_WAIT_HIGH` still only from `liveConditionsFrom`, which nothing calls. |
| L282 | W | W | Unchanged. |
| L283 | N | N | `AIRPORT_CHANGE_REQUIRED` has no input: a session carries ONE airport and there is no itinerary model. |
| L284 | N | N | `SELF_TRANSFER_FRICTION` has no input: nothing records separate bookings. |
| L285 | W | W | **Reason narrowed.** "Each needs an airport-truth fact, and this pass built no fact producer" is now false — a producer exists for the `TRAVELER_OBSERVATION` class. It is the wrong class: `DATA_STALE` is emitted only by `liveConditionsFrom`, which nothing calls. |
| L286 | W | W | Same as L285. |
| L287 | W | W | Same as L285. |
| L296 | N | N | `layover_stable_recommendation_ids_enabled` is FALSE in the production snapshot and in `lib/capability/layover-cutover-measurement.json:9`. |

**Moves proposed: 5.** L181 W→C, L197 W→C, L204 N→W, L246 N→W, L249 N→W.
Net effect on the §39 headline if accepted: C 79 → 81, W 131 → 132, N 86 → 83.

---

## BUILT

### 1. `artifacts/api-server/src/services/layover/LayoverObservationAggregate.ts` (new) — bears on L204, L161, L83, L246

The de-identified per-airport observation aggregate, and the refusal that makes
L204 a guarded prohibition rather than an unguarded absence.

* `AirportObservationAggregate` / `AirportFactAggregate` — every member is a
  count or a percentile. There is no field that can hold an observer, a row id
  or a submission token.
* `assertNoObserverIdentifiers` (`:166`) walks the finished value and THROWS on
  a `tv1-` handle, a bare UUID or a row id under any key. `airportRef` is
  exempt **by path, not by pattern** — an airport with no IATA code is filed
  under its profile id, and exempting the pattern would have reopened the hole
  everywhere else. It is called on the return path of every read (`:310`).
* `MIN_DISTINCT_OBSERVERS_PER_BAND = 3` (`:98`), applied per local hour BEFORE
  `buildHistoricalModel`. `MIN_SAMPLES_PER_BAND` is five SAMPLES and
  `OBSERVATION_RATE_LIMIT` permits three reports per fifteen minutes, so one
  traveller clears the existing floor alone in half an hour.
* `maturityObservationCount` — zero until the corpus is corroborated, so one
  determined person cannot promote an airport up the §22 ladder.
* A failed corpus read is `{ ok: false, reason: "read_failed" }`; a genuinely
  empty airport is `{ ok: true }` with zeroes.

It gives `buildHistoricalModel` its first non-test caller.

### 2. `artifacts/api-server/src/services/airport/layoverMaturityGate.ts` (new) + `2977_layover_maturity_gate_flag.sql` (new) — bears on L249, L246, L243, L250

* `landsideMaturityDecision(db, airport, nowMs, overrides?)` (`:195`) — classify
  the airport, ask `featureAllowedAt("landside_recommendations", level)`,
  publish the rung, the cap reason, the L250 disclosure and the observation
  count.
* `maturitySignalsFor` (`:141`) — `hasExternalLiveFeed` and `hasCalibration` are
  hard FALSE with the artifact named; `hasKnownTransportModel` is read from the
  corridor provider's own enablement gate through `enablementRefusal`, so "the
  provider will answer" and "we claim a transport model" cannot drift apart.
  An EMPTY `terminal_info` is the absence of a topology, not a small one.
* Flag OFF ⇒ `allowed: true` **and no observation read at all**. The
  classification still runs (free, and L250 is a different requirement from
  L249).
* An unreadable corpus counts as ZERO observations — it may not promote a rung —
  and may not demote one the airport earned on other evidence; `signalsReadable`
  publishes the difference between "nobody reported" and "could not ask".
* `2977_layover_maturity_gate_flag.sql` seeds `layover_maturity_gate_enabled`
  FALSE with a postcondition that FAILS if it is ever seeded ON, and a
  near-miss-name postcondition. Its header states in full what enabling it
  does: 0 of 3,206 production airports reach L1, so ON withdraws every landside
  card everywhere. That is spec §22 L243's stated default and an owner decision.

### 3. `artifacts/api-server/src/services/airport/LayoverRecommendationService.ts` — bears on L249, L243, L77

Three line-for-line edits plus one append. The import shares a physical line
with `featureFlags` (`:53`); `const landside = await landsideMaturityDecision(...)`
(`:495`) replaces a blank line inside a seven-line block rewritten to the same
count; `&& landside.allowed` is appended to the two landside gates (`:502`,
`:520`); a `maturity: { … }` block is appended to the `recommendation_generated`
audit metadata (`:847`), below the last anchored citation.

**Why line-for-line:** that file carries sixteen ANCHORED census citations up to
line 819 and `check:doc-citations` reports "anchored citations whose anchor is
NOT at the cited lines: 0" with zero tolerance, while `check:citation-targets`
sits exactly at its ceiling (178/178). Inserting a single line anywhere above
819 breaks the branch. Verified after the edits: both still clean.

### 4. `artifacts/api-server/src/services/airport/LayoverExternalReplanPort.ts` (new) — bears on L93, L94, L97, L99, L112, L259

See **REPLAN PORT** below.

### 5. Stale headers corrected in files I own

| file | what it said | what is true |
| --- | --- | --- |
| `services/airport/LayoverAirportTruth.ts:17-27` | "IT IS NOT A PRODUCER, AND NOTHING ON THIS TREE PRODUCES AN OBSERVATION … the table … is WRITTEN AND NOT APPLIED" | 2860 and 2982 are APPLIED to production; `POST /airport/sessions/:id/observations` is live. The half that IS still true (nothing supplies `liveConditions` outside tests) is kept. |
| `services/layover/LayoverObservationService.ts:96-98` | "migration 2860 (written, NOT applied as of this file)" | 2860 applied; 2982 applied. |
| `services/airport/layoverMaturity.ts` header | "IT IS NOT WIRED. Nothing consults `featureAllowedAt` …" | `layoverMaturityGate.ts` consults it; the gate is seeded FALSE. |
| `layoverMaturity.ts` `L3_PORTAVA_OBSERVED.blockedBy` | "no route accepts one and no table stores one" | Both false — now `reachable: true`, with "reachable is not reached" stated. |
| `layoverMaturity.ts` `L5_DENSE_LIVE.blockedBy` | "the nearest blocker is the same one that blocks L3" | The nearest blockers are now L2 and L4, each named with a checkable symbol. |
| `layoverMaturity.ts` `L4_CALIBRATED.blockedBy` | "with no corpus to measure" | There IS a corpus; there is still no stored OUTCOME to measure against. |
| `layoverMaturity.ts` `MATURITY_FEATURES` doc | "nothing consults this table" | It is consulted; the gate is off. |
| `src/test/layoverMaturityModel.test.ts` | "the day someone wires the gate, the case goes red" | The gate was wired and the case did NOT go red, because the flag allows. What turns it red is the flag being switched on. Corrected in place; no assertion weakened. |

All three new tests are registered in `package.json`'s `test` script
(`check:test-registration` green).

---

## REPLAN PORT

Exported from **`artifacts/api-server/src/services/airport/LayoverExternalReplanPort.ts`**:

```ts
export type ReplanReport =
  | { ok: true; impacted: number; notifications: number }
  | { ok: false; reason: string };

export interface LayoverReplanPort {
  replan(event: LayoverEventEnvelope): Promise<ReplanReport>;
}

export interface LayoverReplanPortOptions {
  nowMs: number;
  sessionLimit?: number;      // default DEFAULT_REPLAN_SESSION_LIMIT = 200
}

export function layoverExternalReplanPort(
  db: SupabaseClient,
  opts: LayoverReplanPortOptions,
): LayoverReplanPort;

export async function replanExternalEvent(
  db: SupabaseClient,
  event: LayoverEventEnvelope,
  opts: LayoverReplanPortOptions,
): Promise<ReplanReport>;
```

**Wire `layoverExternalReplanPort(db, { nowMs })`** — it satisfies your
`ReplanPort` structurally. `replanExternalEvent` is the same thing without the
object wrapper, for a route or a test that has no queue.

`ReplanReport` is **restated, not imported**, because
`services/layover/layoverExternalEventConsumer.ts` does not exist at my HEAD
(`561a0a7b0`) — it is on your branch. The two declarations are structurally
identical; if yours changes, the assignment at your wiring site stops
compiling, which is the right place for that to be reported.

What it does, in order:

1. Resolves every `airport` subject ref to a `FeasibilityAirport`. An
   IATA-shaped ref goes through `lookupByIata`; anything else is read as an
   `airport_profiles` row id, which is what `layover_sessions.airport_id` holds.
2. Reads the ACTIVE sessions at each airport by **every identity that airport
   answers to** — `airport_id IN (ref, profile.id)` and `manual_iata = ref`, as
   two literal `.from("layover_sessions")` reads rather than one `.or()`.
3. Adds the sessions named directly by `session` subjects, resolving each one's
   own airport and merging it into the matching group.
4. Reads `layover_plan_stops` for all of them and maps through
   `candidatesFromStops` — `LayoverPlanFit`'s classifier, so an unstated leg is
   an ABSENCE and not a free journey (L47).
5. Calls `handleEvent` **once per airport group** and sums `impacted` and
   `notifications`.

Rules you named, and where each is honoured:

* **A failed read is `{ ok: false, reason }`, never an empty session list** —
  every one of the four reads is checked. The airport read too: `lookupByIata`
  falls back to the static dataset with `degraded: true`, and accepting that
  would re-certify a real deadline against generic constants during an outage.
  ONE unresolvable airport refuses the WHOLE event, because a partial replan
  reported as success lets you stamp `processed_at` on an event that never
  reached half the travellers it named.
* **`nowMs` is an argument** — supplied when the port is built, one instant for
  the whole drain. No `Date.now()`, no no-arg `new Date()` in the file.
* **String-literal table names** in every `.from(...)`.
* **It never touches `layover_external_events`** — pinned by a test that spies
  on `.from()`.

And what it deliberately does not supply: no held recommendations
(`layover_recommendations` has no `inputHash` column, L64, so
`staleCertification` would fire on invented evidence), no live conditions
(nothing produces them, L81), no disruption states. The empty shape, never an
invented one.

**The grouping is not cosmetic.** `handleEvent` takes one airport. My first
implementation matched the event's ref straight against `airport_id` and would
have shipped a SILENT ZERO — an `airport` subject is an IATA code and
`airport_id` is a profile row id, so no production session would ever have
matched and every airport-wide event would have reported `{ ok: true,
impacted: 0 }` for you to stamp on. The test suite caught it; see TEST EVIDENCE.

---

## TEST EVIDENCE

All targeted runs carry the curated env. No targeted run overlapped a full-suite
run in this worktree.

**1. Aggregate — RED, module absent**

```
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
  node --import tsx/esm --test src/test/layoverObservationAggregate.test.ts
# tests 1
# pass 0
# fail 1
```

**2. Aggregate — RED on BEHAVIOUR, with the distinct-observer floor bypassed**
(`if (false && distinct < MIN_DISTINCT_OBSERVERS_PER_BAND)` and
`maturityObservationCount: totalObservations`, then reverted):

```
    not ok 1 - a band five readings deep from ONE observer is withheld
not ok 2 - L204 — one person is not a distribution
    not ok 1 - an uncorroborated corpus contributes ZERO observations to the ladder
not ok 4 - L246 — the maturity SIGNAL the ladder reads
# tests 11
# pass 9
# fail 2
```

**3. Aggregate — GREEN with the floor restored**

```
# tests 11
# pass 11
# fail 0
```

**4. Maturity gate — RED, module absent**

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../services/airport/layoverMaturityGate.js'
not ok 1 - src/test/layoverMaturityGate.test.ts
# tests 1
# pass 0
# fail 1
```

**5. Maturity gate — GREEN**

```
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
  node --import tsx/esm --test src/test/layoverMaturityGate.test.ts
# tests 13
# pass 13
# fail 0
```

**6. Existing maturity suite — RED after the reachability correction, then GREEN**

The `L5_DENSE_LIVE.blockedBy` rewrite failed the POSITIVE CONTROL that every
unreachable rung must name a checkable artifact:

```
    not ok 3 - POSITIVE CONTROL: every level declared UNREACHABLE names what is missing, and no signal set reaches it
      error: 'L5_DENSE_LIVE is blocked by something unnameable: requires every rung below it. CORRECTED 2026-09-22: ...'
# tests 15
# pass 14
# fail 1
```

Fixed by naming `LayoverAirportTruth.liveConditionsFrom` and
`LayoverAirportTruth.measureCalibration` in the reason — **the assertion was not
weakened**:

```
# tests 15
# pass 15
# fail 0
```

**7. Replan port — RED, module absent**

```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../services/airport/LayoverExternalReplanPort.js'
# tests 14
# pass 0
# fail 14
```

**8. Replan port — RED on BEHAVIOUR (first implementation, ref matched straight
against `airport_id`)**

```
    not ok 1 - an AIRPORT subject fans out to the active sessions at that airport   (0 !== 1)
    not ok 2 - a SESSION subject reaches that session directly                      (false !== true)
    not ok 6 - two airports in one event are certified against their OWN buffers    (0 !== 2)
    not ok 2 - an unreadable plan-stop table REFUSES …                              (true !== false)
    not ok 3 - an unreadable airport_profiles REFUSES …                             (true !== false)
# tests 14
# pass 9
# fail 5
```

**9. Replan port — GREEN**

```
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
  node --import tsx/esm --test src/test/layoverExternalReplanPort.test.ts
# tests 14
# pass 14
# fail 0
```

**10. Regression on the suites my wiring runs through**

```
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test \
    src/test/layoverRecommendationGate.test.ts src/test/layoverCandidateFeasibility.test.ts \
    src/test/layoverRecommendationIdentity.test.ts
# tests 20
# pass 20
# fail 0
```

**11. Full suite** — `npm test` (its script sets the curated env itself):

```
$ npm test
EXIT=0
# tests 25248
# suites 6053
# pass 25248
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1950184.207729
```

`grep -cE "^not ok" fullsuite.log` → **0**. The run took 32 minutes; two earlier
attempts were killed (SIGKILL at 137, then SIGTERM at 143 on a 50-minute
`timeout`) while sibling lanes were running their own suites on the same box —
those are resource kills, not failures, and neither produced a `not ok`.

**12. Required checks** — all from `/home/user/wt-lo-server/artifacts/api-server`:

```
$ npm run typecheck
  (clean, no output)

$ npm run check:schema-references
  Canonical schema: 515 tables from baseline + 660 migrations
  ✓ No NEW undeclared column references. 0 known dead reference(s) ... remain on the ratchet (expected 0)

$ npm run check:enum-literals
  ✓ No undeclared literals off the ratchets.
      filter side: 2 finding(s) across 2 ratcheted key(s)
      write side:  16 finding(s) across 13 ratcheted key(s)
  (both unchanged from the baseline I measured before editing)

$ npm run check:not-null-writes
  ✓ no write payload nulls a NOT NULL column.

$ npm run check:silent-supabase-writes
  ✅ no NEW dead catch around a resolving PostgREST write (21 pre-existing site(s) baselined)

$ npm run check:test-registration
  ✅ 1454 test file(s) on disk under src/
     1421 registered  → RUN under `npm test`
     33 not registered → NEVER RUN (allowlisted)
```

**13. Checks not on the required list that my edits could have broken, run
because the citation ratchet is at its ceiling:**

```
$ npm run check:doc-citations
  OK   citations whose file or line range does not resolve: 0
  OK   anchored citations whose anchor is NOT at the cited lines: 0
  OK   BACKTICKED citations whose WHOLE anchor is not at the cited line: 0
  OK   citations written in a shape NO pass can check: 0
  OK   citations whose anchor holds in MORE THAN ONE candidate file: 0

$ npm run check:citation-targets
  ✓ at the ceiling: 178 / 178.

$ npm run check:flag-polarity
  ✓ 198 flags classified (17 STOP, 179 CAPABILITY, 2 CONFIG) across 1162 files.
    Read-but-unseeded: 0 phantoms

$ npm run check:census-integrity          (used for the verdict dump)
  296 rows parsed for census-layover, 296 expected
```

---

## NOT DONE AND WHY

**(a) Needs a file another lane owns**

1. **`artifacts/api-server/src/routes/airport.ts` — publish the maturity
   disclosure.** L250 asks that a surface be able to say which rung THIS airport
   is on. `landsideMaturityDecision` returns `disclosure` (headline, detail,
   confidence word, reason code) and nothing publishes it. Exact change: in
   `GET /airport/sessions/:id/recommendations` and
   `GET /airport/sessions/:id/safety`, call
   `landsideMaturityDecision(sc, airport, Date.now())` and add
   `maturity: { level, disclosure, cappedBy }` to the response body. It is safe
   with the flag off — `allowed` is ignored, only the words are published.
2. **`artifacts/api-server/src/routes/airport.ts` — expose the de-identified
   aggregate.** `readAirportObservationAggregate(sc, airportRef, airport.timezone, Date.now())`
   next to the existing `GET /airport/sessions/:id/observations` handler
   (`routes/airport.ts:2731`), published as
   `aggregate: { observations, distinctObservers, facts: [...] }`. The guard
   already refuses to hand back anything carrying an identity. Without this the
   aggregate reaches a traveller through nothing, which is what holds L204 at W
   rather than C.
3. **`artifacts/api-server/src/services/airport/LayoverEventReplanner.ts`** —
   owned by another lane, READ only. Its line 875 still says
   `layover_external_events` "(2860)" and `layover_certified_computations`
   "(2700) … are both written and unapplied". **2860 IS applied**; only 2700 is
   not. One-line correction, inside `ReplanOutcome.snapshotUnavailableReason`'s
   doc comment.
4. **`artifacts/api-server/src/migrations/2985_layover_events_crew_vocabulary.sql:44`**
   says `2741  written, NOT applied`. 2741 IS applied
   (`production-applied-migrations.json`). Comment-only; not my prefix.
5. **`travel-buddy-standalone/**`** — forbidden. The traveller-facing screen for
   submitting an observation (L82's remaining half) and the map bands (L67)
   live there. I could not verify whether a submission screen exists, so L82 is
   held at W rather than moved.
6. **The consumer wiring for my replan port** — `src/lib` scheduler plus
   `src/index.ts` registration are the other lane's, as they stated.

**(b) Needs schema that is unapplied**

1. **L64 / L95 / L190 / L206 / L207 / L209 / L215 / L216 / L217 / L240 / L5 /
   L191** — all rest on `layover_certified_computations` (**2700, unapplied**)
   or a snapshot/hash column on `layover_recommendations`. I did NOT add either
   under my 2977 prefix: a writer naming a column of an unapplied migration
   fails at runtime on every live database, and branch CI is already red on
   `audit:schema` / `check:write-path-columns` for exactly that with 2992–2994.
2. **L43 / L159 / L173** — `layover_checkpoints`, created only by **2992,
   unapplied**.
3. **L27 / L129 / L132 / L158 / L166 / L203** — no presence or location-grant
   store exists in any migration, applied or not.
4. **L128** — `layover_presence_ladder_enabled` has no row: **2740 unapplied**.
5. **L259 — the replan fanout INDEX.** My port queries
   `layover_sessions (airport_id, status)` and `(manual_iata, status)` and
   `layover_sessions` carries neither index. The exact change is
   `CREATE INDEX CONCURRENTLY layover_sessions_airport_status_idx ON public.layover_sessions (airport_id, status) WHERE status = 'active';`
   plus the same on `(manual_iata, status)`. I did NOT write it: my only
   migration prefix is 2977 and it is spent on the flag, and two files sharing
   one numeric prefix is a change to migration ordering I am not entitled to
   make. **This matters before the consumer is enabled**, not after — the
   fanout is a sequential scan of `layover_sessions` per event today.
6. **L279** — `BAGGAGE_STATUS_CRITICAL_UNKNOWN` needs `checked_bags` to be able
   to hold UNKNOWN. It is `BOOLEAN NOT NULL` in the production snapshot. A
   nullable column or a mode enum is a migration AND a product decision about
   what the creation sheet asks.

**(c) Needs an external credential / service / device**

1. **L245, L60, L68–L72, L244's transport half** — `LAYOVER_ROUTED_CORRIDOR_ENABLED`
   plus `GOOGLE_MAPS_API_KEY`. Routes API is billed per request with no spend
   ceiling anywhere in this repository. An owner purchase decision.
2. **L169, L283, L284, L160** — a flight-schedule/status feed. No credential of
   any kind exists: `artifacts/api-server/.env.example` lists Foursquare, Google
   Maps, Mapbox, Ticketmaster, OpenAI and Frankfurter, and no flight vendor.
   `lib/providers/flightItineraryProvider.ts` is the port, written and refusing.
3. **Every "on production" claim below the schema snapshot's resolution** — I
   have NO database credentials in this environment. I could not measure how
   many rows `airport_fact_observations` actually holds, which is why L246 is
   `W` and not a claim that any airport has reached L3, and why I did not
   re-test "zero Portava observations" as true or false.
4. **`layover_maturity_gate_enabled` cannot be turned on from here** — flags move
   only through `public.toggle_feature_flag_with_audit`.

**(d) Genuinely out of scope**

1. **L283, L284** — `AIRPORT_CHANGE_REQUIRED` and `SELF_TRANSFER_FRICTION` have
   no input in ANY shape: a layover session carries one airport and no itinerary
   or booking model. I declined to synthesise a signal for either; a fabricated
   input is the defect census L293 exists for.
2. **Wiring community observations into the safety buffer.**
   `routes/airport.ts:2678` records in as many words that this "changes a SAFETY
   number, and it is an owner decision rather than a side effect of giving
   travellers somewhere to report." I honoured that: nothing I built reaches
   `liveConditionsFrom`. This is what keeps L81, L285, L286, L287 at W.
3. **L67, L233** — client surfaces in `travel-buddy-standalone/**`.
4. **L31, L92, L194, L198, L236, L238, L263** — the other lane is grading these,
   as instructed. I did not measure or move them.

---

## STALE EVIDENCE FOUND

Every entry here is a stated reason I RE-TESTED at my HEAD and found false. The
verdict move, where there is one, is in the table above.

| row | the stated reason | what the re-test showed |
| --- | --- | --- |
| **L82** | "There is NO SUBMISSION SURFACE — no route, no screen, nothing a traveller can report from." | There is a route: `routes/airport.ts:2768` (`POST /airport/sessions/:id/observations`), live behind `airport_mode_enabled` alone (`:2359`), backed by `airport_fact_observations` with 2860 and 2982 **applied**. Verdict held at W for the remaining half. |
| **L181** | "a named service operation with no caller is W here." | `reconcile` has a caller, and it is reachable in production: `LayoverObservationService.ts:308` → `routes/airport.ts:2747`. **Moves W → C.** |
| **L197** | §17.5: "Gated on 2700 or 2860." | The 2860 half is false — 2860 is applied, and `airport_fact_observations` is the observation/truth table with TTL and provenance the row asks for. **Moves W → C.** |
| **L204** | "No aggregated airport intelligence exists to leak from." | Was true; is now the thing this lane built. **Moves N → W.** |
| **L243** | "`LayoverRecommendationService.ts:244-246` gates on time and preference, never on data maturity." | It gates on maturity as of this branch (`:495`, `:502`, `:520`). Verdict held at W — the gate is seeded FALSE. |
| **L246** | §22: "Zero external live signals, zero Portava observations. Defining where they would go does not make an airport more mature." | The first clause I could not re-test (no credentials). The second is no longer about definition: the channel is live, the table is applied, and the count now reaches the ladder. **Moves N → W.** |
| **L161** | "No aggregate airport timing is ever produced." | Per-local-hour p50/p75/p90 bands are produced (`LayoverObservationAggregate.ts:276`). Verdict held at N — nothing RETAINS them, which is what the row scores. |
| **L83** | "`buildHistoricalModel` … " (implying no corpus) | It has a non-test caller and a real corpus now. Verdict held at W — "recalibrated" is still not built. |
| **L285 / L286 / L287 / L281** | "Each needs an airport-truth fact, and this pass built no fact producer." | A fact producer exists — for the `TRAVELER_OBSERVATION` class. It is the wrong class: these four codes come only from `liveConditionsFrom`, which has no caller. Verdicts held at W. |
| **§36's L180-group note** (not a verdict row) | "`LayoverAirportTruth.ts` … still has no caller outside its test." | §36 already corrected this; re-confirmed, and it now has a seventh caller (`LayoverObservationAggregate.ts`). |

**Stale evidence in CODE, corrected where I own the file** (full list in BUILT §5):
`LayoverAirportTruth.ts` and `LayoverObservationService.ts` both claimed 2860 was
written-and-not-applied; `layoverMaturity.ts` claimed in four places that nothing
consults it and that no route accepts an observation. All corrected in place,
line-for-line where a census citation is anchored to the file.

**Stale evidence in code I do NOT own, reported rather than changed:**
`services/airport/LayoverEventReplanner.ts:875` (2860 described as unapplied) and
`src/migrations/2985_layover_events_crew_vocabulary.sql:44` (2741 described as
unapplied). Both are comment-only and both are false.

**Two claims re-tested and found TRUE**, recorded so this is not read as
one-sided: `layover_snapshots` really does not exist in any migration (L264,
L95), and `terminal_info` really has no writer anywhere under `src/` (L79,
L244) — only the reads at `AirportProfileService.ts:146` and the maturity
signal at `layoverMaturityGate.ts:154`.
