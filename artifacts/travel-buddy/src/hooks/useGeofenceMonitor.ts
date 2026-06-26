/**
 * useGeofenceMonitor
 *
 * Foreground geofence exit detector for posts with post_status = 'pending_location_exit'.
 *
 * How it works:
 *   1. Fetches the user's pending posts every POSTS_REFRESH_MS.
 *   2. While the app is active (foreground), polls GPS every GPS_POLL_MS.
 *   3. For each pending_location_exit post that has a valid geofence centre and
 *      radius, computes the haversine distance from the current GPS position.
 *   4. When the user is outside the radius, calls POST /api/location/exit-geofence
 *      so the server can transition the post to pending_delay and schedule the
 *      background worker to publish it.
 *
 * Limitations:
 *   - Foreground only. When the app is backgrounded the interval is paused.
 *   - For true background geofencing, upgrade to expo-task-manager +
 *     Location.startGeofencingAsync with background location permissions.
 *     See follow-up task "Upgrade to background geofencing with Expo TaskManager".
 *
 * Usage:
 *   Call useGeofenceMonitor() once in the root tab layout (_layout.tsx) so it
 *   stays mounted regardless of which tab the user is viewing.
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Location from 'expo-location';
import { getPendingPosts, exitGeofence, type PendingPostRow } from '../services/posts';

const GPS_POLL_MS     = 30_000;  // how often to check GPS while in foreground
const POSTS_REFRESH_MS = 5 * 60_000; // how often to refresh the pending-posts list

/**
 * Module-level set of post IDs for which we have already fired the exit call.
 * Module-level (not state) to survive re-renders and avoid double-calls.
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

export function useGeofenceMonitor(): void {
  // Ref holds the latest eligible posts so the interval callback always has
  // the current list without needing to re-register the interval.
  const eligibleRef = useRef<PendingPostRow[]>([]);
  const gpsIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const postsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  function stopGpsPoll() {
    if (gpsIntervalRef.current) {
      clearInterval(gpsIntervalRef.current);
      gpsIntervalRef.current = null;
    }
  }

  async function checkGeofences() {
    const posts = eligibleRef.current.filter((p) => !notifiedPosts.has(p.id));
    if (posts.length === 0) return;

    // Don't prompt for permission — only run if already granted.
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return;

    let pos: Location.LocationObject;
    try {
      pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
    } catch {
      return; // GPS unavailable — will retry next tick
    }

    const { latitude: userLat, longitude: userLng } = pos.coords;

    for (const post of posts) {
      if (notifiedPosts.has(post.id)) continue; // guard against concurrent calls

      const dist = haversineMeters(
        userLat, userLng,
        post.locationLat as number,
        post.locationLng as number,
      );

      if (dist > (post.geofenceRadiusMeters as number)) {
        // Mark immediately to prevent concurrent duplicate calls.
        notifiedPosts.add(post.id);

        exitGeofence({ postId: post.id, lat: userLat, lng: userLng })
          .then((res) => {
            if (!res.ok) {
              // Server rejected (e.g. post already transitioned) — don't retry.
              // Only retry on network errors.
              if (res.errorKind === 'network_unreachable') {
                notifiedPosts.delete(post.id);
              }
            }
          })
          .catch(() => {
            notifiedPosts.delete(post.id);
          });
      }
    }
  }

  function startGpsPoll() {
    stopGpsPoll();
    if (eligibleRef.current.filter((p) => !notifiedPosts.has(p.id)).length === 0) return;
    void checkGeofences();
    gpsIntervalRef.current = setInterval(() => { void checkGeofences(); }, GPS_POLL_MS);
  }

  async function refreshPosts() {
    const res = await getPendingPosts().catch(() => null);
    if (!res?.ok || !res.data) return;

    eligibleRef.current = res.data.filter(
      (p) =>
        p.postStatus === 'pending_location_exit' &&
        p.locationLat != null &&
        p.locationLng != null &&
        p.geofenceRadiusMeters != null,
    );

    // Re-start GPS polling now that we have fresh posts.
    if (appStateRef.current === 'active') startGpsPoll();
  }

  useEffect(() => {
    // Initial fetch
    void refreshPosts();

    // Periodically refresh pending posts in case new ones appear
    postsIntervalRef.current = setInterval(() => { void refreshPosts(); }, POSTS_REFRESH_MS);

    // Start GPS polling if already in foreground
    if (appStateRef.current === 'active') startGpsPoll();

    const sub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      if (next === 'active') {
        void refreshPosts(); // re-fetch on resume
        startGpsPoll();
      } else {
        stopGpsPoll(); // pause while backgrounded
      }
    });

    return () => {
      stopGpsPoll();
      if (postsIntervalRef.current) clearInterval(postsIntervalRef.current);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
