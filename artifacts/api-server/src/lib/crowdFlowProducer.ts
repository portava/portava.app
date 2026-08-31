/**
 * crowdFlowProducer — the PRODUCER half of Map spec §10 Crowd Flow.
 *
 * lib/mapAggregation.deriveCrowdFlow is the consumer: it takes `ZoneTransition[]`
 * and enforces §10's four gates (privacy, freshness, multiple signal families,
 * cohort density). It refuses rather than guesses when `distinctActors`,
 * `distinctGroups` or `maxGroupShare` are missing — which makes supplying those
 * numbers TRUTHFULLY the whole job of this module.
 *
 *   raw signals ─► deriveZoneTransitions ─► ZoneTransition[] ─► deriveCrowdFlow
 *                        (here)                                  (mapAggregation)
 *
 * ── WHY THE COUNTING IS THE PRIVACY DESIGN ───────────────────────────────────
 * "Aggregate movement between places or zones" is one careless join away from a
 * re-identification engine: sequence two coarse positions for one actor and you
 * have that person's trajectory. So this module never builds one.
 *
 *   * There is no per-actor path type, anywhere. The input unit is ONE HOP
 *     (fromZone → toZone), never a sequence, so a path cannot be assembled even
 *     internally.
 *   * Signals fold immediately into an accumulator keyed by
 *     (fromZoneId, toZoneId, timeBucket). The actor id enters a `Set` for
 *     counting and never leaves it: no returned structure has a field that can
 *     hold one. `src/test/crowdFlowProducer.test.ts` walks the whole serialized
 *     output for sentinel actor/group ids and fails if one survives.
 *   * Because every edge is independently gated at k, a chain A→B→C made by one
 *     traveller cannot be read back out of the output: the A→B edge publishes
 *     only if ≥ k DISTINCT people made it, and the B→C edge only if ≥ k distinct
 *     people made THAT — the single traveller's second hop dies alone.
 *
 * ── COUNTING RULES: lib/intelProjectionAggregator IS THE REFERENCE ───────────
 * `assembleClaimInput` is the codebase's existing exact-cohort implementation
 * and this follows it verbatim rather than inventing a second convention:
 *
 *   distinctActors  size of the actor-id Set (people, never events).
 *   distinctGroups  count of DISTINCT NON-NULL group keys. A null group key
 *                   earns ZERO group credit — we never infer a party from a bare
 *                   actor — though the person is still counted as a person.
 *   maxGroupShare   (largest group's distinct actors) / (DISTINCT GROUPED actors,
 *                   the union). The union denominator, not the sum of group
 *                   sizes, so an actor in several crews cannot dilute the
 *                   dominant group's share. A group holding every grouped actor
 *                   reads 1.0 → single_group_dominates, which is precisely the
 *                   "one large party is not a crowd" ceiling §10 needs.
 *
 * This deliberately DIVERGES from lib/trailFollowup.aggregateNextMoves, which
 * drops ungrouped rows outright. Both are fail-closed; the map must gate on
 * PRIVACY_THRESHOLD_V1 through lib/privacyGate (as mapAggregation does), and the
 * gate's `minIndependentGroups` already refuses an all-ungrouped cohort with
 * `below_group_threshold`. Counting an ungrouped person as a person keeps
 * `distinctActors` honest for the k floor instead of quietly under-reporting it.
 *
 * ── OBSERVED vs INFERRED, STRUCTURALLY ───────────────────────────────────────
 * §10: "Observed movement and inferred cause must be separately represented."
 * That is enforced by types here, not by discipline:
 *
 *   * `event_context` is a CAUSE-ONLY family. A MovementSignal carrying it is
 *     REJECTED at intake (`cause_is_not_observation`) — an adjacent event ending
 *     is a hypothesis about WHY, never evidence that anybody moved, so it can
 *     never help satisfy MIN_SIGNAL_FAMILIES or add a body to a cohort.
 *   * A `CauseHypothesis` has no `actorId`, no `groupKey` and no count field.
 *     There is literally nothing on it that arithmetic could pick up.
 *   * `deriveZoneTransitions` returns transitions with `inferredCause`
 *     UNDEFINED. Only `attachCauseHypotheses` sets it, and it copies the
 *     observed fields untouched. The test asserts the observed half is
 *     deep-equal before and after.
 *   * A cause's confidence is capped at `provisional` and at the observation's
 *     own band, whichever is lower. An inference about why is never stronger
 *     than the count it explains.
 *
 * ── PURITY ───────────────────────────────────────────────────────────────────
 * Everything above is pure: rows in, transitions out, `now` injected, no clock
 * of its own. The single I/O function is `readCrowdFlowSignals`, marked as such,
 * with the service client injected — so the derivation is unit-testable without
 * a database.
 *
 * ── WHAT ACTUALLY FEEDS THIS TODAY: TWO FAMILIES. STATED, NOT IMPLIED. ───────
 * §10 names seven input families. Audited 2026-08-31 against the schema rather
 * than against a previous note; every claim below names where it was checked.
 * `UNFED_FAMILY_BLOCKERS` (below) is the same audit as DATA, so a future wiring
 * attempt has to confront it rather than skim past a comment.
 *
 * `accepted_plan` WAS UNFED AND IS NOW FED. The earlier revision of this header
 * recorded four blockers against it, and all four have been closed — by
 * capture, schema and policy work, NOT by relaxing a gate. MIN_SIGNAL_FAMILIES,
 * PRIVACY_THRESHOLD_V1, maxGroupShare and the freshness horizon are all exactly
 * as they were. What changed:
 *
 *   NOTHING WAS EVER ACCEPTED   ->  POST /api/route-plans/:id/accept is now the
 *                                   ONLY writer of status='active', and
 *                                   migration 2224's CHECK constraint
 *                                   route_plans_accepted_requires_evidence makes
 *                                   'active' with no recorded accepter
 *                                   UNREPRESENTABLE. An accepted plan is
 *                                   distinguishable from a generated one in the
 *                                   data, not by convention.
 *   NO LAWFUL BASIS             ->  lib/locationPurposes purpose
 *                                   `route_plan_itinerary`.
 *   NO CONSENT FOR PUBLICATION  ->  route_flow_contribution_consent (2224),
 *                                   default OFF, modelled on
 *                                   intel_contribution_consent (2172, D4), a
 *                                   SEPARATE record so one consent decision does
 *                                   not govern both families.
 *   COORDINATES, NOT ZONES      ->  lib/routeHopSignal.resolveStopZones is the
 *                                   only function that sees {lat,lng} and it
 *                                   returns a type with no coordinate field. A
 *                                   stop that resolves to no zone is dropped,
 *                                   never approximated to its point.
 *
 * AND THE INDEPENDENCE ARGUMENT IS WRITTEN DOWN, NOT ASSERTED. See
 * `SIGNAL_FAMILY_INDEPENDENCE`: source table, derivation path, actor population,
 * correlation risk, failure mode, separateness argument — and, required and
 * non-empty, the part of the claim that does NOT hold. The short version: the
 * family clears the bar on SOURCE independence (different table, writer, consent
 * record and failure mode, so nothing that corrupts one family can fabricate the
 * other) and does NOT clear it on SEMANTIC independence (both families are P0
 * self-reported INTENT and their actor populations overlap). The overlap cannot
 * inflate a cohort — `distinctActors` is a Set keyed on actor id ACROSS families
 * — but two families here certify two independent SOURCES, not two independent
 * populations, and the confidence ladder below is calibrated for that: two
 * families cap the band at `provisional`; `likely_current` needs three.
 *
 * THE RULE THAT DECIDES ALL OF THIS — A HOP NEEDS BOTH ENDPOINTS, AND THE ONLY
 * HONEST WAY TO GET BOTH IS FOR ONE TRAVELLER ACT TO DECLARE BOTH. Six of the
 * seven families are DESTINATION-ONLY events: they record that a person is going
 * to, or has reached, somewhere. Turning one into a hop means supplying the
 * origin from that actor's last known position — `user_location_state`
 * (purpose derived_traveler_state: "Current state only ... state, not history",
 * own-row visibility), `location_snapshots` (safety_anti_spoof,
 * legitimate_interest, 24h, "Never shown to any user") or the actor's own
 * previous event. Each of those is BOTH the trajectory reconstruction §10
 * forbids AND a use outside the source's declared purpose. That is why the
 * register below records `no_declared_origin` rather than "not built yet": for
 * most families this is not a wiring gap that effort closes.
 *
 *   coarse_transition       TABLE ABSENT. `journey_observations` — the only table
 *                           lib/locationPurposes declares for coarse journey
 *                           ingestion (purpose `journey_observation`, consent,
 *                           24h) — has no CREATE TABLE in src/migrations, is
 *                           absent from the 2026-08-19 baseline, and survives
 *                           only as a comment (2130_intel_storage.sql:135). The
 *                           precise table that DOES exist, `location_snapshots`,
 *                           is anti-spoof-only; mining it would be exactly the
 *                           continuous-tracking engine §10 forbids. Refused on
 *                           purpose, not overlooked.
 *   arrival                 NO DECLARED ORIGIN, and party-scoped where it exists.
 *                           `canonical_events` verb 'arrival' (2120) has ZERO
 *                           producers: the only callers of recordEvent /
 *                           recordEvents in the repository are in
 *                           test/canonicalEvents.test.ts. The arrival captures
 *                           that ARE written name a destination and nothing else
 *                           — plan_checkins / plan_attendance_events (purpose
 *                           geofence_checkin, trip-private, one trip = one party,
 *                           so it could never certify independent groups),
 *                           circle_checkins.checkin_type='arrived' (purpose
 *                           presence_in_context, consent, visible in "the trip or
 *                           event context only"), route_stops.checkpoint_status.
 *   accepted_plan           FED (lib/routeHopSignal). `route_legs` is the one
 *                           table in this repository with a real from→to pair AND
 *                           a real writer, and it is now reachable honestly: a
 *                           plan contributes only after the traveller ACCEPTED it
 *                           (POST /api/route-plans/:id/accept), only while the
 *                           accepter's route_flow_contribution_consent is live,
 *                           and only as zone→zone edges. One accepted plan
 *                           contributes ONE person — the accepter — with a crew
 *                           token when the plan belongs to a trip (so five
 *                           friends on one trip collapse to one party) and a solo
 *                           token otherwise, per lib/intelGroupKey's ruling. Legs
 *                           whose stops moved after acceptance are dropped: legs
 *                           are written once and PATCH .../stops/:stopId does not
 *                           recompute them, so such a leg is no longer what was
 *                           accepted. `event_rsvps` remains unusable — it has no
 *                           server writer outside scripts/seed-demo-profile.ts,
 *                           and an RSVP carries no origin.
 *   navigation_start        NO ORIGIN EXISTS, STRUCTURALLY — not merely unwired.
 *                           `canonical_events` verb 'direction' (2120) is the only
 *                           candidate, and its zero producers are the LESSER
 *                           problem. The row shape carries ONE subject
 *                           (subject_kind, subject_id): it can say where a person
 *                           is going and has no column that could say where from.
 *                           `payload` cannot carry one either — lib/canonicalEvents
 *                           strips FORBIDDEN_PAYLOAD_KEYS (lat/lng/latitude/
 *                           longitude/coords/accuracy) absolutely, then projects to
 *                           ALLOWED_PAYLOAD_KEYS, which holds `destination` and
 *                           nothing origin-shaped. canonical_events is also claimed
 *                           by no purpose in lib/locationPurposes and is not in
 *                           REFERENCE_LOCATION_TABLES; it passes
 *                           check:location-purposes only because it holds no
 *                           coordinate columns and the sanitizer guarantees it
 *                           never will. Deriving a geographic zone→zone hop from it
 *                           would turn it into a location table with no lawful
 *                           basis, no retention decision and no consent.
 *                           `compass_user_navigation_patterns`
 *                           (0054_compass_cache.sql: from_screen/to_screen) is
 *                           screen-to-screen navigation, not geographic.
 *   event_context           REAL, and deliberately CAUSE-ONLY (see above).
 *   aggregate_presence      NOT A TRANSITION. `circle_presence`
 *                           (0108_circle_schema_tracked.sql:147) is one row per
 *                           (user, context_type, context_id) holding a status and
 *                           venue / approximate LABELS — presence, with no
 *                           from-zone to be had, circle-scoped, consent-based and
 *                           per-viewer. src/presence/domain/* is Phase-0 types and
 *                           a transport selector: no store, no fusion layer.
 *   next_stop_contribution  REAL SCHEMA + REAL CAPTURE PATH, zero rows. THE ONLY
 *                           family whose source declares BOTH endpoints in one
 *                           act: the contributor is standing at the origin
 *                           (intel_observations.zone_id / subject_id,
 *                           2130_intel_storage.sql:145) at the moment they name
 *                           the destination (value.destinationArea,
 *                           lib/trailFollowup). Captured through
 *                           IntelCaptureService's `trail` surface behind
 *                           `intel_trail_followup` (seeded OFF), carrying
 *                           `group_key` (2171) and D4 consent (2172). It is the
 *                           only family that can certify independent groups.
 *
 * CONCLUSION: two OBSERVED families are fed, which is exactly
 * MIN_SIGNAL_FAMILIES, so this producer can now emit — and the moment it can,
 * the interesting question stops being "is anything wired" and becomes "is the
 * second family real". `SIGNAL_FAMILY_INDEPENDENCE` is where that is answered
 * and where it must keep being answered: adding a THIRD family means writing the
 * same six-term case, and a third family that cannot fill in
 * `residualCorrelation` honestly should not be added. Adding a second CLAIM TYPE
 * to intel_observations still would NOT count — same table, same consent, same
 * capture service, same actor population — and that is the standard any future
 * candidate is measured against.
 *
 * `WIRED_SIGNAL_SOURCES` is the honest register; adding to it is a deliberate
 * edit, pinned by a test.
 *
 * RUNTIME EFFECT TODAY: STILL NONE IN PRACTICE, and stating that plainly matters
 * more than the wiring does. Four independent things must each change before any
 * flow reaches a user, and none of them is this file:
 *
 *   1. `map_crowd_flow_enabled` (migration 2218) is seeded FALSE.
 *   2. No route serves crowd flow: nothing in src/routes calls
 *      `produceZoneTransitions` or `deriveCrowdFlow`.
 *   3. The caller must inject a zone model — `resolveZoneId` for the next-move
 *      family and `resolveZoneForPoint` for accepted plans. Without them both
 *      families resolve nothing and produce nothing, by design.
 *   4. Both consent scopes are default-off and, in production today, empty.
 */
