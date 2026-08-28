/**
 * Presence Network — domain types (spec §56 Phase 0).
 *
 * TYPES AND PURE FUNCTIONS ONLY. No tables, no writers, no feature logic, and
 * deliberately no dependency on the journey_* family while its ownership is
 * unresolved. Nothing here reaches a database.
 *
 * The two invariants this module exists to make *unrepresentable-if-violated*,
 * rather than merely documented:
 *
 *   §2.2  Observation ≠ inference ≠ prediction. A raw observation and a derived
 *         estimate are DIFFERENT TYPES here, so code cannot accidentally store an
 *         inference as though it were a fact.
 *   §52   A consumer can never obtain more precision than policy allows. Precision
 *         is an ordered ladder and the only exported combinator narrows.
 */

/** §52 precision ladder, ordered least → most revealing. Order is load-bearing. */
export const PRECISION_LADDER = [
  "none",
  "presence_only",
  "venue",
  "zone",
  "approximate",
  "nearby",
  "precise",
] as const;
export type LocationPrecision = (typeof PRECISION_LADDER)[number];

/** Numeric rank; higher = more revealing. */
export function precisionRank(p: LocationPrecision): number {
  return PRECISION_LADDER.indexOf(p);
}

/**
 * §52's whole rule, as one function: the effective precision is the LEAST
 * revealing of what was asked for and what policy permits. There is deliberately
 * no `widen` counterpart — a widening helper is how precision leaks get written.
 */
export function narrowestPrecision(
  requested: LocationPrecision,
  allowedByPolicy: LocationPrecision,
): LocationPrecision {
  return precisionRank(requested) <= precisionRank(allowedByPolicy) ? requested : allowedByPolicy;
}

/** Per-feature ceilings from §52. A feature may ask for less, never for more. */
export const FEATURE_PRECISION_CEILING = {
  crowd_intelligence: "presence_only",
  bump: "zone",
  crew: "precise",
  proof_of_presence: "presence_only",
} as const satisfies Record<string, LocationPrecision>;

/** §8 evidence sources. `relay` is separate from `ble_direct` on purpose. */
export const EVIDENCE_TYPES = [
  "gps", "ble_direct", "ble_relay", "peer", "venue_anchor",
  "user_checkin", "event_qr", "wifi_context", "motion", "server_sync",
] as const;
export type PresenceEvidenceType = (typeof EVIDENCE_TYPES)[number];

/**
 * §10 estimate states. `precise` and `last_known` are both "we have a position",
 * and the difference between them is the entire point — a stale pin must never
 * render as a live one (§2.2, §16).
 */
export const ESTIMATE_STATES = [
  "precise", "nearby", "relayed", "recent",
  "inferred", "predicted", "last_known", "unknown",
] as const;
export type PresenceEstimateState = (typeof ESTIMATE_STATES)[number];

/** States that assert CURRENT truth. Anything else is history or a guess. */
const LIVE_STATES: ReadonlySet<PresenceEstimateState> = new Set(["precise", "nearby", "relayed"]);

/** True when the state may be presented as a current position. */
export function isLiveState(s: PresenceEstimateState): boolean {
  return LIVE_STATES.has(s);
}

export interface GeoPoint { lat: number; lng: number }

/**
 * A RAW OBSERVATION. Something a sensor or a peer reported. Never a conclusion.
 * There is no `position` field on purpose: a position the system *derived* is an
 * estimate, not an observation.
 */
export interface PresenceObservation {
  sessionId: string;
  /** Rotating ephemeral id (§6) — never a persistent user id on the wire. */
  subjectEphemeralId: string;
  observerEphemeralId?: string | null;
  source: PresenceEvidenceType;
  observedAt: Date;
  receivedAt: Date;
  point?: GeoPoint | null;
  accuracyM?: number | null;
  distanceEstimateM?: number | null;
  headingDeg?: number | null;
  speedMps?: number | null;
  floor?: number | null;
  zoneId?: string | null;
  anchorId?: string | null;
  /** §53 — every identifiable observation carries its own expiry. */
  expiresAt: Date;
}

/**
 * A DERIVED ESTIMATE (§10). Distinct type from an observation, so the two cannot
 * be confused at a call site. `confidence` and `freshness` are separate: a very
 * confident reading can still be very old, and conflating them is how a stale pin
 * becomes a live one.
 */
export interface PresenceEstimate {
  subjectId: string;
  observedAt: Date;
  position?: GeoPoint | null;
  zoneId?: string | null;
  floor?: number | null;
  distanceRange?: { minMeters: number; maxMeters: number } | null;
  /** 0..1 — how much we believe the evidence. */
  confidence: number;
  /** 0..1 — how recent it is. 1 = just now. */
  freshness: number;
  evidenceTypes: PresenceEvidenceType[];
  state: PresenceEstimateState;
  /** The precision this estimate may be rendered at, after policy. */
  precision: LocationPrecision;
}

/** §71 platform capabilities. Behaviour adapts to these; it never assumes them. */
export interface PresenceCapabilities {
  bleScan: boolean;
  bleAdvertise: boolean;
  backgroundBle: boolean;
  backgroundLocation: boolean;
  uwb: boolean;
  localPeer: boolean;
}

/**
 * Verified capability baseline for the current Portava mobile stack (2026-08-28).
 * Background location ships today; BLE is entirely absent (the declared Android
 * BLUETOOTH/BLUETOOTH_CONNECT permissions are for LiveKit audio routing, and
 * BLUETOOTH_SCAN / BLUETOOTH_ADVERTISE and the iOS bluetooth-* background modes
 * are not present). Kept here so no feature silently assumes a radio we lack.
 */
export const CURRENT_STACK_CAPABILITIES: PresenceCapabilities = {
  bleScan: false,
  bleAdvertise: false,
  backgroundBle: false,
  backgroundLocation: true,
  uwb: false,
  localPeer: false,
};
