/**
 * LayoverDegradedService — §16 offline, battery and degraded-mode.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt §16
 *   Return deadline  persist latest certified value + snapshot timestamp  (L150)
 *   Map              cache airport + selected route/area                  (L151)
 *   Route            cache outbound/return instructions + airport address (L152)
 *   Flight/gate      cache last confirmed values with stale indicator     (L153)
 *   Crew             cache meeting point; optional peer proximity         (L154)
 *   Translation      cache context phrases required by the active plan    (L155)
 *   Replanning       local conservative fallback only if deterministic inputs
 *                    suffice; otherwise show unavailable/stale            (L156)
 *   Battery          adaptive sensing; avoid continuous GPS               (L157)
 *
 * ── THE DIVISION OF LABOUR, STATED BEFORE ANYTHING ELSE ─────────────────────
 * The CACHE lives on the client, which is not in this repository
 * (`artifacts/` holds `api-server` and `mockup-sandbox` only). What the server
 * owes is the thing the census says is missing on BOTH sides: a certified,
 * self-describing bundle that is worth caching and that carries its own
 * staleness. Census L150: "nothing is cached for display … and there is no
 * snapshot timestamp to persist." The second half is a server defect and this
 * file fixes it — every bundle carries `certifiedAt`, `staleAfter` and the
 * `inputHash` of the computation that produced it, so a client rendering it an
 * hour later can say SO instead of showing an hour-old deadline as current.
 *
 * ── WHAT IS DELIBERATELY EMPTY, AND WHY THAT IS THE HONEST ANSWER ───────────
 * Route (L152) and map geometry (L151) are `null` with a named reason: no
 * routing provider and no envelope geometry exist on this tree. Flight/gate
 * (L153) is `null` for the same reason — there is no flight feed; the SCHEDULE
 * the traveller typed in is not a confirmed operational value and is not dressed
 * up as one. Crew meeting point (L154) is `null` because no crew storage
 * exists. Each is an explicit `unavailable` entry rather than an omitted key,
 * so a client can render "unavailable" (which §16 asks for) rather than
 * rendering nothing (which looks like "fine").
 *
 * ── AND THE ONE THING A CLIENT MUST NOT DO WITH THIS ────────────────────────
 * `localReplan` decides whether a cached bundle may be replanned OFFLINE.
 * §16 permits it "only if deterministic inputs sufficient; otherwise show
 * unavailable/stale". The inputs are sufficient only while the bundle is
 * fresh AND the deadline is anchored to a schedule that has not changed, so
 * this returns `allowed: false` the moment the bundle is stale — and a refusal
 * carries the last certified deadline, because the deadline is the one number
 * that must remain on screen when everything else goes dark.
 */
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import type { LayoverReturnState } from "./LayoverSafetyEngine.js";
import { certificationHeader, type LayoverFeasibilityRecord } from "./LayoverFeasibility.js";

/** Version of the offline bundle's shape. Travels on every bundle. */
export const LAYOVER_OFFLINE_BUNDLE_VERSION = "2026.09.08-1";

/**
 * How long a certified bundle may be presented as current before a client must
 * badge it stale.
 *
 * 15 minutes, and the number is derived rather than picked: `RETURN_SOON_LEAD_MIN`
 * is 30, so a bundle older than half that lead could carry a NORMAL state for a
 * traveller who has already crossed into RETURN_SOON. Anything larger lets the
 * escalation ladder go unnoticed for longer than the ladder's own first step.
 */
export const OFFLINE_BUNDLE_TTL_MIN = 15;

export type UnavailableReason =
  | "no_routing_provider"
  | "no_envelope_geometry"
  | "no_flight_feed"
  | "no_crew_storage"
  | "no_phrase_catalogue";

export interface OfflineCapability<T> {
  available: boolean;
  value: T | null;
  reason: UnavailableReason | null;
}

function unavailable<T>(reason: UnavailableReason): OfflineCapability<T> {
  return { available: false, value: null, reason };
}
function available<T>(value: T): OfflineCapability<T> {
  return { available: true, value, reason: null };
}

export interface OfflineReturnDeadline {
  hardReturnTime: string;
  hardReturnLocal: string | null;
  returnState: LayoverReturnState;
  bufferMinutes: number;
  /** The reminder instant the traveller asked for, if any. */
  returnReminderAt: string | null;
}

export interface OfflineAirport {
  iataCode: string;
  name: string;
  city: string;
  country: string;
  timezone: string;
  lat: number | null;
  lng: number | null;
  terminalInfo: Record<string, unknown> | null;
}

