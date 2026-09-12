/**
 * Trips spec §7.4 — the route-availability check: "feasible by taxi but the
 * transport-mode policy says no taxi" (census-trips TR137).
 *
 * WHAT A POLICY IS
 * ================
 * The modes a trip does NOT use (2793 trip_transport_policies.disallowed_modes),
 * a subset of the provider's own vocabulary less "unknown". No row is no
 * policy: every mode allowed. The policy is a preference the feasibility
 * route reads at request time, not trip state — a projection does not replay
 * it and trips.version does not move for it.
 *
 * WHAT THE CHECK SAYS
 * ===================
 * For one hop, the provider is asked ONCE PER MODE and each answer is judged
 * against the same deadline the temporal engine uses (depart + travel + prep
 * ≤ deadline). Then:
 *
 *   AVAILABLE       an allowed mode fits. Nothing to report.
 *   POLICY_BLOCKED  no allowed mode fits and a disallowed one does — §7.4's
 *                   sentence. TRIP_SPATIAL_ROUTE_UNAVAILABLE.
 *   NO_MODE_FITS    every mode answered and none fits: not a policy problem,
 *                   a temporal one, and the temporal engine has already said
 *                   INFEASIBLE for this hop. TRIP_TEMPORAL_INFEASIBLE, so the
 *                   two verdicts agree on the wire.
 *   UNCHECKABLE     no mode fits AND at least one mode could not be estimated.
 *                   Stated, never rendered as AVAILABLE: an unknown travel
 *                   time is not a short one (TravelTimeProvider's rule).
 *
 * The straight-line adapter answers drive and transit with the same number
 * (it has one road speed); `byMode` shows that rather than hiding it, and a
 * routed provider later changes the numbers and nothing here.
 */
import {
  type GeoPoint, type TravelMode, type TravelTimeProvider, type TravelTimeResult,
} from "./TravelTimeProvider.js";
import { FEASIBILITY_PERCENTILE, travelMinutesAt } from "../../lib/travelEstimate.js";

/** The modes a policy can name: the provider's, less "unknown". */
export const POLICY_MODES = ["walk", "drive", "transit"] as const satisfies readonly TravelMode[];
export type PolicyMode = (typeof POLICY_MODES)[number];

export function isPolicyMode(v: unknown): v is PolicyMode {
  return typeof v === "string" && (POLICY_MODES as readonly string[]).includes(v);
}

export interface TransportModePolicy {
  disallowedModes: readonly PolicyMode[];
  note: string | null;
}

/** No row: every mode allowed. */
export const NO_TRANSPORT_POLICY: TransportModePolicy = Object.freeze({ disallowedModes: [], note: null });

export const ROUTE_AVAILABILITY_VERDICTS = ["AVAILABLE", "POLICY_BLOCKED", "NO_MODE_FITS", "UNCHECKABLE"] as const;
export type RouteAvailabilityVerdict = (typeof ROUTE_AVAILABILITY_VERDICTS)[number];

export interface ModeAnswer {
  mode: PolicyMode;
  allowed: boolean;
  /** The provider's minutes at the feasibility percentile; null when unknown. */
  travelMinutes: number | null;
  /** Whether depart + travel + prep ≤ deadline; null when unknown. */
  fits: boolean | null;
  /** The provider's unknown reason, when it had one. */
  unknownReason: string | null;
}

export interface RouteAvailability {
  verdict: RouteAvailabilityVerdict;
  reasonCode: "TRIP_SPATIAL_ROUTE_UNAVAILABLE" | "TRIP_TEMPORAL_INFEASIBLE" | null;
  byMode: ModeAnswer[];
  /** The first allowed mode that fits, when one does. */
  fitsByAllowed: PolicyMode | null;
  /** The first disallowed mode that fits, when no allowed one does. */
  fitsOnlyByDisallowed: PolicyMode | null;
  detail: string;
}

export interface RouteAvailabilityHop {
  from: GeoPoint | null;
  to: GeoPoint | null;
  departAt: Date;
  /** requiredArrivalAt ?? startsAt, plus tolerance — the temporal engine's deadline. */
  deadline: Date;
  prepMinutes?: number;
}

const MS_PER_MIN = 60_000;

function minutesOf(r: TravelTimeResult): { minutes: number | null; unknownReason: string | null } {
  if (r.kind === "unknown") return { minutes: null, unknownReason: r.reason };
  return { minutes: travelMinutesAt(r.estimate, FEASIBILITY_PERCENTILE), unknownReason: null };
}

export async function checkRouteAvailability(
  provider: TravelTimeProvider,
  hop: RouteAvailabilityHop,
  policy: TransportModePolicy = NO_TRANSPORT_POLICY,
): Promise<RouteAvailability> {
  const prep = Number.isFinite(hop.prepMinutes) && (hop.prepMinutes as number) >= 0 ? (hop.prepMinutes as number) : 0;
  const byMode: ModeAnswer[] = [];
  for (const mode of POLICY_MODES) {
    const answer = minutesOf(await provider.estimate({ from: hop.from, to: hop.to, departAt: hop.departAt, mode }));
    const fits = answer.minutes === null ? null
      : hop.departAt.getTime() + (answer.minutes + prep) * MS_PER_MIN <= hop.deadline.getTime();
    byMode.push({ mode, allowed: !policy.disallowedModes.includes(mode), travelMinutes: answer.minutes, fits, unknownReason: answer.unknownReason });
  }
  const fitsByAllowed = byMode.find((m) => m.allowed && m.fits === true)?.mode ?? null;
  if (fitsByAllowed) {
    return { verdict: "AVAILABLE", reasonCode: null, byMode, fitsByAllowed, fitsOnlyByDisallowed: null, detail: `${fitsByAllowed} fits and the policy allows it` };
  }
  const fitsOnlyByDisallowed = byMode.find((m) => !m.allowed && m.fits === true)?.mode ?? null;
  if (fitsOnlyByDisallowed) {
    return {
      verdict: "POLICY_BLOCKED", reasonCode: "TRIP_SPATIAL_ROUTE_UNAVAILABLE", byMode, fitsByAllowed: null, fitsOnlyByDisallowed,
      detail: `feasible by ${fitsOnlyByDisallowed}, and the trip's transport policy disallows ${fitsOnlyByDisallowed}${policy.note ? ` (${policy.note})` : ""}`,
    };
  }
  if (byMode.every((m) => m.fits === false)) {
    return { verdict: "NO_MODE_FITS", reasonCode: "TRIP_TEMPORAL_INFEASIBLE", byMode, fitsByAllowed: null, fitsOnlyByDisallowed: null, detail: "no mode reaches the deadline: a temporal infeasibility, not a policy one" };
  }
  const unknown = byMode.filter((m) => m.fits === null).map((m) => `${m.mode}: ${m.unknownReason}`).join(", ");
  return { verdict: "UNCHECKABLE", reasonCode: null, byMode, fitsByAllowed: null, fitsOnlyByDisallowed: null, detail: `could not be estimated (${unknown}); an unknown travel time is not a short one` };
}

/** Worst-first fold for a day of hops: one blocked hop blocks the day. */
export function foldRouteAvailability(hops: readonly RouteAvailability[]): RouteAvailabilityVerdict {
  const order: RouteAvailabilityVerdict[] = ["POLICY_BLOCKED", "NO_MODE_FITS", "UNCHECKABLE", "AVAILABLE"];
  for (const v of order) if (hops.some((h) => h.verdict === v)) return v;
  return "AVAILABLE";
}
