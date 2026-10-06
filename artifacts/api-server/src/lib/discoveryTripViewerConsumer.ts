/**
 * discoveryTripViewerConsumer — Discovery's consumer of the two Trip-owned
 * projections in `domain/trips/contracts/tripViewerProjections.ts`.
 *
 * census-discovery A10 (§57.6, §81; register D-W10S2-4). The Trips-owned side
 * decides Trip semantics; this side decides only how Discovery's existing call
 * sites read the answer, so that the downstream code of each site is untouched:
 *
 *   searchPlans (lib/inputAssistance/searchCandidates.ts)
 *     the plan-item projection, handed back in the `{ data, error }` shape the
 *     site's legacy `.from("trip_plan_items")` read produced — the same five
 *     columns, the same order, the same paging, and a projection refusal as a
 *     read `error`, which the site already turns into its named
 *     `DiscoverySearchReadError("trip_plan_items")`. Never an empty page.
 *
 *   getNextTripCity (services/location/DiscoveryLocationContext.ts)
 *     the next-trip projection's destination city. A refusal is `null`, which
 *     is what the legacy reader's own catch answered — `?context=going_soon`
 *     then degrades to the viewer's other context exactly as before.
 *
 * FLAG. `discovery_trip_viewer_projections_enabled` (migration 3467, seeded
 * FALSE). Off, absent or unreadable (`isFlagEnabled` is fail-closed): each
 * site takes its legacy arm, byte-identical. On: the plan-item search matches
 * exactly what the legacy read matched (same predicate, now stated by Trips);
 * the next-trip city can change, because Trips counts `upcoming` trips and
 * trips the viewer joined — the §57.10 Q3 decision, and the reason for the flag.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { searchTripPlanItemProjections, readViewerNextTrip } from "../domain/trips/contracts/tripViewerProjections.js";

export const DISCOVERY_TRIP_VIEWER_PROJECTIONS_FLAG = "discovery_trip_viewer_projections_enabled";

export async function discoveryTripViewerProjectionsOn(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, DISCOVERY_TRIP_VIEWER_PROJECTIONS_FLAG);
}

/** The legacy row shape searchPlans reads, from the Trip-owned projection. */
export interface LegacyPlanItemRow {
  id: string;
  title: string | null;
  trip_id: string;
  creator_id: string | null;
  created_at: string | null;
  /** null = the row did not say; the owner-only rule reads that as private. */
  location_is_private: boolean | null;
}

export async function planItemRowsFromProjection(
  sc: any,
  // census-trips §81: named, `viewerId` drops other members' private items here; absent, each row carries location_is_private for the caller's rule.
  q: { pattern: string; offset: number; limit: number; viewerId?: string | null },
): Promise<{ data: LegacyPlanItemRow[] | null; error: { message: string } | null }> {
  const r = await searchTripPlanItemProjections(sc, q);
  if (!r.ok) return { data: null, error: { message: `${r.reason}: ${r.detail}` } };
  return {
    data: r.items.map((p) => ({ id: p.planItemId, title: p.title, trip_id: p.tripId, creator_id: p.creatorId, created_at: p.createdAt, location_is_private: p.locationIsPrivate })),
    error: null,
  };
}

/** The viewer's next trip's city by Trips' definition, or null (none, or the projection refused). */
export async function nextTripCityFromProjection(sc: any, viewerId: string): Promise<string | null> {
  const r = await readViewerNextTrip(sc, viewerId);
  return r.ok && r.trip ? r.trip.destinationCity : null;
}
