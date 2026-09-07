/**
 * Discovery's consumer of the Trip-owned TripDiscoveryProjection
 * (lib/tripDiscoveryProjection.ts) — the switch, the acceptance check and the
 * card mapping, and nothing that reads `trips`.
 *
 * Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
 *   §19.1 "Consumers reject or visibly degrade on stale/incompatible critical
 *         projections."                                    (acceptProjections)
 *   §25   "Map, Compass, Discovery ... consume explicit Trip projections /
 *         contracts rather than duplicating Trip semantics."
 * docs/architecture/census-discovery.md A10 / D3.
 *
 * WHY A FLAG, AND WHY IT SEEDS OFF
 * ================================
 * TRIP_DISCOVERY_SOURCE_COLUMNS ends with `version` (migration 2420).
 * Production (ajrurzioarfkagpuxfnb), measured 2026-09-07: trips.version does
 * NOT exist (2420 unapplied), 43 trips, 12 discoverable. Both projection
 * readers fail CLOSED on a resolved `.error`, so an ungated switch would turn
 * every production trip search into `[]` the moment it deployed — a 42703 on
 * a missing column, silent to the user. So the consumer is gated by
 * `discovery_trip_projection_enabled` (migration 2550, seeded FALSE — the
 * 2410 / 2420 / 2520 pattern), and the flag-off path is the legacy read in
 * routes/discoverySearch.ts, byte-identical to before this module existed
 * (pinned by src/test/discoveryTripProjectionConsumer.test.ts).
 *
 * THE FLAG READ IS FAIL-CLOSED TOWARD LEGACY
 * ==========================================
 * isFlagEnabled returns false on an absent row, a resolved `.error`, and a
 * thrown client. Every one of those means "legacy path". The projection is
 * only ever consulted on a row that reads `enabled = true`. Cached 30 s for
 * the same reason the buddy launch gate in routes/discoverySearch.ts is:
 * type=all fans out through trips AND plans on every search, and an uncached
 * read would add two round-trips per search for a flag that changes once.
 *
 * WHAT CHANGES FOR A USER WHEN THE FLAG IS ON (stated, not buried)
 * ================================================================
 * The projection is built on toPrivateTripPreview, so the owner's
 * show_exact_dates / show_destination_city / show_header_publicly toggles
 * apply to a Discovery searcher. Today Discovery ignores them and shows the
 * true start_date, city and cover of every discoverable trip. Production
 * 2026-09-07: 12 discoverable trips, 0 with any toggle off — unobservable
 * today, real the moment an owner sets one. The Trips lane chose this
 * deliberately (one non-member rule, one place) and it is the more private
 * direction; this consumer does not bypass it.
 *
 * WHAT STAYS IN DISCOVERY
 * =======================
 * The blocked-set, age-restricted-set and active-owner filters. They are
 * Trust / Discovery rules about `ownerId`, not Trip semantics; the projection
 * carries ownerId for exactly that purpose and never decides them.
 */
import { isFlagEnabled } from "./featureFlags.js";
import {
  TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION,
  type TripDiscoveryProjection,
} from "./tripDiscoveryProjection.js";

/** Literal name so check-flag-polarity resolves the read. `*_enabled` ⇒ CAPABILITY, read fail-closed. */
export const DISCOVERY_TRIP_PROJECTION_FLAG = "discovery_trip_projection_enabled";

/**
 * The one projection schema version this consumer can read. A bump on the
 * Trips side is a compile error here (the literal types diverge) and a runtime
 * rejection in acceptTripDiscoveryProjections — §19.1 makes rejecting the
 * consumer's duty, and the readers deliberately do not do it for us.
 */
export const DISCOVERY_TRIP_PROJECTION_ACCEPTED_SCHEMA_VERSION: typeof TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION = 1;

const FLAG_TTL_MS = 30_000;
let _flagCache: { value: boolean; at: number } | null = null;

/** Drop the cached flag value. Exported for tests. */
export function invalidateDiscoveryTripProjectionFlagCache(): void {
  _flagCache = null;
}

/**
 * Is Discovery to consume the projection? false on an absent row, an
 * unreadable table, a thrown client — legacy in every failure.
 */
export async function discoveryTripProjectionEnabled(sc: any): Promise<boolean> {
  if (_flagCache && Date.now() - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  const value = await isFlagEnabled(sc, DISCOVERY_TRIP_PROJECTION_FLAG);
  _flagCache = { value, at: Date.now() };
  return value;
}

/**
 * §19.1: keep only projections of a schema version this consumer can read.
 * A rejected projection is dropped (degrade), never rendered from a shape we
 * do not understand. Returns the count rejected so a caller can log it.
 */
export function acceptTripDiscoveryProjections(
  projections: readonly TripDiscoveryProjection[],
): { accepted: TripDiscoveryProjection[]; rejected: number } {
  const accepted: TripDiscoveryProjection[] = [];
  let rejected = 0;
  for (const p of projections) {
    if (p.projectionSchemaVersion === DISCOVERY_TRIP_PROJECTION_ACCEPTED_SCHEMA_VERSION) accepted.push(p);
    else rejected += 1;
  }
  return { accepted, rejected };
}

/**
 * The fields a trip search card is built from, in one shape for BOTH paths so
 * the mapping to SearchResult is one function and the two paths cannot drift
 * in the card. The legacy row (routes/discoverySearch.ts searchTrips) fills
 * this from its own select; the projection fills it below.
 */
export interface DiscoveryTripCardSource {
  id: string;
  ownerId: string;
  title: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  coverUrl: string | null;
  startDate: string | null;
  status: string;
  createdAt: string | null;
}

/** Projection → card source. `title ?? destinationCity` is the legacy card's own fallback. */
export function tripCardSourceFromProjection(p: TripDiscoveryProjection): DiscoveryTripCardSource {
  return {
    id: p.tripId,
    ownerId: p.ownerId,
    title: p.title ?? null,
    destinationCity: p.destinationCity,
    destinationCountry: p.destinationCountry,
    coverUrl: p.coverUrl,
    startDate: p.startDate,
    status: p.status,
    createdAt: p.createdAt ?? null,
  };
}

/**
 * What searchPlans needs of a parent trip, in one shape for both paths:
 * whether this viewer may see its plans (Trip semantics — tripDiscoveryAdmits
 * on the projection path, the legacy predicate on the other), the owner for
 * Discovery's own filters, and the start date for the time-intent bound.
 */
export interface DiscoveryPlanParentTrip {
  id: string;
  ownerId: string;
  startDate: string | null;
  admitted: boolean;
}