export interface LayoverOfflineBundle {
  bundleVersion: string;
  sessionId: string;
  /** Instant the underlying feasibility record was certified for. §16 L150. */
  certifiedAt: string;
  /** After this instant a client MUST badge the bundle stale. */
  staleAfter: string;
  certification: ReturnType<typeof certificationHeader>;

  /** L150 — the one thing that must survive everything else going dark. */
  returnDeadline: OfflineReturnDeadline;
  /** L151/L152 — airport identity is cacheable; geometry and route are not. */
  airport: OfflineAirport;
  mapGeometry: OfflineCapability<never>;
  route: OfflineCapability<never>;
  /** L153 — no operational feed; the traveller's own schedule is not one. */
  flightStatus: OfflineCapability<never>;
  /** L154 — no crew storage. */
  crewMeetingPoint: OfflineCapability<never>;
  /** L155 — no phrase catalogue keyed on the active plan. */
  translationPhrases: OfflineCapability<never>;
  /** The plan the traveller can still read while offline. */
  stops: Array<{ title: string; durationMin: number; travelMin: number; insideAirport: boolean }>;
}

/**
 * Build the bundle a client should persist for this session.
 *
 * Takes the certified record rather than the raw session/airport, so the
 * deadline in the bundle is BY CONSTRUCTION the same one every online surface
 * publishes — there is no second derivation here to drift from it.
 */
export function buildOfflineBundle(input: {
  session: LayoverSession;
  airport: AirportProfile;
  record: LayoverFeasibilityRecord;
  hardReturnLocal?: string | null;
  stops?: Array<{ title: string; durationMin: number; travelMin: number; insideAirport: boolean }>;
}): LayoverOfflineBundle {
  const { session, airport, record } = input;
  const certifiedAtMs = record.inputs.nowMs;
  return {
    bundleVersion: LAYOVER_OFFLINE_BUNDLE_VERSION,
    sessionId: session.id,
    certifiedAt: new Date(certifiedAtMs).toISOString(),
    staleAfter: new Date(certifiedAtMs + OFFLINE_BUNDLE_TTL_MIN * 60_000).toISOString(),
    certification: certificationHeader(record),
    returnDeadline: {
      hardReturnTime: record.deadline.hardReturnTime.toISOString(),
      hardReturnLocal: input.hardReturnLocal ?? null,
      returnState: record.envelope.returnState,
      bufferMinutes: record.deadline.breakdown.totalBuffer,
      returnReminderAt: session.returnReminderAt,
    },
    airport: {
      iataCode: airport.iataCode,
      name: airport.name,
      city: airport.city,
      country: airport.country,
      timezone: airport.timezone ?? "UTC",
      lat: airport.lat ?? null,
      lng: airport.lng ?? null,
      terminalInfo: airport.terminalInfo ?? null,
    },
    mapGeometry: unavailable("no_envelope_geometry"),
    route: unavailable("no_routing_provider"),
    flightStatus: unavailable("no_flight_feed"),
    crewMeetingPoint: unavailable("no_crew_storage"),
    translationPhrases: unavailable("no_phrase_catalogue"),
    stops: input.stops ?? [],
  };
}

export interface BundleFreshness {
  stale: boolean;
  ageMinutes: number;
  /** Minutes until the bundle goes stale; 0 once it has. */
  freshForMinutes: number;
}

export function bundleFreshness(bundle: LayoverOfflineBundle, nowMs: number): BundleFreshness {
  const certifiedMs = new Date(bundle.certifiedAt).getTime();
  const staleMs = new Date(bundle.staleAfter).getTime();
  const ageMinutes = Math.max(0, Math.round((nowMs - certifiedMs) / 60_000));
  return {
    stale: nowMs >= staleMs,
    ageMinutes,
    freshForMinutes: Math.max(0, Math.round((staleMs - nowMs) / 60_000)),
  };
}

export type LocalReplanRefusal =
  | "bundle_stale"
  | "schedule_changed_since_certification"
  | "already_past_hard_return";

export interface LocalReplanDecision {
  allowed: boolean;
  refusals: LocalReplanRefusal[];
  /** ALWAYS present, allowed or not. §16: the deadline survives everything. */
  lastCertifiedDeadline: string;
  lastCertifiedReturnState: LayoverReturnState;
  freshness: BundleFreshness;
  /** Usable minutes a conservative local recompute may assume. Null when refused. */
  conservativeUsableMinutes: number | null;
}

