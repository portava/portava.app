/**
 * layoverCertification — census-layover L218, spec §21:
 *
 *   "Do not certify Layover because cards render or example itineraries look
 *    plausible. Certification must prove hard invariants across deterministic
 *    scenarios, synthetic disruption, replay, database authorization, and
 *    end-to-end lifecycle behavior."
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * The certification as DATA a checker can read (`check:layover-certification`,
 * src/scripts/checkLayoverCertification.ts), in the shape Telegraph's §26/§27
 * certification already takes. Every entry is one claim in the spec's words,
 * the census row(s) it certifies, and the PROOF: the suite and the exact test
 * title that proves it. The checker refuses a manifest that is incomplete (any
 * of the five proof classes, the seven §6.1 hard invariants or the fifteen
 * §21.1 scenarios missing), a proof whose file or test title does not exist, a
 * proof file no runner executes, a dependency that names a migration or flag
 * the tree does not have, and an unproved set that grows. It also renders the
 * certification table in docs/architecture/layover-certification.md and refuses
 * a document that has drifted from this file.
 *
 * ── WHAT A "PROOF" HERE IS, AND IS NOT ───────────────────────────────────────
 * A proof is a REGISTERED test that fails when the claim stops holding; the
 * suites settle whether it holds, on every run. This file does not judge that
 * a status is right — it makes the claim complete, cited, executed and
 * monotone. Cards rendering proves nothing here: no entry cites a render-only
 * test.
 *
 * ── PRODUCTION IS A SEPARATE QUESTION, AND IS ANSWERED SEPARATELY ────────────
 * A claim proved in code is not a claim true in production. Each entry names
 * what production needs for the proved behaviour to reach a traveller — the
 * migrations and flags (`requires`), an owner ruling, or an external provider —
 * and the checker reports, from the repository's committed production records
 * (the applied-migrations ledger and the current schema snapshot's flags),
 * which entries are reachable there. Those records lag production; the report
 * says which records it read. Grades are census-layover's, never this file's.
 */

export const LAYOVER_PROOF_CLASSES = [
  "deterministic_scenarios",
  "synthetic_disruption",
  "replay",
  "database_authorization",
  "e2e_lifecycle",
] as const;
export type LayoverProofClass = (typeof LAYOVER_PROOF_CLASSES)[number];

/** Which runner executes the proof file. */
export type ProofTier =
  /** artifacts/api-server's registered `test` script (node:test, every CI run). */
  | "node"
  /** artifacts/api-server/scripts/local-db/run-tests.sh (CI's api-server-local-db job, PostgreSQL 16 with the migrated chain). */
  | "local_db"
  /** travel-buddy-standalone's jest component suite (`test:component`). */
  | "client";

export interface ProofRef {
  /** Repository-relative path. */
  file: string;
  /** A verbatim substring of the test's or suite's title in that file. */
  test: string;
  tier: ProofTier;
}

export interface ProductionNeeds {
  /** Migration number prefixes that must be applied (each must name a file under src/migrations). */
  migrations?: readonly string[];
  /** Flags that must be ON (each must be seeded by some migration). */
  flags?: readonly string[];
  /** An owner decision the behaviour waits on (docs/ops/layover-owner-decisions-20261018.md). */
  ownerRuling?: string;
  /** A provider, credential or device capability outside this repository. */
  external?: string;
  /** Data production does not have yet (curation, a recorded history). */
  data?: string;
}

export interface CertificationEntry {
  id: string;
  class: LayoverProofClass;
  /** census-layover row ids this entry certifies. */
  census: readonly string[];
  /** The claim, in the spec's own words. */
  claim: string;
  /** The tests that prove it. `null` = no test in this tree proves it; `unprovedBecause` says why. */
  proof: readonly ProofRef[] | null;
  unprovedBecause?: string;
  /** What of the claim the proofs do NOT cover, when they cover only part of it. Reported as "proved in part". */
  gaps?: string;
  /** What production needs for the proved behaviour to reach a traveller. Empty = nothing beyond what is deployed. */
  production: ProductionNeeds;
}

const API = "artifacts/api-server/src/test/";
const DB = "artifacts/api-server/src/test/db/";
const APP = "travel-buddy-standalone/src/";
const node = (f: string, test: string): ProofRef => ({ file: API + f, test, tier: "node" });
const db = (f: string, test: string): ProofRef => ({ file: DB + f, test, tier: "local_db" });
const client = (f: string, test: string): ProofRef => ({ file: APP + f, test, tier: "client" });

