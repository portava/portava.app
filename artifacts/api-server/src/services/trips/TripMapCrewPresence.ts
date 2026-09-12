/**
 * §14.1 crew presence for the Trip Map projection — the one map layer that
 * comes through the crew map (TripCrewLocationService.getCrewMap, which
 * applies every §6.1 / §10 rule; nothing here reads a position row itself).
 *
 * WHY THIS IS ITS OWN FILE. The same reason TripPulseCrewPresence.ts is:
 * check:flag-schema-prerequisites attributes every table a file names to
 * every flag it names, and refuses a flag that is ON in production whose code
 * names tables production lacks. This layer sits behind `trip_crew_map_enabled`
 * (ON in production) and reads production tables only; the projection route
 * names kernel-era tables behind `trip_operational_projections_enabled`
 * (seeded FALSE). Naming both flags in routes/tripMapProjection.ts would
 * read — correctly, by that rule — as "an ON flag whose code reaches
 * trip_stages / trip_commitments / trip_meeting_checkpoints". So the crew flag
 * lives with the crew read, and only there.
 *
 * WHAT IT DRAWS. A card becomes a point only when the crew map put
 * `exactCoords` on it — which lib/tripCrewLocation.ts does only under an
 * active live-share grant to this viewer, with hotel/home blur off, over a
 * position judged LIVE or RECENT on its own clock — and the class is checked
 * again here (crewPresencePoints). Everyone else is summarised by reason and
 * the reading says so. Flag off: `no_source`, with the flag named, because
 * nothing on that deployment produces the layer. Crew map refused: `unread`.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { incrementTripMetric } from "../../lib/tripMetrics.js";
import { getCrewMap, CrewMapUnavailableError } from "../tripCrew/TripCrewLocationService.js";
import { ok, unread, noSource, crewPresencePoints, crewPresenceReading, type Layer, type MapPoint } from "./TripMapProjection.js";

export const CREW_PRESENCE_FLAG = "trip_crew_map_enabled";

export interface CrewPresenceLayerRead {
  layer: Layer<MapPoint>;
  /** The sentence the response carries: who is drawn, who is summarised, and why. */
  reading: string;
}

export async function readCrewPresenceLayer(
  sc: any,
  tripId: string,
  viewerId: string,
  log: { warn: (o: Record<string, unknown>, msg: string) => void },
): Promise<CrewPresenceLayerRead> {
  if (!(await isFlagEnabled(sc, CREW_PRESENCE_FLAG))) {
    return {
      layer: noSource(
        `${CREW_PRESENCE_FLAG} is off on this deployment, and the crew map is the only producer of crew presence: a coordinate reaches this layer only through an active live-share grant the crew map verifies (§14.4), so nothing produces it while the flag is off.`,
      ),
      reading: `not read: ${CREW_PRESENCE_FLAG} is off`,
    };
  }
  try {
    const map = await getCrewMap(sc, tripId, viewerId);
    const built = crewPresencePoints(map.members);
    for (const userId of built.refusedStale) {
      // §21.1 stale_presence_render_attempt_total, at the second place a stale
      // coordinate could have been drawn as current (census-trips TR399).
      log.warn({ tripId, userId }, "map projection: crew card carried a coordinate over a non-current position — refused");
      incrementTripMetric("stale_presence_render_attempt_total", { reason: "map_projection_crew_layer_over_non_current_position" });
    }
    return { layer: ok(built.points), reading: crewPresenceReading(built) };
  } catch (e: any) {
    const why = e instanceof CrewMapUnavailableError ? e.message : String(e?.message ?? e);
    log.warn({ err: why, tripId }, "map projection: crew map unread");
    return { layer: unread(`the crew map could not be read: ${why}`), reading: "not assembled: the crew map could not be read" };
  }
}
