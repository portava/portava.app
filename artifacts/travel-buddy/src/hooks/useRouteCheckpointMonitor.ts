/**
 * useRouteCheckpointMonitor
 *
 * Tracks arrival at each stop checkpoint during an active route session.
 *
 * Architecture note: This hook intentionally reuses the FOREGROUND location
 * system (`Location.watchPositionAsync` / haversine check), the same approach
 * used throughout the rest of the app (`useActiveLocation`, `LocationContext`).
 *
 * `useGeofenceMonitor` (delayed-post exit events) uses
 * `Location.startGeofencingAsync` with `notifyOnEnter: false` and a separate
 * background task.  Checkpoint monitoring is a foreground-only concern — the
 * user is actively navigating, the app is in the foreground — so we avoid
 * adding a parallel background-task system.  We watch the position stream and
 * run a haversine check on each update; when the user comes within `radius`
 * metres of an un-arrived stop we fire `onArrived`.
 *
 * Usage:
 *   useRouteCheckpointMonitor({ stops, onArrived: markArrived, enabled: routeStarted });
 */
import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';

const DEFAULT_RADIUS_M = 80; // metres

export interface CheckpointStopInput {
  id: string;
  lat: number;
  lng: number;
  radius?: number;
}

export interface UseRouteCheckpointMonitorOptions {
  stops: CheckpointStopInput[];
  onArrived: (stopId: string) => Promise<void>;
  enabled?: boolean;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R     = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a     =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Module-level dedup set — prevents duplicate PATCH calls during one session. */
const notifiedStops = new Set<string>();

export function useRouteCheckpointMonitor({
  stops,
  onArrived,
  enabled = true,
}: UseRouteCheckpointMonitorOptions): void {
  const stopsRef     = useRef<CheckpointStopInput[]>(stops);
  const onArrivedRef = useRef<(id: string) => Promise<void>>(onArrived);

  stopsRef.current    = stops;
  onArrivedRef.current = onArrived;

  useEffect(() => {
    if (!enabled || stops.length === 0) return;

    notifiedStops.clear();

    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    async function startWatch() {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;

      subscription = await Location.watchPositionAsync(
        {
          accuracy:            Location.Accuracy.Balanced,
          distanceInterval:    20,   // fire at most once per 20 m moved
          timeInterval:        15_000,
        },
        (pos) => {
          const { latitude: userLat, longitude: userLng } = pos.coords;
          const pending = stopsRef.current.filter((s) => !notifiedStops.has(s.id));
          for (const stop of pending) {
            const dist = haversineMeters(userLat, userLng, stop.lat, stop.lng);
            if (dist <= (stop.radius ?? DEFAULT_RADIUS_M)) {
              notifiedStops.add(stop.id);
              onArrivedRef.current(stop.id).catch(() => {
                notifiedStops.delete(stop.id);
              });
            }
          }
        },
      );
    }

    void startWatch();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, stops.length]);
}