import {
  CROWD_FLOW_SIGNAL_FAMILIES,
  FLOW_DENSITY_BUCKET_MINUTES,
  MIN_SIGNAL_FAMILIES,
  type CrowdFlowSignalFamily,
  type ZoneTransition,
} from "./mapAggregation.js";
import { CONFIDENCE_STATES, type ConfidenceState } from "./mapObjects.js";
import { CLAIM_TYPES, PILOT_CLAIMABLE_MODERATION_STATES } from "./intelContracts.js";
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";
import {
  ACCEPTED_PLAN_FAMILY,
  ACCEPTED_PLAN_INDEPENDENCE,
  readAcceptedPlanHops,
  type AcceptedPlanReadRefusal,
  type FamilyIndependenceCase,
  type HopGroupKeyFn,
  type ResolveZoneForPoint,
} from "./routeHopSignal.js";

// ── Feature flag (migration 2218) ─────────────────────────────────────────────
export const CROWD_FLOW_FLAG = "map_crowd_flow_enabled";

// ── Observed vs cause-only families ───────────────────────────────────────────

/**
 * §10 families that constitute an OBSERVATION of movement. Everything except
 * `event_context`: an event is context for WHY a flow might exist, never
 * evidence that it does.
 */
export const OBSERVED_SIGNAL_FAMILIES: readonly CrowdFlowSignalFamily[] =
  CROWD_FLOW_SIGNAL_FAMILIES.filter((f) => f !== "event_context");