/**
 * §16 "Replanning — local conservative fallback only if deterministic inputs
 * sufficient; otherwise show unavailable/stale."
 *
 * Three refusals, and each one is a case where the cached inputs stopped being
 * sufficient rather than a case where replanning is merely inconvenient:
 *
 *   bundle_stale                          the bundle is older than the TTL, so
 *                                         the escalation state in it may be a
 *                                         step behind the traveller.
 *   schedule_changed_since_certification  the session's departure/boarding no
 *                                         longer match the ones the record was
 *                                         certified against — the deadline in
 *                                         the bundle is about a different flight.
 *   already_past_hard_return              the deadline has passed. Nothing local
 *                                         can produce a safe plan from here;
 *                                         §15 owns this moment, not §16.
 *
 * The conservative usable-minutes figure, when allowed, is the certified window
 * MINUS the bundle's age. It cannot exceed the certified figure and it shrinks
 * with time, so an offline client's plan can only ever get more cautious — the
 * direction a fallback is allowed to move.
 */
export function localReplan(
  bundle: LayoverOfflineBundle,
  input: {
    nowMs: number;
    certifiedUsableMinutes: number;
    currentDepartureTime: string;
    currentBoardingTime: string | null;
    certifiedDepartureTime: string;
    certifiedBoardingTime: string | null;
  },
): LocalReplanDecision {
  const freshness = bundleFreshness(bundle, input.nowMs);
  const refusals: LocalReplanRefusal[] = [];
  if (freshness.stale) refusals.push("bundle_stale");
  if (
    input.currentDepartureTime !== input.certifiedDepartureTime ||
    (input.currentBoardingTime ?? null) !== (input.certifiedBoardingTime ?? null)
  ) {
    refusals.push("schedule_changed_since_certification");
  }
  if (input.nowMs >= new Date(bundle.returnDeadline.hardReturnTime).getTime()) {
    refusals.push("already_past_hard_return");
  }
  const allowed = refusals.length === 0;
  return {
    allowed,
    refusals,
    lastCertifiedDeadline: bundle.returnDeadline.hardReturnTime,
    lastCertifiedReturnState: bundle.returnDeadline.returnState,
    freshness,
    conservativeUsableMinutes: allowed
      ? Math.max(0, input.certifiedUsableMinutes - freshness.ageMinutes)
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §16 battery / adaptive sensing
// ─────────────────────────────────────────────────────────────────────────────

export type SensingCadence = "none" | "significant_change" | "periodic" | "navigation";

export interface SensingPolicy {
  cadence: SensingCadence;
  /** Seconds between position samples. Null for `none` and `significant_change`. */
  intervalSeconds: number | null;
  /** §16 "avoid continuous GPS when semantic checkpoints … are sufficient." */
  continuousGpsPermitted: boolean;
  reason: string;
}

/**
 * §16's adaptive sensing table, as a function of the two things §16 names —
 * the escalation state and whether the traveller is moving — plus the one thing
 * §17.1 insists on: LOCATION SHARING MUST BE OFF UNLESS THE TRAVELLER TURNED IT
 * ON. `locationGranted: false` yields `none` in every state, including
 * CONNECTION_AT_RISK, because a permission the traveller did not give is not
 * granted by an emergency.
 *
 * Continuous GPS is permitted in exactly ONE cell — RETURNING/navigation — which
 * is the spec's "navigation-appropriate updates during RETURNING" and nothing
 * wider.
 */
export function sensingPolicy(input: {
  returnState: LayoverReturnState;
  stationary: boolean;
  insideAirport: boolean;
  locationGranted: boolean;
}): SensingPolicy {
  if (!input.locationGranted) {
    return {
      cadence: "none",
      intervalSeconds: null,
      continuousGpsPermitted: false,
      reason: "location permission not granted",
    };
  }
  if (input.returnState === "RETURN_NOW" || input.returnState === "CONNECTION_AT_RISK") {
    return {
      cadence: "navigation",
      intervalSeconds: 10,
      continuousGpsPermitted: true,
      reason: "returning to the airport — navigation-appropriate updates",
    };
  }
  if (input.returnState === "RETURN_SOON") {
    return {
      cadence: "periodic",
      intervalSeconds: 120,
      continuousGpsPermitted: false,
      reason: "near the decision boundary — moderate frequency",
    };
  }
  if (input.stationary || input.insideAirport) {
    return {
      cadence: "significant_change",
      intervalSeconds: null,
      continuousGpsPermitted: false,
      reason: "safe and stationary — semantic checkpoints only, no polling",
    };
  }
  return {
    cadence: "periodic",
    intervalSeconds: 600,
    continuousGpsPermitted: false,
    reason: "moving landside, well before the deadline — low frequency",
  };
}
