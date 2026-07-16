/**
 * useGeofenceMonitor
 *
 * Manages geofence monitoring for posts with post_status = 'pending_location_exit'.
 *
 * Strategy (tried in order):
 *   1. Background geofencing via expo-task-manager + Location.startGeofencingAsync.
 *      The OS triggers the GEOFENCE_EXIT_TASK when the device crosses a boundary,
 *      even when the app is backgrounded or suspended. Requires background location
 *      permission (requested at hook init).
 *   2. Foreground polling fallback — if background permission is denied, polls GPS
 *      every 30 s while AppState === 'active'.
 *
 * Usage: call useGeofenceMonitor() once in app/(tabs)/_layout.tsx so it stays
 * mounted regardless of which tab is active.
 *
 * Prerequisite: import '../../src/tasks/geofenceExitTask.ts' in app/_layout.tsx
 * BEFORE any call to Location.startGeofencingAsync (TaskManager.defineTask must
 * be registered at module root first).
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Location from 'expo-location';
import { getPendingPosts, exitGeofence, type PendingPostRow } from '../services/posts.ts';
import { GEOFENCE_EXIT_TASK } from '../tasks/geofenceExitTask.ts';

const GPS_POLL_MS      = 30_000;       // foreground fallback: GPS check interval
const POSTS_REFRESH_MS = 5 * 60_000;  // how often to refresh pending-posts list

/**
 * Module-level set of post IDs already dispatched to the server.
 * Prevents duplicate calls from the foreground fallback path on re-renders.
 */
const notifiedPosts = new Set<string>();

/** Haversine great-circle distance in metres. */
function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Filter a pending-posts list to posts eligible for geofence monitoring. */
function eligiblePosts(posts: PendingPostRow[]): PendingPostRow[] {
  return posts.filter(
    (p) =>
      p.postStatus === 'pending_location_exit' &&
      p.locationLat != null &&
      p.locationLng != null &&
      p.geofenceRadiusMeters != null,
  );
}

// ── Background geofencing ──────────────────────────────────────────────────────

async function tryStartBackgroundGeofencing(
  posts: PendingPostRow[],
): Promise<boolean> {
  try {
    const { status } = await Location.requestBackgroundPermissionsAsync();
    if (status !== 'granted') return false;

    const regions: Location.LocationRegion[] = posts.map((p) => ({
      identifier: p.id,
      latitude:   p.locationLat  as number,
      longitude:  p.locationLng  as number,
      radius:     p.geofenceRadiusMeters as number,
      notifyOnEnter: false,
      notifyOnExit:  true,
    }));

    await Location.startGeofencingAsync(GEOFENCE_EXIT_TASK, regions);
    return true;
  } catch {
    return false;
  }
}

async function stopBackgroundGeofencing(): Promise<void> {
  try {
    const running = await Location.hasStartedGeofencingAsync(GEOFENCE_EXIT_TASK);
    if (running) await Location.stopGeofencingAsync(GEOFENCE_EXIT_TASK);
  } catch { /* non-fatal */ }
}

// ── Foreground polling fallback ───────────────────────────────────────────────

async function checkGeofencesForeground(posts: PendingPostRow[]): Promise<void> {
  const candidates = posts.filter((p) => !notifiedPosts.has(p.id));
  if (candidates.length === 0) return;

  const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') return;

  let pos: Location.LocationObject;
  try {
    pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
  } catch {
    return;
  }

  const { latitude: userLat, longitude: userLng } = pos.coords;

  for (const post of candidates) {
    if (notifiedPosts.has(post.id)) continue;
    const dist = haversineMeters(
      userLat, userLng,
      post.locationLat  as number,
      post.locationLng  as number,
    );
    if (dist > (post.geofenceRadiusMeters as number)) {
      notifiedPosts.add(post.id);
      exitGeofence({ postId: post.id, lat: userLat, lng: userLng })
        .then((res) => {
          if (!res.ok && res.errorKind === 'network_unreachable') {
            notifiedPosts.delete(post.id); // retry on next tick
          }
        })
        .catch(() => {
          notifiedPosts.delete(post.id);
        });
    }
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useGeofenceMonitor(): void {
  const eligibleRef       = useRef<PendingPostRow[]>([]);
  const usingBackgroundRef = useRef(false);
  const gpsIntervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const postsIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef       = useRef<AppStateStatus>(AppState.currentState);

  function stopForegroundPoll() {
    if (gpsIntervalRef.current) {
      clearInterval(gpsIntervalRef.current);
      gpsIntervalRef.current = null;
    }
  }

  function startForegroundPoll() {
    stopForegroundPoll();
    const posts = eligibleRef.current.filter((p) => !notifiedPosts.has(p.id));
    if (posts.length === 0) return;
    void checkGeofencesForeground(posts);
    gpsIntervalRef.current = setInterval(
      () => { void checkGeofencesForeground(eligibleRef.current); },
      GPS_POLL_MS,
    );
  }

  async function applyPosts(posts: PendingPostRow[]) {
    eligibleRef.current = posts;

    if (posts.length === 0) {
      stopForegroundPoll();
      await stopBackgroundGeofencing();
      usingBackgroundRef.current = false;
      return;
    }

    // Always (re-)register geofences when the post list changes so newly
    // created posts are included in the OS-monitored regions.
    const bgOk = await tryStartBackgroundGeofencing(posts);
    usingBackgroundRef.current = bgOk;

    if (bgOk) {
      // Background geofencing is active — stop the foreground poll to save battery.
      stopForegroundPoll();
    } else {
      // No background permission — use foreground polling while app is active.
      if (appStateRef.current === 'active') startForegroundPoll();
    }
  }

  async function refreshPosts() {
    const res = await getPendingPosts().catch(() => null);
    if (!res?.ok || !res.data) return;
    await applyPosts(eligiblePosts(res.data));
  }

  useEffect(() => {
    void refreshPosts();

    postsIntervalRef.current = setInterval(
      () => { void refreshPosts(); },
      POSTS_REFRESH_MS,
    );

    const sub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      if (next === 'active') {
        void refreshPosts(); // pick up any new posts after resume
        if (!usingBackgroundRef.current) startForegroundPoll();
      } else {
        if (!usingBackgroundRef.current) stopForegroundPoll();
        // Background geofencing continues regardless of AppState.
      }
    });

    return () => {
      stopForegroundPoll();
      if (postsIntervalRef.current) clearInterval(postsIntervalRef.current);
      sub.remove();
      void stopBackgroundGeofencing();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
