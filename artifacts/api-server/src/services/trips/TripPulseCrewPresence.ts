/**
 * §16 crew presence for the Trip Pulse — the one Pulse source that comes
 * through the crew map (TripCrewLocationService.getCrewMap, which applies
 * every §10 rule; nothing here reads a position row itself).
 *
 * WHY THIS IS ITS OWN FILE. check:flag-schema-prerequisites attributes every
 * table a file names to every flag it names, and refuses a flag that is ON
 * in production whose code names tables production lacks. This source sits
 * behind `trip_crew_map_enabled` (ON in production) and reads production
 * tables only; the Pulse's other sources are kernel-era tables behind
 * `trip_operational_projections_enabled` (seeded FALSE). Naming both flags
 * in TripPulseProjection.ts read — correctly, by that rule — as "an ON flag
 * whose code reaches trip_commitments / trip_stages / trip_transport_segments
 * / trip_goals". The split is the same one §43 made for the opportunity
 * projection: the crew flag lives with the crew read, and only there.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { getCrewMap, CrewMapUnavailableError } from "../tripCrew/TripCrewLocationService.js";
import { metresBetween, type FriendNearbyValue, type GeoPoint, type SignalObservation } from "./TripSignals.js";
import type { PulseSourceReport } from "./TripPulseProjection.js";

export const FRIEND_NEARBY_BANDS: readonly { withinM: number; band: FriendNearbyValue["distanceBand"] }[] = [
  { withinM: 150, band: "same_venue" },
  { withinM: 1_500, band: "walking" },
  { withinM: 5_000, band: "nearby" },
];

export interface CrewPresenceForPulse {
  /** The viewer's own exact position through the crew map — the best location band there is — or null. */
  viewerPoint: GeoPoint | null;
  /** One observation per crew member within a band, keyed by member id. */
  observations: Map<string, SignalObservation<FriendNearbyValue>[]>;
  /** The source report the Pulse carries for `crew_presence`. */
  source: PulseSourceReport;
}

export async function readCrewPresenceForPulse(sc: any, tripId: string, viewerId: string, nowMs: number): Promise<CrewPresenceForPulse> {
  const observations = new Map<string, SignalObservation<FriendNearbyValue>[]>();
  if (!(await isFlagEnabled(sc, "trip_crew_map_enabled"))) {
    return { viewerPoint: null, observations, source: { name: "crew_presence", status: "no_source", observations: 0, detail: "trip_crew_map_enabled is off; presence not read" } };
  }
  const nowIso = new Date(nowMs).toISOString();
  try {
    const map = await getCrewMap(sc, tripId, viewerId);
    const me = map.members.find((m) => m.userId === viewerId) ?? null;
    const viewerPoint: GeoPoint | null = me?.exactCoords ?? null;
    const viewerSharing = me?.liveShareActive === true;
    let n = 0;
    for (const m of map.members) {
      if (m.userId === viewerId || !m.exactCoords || !viewerPoint) continue;
      const d = metresBetween(viewerPoint, m.exactCoords);
      const band = FRIEND_NEARBY_BANDS.find((b) => d <= b.withinM)?.band;
      if (!band) continue;
      n++;
      const observedAt = m.observedAt ?? m.updatedAt ?? nowIso;
      const fresh = nowMs - Date.parse(observedAt) <= 5 * 60 * 1000;
      observations.set(m.userId, [{
        value: { userId: m.userId, distanceBand: band, bothSharing: viewerSharing && m.liveShareActive },
        confidence: fresh ? 0.9 : 0.6, sourceClass: "verified_firsthand", observedAt,
        expiresAt: m.liveShareExpiresAt ?? new Date(nowMs + 15 * 60 * 1000).toISOString(),
      }]);
    }
    return { viewerPoint, observations, source: { name: "crew_presence", status: "ok", observations: n, detail: viewerPoint ? null : "the viewer has no position; distance to crew cannot be judged" } };
  } catch (err) {
    if (!(err instanceof CrewMapUnavailableError)) throw err;
    return { viewerPoint: null, observations, source: { name: "crew_presence", status: "unread", observations: 0, detail: `crew map unavailable: ${err.table}` } };
  }
}