/** §10 families that may only ever inform the INFERRED half. */
export const CAUSE_ONLY_SIGNAL_FAMILIES: readonly CrowdFlowSignalFamily[] = ["event_context"];

/**
 * The families for which a real producer exists in this repository today. See
 * the header audit. Length < MIN_SIGNAL_FAMILIES ⇒ no flow can be published, and
 * `readCrowdFlowSignals` declines to read rather than gathering a cohort it
 * cannot use.
 *
 * Every entry here MUST have a `SIGNAL_FAMILY_INDEPENDENCE` case, which the test
 * enforces. Appending a family without writing that argument is the failure mode
 * this register exists to prevent.
 */
export const WIRED_SIGNAL_SOURCES: readonly CrowdFlowSignalFamily[] = [
  "next_stop_contribution",
  "accepted_plan",
];

/**
 * Families §10 names that this repository declares but does not feed. Kept as
 * data so the gap is inspectable rather than a comment nobody re-reads.
 */
export const DECLARED_BUT_UNFED_FAMILIES: readonly CrowdFlowSignalFamily[] =
  CROWD_FLOW_SIGNAL_FAMILIES.filter(
    (f) => !WIRED_SIGNAL_SOURCES.includes(f) && !CAUSE_ONLY_SIGNAL_FAMILIES.includes(f),
  );

/**
 * WHY a declared family is unfed. The distinction that matters is between
 * `no_producer` (effort closes it) and everything else (effort does not).
 */
export type UnfedBlocker =
  /** The source table lib/locationPurposes declares for it does not exist. */
  | "table_absent"
  /** The table exists and nothing in the repository ever writes a row. */
  | "no_producer"
  /**
   * Rows name a DESTINATION only. An origin could come only from the actor's
   * last known position — the trajectory reconstruction §10 forbids. This is the
   * blocker that no amount of wiring removes.
   */
  | "no_declared_origin"
  /** The source is written, but its declared lawful basis does not cover
   *  publication into a public aggregate. */
  | "purpose_mismatch"
  /** One source row = one party, so it can never certify independent groups. */
  | "party_scoped";

export interface UnfedFamilyFinding {
  /** The blocker that would still stand if every other one were removed. */
  blocker: UnfedBlocker;
  /** Everything else that independently blocks it. A family may fail several ways. */
  alsoBlockedBy: readonly UnfedBlocker[];
  /** Where this was checked. Files, not adjectives. */
  evidence: readonly string[];
}

/**
 * The header audit as DATA, so the gap is inspectable and a future attempt to
 * flip a family into `WIRED_SIGNAL_SOURCES` has to delete a specific, named
 * finding rather than quietly append a string. Pinned by
 * src/test/crowdFlowProducer.test.ts: every DECLARED_BUT_UNFED_FAMILIES entry
 * must appear here, and nothing else may.
 *
 * NOTE THE SHAPE OF THE ANSWER. Only `aggregate_presence` and `coarse_transition`
 * are missing-infrastructure problems. `arrival` and `navigation_start` are
 * missing-CAPTURE problems: their sources are destination-only by construction,
 * and no producer wired onto them would change that.
 */
