/**
 * useRouteCheckpointMonitor
 *
 * Manages arrival geofence monitoring for active route plan checkpoints.
 * Mirrors the same two-path strategy as useGeofenceMonitor:
 *
 *   1. Background geofencing via expo-task-manager + Location.startGeofencingAsync.
 *      The OS triggers CHECKPOINT_ARRIVAL_TASK when the device enters a stop's
 *      radius, even when the app is backgrounded or suspended. The task queues
 *      the stop ID in AsyncStorage; this hook drains the queue on resume.
 *
 *   2. Foreground polling fallback — if background permission is denied, polls GPS
 *      every GPS_POLL_MS while AppState === 'active'.
 *
 * Usage:
 *   // In app/route/[id].tsx (mounted only while the route session is active)
 *   useRouteCheckpointMonitor({ stops, onArrived: markArrived, enabled: routeStarted });
 *
 * Prerequisite: import '../../src/tasks/checkpointArrivalTask' in app/_layout.tsx
 * BEFORE any call to Location.startGeofencingAsync.
 */
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import {
  CHECKPOINT_ARRIVAL_TASK,
  PENDING_ARRIVALS_STORE_KEY,
} from '../tasks/checkpointArrivalTask';

const GPS_POLL_MS       = 30_000;
const DEFAULT_RADIUS_M  = 80;   // metres — arrival circle around each checkpoint

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

/** Module-level dedup set — prevents duplicate PATCH calls during one session. */
const notifiedStops = new Set<string>();

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

// ── Background geofencing ──────────────────────────────────────────────────────

async function tryStartBackgroundGeofencing(
  stops: CheckpointStopInput[],
): Promise<boolean> {
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

// ── Pending-arrivals queue (written by background task) ───────────────────────

async function drainPendingArrivals(
  onArrived: (id: string) => Promise<void>,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_ARRIVALS_STORE_KEY);
    if (!raw) return;
    const pending: string[] = JSON.parse(raw) as string[];
    if (pending.length === 0) return;
    // Clear queue first to prevent double-processing
    await AsyncStorage.removeItem(PENDING_ARRIVALS_STORE_KEY);
    for (const stopId of pending) {
      if (notifiedStops.has(stopId)) continue;
      notifiedStops.add(stopId);
      await onArrived(stopId).catch(() => {
        notifiedStops.delete(stopId);
      });
    }
  } catch { /* non-fatal */ }
}

// ── Foreground proximity check ─────────────────────────────────────────────────

async function checkProximityForeground(
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
      await onArrived(stop.id).catch(() => {
        notifiedStops.delete(stop.id);
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
  const stopsRef              = useRef<CheckpointStopInput[]>(stops);
  const onArrivedRef          = useRef<(id: string) => Promise<void>>(onArrived);
  const usingBackgroundRef    = useRef(false);
  const gpsIntervalRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const drainIntervalRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef           = useRef<AppStateStatus>(AppState.currentState);

  // Keep refs fresh without re-running the effect
  stopsRef.current    = stops;
  onArrivedRef.current = onArrived;

  function stopForegroundPoll() {
    if (gpsIntervalRef.current) { clearInterval(gpsIntervalRef.current); gpsIntervalRef.current = null; }
    if (drainIntervalRef.current) { clearInterval(drainIntervalRef.current); drainIntervalRef.current = null; }
  }

  function startForegroundPoll() {
    stopForegroundPoll();
    const activeStops = stopsRef.current.filter((s) => !notifiedStops.has(s.id));
    if (activeStops.length === 0) return;

    void checkProximityForeground(activeStops, onArrivedRef.current);
    gpsIntervalRef.current = setInterval(
      () => { void checkProximityForeground(stopsRef.current, onArrivedRef.current); },
      GPS_POLL_MS,
    );

    // Drain background-queued arrivals every 5 s while in foreground
    drainIntervalRef.current = setInterval(
      () => { void drainPendingArrivals(onArrivedRef.current); },
      5_000,
    );
  }

  useEffect(() => {
    if (!enabled || stops.length === 0) return;

    // Clear dedup set when the stop list changes (e.g. new route)
    notifiedStops.clear();

    let cancelled = false;

    async function init() {
      const bgOk = await tryStartBackgroundGeofencing(stopsRef.current);
      if (cancelled) return;
      usingBackgroundRef.current = bgOk;

      if (bgOk) {
        stopForegroundPoll();
        // Still drain the queue (arrivals queued while app was fully killed)
        void drainPendingArrivals(onArrivedRef.current);
      } else {
        if (appStateRef.current === 'active') startForegroundPoll();
      }
    }

    void init();

    // Drain once immediately when hook mounts (in case arrivals accumulated)
    void drainPendingArrivals(onArrivedRef.current);

    const appSub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      if (next === 'active') {
        void drainPendingArrivals(onArrivedRef.current);
        if (!usingBackgroundRef.current) startForegroundPoll();
      } else {
        if (!usingBackgroundRef.current) stopForegroundPoll();
      }
    });

    return () => {
      cancelled = true;
      stopForegroundPoll();
      appSub.remove();
      void stopBackgroundGeofencing();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, stops.length]);
}