const CONSTRAINTS: ProductionNeeds = { migrations: ["2992", "3640"], flags: ["layover_constraints_enabled"] };
const ENTRY_FORBID: ProductionNeeds = { migrations: ["3640"], flags: ["layover_entry_forbid_landside_enabled"], ownerRuling: "#9 entry forbid flag" };
const LIVE_SIGNALS: ProductionNeeds = { migrations: ["3885"], flags: ["layover_live_signals_enabled"], ownerRuling: "#4 live airport signals" };
const ROUTES: ProductionNeeds = { migrations: ["3856"], flags: ["layover_routed_corridor_enabled"], external: "Google Routes API credentials and spend settings" };
const CURATED = "a curated airport model (no production airport is curated; census L220, L143)";
const LEDGER: ProductionNeeds = { migrations: ["2700", "2992", "3623", "3792"], flags: ["layover_decision_persistence_enabled"] };

export const LAYOVER_CERTIFICATION: readonly CertificationEntry[] = [
  // ── §6.1 hard invariants, proved over deterministic inputs ─────────────────
  {
    id: "HI-1", class: "deterministic_scenarios", census: ["L47"],
    claim: "recommendation.expected_airport_return_at <= return_plan.hard_return_by",
    proof: [
      node("layoverPlanFitUnknownLegs.test.ts", "A1 — THE DEFECT: a landside stop with no travel time is NOT a fit"),
      node("layoverRecommendationContract.test.ts", "every check in the vocabulary has a planted case above"),
    ],
    production: {},
  },
  {
    id: "HI-2", class: "deterministic_scenarios", census: ["L48"],
    claim: "if entry_permission_state != CONFIRMED_ALLOWED: forbid_landside_recommendations()",
    proof: [node("layoverConstraintGate.test.ts", "policy ON + unresolved corridor: verdict `no`, gate closed by entry_unconfirmed")],
    production: ENTRY_FORBID,
  },
  {
    id: "HI-3", class: "deterministic_scenarios", census: ["L49"],
    claim: "if critical_unknowns contains safety-critical unknown: confidence = INSUFFICIENT; forbid_landside_recommendations()",
    proof: [
      node("layoverConstraintGate.test.ts", "UNKNOWN closes landside"),
      node("layoverConstraintGate.test.ts", "answering the one question lifts the closure, either way the answer goes"),
    ],
    production: CONSTRAINTS,
  },
  {
    id: "HI-4", class: "deterministic_scenarios", census: ["L50"],
    claim: "if risk_band == UNSAFE: recommendation.status = BLOCKED",
    proof: [
      node("layoverEnvelope.test.ts", "L50 — a certainly-unreachable place is BLOCKED, not rated and served"),
      node("layoverExecutableRecommendationContract.test.ts", "a one-way measured leg cannot masquerade as an executable return plan"),
    ],
    gaps: "'unsafe' is broader than 'unreachable': a card the buffer arithmetic rates not_recommended is still generated and served (census L50)",
    production: {},
  },
  {
    id: "HI-5", class: "deterministic_scenarios", census: ["L51"],
    claim: "security_wait ↑ must never increase usable_time",
    proof: [node("layoverFeasibilityInvariants.test.ts", "never increases usableMinutes or moves the deadline later")],
    production: {},
  },
  {
    id: "HI-6", class: "deterministic_scenarios", census: ["L52"],
    claim: "return_travel_time ↑ must never expand safe_envelope",
    proof: [node("layoverFeasibilityInvariants.test.ts", "§6.1 L52 — a longer travel leg never expands the safe envelope")],
    production: {},
  },
  {
    id: "HI-7", class: "deterministic_scenarios", census: ["L53"],
    claim: "departure_time earlier must never expand safe_envelope",
    proof: [node("layoverFeasibilityInvariants.test.ts", "§6.1 L53 — an earlier departure never expands the certified envelope")],
    production: {},
  },

  // ── §21.1 the minimum deterministic scenario matrix ────────────────────────
  {
    id: "S-L219", class: "deterministic_scenarios", census: ["L219"],
    claim: "2h domestic → Airport-only expected",
    proof: [node("layoverScenarioMatrix.test.ts", "is refused a city, and told AIRPORT-ONLY, as §21.1 names it")],
    production: {},
  },
  {
    id: "S-L220", class: "deterministic_scenarios", census: ["L220"],
    claim: "4h international visa allowed → Potential landside depending on airport model",
    proof: [
      node("layoverScenarioL220.test.ts", "the curated model reaches POTENTIAL landside"),
      node("layoverScenarioL220.test.ts", "the generic model, same session, clock and entry, does not"),
    ],
    production: { data: CURATED },
  },
  {
    id: "S-L221", class: "deterministic_scenarios", census: ["L221"],
    claim: "6h visa-free → Landside + return contract",
    proof: [node("layoverScenarioMatrix.test.ts", "6h international, curated: landside, with the deadline the CONTRACT would have to carry")],
    production: { ...ROUTES, data: CURATED },
  },
  {
    id: "S-L222", class: "deterministic_scenarios", census: ["L222"],
    claim: "5h self-transfer → Recheck friction included",
    proof: [node("layoverConstraintGate.test.ts", "collect-and-recheck costs claim time AND bag-drop time against carry-on only")],
    production: CONSTRAINTS,
  },
  {
    id: "S-L223", class: "deterministic_scenarios", census: ["L223"],
    claim: "Overnight → Overnight state / expanded options",
    proof: [node("layoverScenarioMatrix.test.ts", "an overnight layover crosses the local day and is tiered for sleep")],
    gaps: "the overnight STATE is proved; 'expanded options' are not — every session gets the same airside rest card (census L223)",
    production: {},
  },
  {
    id: "S-L224", class: "deterministic_scenarios", census: ["L224"],
    claim: "Airport change → Exploration subordinate to transfer",
    proof: [node("layoverConstraintGate.test.ts", "closes landside at any amount of spare time, and says why")],
    production: CONSTRAINTS,
  },
  {
    id: "S-L225", class: "deterministic_scenarios", census: ["L225"],
    claim: "Arrival delay → Freedom shrinks",
    proof: [node("layoverScenarioMatrixDisruption.test.ts", "90 minutes late is 90 fewer minutes in the city, and the deadline does not move")],
    production: {},
  },
  {
    id: "S-L226", class: "deterministic_scenarios", census: ["L226"],
    claim: "Departure delay → Freedom may expand after recompute",
    proof: [node("layoverScenarioMatrixDisruption.test.ts", "two hours later is a later deadline and more usable time")],
    production: {},
  },
  {
    id: "S-L227", class: "deterministic_scenarios", census: ["L227"],
    claim: "Security spike → Envelope contracts monotonically",
    proof: [node("layoverScenarioMatrixDisruption.test.ts", "over a rising ladder of observed waits, freedom never increases")],
    production: LIVE_SIGNALS,
  },
  {
    id: "S-L228", class: "deterministic_scenarios", census: ["L228"],
    claim: "Traffic spike → Return deadline moves earlier",
    proof: [node("layoverScenarioMatrixDisruption.test.ts", "a degraded ground route pulls the deadline in by the observed minutes")],
    production: LIVE_SIGNALS,
  },
  {
    id: "S-L229", class: "deterministic_scenarios", census: ["L229"],
    claim: "Unknown baggage → Fail closed if critical",
    proof: [node("layoverConstraintGate.test.ts", "UNKNOWN closes landside")],
    production: CONSTRAINTS,
  },
  {
    id: "S-L230", class: "deterministic_scenarios", census: ["L230"],
    claim: "Unknown entry permission → No landside recommendation",
    proof: [node("layoverConstraintGate.test.ts", "policy ON + unresolved corridor: verdict `no`, gate closed by entry_unconfirmed")],
    production: ENTRY_FORBID,
  },
  {
    id: "S-L231", class: "deterministic_scenarios", census: ["L231"],
    claim: "Flight cancellation → Transition to disruption/recovery",
    proof: [node("layoverScenarioMatrixDisruption.test.ts", "the state machine moves, and the schedule is NOT invented")],
    production: {},
  },
  {
    id: "S-L232", class: "deterministic_scenarios", census: ["L232"],
    claim: "Crew mixed departures → Shared constraint = earliest or explicit split",
    proof: [node("layoverCrewConstraints.test.ts", "EARLIEST arm: every ordering of a mixed-departure crew binds on the earliest member")],
    production: {},
  },
  {
    id: "S-L233", class: "deterministic_scenarios", census: ["L233"],
    claim: "Offline after leaving → Cached return plan remains visible with stale indicator",
    proof: [
      client("lib/__tests__/layoverPlanCache.component.test.ts", "a written plan reads back with the server bound VERBATIM"),
      client("components/layover/__tests__/LayoverSafeReturnCard.component.test.tsx", "past staleAfter the deadline is relabelled and captioned with its age"),
    ],
    production: LEDGER,
  },

  // ── synthetic disruption: §11.1 event → replan → snapshot → invalidation → notification ──
  {
    id: "D-1", class: "synthetic_disruption", census: ["L238", "L96", "L97", "L98", "L99"],
    claim: "Integration tests for event → replan → snapshot → invalidation → notification (§11.1 steps 5–8)",
    proof: [
      node("layoverEventReplanner.test.ts", "a security spike that shrinks the window drops the options that no longer fit"),
      node("layoverEventReplanner.test.ts", "names both the infeasible candidates and the ones certified under another hash"),
      node("layoverEventReplanner.test.ts", "a material move emits one, with the reason spelled out"),
      node("layoverEventReplanner.test.ts", "a planned option that stopped fitting is a high-priority notification"),
    ],
    gaps: "the SNAPSHOT stage is proved only where the ledger is pressed (2700 → 2992 → 3623 → 3792)",
    production: LEDGER,
  },
  {
    id: "D-2", class: "synthetic_disruption", census: ["L92", "L257"],
    claim: "Normalize and deduplicate the external/internal event (§11.1 step 1); validate all external event payloads and deduplicate by stable source keys (§23)",
    proof: [
      node("layoverEventReplanner.test.ts", "the same upstream event delivered twice with different eventIds collapses"),
      node("layoverEventReplanner.test.ts", "every event type has a payload validator, and a valid payload passes it"),
    ],
    production: { migrations: ["2981"], flags: ["layover_event_ingest_enabled"], external: "a layover event producer and LAYOVER_EVENT_PRODUCER_SECRET" },
  },
  {
    id: "D-3", class: "synthetic_disruption", census: ["L231"],
    claim: "Disruption may expand or shrink the FreedomWindow. Recompute; do not simply append delay minutes (§15.2)",
    proof: [
      node("layoverScenarioMatrixDisruption.test.ts", "a departure delay is a disruption of a different kind, carrying its minutes"),
      node("layoverEventReplanner.test.ts", "a cancelled flight does not invent a replacement departure time"),
    ],
    production: {},
  },

  // ── replay ─────────────────────────────────────────────────────────────────
  {
    id: "R-1", class: "replay", census: ["L240"],
    claim: "Deterministic replay tests for recorded sessions",
    proof: [
      node("layoverReplayDeterminism.test.ts", "an untouched ledger entry replays with no mismatch"),
      node("layoverReplayDeterminism.test.ts", "POSITIVE CONTROL: a forged DEADLINE is reported"),
    ],
    production: LEDGER,
  },
  {
    id: "R-2", class: "replay", census: ["L241"],
    claim: "Decision-diff CI comparing old/new engine behavior over historical/synthetic corpora",
    proof: [
      node("layoverDecisionDiffCheck.test.ts", "compares every scenario and finds nothing changed"),
      node("layoverDecisionDiffCheck.test.ts", "a deadline moved LATER is red, and is the first thing the report says"),
    ],
    gaps: "the SYNTHETIC corpus is proved; the HISTORICAL half needs stored decisions to compare (census L241)",
    production: { ...LEDGER, data: "a history of stored decisions" },
  },
  {
    id: "R-3", class: "replay", census: ["L217"],
    claim: "decision_replay_mismatch — Replay divergence for identical engine/input; target = 0",
    proof: [
      node("layoverReplayDeterminism.test.ts", "refuses to replay a record whose engine version is not the running one"),
      node("layoverReplayDeterminism.test.ts", "POSITIVE CONTROL: a refusal is NOT a match"),
    ],
    production: LEDGER,
  },

  // ── database authorization, on a real migrated schema ──────────────────────
  {
    id: "A-1", class: "database_authorization", census: ["L236", "L295", "L201"],
    claim: "Database tests against a real CI schema for column names, enum literals, RLS and migration postconditions",
    proof: [
      db("layoverClientBoundary.db.test.ts", "B2. 0127's owner policies"),
      db("layoverClientBoundary.db.test.ts", "B3. every client write is refused — and nothing changed"),
      db("layoverClientBoundary.db.test.ts", "B4. anon reads nothing on the four tables"),
    ],
    gaps: "its first real-PostgreSQL run is CI's local-db job; whether a chain-replay database counts as 'a real CI schema' is the lead's grading call U-1 (census L236, L295)",
    production: { migrations: ["3620"] },
  },
  {
    id: "A-2", class: "database_authorization", census: ["L199", "L200"],
    claim: "Computed snapshots, risk, return plans and certification fields are server-controlled (§19.1); no client or LLM path can write certified risk/return fields (§27)",
    proof: [
      db("layoverPressedWriteBoundary.db.test.ts", "W1 L200 — a traveller's own PostgREST client cannot write their session around the routes"),
      db("layoverPressedWriteBoundary.db.test.ts", "W3 L199 — for every client-writable layover table"),
    ],
    production: { migrations: ["3620"] },
  },

  // ── end-to-end lifecycle ───────────────────────────────────────────────────
  {
    id: "E-1", class: "e2e_lifecycle", census: ["L239"],
    claim: "E2E tests for detection → evaluation → plan → execution → return → completion",
    proof: [
      db("layoverFlightConnections.db.test.ts", "P6 L239 L33 — detection → evaluation → plan → execution → return → completion over the real router"),
      node("layoverApiLifecycle.test.ts", "every stage runs, and each one's output is what the next one reads"),
    ],
    production: { migrations: ["3826", "3827"], flags: ["trip_flight_segments_enabled", "layover_flight_connections_enabled"] },
  },
];