export const UNFED_FAMILY_BLOCKERS: Readonly<Record<string, UnfedFamilyFinding>> = {
  coarse_transition: {
    blocker: "table_absent",
    alsoBlockedBy: [],
    evidence: [
      "lib/locationPurposes.ts — purpose 'journey_observation' claims journey_observations",
      "src/migrations/** — no CREATE TABLE journey_observations; absent from the 2026-08-19 baseline",
      "src/migrations/2130_intel_storage.sql:135 — named only in a comment",
    ],
  },
  arrival: {
    blocker: "no_declared_origin",
    alsoBlockedBy: ["no_producer", "party_scoped", "purpose_mismatch"],
    evidence: [
      "src/migrations/2120_canonical_events.sql — verb 'arrival' carries ONE subject; no origin column",
      "lib/canonicalEvents.ts — recordEvent/recordEvents called only from test/canonicalEvents.test.ts",
      "src/migrations/0039_plan_geofence_full.sql:41 — plan_attendance_events is trip-scoped (purpose geofence_checkin)",
      "src/migrations/0108_circle_schema_tracked.sql:206 — circle_checkins is circle-scoped (purpose presence_in_context)",
    ],
  },
  // `accepted_plan` USED TO LIVE HERE, with blocker 'purpose_mismatch' and
  // alsoBlockedBy ['no_producer']. It is gone because the finding is gone, not
  // because the finding was inconvenient: the acceptance transition, the
  // `route_plan_itinerary` purpose, the route_flow_contribution_consent scope
  // and the zone quarantine each closed one of its four blockers. Deleting a
  // finding is the friction this register is FOR — the test asserts this object
  // tracks DECLARED_BUT_UNFED_FAMILIES exactly, so a family cannot be wired
  // without someone removing its named finding by hand.
  navigation_start: {
    blocker: "no_declared_origin",
    alsoBlockedBy: ["no_producer", "purpose_mismatch"],
    evidence: [
      "src/migrations/2120_canonical_events.sql — verb 'direction' carries ONE subject (subject_kind, subject_id); no origin column exists",
      "lib/canonicalEvents.ts — FORBIDDEN_PAYLOAD_KEYS strips coordinates absolutely; ALLOWED_PAYLOAD_KEYS holds 'destination' and nothing origin-shaped",
      "lib/locationPurposes.ts — canonical_events is claimed by no purpose and is not REFERENCE_LOCATION_TABLES",
      "src/migrations/0054_compass_cache.sql:109 — compass_user_navigation_patterns is from_screen/to_screen, not geographic",
    ],
  },
  aggregate_presence: {
    blocker: "no_declared_origin",
    alsoBlockedBy: ["party_scoped", "purpose_mismatch"],
    evidence: [
      "src/migrations/0108_circle_schema_tracked.sql:147 — circle_presence is one row per (user, context); a status and labels, no from-zone",
      "src/presence/domain/** — Phase-0 types and a transport selector; no store, no fusion layer",
    ],
  },
} as const;

/**
 * The capture that has to exist before a family may be fed honestly. Stated as a
 * checklist rather than prose because each line is a separate precondition and
 * three of the five are non-engineering decisions.
 *
 * This list is UNCHANGED by `accepted_plan` being wired — it is the standing bar,
 * not a to-do that got ticked off. `SECOND_FAMILY_EVIDENCE` below records how
 * each line was met, one entry per precondition, so "we satisfied the
 * preconditions" is a claim with a file behind it rather than a summary.
 *
 * Deliberately NOT satisfiable by adding another claim type to
 * `intel_observations`: that reuses the same table, the same consent record, the
 * same capture service and the same actor population, so MIN_SIGNAL_FAMILIES
 * would be counting prompts rather than independent sources.
 */
export const SECOND_FAMILY_PRECONDITIONS: readonly string[] = [
  "A traveller act that declares an ORIGIN ZONE in the same act as the destination — never an origin joined in from a last-known position.",
  "The origin at ZONE granularity (district/neighbourhood id), never a coordinate, so no coarsening step can be skipped later.",
  "A consent scope covering publication of that hop into a PUBLIC aggregate, analogous to intel_contribution_consent (D4, migration 2172).",
  "A group_key on the row (as intel_observations gained in 2171), or the family adds bodies but zero group credit and the privacy gate's independent-group floor never clears.",
  "A lib/locationPurposes entry for wherever it lands, with a lawful basis, retention bound, visibility and deletion behaviour.",
];

/**
 * How `accepted_plan` met each precondition, in order. One entry per line of
 * SECOND_FAMILY_PRECONDITIONS — the test asserts the counts match, so a future
 * family cannot be waved through by satisfying four of five.
 */
export const SECOND_FAMILY_EVIDENCE: readonly { precondition: string; satisfiedBy: string }[] = [
  {
    precondition: SECOND_FAMILY_PRECONDITIONS[0],
    satisfiedBy:
      "One route_legs row IS the declaration of both endpoints: it names from_stop_id and to_stop_id, both written at plan creation, and the traveller adopts that whole ordering in one act (POST /api/route-plans/:id/accept). No origin is joined in from user_location_state, location_snapshots or a previous event — lib/routeHopSignal never reads any of them.",
  },
  {
    precondition: SECOND_FAMILY_PRECONDITIONS[1],
    satisfiedBy:
      "lib/routeHopSignal.resolveStopZones is the only function that can see {lat,lng}, and it returns StopZone, which has no coordinate field. deriveAcceptedPlanHops takes StopZone[], so there is no point for a later stage to fall back to. An unresolvable stop is dropped (unresolved_zone); a missing zone resolver yields the refusal no_zone_resolver and zero hops.",
  },
  {
    precondition: SECOND_FAMILY_PRECONDITIONS[2],
    satisfiedBy:
      "route_flow_contribution_consent (migration 2224): default OFF, explicit opt-in, service-role write only, checked per accepter at READ time so a withdrawal takes effect at once. A SEPARATE record from intel_contribution_consent on purpose — one consent decision governing both families would collapse them back into one source.",
  },
  {
    precondition: SECOND_FAMILY_PRECONDITIONS[3],
    satisfiedBy:
      "lib/intelGroupKey.deriveGroupKey, reused verbatim: a crew token keyed on the trip when the plan is trip-linked (five friends on one trip collapse to ONE party), a solo token otherwise, scoped to the EDGE so the same crew on two edges is unlinkable. If the server secret is absent, readAcceptedPlanHops refuses (no_group_key_secret) rather than contributing bodies with zero group credit.",
  },
  {
    precondition: SECOND_FAMILY_PRECONDITIONS[4],
    satisfiedBy:
      "lib/locationPurposes purpose `route_plan_itinerary`: precision precise, lawfulBasis contract, retentionBound content_lifetime, requiresSeparateControl true, with visibility and deletion behaviour naming the RLS policies (0058) and the CASCADE that erases it. Its wording is flagged in-file as needing privacy-policy review.",
  },
];

/**
 * THE INDEPENDENCE ARGUMENT FOR EVERY WIRED FAMILY, AS DATA.
 *
 * §10 requires signals from at least two families, and the point of that rule is
 * that one sensor's artefact cannot masquerade as a crowd. A register of family
 * NAMES cannot tell you whether that holds; only an argument can, and an
 * argument that lives in a commit message is an argument nobody re-reads.
 *
 * So each wired family carries a `FamilyIndependenceCase` in six terms — source
 * table, derivation path, actor population, correlation risk, failure mode,
 * separateness argument — plus a REQUIRED, non-empty `residualCorrelation`
 * naming the part of the claim that does not hold. The test asserts every wired
 * family has a case and that no `residualCorrelation` is empty, because a family
 * whose author could not name a single limitation has not been examined.
 */
