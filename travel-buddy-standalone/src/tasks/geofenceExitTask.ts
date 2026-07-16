/**
 * Geofence exit background task.
 *
 * IMPORTANT: TaskManager.defineTask MUST be called at module root — this
 * module must be imported early in the app lifecycle (before any call to
 * Location.startGeofencingAsync). Import it in app/_layout.tsx.
 *
 * When the OS detects the user has exited a registered geofence region, this
 * task fires in the background (even when the app is backgrounded or suspended)
 * and calls POST /api/location/exit-geofence so the server can transition the
 * post from pending_location_exit → pending_delay and schedule publishing.
 */

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { exitGeofence } from '../services/posts.ts';

export const GEOFENCE_EXIT_TASK = 'geofence-exit-task';

type GeofenceTaskData = {
  eventType: Location.GeofencingEventType;
  region: Location.LocationRegion;
};

TaskManager.defineTask<GeofenceTaskData>(
  GEOFENCE_EXIT_TASK,
  async ({ data, error }: TaskManager.TaskManagerTaskBody<GeofenceTaskData>) => {
    if (error || !data) return;

    const { eventType, region } = data;
    if (eventType !== Location.GeofencingEventType.Exit) return;
    if (!region?.identifier) return;

    // Use the geofence centre as exit coordinates — the user's exact position at
    // exit is unavailable without a fresh getCurrentPositionAsync call (unreliable
    // in background). The server accepts the centre lat/lng for the audit log.
    await exitGeofence({
      postId: region.identifier,
      lat: region.latitude,
      lng: region.longitude,
    }).catch(() => {
      // Background task — swallow failures silently.
      // Server-side idempotency (post_status check) prevents duplicate transitions.
    });
  },
);
