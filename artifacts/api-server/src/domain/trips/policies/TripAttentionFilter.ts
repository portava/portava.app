/**
 * Trips §17.2 — the priority switch, APPLIED to a candidate list.
 *
 * `prioritySwitch` (TripHealth.ts) derives whether commercial recommendations
 * and entertainment discovery are suppressed. Until census-trips §60 nothing
 * applied that verdict to a list: the Pulse dropped its own discovery
 * signals and the attention policy held pushes, but Compass's search_places
 * / search_events and the trip brief handed the traveller a bar and a night
 * market while the trip was DISRUPTED. This is the one place a list is
 * filtered by the switch, so those surfaces cannot disagree about what
 * "commercial or entertainment" means. census-trips TR319.
 *
 * THE RULE IS FAIL-CLOSED UNDER SUPPRESSION
 * =========================================
 * When the switch says suppress, a candidate is KEPT only if something about
 * it names a safety or logistics need — a pharmacy, a station, an embassy, a
 * hotel. A candidate this module cannot classify is withheld. The asymmetry
 * is deliberate: the switch is on because the traveller's attention is
 * needed elsewhere, and an unclassifiable candidate is far more likely a
 * restaurant than a hospital.
 *
 * WHAT COULD NOT BE READ IS NOT SUPPRESSED
 * ========================================
 * The switch lives on the health projection, behind
 * trip_operational_projections_enabled. Where that gate is closed (every
 * deployment today) the switch cannot be read, and this module does NOT
 * suppress: withholding every ordinary recommendation everywhere because a
 * flag is off would be the gate deciding product behaviour it was never
 * given. The reading says `consulted: false` and why, on the wire.
 */
import type { PriorityMode, PrioritySwitch } from "../services/TripHealth.js";
import { buildTripHealthProjection } from "../projections/TripHealthProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../contracts/TripProjectionEnvelope.js";
import { isAcceptedTripMember } from "../../../lib/http.js";

/**
 * Whole tokens that mark a candidate as a safety or logistics need. Matched
 * against TOKENS (split on anything non-alphanumeric), never substrings:
 * "gas" must not match "gastropub", "safety" must match "safety_tip".
 */
export const SAFETY_LOGISTICS_TERMS: readonly string[] = [
  // safety and health
  "safety", "safe", "emergency", "hospital", "clinic", "pharmacy", "chemist", "doctor", "medical", "health",
  "police", "embassy", "consulate", "shelter", "help", "rescue",
  // getting there and back
  "airport", "train", "rail", "station", "transit", "bus", "metro", "subway", "tram", "taxi", "transport",
  "ferry", "port", "terminal", "fuel", "gas", "charging", "parking",
  // somewhere to sleep, money, essentials
  "hotel", "hostel", "lodging", "accommodation", "atm", "bank", "exchange", "grocery", "supermarket",
  "convenience", "water", "laundry", "sim", "wifi",
  // orientation
  "logistics", "language", "translation", "information",
];
const TERM_SET: ReadonlySet<string> = new Set(SAFETY_LOGISTICS_TERMS);

export type AttentionClass = "safety_logistics" | "commercial_entertainment";

export function classifyForAttention(terms: ReadonlyArray<string | null | undefined>): AttentionClass {
  for (const t of terms) {
    if (typeof t !== "string") continue;
    for (const tok of t.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok && TERM_SET.has(tok)) return "safety_logistics";
    }
  }
  return "commercial_entertainment";
}

/** The switch as consulted for one trip, ready for the wire. */
export interface AttentionReading {
  consulted: boolean;
  tripId: string | null;
  mode: PriorityMode | null;
  suppressed: boolean;
  reason: "TRIP_DISRUPTION_SUPPRESSED" | null;
  detail: string | null;
  /** Why the switch could not be consulted; null when it was. */
  info: string | null;
  attention: PrioritySwitch | null;
}

export function attentionNotConsulted(tripId: string | null, info: string): AttentionReading {
  return { consulted: false, tripId, mode: null, suppressed: false, reason: null, detail: null, info, attention: null };
}

export function attentionFrom(tripId: string, attention: PrioritySwitch): AttentionReading {
  const suppressed = attention.suppression.commercial || attention.suppression.discovery;
  return {
    consulted: true, tripId, mode: attention.mode, suppressed,
    reason: suppressed ? "TRIP_DISRUPTION_SUPPRESSED" : null,
    detail: attention.suppression.detail, info: null, attention,
  };
}

export interface AttentionFilterResult<T> {
  kept: T[];
  withheld: number;
  reason: "TRIP_DISRUPTION_SUPPRESSED" | null;
  detail: string | null;
}

/**
 * Keep the safety/logistics candidates and withhold the rest while the switch
 * suppresses; keep everything otherwise. `termsOf` names the fields that
 * describe a candidate (category, type, tags) — the classifier reads tokens
 * from all of them.
 */
export function applyAttentionSuppression<T>(
  items: readonly T[],
  reading: AttentionReading | null,
  termsOf: (item: T) => ReadonlyArray<string | null | undefined>,
): AttentionFilterResult<T> {
  if (!reading || !reading.consulted || !reading.suppressed) {
    return { kept: [...items], withheld: 0, reason: null, detail: null };
  }
  const kept = items.filter((it) => classifyForAttention(termsOf(it)) === "safety_logistics");
  const withheld = items.length - kept.length;
  return {
    kept, withheld, reason: "TRIP_DISRUPTION_SUPPRESSED",
    detail: withheld > 0
      ? `${withheld} commercial or entertainment candidate${withheld === 1 ? "" : "s"} withheld — ${reading.detail ?? "the trip needs attention"}`
      : reading.detail,
  };
}

/** The reading plus the count, as a search tool or the brief reports it. */
export function attentionOnTheWire(reading: AttentionReading, withheld: number) {
  return {
    consulted: reading.consulted, tripId: reading.tripId, mode: reading.mode, suppressed: reading.suppressed,
    reason: reading.reason, withheld, detail: reading.detail, info: reading.info,
  };
}

/**
 * Consult the switch for a trip on behalf of a viewer: membership first, then
 * the health projection through the §19.1 consumer rule. Never throws — a
 * switch that cannot be read is reported as not consulted, and the caller
 * decides what that means (this module's filter treats it as "nothing to
 * withhold").
 */
export async function readTripAttention(
  sc: any,
  tripId: string,
  viewerId: string,
  opts: { now?: Date } = {},
): Promise<AttentionReading> {
  let member: boolean;
  try {
    member = await isAcceptedTripMember(sc, tripId, viewerId);
  } catch (e) {
    return attentionNotConsulted(tripId, `membership could not be checked: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!member) return attentionNotConsulted(tripId, "The user is not a member of that trip.");
  let built: Awaited<ReturnType<typeof buildTripHealthProjection>>;
  try {
    built = await buildTripHealthProjection(sc, tripId, viewerId, opts);
  } catch (e) {
    return attentionNotConsulted(tripId, `the health projection threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!built.ok) {
    return attentionNotConsulted(tripId, built.reason === "FEATURE_DISABLED"
      ? `the priority switch is not readable: ${built.message}`
      : `the priority switch could not be read (${built.reason}): ${built.message}`);
  }
  const decision = acceptTripProjection(built.projection, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, metric: "TripHealthProjection" });
  if (!decision.accepted) return attentionNotConsulted(tripId, `the health projection was rejected (${decision.reason}): ${decision.message}`);
  return attentionFrom(tripId, built.projection.attention);
}