export const NEXT_STOP_CONTRIBUTION_INDEPENDENCE: FamilyIndependenceCase = {
  family: "next_stop_contribution",
  sourceTable: ["intel_observations", "intel_contribution_consent"],
  derivationPath: [
    "A traveller standing at a place is prompted on the `trail` surface (IntelCaptureService, behind intel_trail_followup) and names where they are going next.",
    "The row lands in intel_observations with claim_type 'experience.next_move': the ORIGIN is the row's own zone_id / subject_id (where they were standing) and the DESTINATION is value.destinationArea.",
    "readCrowdFlowSignals reads fresh, allowed-moderation-state rows whose actor has a live intel_contribution_consent, resolving both endpoints through the injected resolveZoneId.",
  ],
  actorPopulation:
    "Travellers in the field who are shown the trail prompt, answer it, and have granted D4 intel-contribution consent. Capture-moment population: they are physically at the origin when they declare.",
  correlationRisk:
    "Overlaps with accepted_plan: the same person can accept a route plan and answer a trail prompt about the same edge. The overlap adds no bodies (distinctActors is a Set keyed on actor id across families) but it does mean the two families can trace to one population.",
  failureMode:
    "Silent when intel_trail_followup is off, when the prompt is not shown, when IntelCaptureService fails, or when moderation holds the rows. None of those can stop a traveller from accepting a route plan.",
  separatenessArgument:
    "This is the reference family, not the one under scrutiny — it is the sole surviving family from the original audit, and it is the standard the other is measured against: a different table, writer, consent record and capture surface from anything else that feeds this producer.",
  residualCorrelation:
    "P0 unverified self-report of INTENT, exactly like accepted_plan. The two families are structurally independent and semantically similar, so agreement between them is weaker evidence than agreement between an intent signal and a measured one would be. No measured-movement family exists in this repository (see UNFED_FAMILY_BLOCKERS: every remaining candidate is destination-only or has no table).",
  evidence: [
    "src/migrations/2130_intel_storage.sql:145 — intel_observations.zone_id / subject_id carry the origin",
    "src/lib/trailFollowup.ts — value.destinationArea is the declared destination",
    "src/migrations/2171_intel_group_signal.sql — group_key; src/migrations/2172_intel_contribution_consent.sql — D4 consent",
    "src/lib/intelContracts.ts — INTEL_FLAGS / intel_trail_followup, seeded off",
  ],
};

export const SIGNAL_FAMILY_INDEPENDENCE: Readonly<Record<string, FamilyIndependenceCase>> = {
  next_stop_contribution: NEXT_STOP_CONTRIBUTION_INDEPENDENCE,
  accepted_plan: ACCEPTED_PLAN_INDEPENDENCE,
};

/** True iff enough OBSERVED families are wired for a flow to be publishable at all. */
export function canProduceFlow(wired: readonly CrowdFlowSignalFamily[] = WIRED_SIGNAL_SOURCES): boolean {
  const observed = new Set(wired.filter((f) => OBSERVED_SIGNAL_FAMILIES.includes(f)));
  return observed.size >= MIN_SIGNAL_FAMILIES;
}

// ── Freshness horizon ─────────────────────────────────────────────────────────

/**
 * Oldest a raw signal may be and still count toward a cohort, in minutes.
 * Anchored to the `experience.next_move` TTL in the claim registry (1800s) — the
 * spec's own clock for aggregate next-stop movement — rather than a number
 * invented here. §37: "Do not let stale claims remain visually live."
 */
export const SIGNAL_MAX_AGE_MINUTES: number =
  (CLAIM_TYPES.find((c) => c.claimType === "experience.next_move")?.ttlSeconds ?? 1800) / 60;

// ── Inputs ────────────────────────────────────────────────────────────────────

/**
 * ONE observed hop between two zones by one person.
 *
 * This is deliberately not a path, a route, or a position pair: it is already
 * zone-to-zone, so no coordinate and no ordering beyond a single edge ever
 * enters this module. `actorId` and `groupKey` are consumed for counting and are
 * never copied into any output.
 */
export interface MovementSignal {
  /** Counting only. NEVER appears in a returned value. */
  actorId: string;
  /** Certified party token (intel_observations.group_key). Null ⇒ zero group credit. */
  groupKey?: string | null;
  family: string;
  fromZoneId: string;
  toZoneId: string;
  observedAt: string | number | Date;
  /** Protected origin/destination — poisons the whole bucket, fail-closed. */
  sensitiveSubject?: boolean;
}

/**
 * A hypothesis about WHY a zone is drawing people. Note what is absent: no
 * actor, no group, no count, no cohort. There is nothing here that the
 * observation arithmetic could pick up even by accident.
 */
export interface CauseHypothesis {
  /** The destination zone this hypothesis is about. */
  zoneId: string;
  /** Human-readable cause, e.g. "Concert at Riverside ends around now". */
  cause: string;
  /** What the hypothesis rests on, e.g. ["event:1234"]. Never a person. */
  basis?: readonly string[];
  /** The proposer's own band. Capped on attach; never raises the observation. */
  confidence?: ConfidenceState;
}

export type SignalRejectionReason =
  | "invalid_input"
  | "unrecognized_family"
  | "cause_is_not_observation"
  | "not_a_transition"
  | "unknown_zone"
  | "stale_signal"
  | "future_signal";

export interface SignalRejection {
  fromZoneId: string;
  toZoneId: string;
  reason: SignalRejectionReason;
}

export interface DeriveZoneTransitionsOptions {
  now?: string | number | Date;
  /** Zone id → CENTROID. A zone with no centroid yields no transition. */
  zoneCentroids?: ReadonlyMap<string, { lat: number; lng: number }>;
  /** Defaults to FLOW_DENSITY_BUCKET_MINUTES (the privacy time bucket). */
  bucketMinutes?: number;
  /** Defaults to SIGNAL_MAX_AGE_MINUTES. */
  maxSignalAgeMinutes?: number;
}

