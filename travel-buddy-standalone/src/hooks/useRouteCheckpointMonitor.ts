/**
 * useRouteCheckpointMonitor
 *
 * Tracks checkpoint ENTER events during an active walking route.
 *
 * Strategy (mirrors useGeofenceMonitor exactly):
 *   1. Background geofencing via expo-task-manager + Location.startGeofencingAsync
 *      (CHECKPOINT_ARRIVAL_TASK, notifyOnEnter: true).  The OS fires the task
 *      even when the app is backgrounded.  Requires background location permission.
 *   2. Foreground polling fallback — if background permission is denied, polls GPS
 *      every GPS_POLL_MS while AppState === 'active', same as useGeofenceMonitor.
 *
 * Prerequisite: import '../../src/tasks/checkpointArrivalTask' in app/_layout.tsx
 * so TaskManager.defineTask is registered before any startGeofencingAsync call.
 */
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CHECKPOINT_ARRIVAL_TASK,
  PENDING_ARRIVALS_STORE_KEY,
} from '../tasks/checkpointArrivalTask.ts';

const GPS_POLL_MS      = 30_000;  // foreground fallback: GPS check interval
const DEFAULT_RADIUS_M = 80;      // metres — matches plan_geofences default

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

/**
 * Haversine great-circle distance in metres.
 * Exported so useGeofenceMonitor can optionally import it instead of
 * maintaining a duplicate implementation.
 */
export function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R     = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a     =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Module-level dedup set — prevents duplicate PATCH calls within one session.
 * Cleared when the hook mounts with a new set of enabled stops.
 */
const notifiedStops = new Set<string>();

// ── Background geofencing ──────────────────────────────────────────────────────

async function tryStartBackgroundGeofencing(stops: CheckpointStopInput[]): Promise<boolean> {
  try {
    const { status } = await Location.requestBackgroundPermissionsAsync();
    if (status !== 'granted') return false;

    const regions: Location.LocationRegion[] = stops.map((s) => ({
      identifier:    s.id,
      latitude:      s.lat,
      longitude:     s.lng,
      radius:        s.radius ?? DEFAULT_RADIUS_M,
      notifyOnEnter: true,
      notifyOnExit:  false,
    }));

    await Location.startGeofencingAsync(CHECKPOINT_ARRIVAL_TASK, regions);
    return true;
  } catch {
    return false;
  }
}

async function stopBackgroundGeofencing(): Promise<void> {
  try {
    const running = await Location.hasStartedGeofencingAsync(CHECKPOINT_ARRIVAL_TASK);
    if (running) await Location.stopGeofencingAsync(CHECKPOINT_ARRIVAL_TASK);
  } catch { /* non-fatal */ }
}

// ── Foreground polling fallback ───────────────────────────────────────────────

async function checkStopsForeground(
  stops: CheckpointStopInput[],
  onArrived: (id: string) => Promise<void>,
): Promise<void> {
  const candidates = stops.filter((s) => !notifiedStops.has(s.id));
  if (candidates.length === 0) return;

  const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') return;

  let pos: Location.LocationObject;
  try {
    pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  } catch {
    return;
  }

  const { latitude: userLat, longitude: userLng } = pos.coords;
  for (const stop of candidates) {
    if (notifiedStops.has(stop.id)) continue;
    const dist = haversineMeters(userLat, userLng, stop.lat, stop.lng);
    if (dist <= (stop.radius ?? DEFAULT_RADIUS_M)) {
      notifiedStops.add(stop.id);
      onArrived(stop.id).catch(() => {
        notifiedStops.delete(stop.id); // retry on next tick
      });
    }
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useRouteCheckpointMonitor({
  stops,
  onArrived,
  enabled = true,
}: UseRouteCheckpointMonitorOptions): void {
  const stopsRef       = useRef<CheckpointStopInput[]>(stops);
  const onArrivedRef   = useRef<(id: string) => Promise<void>>(onArrived);
  const usingBgRef     = useRef(false);
  const gpsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef    = useRef<AppStateStatus>(AppState.currentState);

  stopsRef.current    = stops;
  onArrivedRef.current = onArrived;

  useEffect(() => {
    if (!enabled || stops.length === 0) return;

    notifiedStops.clear();

    function stopForegroundPoll() {
      if (gpsIntervalRef.current) {
        clearInterval(gpsIntervalRef.current);
        gpsIntervalRef.current = null;
      }
    }

    function startForegroundPoll() {
      stopForegroundPoll();
      const pending = stopsRef.current.filter((s) => !notifiedStops.has(s.id));
      if (pending.length === 0) return;
      void checkStopsForeground(stopsRef.current, onArrivedRef.current);
      gpsIntervalRef.current = setInterval(
        () => void checkStopsForeground(stopsRef.current, onArrivedRef.current),
        GPS_POLL_MS,
      );
    }

    /**
     * Drain the AsyncStorage queue written by CHECKPOINT_ARRIVAL_TASK during
     * background geofencing.  Called on mount and on every foreground resume
     * so that background arrivals are processed even if the foreground poll
     * hadn't fired yet.
     */
    async function drainPendingArrivals() {
      try {
        const raw = await AsyncStorage.getItem(PENDING_ARRIVALS_STORE_KEY);
        if (!raw) return;
        const pending: string[] = JSON.parse(raw) as string[];
        if (pending.length === 0) return;

        const toProcess = pending.filter((id) => !notifiedStops.has(id));
        if (toProcess.length === 0) {
          await AsyncStorage.removeItem(PENDING_ARRIVALS_STORE_KEY);
          return;
        }

        // Process each queued stop ID and clear the store on success.
        await Promise.all(
          toProcess.map(async (stopId) => {
            notifiedStops.add(stopId);
            await onArrivedRef.current(stopId).catch(() => {
              notifiedStops.delete(stopId); // allow retry next drain
            });
          }),
        );
        await AsyncStorage.removeItem(PENDING_ARRIVALS_STORE_KEY);
      } catch {
        /* non-fatal */
      }
    }

    async function applyStops() {
      const bgOk = await tryStartBackgroundGeofencing(stopsRef.current);
      usingBgRef.current = bgOk;

      if (bgOk) {
        // Background geofencing active — stop foreground poll to save battery.
        stopForegroundPoll();
      } else {
        // No background permission — use foreground polling while app is active.
        if (appStateRef.current === 'active') startForegroundPoll();
      }
    }

    void applyStops();
    void drainPendingArrivals(); // drain any arrivals queued while app was backgrounded

    const sub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      if (next === 'active') {
        void drainPendingArrivals(); // pick up background geofence events on resume
        if (!usingBgRef.current) startForegroundPoll();
      } else {
        if (!usingBgRef.current) stopForegroundPoll();
        // Background geofencing continues regardless of AppState.
      }
    });

    return () => {
      stopForegroundPoll();
      sub.remove();
      void stopBackgroundGeofencing();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, stops.length]);
}
