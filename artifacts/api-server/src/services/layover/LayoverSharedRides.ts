/**
 * LayoverSharedRides — the explicit PRODUCT CONTRACT for §14.1 "Shared rides require opt-in and should avoid
 * revealing full itinerary to unrelated users" (census-layover L139).
 *
 * Owner decision 2026-10-18 (SHARED RIDES): "Implement the original requirement using an explicit product contract.
 * Do not claim shared rides are available when they are not. Apply all relevant consent, verification, and safety
 * restrictions."
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * A shared ride is offered on the layover surface ONLY when ALL of these hold, and each is checked here, in code:
 *   1. MECHANISM. A real shared-ride mechanism exists for the traveller's airport (`SHARED_RIDE_MECHANISMS`): a
 *      ride-share provider or partner integration that can actually carry two travellers in one vehicle. A label, a
 *      chat message or a hope is not a mechanism. TODAY THE REGISTRY IS EMPTY, so `sharedRideCapability` answers
 *      `available: false` for every airport and every surface says so.
 *   2. OPT-IN, BOTH SIDES. The offerer opted in to offering this ride, and the viewer opted in to joining it (a
 *      co-rider). Neither is inferred from crew membership.
 *   3. VERIFICATION. Both are identity-verified when the mechanism requires it (`requiresVerifiedIdentity`).
 *   4. SAFETY. No block either way; both travellers' certified layover allows leaving the airport (landside gate not
 *      closed) and neither is already on the §15 escalation ladder (RETURN_NOW / CONNECTION_AT_RISK).
 *   5. DISCLOSURE. A co-rider sees exactly ONE leg — the shared one — and nothing before or after it; an unrelated
 *      viewer sees nothing at all (`sharedRideDisclosure`, LayoverCrewService.ts — the redaction is structural).
 *
 * ── WHAT IS NOT HERE, SAID PLAINLY ───────────────────────────────────────────
 * No shared-ride storage, booking, payment, or matching: there is no mechanism to put behind them, and building them
 * before one exists would be the "claim availability that does not exist" the owner forbade. Adding a mechanism is
 * one registry entry PLUS that mechanism's own integration — named, in the handback, as the external dependency.
 */
import {
  sharedRideDisclosure,
  type SharedRideLeg,
} from "../airport/LayoverCrewService.js";
import type { LayoverReturnState } from "../airport/LayoverSafetyEngine.js";

export const SHARED_RIDE_CONTRACT_VERSION = "2026-10-18.1";

/** A real shared-ride mechanism and the airports it serves. */
export interface SharedRideMechanism {
  /** Stable id of the provider / partner integration. */
  id: string;
  /** IATA codes the mechanism actually serves. */
  airports: readonly string[];
  /** Whether both riders must be identity-verified to use it. */
  requiresVerifiedIdentity: boolean;
}

/**
 * THE REGISTRY. Empty: Portava has no shared-ride provider, partner or in-product mechanism at any airport
 * (measured 2026-10-18: no ride-share integration in services/, lib/providers/ or routes/; Telegraph's SPLIT_RIDE is
 * a coordination proposal inside a conversation, not a ride, and no layover crew has a Telegraph thread).
 */
export const SHARED_RIDE_MECHANISMS: readonly SharedRideMechanism[] = Object.freeze([]);

export type SharedRideUnavailableReason = "no_shared_ride_mechanism" | "airport_unknown";

export type SharedRideCapability =
  | { available: true; contractVersion: string; mechanismId: string; requiresVerifiedIdentity: boolean }
  | { available: false; contractVersion: string; reason: SharedRideUnavailableReason; message: string };

export const SHARED_RIDE_UNAVAILABLE_MESSAGE = "Shared rides are not available at this airport. Portava does not arrange or match shared rides here.";

/** Contract term 1: is there a real mechanism for this airport? */
export function sharedRideCapability(
  airportIata: string | null | undefined,
  registry: readonly SharedRideMechanism[] = SHARED_RIDE_MECHANISMS,
): SharedRideCapability {
  const iata = typeof airportIata === "string" ? airportIata.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(iata) || iata === "UNK") {
    return { available: false, contractVersion: SHARED_RIDE_CONTRACT_VERSION, reason: "airport_unknown", message: SHARED_RIDE_UNAVAILABLE_MESSAGE };
  }
  const m = registry.find((r) => r.airports.some((a) => a.toUpperCase() === iata));
  if (!m) return { available: false, contractVersion: SHARED_RIDE_CONTRACT_VERSION, reason: "no_shared_ride_mechanism", message: SHARED_RIDE_UNAVAILABLE_MESSAGE };
  return { available: true, contractVersion: SHARED_RIDE_CONTRACT_VERSION, mechanismId: m.id, requiresVerifiedIdentity: m.requiresVerifiedIdentity };
}

export type SharedRideDenial =
  | "no_shared_ride_mechanism"
  | "airport_unknown"
  | "offerer_not_opted_in"
  | "viewer_not_opted_in"
  | "identity_not_verified"
  | "blocked"
  | "landside_closed"
  | "return_state_escalated";

export interface SharedRideOfferInput {
  capability: SharedRideCapability;
  offererOptedIn: boolean;
  /** The viewer asked to join this ride (a co-rider). */
  viewerOptedIn: boolean;
  offererVerified: boolean;
  viewerVerified: boolean;
  blocked: boolean;
  /** Either rider's certified landside gate is closed. */
  landsideClosedForEither: boolean;
  offererReturnState: LayoverReturnState | null;
  viewerReturnState: LayoverReturnState | null;
  sharedLeg: SharedRideLeg | null;
  fullItinerary: SharedRideLeg[];
}

/**
 * The whole contract for one (offerer, viewer) pair. Returns EVERY failed term, and the disclosure the viewer may
 * see — which is nothing unless every term holds, and then exactly the shared leg.
 */
export function sharedRideOffer(input: SharedRideOfferInput): {
  allowed: boolean;
  denials: SharedRideDenial[];
  disclosure: { offered: boolean; leg: SharedRideLeg | null; withheldLegs: number };
} {
  const denials: SharedRideDenial[] = [];
  if (!input.capability.available) denials.push(input.capability.reason);
  if (!input.offererOptedIn) denials.push("offerer_not_opted_in");
  if (!input.viewerOptedIn) denials.push("viewer_not_opted_in");
  if (input.capability.available && input.capability.requiresVerifiedIdentity && !(input.offererVerified && input.viewerVerified)) denials.push("identity_not_verified");
  if (input.blocked) denials.push("blocked");
  if (input.landsideClosedForEither) denials.push("landside_closed");
  const escalated = (s: LayoverReturnState | null) => s === null || s === "RETURN_NOW" || s === "CONNECTION_AT_RISK";
  if (escalated(input.offererReturnState) || escalated(input.viewerReturnState)) denials.push("return_state_escalated");
  const allowed = denials.length === 0;
  const disclosure = sharedRideDisclosure({
    offererOptedIn: allowed && input.offererOptedIn,
    viewerIsCoRider: allowed && input.viewerOptedIn,
    blocked: input.blocked,
    sharedLeg: input.sharedLeg,
    fullItinerary: input.fullItinerary,
  });
  return { allowed, denials, disclosure };
}
