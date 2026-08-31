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
 * ── WHAT ACTUALLY FEEDS THIS TODAY: NOTHING. STATED, NOT IMPLIED. ────────────
 * §10 names seven input families. Audited against this repository:
 *
 *   coarse_transition       NOT FED. The only table declared for coarse journey
 *                           ingestion is `journey_observations`
 *                           (lib/locationPurposes, purpose `journey_observation`)
 *                           and it does not exist: no migration, absent from the
 *                           2026-08-19 baseline, no code. The precise table that
 *                           DOES exist, `location_snapshots`, belongs to the
 *                           `safety_anti_spoof` purpose — anti-spoof only,
 *                           legitimate_interest, 24h. Mining it for crowd flow
 *                           would be exactly the continuous-tracking engine §10
 *                           forbids and would break the purpose registry. Refused
 *                           on purpose, not overlooked.
 *   arrival                 NOT FED for a public flow. `canonical_events` verb
 *                           'arrival' exists (migration 2120) with ZERO
 *                           producers — nothing calls recordEvent/recordEvents.
 *                           `plan_attendance_events` is written, but under the
 *                           `geofence_checkin` purpose: trip-private, and
 *                           party-scoped by construction (one trip = one group),
 *                           so it could never certify independent groups.
 *   accepted_plan           NOT FED. `event_rsvps` has no server writer outside
 *                           the demo seeder, and an RSVP carries no ORIGIN zone,
 *                           so it cannot name a from→to hop at all.
 *   navigation_start        NOT FED. `canonical_events` verb 'direction' — same
 *                           unfed spine. `compass_user_navigation_patterns` is
 *                           screen-to-screen navigation, not geographic.
 *   event_context           REAL, and deliberately CAUSE-ONLY (see above).
 *   aggregate_presence      NOT FED. src/presence/domain/* is Phase-0 domain
 *                           types and a transport selector; there is no fusion
 *                           layer and no presence store. `circle_presence` is
 *                           circle-scoped and per-viewer, not an aggregate.
 *   next_stop_contribution  REAL SCHEMA + REAL CAPTURE PATH, zero rows.
 *                           `intel_observations` claim_type
 *                           'experience.next_move', captured through
 *                           IntelCaptureService's `trail` surface behind
 *                           `intel_trail_followup` (seeded OFF), carrying
 *                           `group_key` (2171) and D4 consent (2172). It is the
 *                           only family that can certify independent groups.
 *
 * ONE fed family, and §10 requires MIN_SIGNAL_FAMILIES (2). So this producer
 * emits nothing today, and `readCrowdFlowSignals` REFUSES TO READ AT ALL rather
 * than touching consent-scoped contribution data for a result that provably
 * cannot publish. `WIRED_SIGNAL_SOURCES` is the honest register; adding to it is
 * a deliberate edit, pinned by a test.
 *
 * RUNTIME EFFECT: NONE until `map_crowd_flow_enabled` (migration 2205) is on AND
 * a second observed family is wired.
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

// ── Feature flag (migration 2205) ─────────────────────────────────────────────
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
 */
export const WIRED_SIGNAL_SOURCES: readonly CrowdFlowSignalFamily[] = ["next_stop_contribution"];

/**
 * Families §10 names that this repository declares but does not feed. Kept as
 * data so the gap is inspectable rather than a comment nobody re-reads.
 */
export const DECLARED_BUT_UNFED_FAMILIES: readonly CrowdFlowSignalFamily[] =
  CROWD_FLOW_SIGNAL_FAMILIES.filter(
    (f) => !WIRED_SIGNAL_SOURCES.includes(f) && !CAUSE_ONLY_SIGNAL_FAMILIES.includes(f),
  );

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
  /** Populated when nothing was read. Never a silent empty. */
  refusal: SignalReadRefusal | null;
  /** Families §10 names that this repository does not feed. */
  unfedFamilies: readonly CrowdFlowSignalFamily[];
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
  /** Test seam. Defaults to WIRED_SIGNAL_SOURCES. */
  wired?: readonly CrowdFlowSignalFamily[];
}

/**
 * Read today's only real §10 family — `experience.next_move` next-stop
 * contributions — as MovementSignals.
 *
 * IT REFUSES BEFORE IT READS. Fewer than MIN_SIGNAL_FAMILIES observed families
 * are wired in this repository, so no cohort assembled here could ever publish;
 * gathering consent-scoped contribution rows anyway would be processing personal
 * data for an outcome that cannot exist. So the family check runs FIRST, and the
 * query is never issued. Flip a second entry into WIRED_SIGNAL_SOURCES and this
 * starts reading.
 *
 * When it does read, it mirrors lib/intelProjectionAggregator.assembleClaimInput
 * exactly: allowed moderation states only, unexpired rows only, and D4 consent
 * enforced per actor (enabled AND not withdrawn) with a consent-read failure
 * leaving the consented set EMPTY — a failure can shrink a cohort, never inflate
 * one.
 */
export async function readCrowdFlowSignals(
  sc: any,
  opts: ReadCrowdFlowSignalsOptions = {},
): Promise<ReadCrowdFlowSignalsResult> {
  const empty = (refusal: SignalReadRefusal | null): ReadCrowdFlowSignalsResult => ({
    signals: [],
    refusal,
    unfedFamilies: DECLARED_BUT_UNFED_FAMILIES,
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

  try {
    const { data, error } = await sc
      .from("intel_observations")
      .select("actor_id, subject_id, zone_id, value, group_key, observed_at, expires_at")
      .eq("claim_type", "experience.next_move")
      .in("moderation_state", PILOT_CLAIMABLE_MODERATION_STATES as unknown as string[])
      .gte("observed_at", sinceIso);
    if (error || !data) {
      logger.warn({ err: error }, "crowdFlowProducer: next_move read failed");
      return empty("read_failed");
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

    const signals: MovementSignal[] = [];
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
    return { signals, refusal: null, unfedFamilies: DECLARED_BUT_UNFED_FAMILIES };
  } catch (err) {
    logger.warn({ err }, "crowdFlowProducer: next_move read threw");
    return empty("read_failed");
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
): Promise<DeriveZoneTransitionsResult & { refusal: SignalReadRefusal | null }> {
  const read = await readCrowdFlowSignals(sc, opts);
  if (read.refusal !== null) return { transitions: [], rejected: [], refusal: read.refusal };
  const derived = deriveZoneTransitions(read.signals, opts);
  return {
    transitions: attachCauseHypotheses(derived.transitions, opts.causeHypotheses ?? []),
    rejected: derived.rejected,
    refusal: null,
  };
}