export interface DeriveZoneTransitionsResult {
  /** Observed movement only — `inferredCause` is always undefined here. */
  transitions: ZoneTransition[];
  /** Why each discarded signal contributed nothing. Never a silent drop. */
  rejected: SignalRejection[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function toEpochMs(t: string | number | Date | null | undefined): number | null {
  if (t === null || t === undefined) return null;
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isRecognizedFamily(f: unknown): f is CrowdFlowSignalFamily {
  return typeof f === "string" && (CROWD_FLOW_SIGNAL_FAMILIES as readonly string[]).includes(f);
}

/**
 * Confidence band for an observed transition. Deliberately capped at
 * `likely_current`: this producer's inputs are P0 (unverified self-report), so
 * it must never mint a `live` or `strong` band. Under-scoring hides a label;
 * over-scoring invents one.
 */
function observedConfidence(familyCount: number): ConfidenceState {
  if (familyCount >= 3) return "likely_current";
  if (familyCount >= MIN_SIGNAL_FAMILIES) return "provisional";
  return "unverified";
}

// ── The derivation (PURE) ─────────────────────────────────────────────────────

interface Bucket {
  fromZoneId: string;
  toZoneId: string;
  bucketStartMs: number;
  latestObservedMs: number;
  /** Actor ids live HERE and nowhere else. Never read out, only sized. */
  actors: Set<string>;
  /** group key → the distinct actors seen under it. */
  groupActors: Map<string, Set<string>>;
  /** Union of actors that carry ANY group key — the maxGroupShare denominator. */
  groupedActorUnion: Set<string>;
  families: Set<CrowdFlowSignalFamily>;
  sensitive: boolean;
}

/**
 * Fold raw movement signals into `ZoneTransition[]`.
 *
 * PURE — `now` is injected, there is no clock and no I/O. Every discard is
 * reported in `rejected`; nothing is dropped silently.
 *
 * The bucket tuple (from, to, window) is carried IN the accumulator and never
 * encoded into the map key and parsed back: a zone id can contain any character,
 * so there is no safe in-band delimiter (the same reasoning
 * lib/trailFollowup.aggregateNextMoves records).
 */
export function deriveZoneTransitions(
  signals: readonly MovementSignal[],
  opts: DeriveZoneTransitionsOptions = {},
): DeriveZoneTransitionsResult {
  const rejected: SignalRejection[] = [];
  if (!Array.isArray(signals) || signals.length === 0) return { transitions: [], rejected };

  const nowMs = toEpochMs(opts.now ?? Date.now());
  if (nowMs === null) return { transitions: [], rejected };

  const bucketMinutes =
    finite(opts.bucketMinutes) && opts.bucketMinutes > 0
      ? opts.bucketMinutes
      : FLOW_DENSITY_BUCKET_MINUTES;
  const bucketMs = bucketMinutes * 60_000;
  const maxAgeMs =
    (finite(opts.maxSignalAgeMinutes) && opts.maxSignalAgeMinutes > 0
      ? opts.maxSignalAgeMinutes
      : SIGNAL_MAX_AGE_MINUTES) * 60_000;
  const centroids = opts.zoneCentroids ?? new Map<string, { lat: number; lng: number }>();

  const buckets = new Map<string, Bucket>();

  for (const s of signals) {
    const id = {
      fromZoneId: typeof s?.fromZoneId === "string" ? s.fromZoneId : "",
      toZoneId: typeof s?.toZoneId === "string" ? s.toZoneId : "",
    };
    if (
      !s ||
      typeof s.actorId !== "string" ||
      s.actorId === "" ||
      !id.fromZoneId ||
      !id.toZoneId
    ) {
      rejected.push({ ...id, reason: "invalid_input" });
      continue;
    }

    // A cause is never an observation. Checked BEFORE family recognition so the
    // refusal names the real problem.
    if (
      typeof s.family === "string" &&
      (CAUSE_ONLY_SIGNAL_FAMILIES as readonly string[]).includes(s.family)
    ) {
      rejected.push({ ...id, reason: "cause_is_not_observation" });
      continue;
    }
    if (!isRecognizedFamily(s.family) || !OBSERVED_SIGNAL_FAMILIES.includes(s.family)) {
      rejected.push({ ...id, reason: "unrecognized_family" });
      continue;
    }

    if (id.fromZoneId === id.toZoneId) {
      rejected.push({ ...id, reason: "not_a_transition" });
      continue;
    }

    const observedMs = toEpochMs(s.observedAt);
    if (observedMs === null) {
      rejected.push({ ...id, reason: "invalid_input" });
      continue;
    }
    // A clock we cannot trust must not buy a fresh label (mirrors
    // mapObjects.deriveFreshness, which calls a future timestamp 'unknown').
    if (observedMs > nowMs) {
      rejected.push({ ...id, reason: "future_signal" });
      continue;
    }
    if (nowMs - observedMs > maxAgeMs) {
      rejected.push({ ...id, reason: "stale_signal" });
      continue;
    }

    // Both endpoints must resolve to a zone CENTROID. No centroid, no geometry,
    // and we will not fall back to anything sharper.
    const from = centroids.get(id.fromZoneId);
    const to = centroids.get(id.toZoneId);
    if (
      !from || !to ||
      !finite(from.lat) || !finite(from.lng) || !finite(to.lat) || !finite(to.lng) ||
      Math.abs(from.lat) > 90 || Math.abs(to.lat) > 90 ||
      Math.abs(from.lng) > 180 || Math.abs(to.lng) > 180
    ) {
      rejected.push({ ...id, reason: "unknown_zone" });
      continue;
    }

    const bucketStartMs = Math.floor(observedMs / bucketMs) * bucketMs;
    const key = JSON.stringify([id.fromZoneId, id.toZoneId, bucketStartMs]);
    let b = buckets.get(key);
    if (!b) {
      b = {
        fromZoneId: id.fromZoneId,
        toZoneId: id.toZoneId,
        bucketStartMs,
        latestObservedMs: observedMs,
        actors: new Set(),
        groupActors: new Map(),
        groupedActorUnion: new Set(),
        families: new Set(),
        sensitive: false,
      };
      buckets.set(key, b);
    }
    b.actors.add(s.actorId);
    b.families.add(s.family);
    if (observedMs > b.latestObservedMs) b.latestObservedMs = observedMs;
    // Fail-closed OR: one protected endpoint poisons the whole bucket.
    if (s.sensitiveSubject === true) b.sensitive = true;
    // Group credit ONLY from a real, non-empty key. A bare actor is never
    // promoted to a party (lib/intelProjectionAggregator's rule, verbatim).
    if (typeof s.groupKey === "string" && s.groupKey !== "") {
      let set = b.groupActors.get(s.groupKey);
      if (!set) {
        set = new Set();
        b.groupActors.set(s.groupKey, set);
      }
      set.add(s.actorId);
      b.groupedActorUnion.add(s.actorId);
    }
  }

  const transitions: ZoneTransition[] = [];
  for (const b of buckets.values()) {
    const from = centroids.get(b.fromZoneId)!;
    const to = centroids.get(b.toZoneId)!;

    let maxGroupActors = 0;
    for (const set of b.groupActors.values()) {
      if (set.size > maxGroupActors) maxGroupActors = set.size;
    }
    // Denominator is the DISTINCT grouped actors (the union), not the sum of
    // per-group sizes, so an actor in several crews cannot dilute the dominant
    // group's share. Always finite (0 when nothing is grouped) so the privacy
    // gate returns an accurate below_group_threshold, never invalid_input.
    const maxGroupShare =
      b.groupedActorUnion.size > 0 ? maxGroupActors / b.groupedActorUnion.size : 0;

    const families = [...b.families].sort();
    const observedIso = new Date(b.latestObservedMs).toISOString();

    // `dispersing` and `unusual` are NOT set. deriveCrowdFlow takes them as
    // explicitly-flagged facts; deducing "dispersing" from a falling count here
    // would be an inference wearing an observation's clothes, which is the one
    // thing §10 forbids.
    transitions.push({
      fromZoneId: b.fromZoneId,
      toZoneId: b.toZoneId,
      from: { lat: from.lat, lng: from.lng },
      to: { lat: to.lat, lng: to.lng },
      distinctActors: b.actors.size,
      distinctGroups: b.groupActors.size,
      maxGroupShare,
      signalFamilies: families,
      windowMinutes: bucketMinutes,
      observedAt: observedIso,
      expiresAt: new Date(b.latestObservedMs + maxAgeMs).toISOString(),
      confidence: observedConfidence(families.length),
      privacyClass: "aggregate_only",
      sensitiveSubject: b.sensitive,
      // inferredCause is deliberately ABSENT. Only attachCauseHypotheses sets it.
    });
  }

  // Deterministic order regardless of input order, so paging is stable.
  transitions.sort((a, b) => {
    const ka = `${a.fromZoneId}\u0000${a.toZoneId}\u0000${String(a.observedAt)}`;
    const kb = `${b.fromZoneId}\u0000${b.toZoneId}\u0000${String(b.observedAt)}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return { transitions, rejected };
}

// ── Inferred cause (separate stage, separate type, capped confidence) ─────────

const CONFIDENCE_RANK = new Map<ConfidenceState, number>(
  CONFIDENCE_STATES.map((c, i) => [c, i] as const),
);

/** Ceiling for any inferred cause. A guess about WHY is never "live" or "strong". */
export const MAX_INFERRED_CAUSE_CONFIDENCE: ConfidenceState = "provisional";

function capCauseConfidence(
  proposed: ConfidenceState | undefined,
  observed: ConfidenceState | undefined,
): ConfidenceState {
  const lowest = CONFIDENCE_STATES[0] as ConfidenceState;
  const p = CONFIDENCE_RANK.get(proposed as ConfidenceState);
  const o = CONFIDENCE_RANK.get(observed as ConfidenceState) ?? 0;
  const ceiling = CONFIDENCE_RANK.get(MAX_INFERRED_CAUSE_CONFIDENCE) ?? 0;
  if (p === undefined) return lowest;
  return CONFIDENCE_STATES[Math.min(p, o, ceiling)] as ConfidenceState;
}

/**
 * Attach at most one cause HYPOTHESIS per transition, matched on the DESTINATION
 * zone. Returns new objects; the observed half of every transition is copied
 * through byte-for-byte, which the test asserts by deep-equal.
 *
 * A hypothesis cannot influence the observation: it carries no actor, no group
 * and no count, and this function touches no counting field. Pure.
 */
export function attachCauseHypotheses(
  transitions: readonly ZoneTransition[],
  hypotheses: readonly CauseHypothesis[],
): ZoneTransition[] {
  if (!Array.isArray(transitions)) return [];
  const byZone = new Map<string, CauseHypothesis>();
  for (const h of hypotheses ?? []) {
    if (!h || typeof h.zoneId !== "string" || h.zoneId === "") continue;
    if (typeof h.cause !== "string" || h.cause.trim() === "") continue;
    if (!byZone.has(h.zoneId)) byZone.set(h.zoneId, h);
  }

  return transitions.map((t) => {
    const h = byZone.get(t.toZoneId);
    if (!h) return { ...t };
    return {
      ...t,
      inferredCause: {
        text: h.cause,
        confidence: capCauseConfidence(h.confidence, t.confidence),
        basis: Array.isArray(h.basis) ? [...h.basis] : [],
      },
    };
  });
}

// ── I/O — the ONLY function here that touches a database ──────────────────────

export type SignalReadRefusal =
  | "flag_off"
  | "insufficient_wired_families"
  | "no_service_client"
  | "read_failed";

export interface ReadCrowdFlowSignalsResult {
  signals: MovementSignal[];
  /** Populated when nothing was read AT ALL. Never a silent empty. */
  refusal: SignalReadRefusal | null;
  /** Families §10 names that this repository does not feed. */
  unfedFamilies: readonly CrowdFlowSignalFamily[];
  /**
   * Per-family outcome. A family that refused reports WHY here while the others
   * still contribute, so a partially-fed read is legible instead of looking like
   * a thin crowd. Note this is diagnostic only and cannot rescue a flow: a family
   * that returned nothing contributes no signal, so deriveCrowdFlow's own
   * families gate refuses the bucket with `insufficient_signal_families`. A
   * failure here shrinks what publishes; it can never widen it.
   */
  familyRefusals: Readonly<Record<string, string | null>>;
}

export interface ReadCrowdFlowSignalsOptions {
  now?: string | number | Date;
  maxSignalAgeMinutes?: number;
  /**
   * Maps an intel_observations row's origin place / destination area onto zone
   * ids. Injected because zone identity is the caller's model, not this
   * module's. A hop either endpoint cannot resolve is dropped.
   */
  resolveZoneId?: (kind: "origin_place" | "destination_area", key: string) => string | null;
  /**
   * Maps a route stop's coordinate onto a zone id, for the `accepted_plan`
   * family. Injected for the same reason, and REQUIRED for that family: without
   * it lib/routeHopSignal refuses rather than letting a point through.
   */
  resolveZoneForPoint?: ResolveZoneForPoint;
  /** Test seam for the accepted-plan party token. */
  groupKeyFor?: HopGroupKeyFn;
  /** Test seam. Defaults to WIRED_SIGNAL_SOURCES. */
  wired?: readonly CrowdFlowSignalFamily[];
}

/**
 * Read every WIRED §10 family as MovementSignals.
 *
 * IT REFUSES BEFORE IT READS when fewer than MIN_SIGNAL_FAMILIES observed
 * families are wired: no cohort assembled then could ever publish, and gathering
 * consent-scoped contribution rows anyway would be processing personal data for
 * an outcome that cannot exist. So the family check runs FIRST and no query is
 * issued at all.
 *
 * TWO families are read today, each behind its OWN consent scope, and both
 * follow lib/intelProjectionAggregator.assembleClaimInput's rule: consent
 * enforced per actor (enabled AND not withdrawn), with a consent-read failure
 * leaving the consented set EMPTY. A failure can shrink a cohort, never inflate
 * one.
 *
 *   next_stop_contribution  intel_observations claim_type experience.next_move,
 *                           allowed moderation states only, unexpired only, D4
 *                           consent (intel_contribution_consent).
 *   accepted_plan           lib/routeHopSignal.readAcceptedPlanHops — accepted
 *                           route plans only, route_flow_contribution_consent,
 *                           zone granularity enforced by type.
 *
 * A family that refuses does NOT abort the read: its refusal is reported in
 * `familyRefusals` and the others still contribute. That is safe because a
 * missing family cannot help anything publish — the surviving signals carry
 * fewer families and deriveCrowdFlow's own gate refuses the bucket. The overall
 * `refusal` stays null whenever at least one family was actually queried, so a
 * caller can tell "we looked and found nothing" from "we declined to look".
 */
export async function readCrowdFlowSignals(
  sc: any,
  opts: ReadCrowdFlowSignalsOptions = {},
): Promise<ReadCrowdFlowSignalsResult> {
  const familyRefusals: Record<string, string | null> = {};
  const empty = (refusal: SignalReadRefusal | null): ReadCrowdFlowSignalsResult => ({
    signals: [],
    refusal,
    unfedFamilies: DECLARED_BUT_UNFED_FAMILIES,
    familyRefusals,
  });

  const wired = opts.wired ?? WIRED_SIGNAL_SOURCES;
  // FIRST — before any read. See the docstring.
  if (!canProduceFlow(wired)) return empty("insufficient_wired_families");
  if (!sc) return empty("no_service_client");
  if (!(await isFlagEnabled(sc, CROWD_FLOW_FLAG))) return empty("flag_off");

  const nowMs = toEpochMs(opts.now ?? Date.now()) ?? Date.now();
  const maxAgeMinutes =
    finite(opts.maxSignalAgeMinutes) && opts.maxSignalAgeMinutes > 0
      ? opts.maxSignalAgeMinutes
      : SIGNAL_MAX_AGE_MINUTES;
  const sinceIso = new Date(nowMs - maxAgeMinutes * 60_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const resolveZoneId = opts.resolveZoneId ?? (() => null);

  const signals: MovementSignal[] = [];

  // ── accepted_plan (lib/routeHopSignal) ──────────────────────────────────────
  if (wired.includes(ACCEPTED_PLAN_FAMILY)) {
    const hops = await readAcceptedPlanHops(sc, {
      now: nowMs,
      maxAgeMinutes,
      resolveZoneForPoint: opts.resolveZoneForPoint,
      groupKeyFor: opts.groupKeyFor,
    });
    familyRefusals[ACCEPTED_PLAN_FAMILY] = hops.refusal as AcceptedPlanReadRefusal | null;
    signals.push(...hops.signals);
  }

  if (!wired.includes("next_stop_contribution")) {
    return { signals, refusal: null, unfedFamilies: DECLARED_BUT_UNFED_FAMILIES, familyRefusals };
  }

  try {
    const { data, error } = await sc
      .from("intel_observations")
      .select("actor_id, subject_id, zone_id, value, group_key, observed_at, expires_at")
      .eq("claim_type", "experience.next_move")
      .in("moderation_state", PILOT_CLAIMABLE_MODERATION_STATES as unknown as string[])
      .gte("observed_at", sinceIso);
    if (error || !data) {
      logger.warn({ err: error }, "crowdFlowProducer: next_move read failed");
      // Report the family's failure, keep whatever the other family produced.
      // Those signals carry ONE family, so deriveCrowdFlow refuses the bucket —
      // a failed read shrinks the result and cannot widen it.
      familyRefusals.next_stop_contribution = "read_failed";
      return { signals, refusal: null, unfedFamilies: DECLARED_BUT_UNFED_FAMILIES, familyRefusals };
    }

    const fresh = (data as any[]).filter((o) => !o.expires_at || o.expires_at > nowIso);

    // D4 consent parity with system promotion (2174). An actor who withdrew
    // consent must not keep inflating a cohort. Fail-soft to EMPTY.
    const actorIds = [...new Set(fresh.map((o) => o.actor_id).filter(Boolean))];
    let consented = new Set<string>();
    if (actorIds.length > 0) {
      const { data: consentRows, error: consentErr } = await sc
        .from("intel_contribution_consent")
        .select("user_id")
        .in("user_id", actorIds)
        .eq("enabled", true)
        .is("withdrawn_at", null);
      if (consentErr) {
        logger.warn({ err: consentErr }, "crowdFlowProducer: consent read failed; cohort empty");
      } else {
        consented = new Set(((consentRows as any[]) ?? []).map((r) => r.user_id as string));
      }
    }

    for (const o of fresh) {
      if (!o.actor_id || !consented.has(o.actor_id)) continue;
      const destinationArea =
        o.value && typeof o.value === "object" && typeof (o.value as any).destinationArea === "string"
          ? ((o.value as any).destinationArea as string)
          : null;
      if (!destinationArea) continue;
      const fromZoneId =
        (typeof o.zone_id === "string" && o.zone_id !== "" ? o.zone_id : null) ??
        (o.subject_id ? resolveZoneId("origin_place", String(o.subject_id)) : null);
      const toZoneId = resolveZoneId("destination_area", destinationArea);
      if (!fromZoneId || !toZoneId) continue;
      signals.push({
        actorId: String(o.actor_id),
        groupKey: typeof o.group_key === "string" && o.group_key !== "" ? o.group_key : null,
        family: "next_stop_contribution",
        fromZoneId,
        toZoneId,
        observedAt: o.observed_at,
      });
    }
    familyRefusals.next_stop_contribution = null;
    return { signals, refusal: null, unfedFamilies: DECLARED_BUT_UNFED_FAMILIES, familyRefusals };
  } catch (err) {
    logger.warn({ err }, "crowdFlowProducer: next_move read threw");
    familyRefusals.next_stop_contribution = "read_failed";
    return { signals, refusal: null, unfedFamilies: DECLARED_BUT_UNFED_FAMILIES, familyRefusals };
  }
}

/**
 * Convenience for a route: read → derive → attach cause. Returns transitions
 * ready for `deriveCrowdFlow`, plus the refusal so the caller can say WHY the
 * layer is empty instead of rendering a blank map.
 */
export async function produceZoneTransitions(
  sc: any,
  opts: ReadCrowdFlowSignalsOptions & DeriveZoneTransitionsOptions & {
    causeHypotheses?: readonly CauseHypothesis[];
  } = {},
): Promise<DeriveZoneTransitionsResult & {
  refusal: SignalReadRefusal | null;
  familyRefusals: Readonly<Record<string, string | null>>;
}> {
  const read = await readCrowdFlowSignals(sc, opts);
  if (read.refusal !== null) {
    return { transitions: [], rejected: [], refusal: read.refusal, familyRefusals: read.familyRefusals };
  }
  const derived = deriveZoneTransitions(read.signals, opts);
  return {
    transitions: attachCauseHypotheses(derived.transitions, opts.causeHypotheses ?? []),
    rejected: derived.rejected,
    refusal: null,
    familyRefusals: read.familyRefusals,
  };
}
