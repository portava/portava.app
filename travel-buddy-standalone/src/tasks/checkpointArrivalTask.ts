/**
 * checkpointArrivalTask — Expo TaskManager task for background geofence ENTER events.
 *
 * When the OS detects the user has entered a checkpoint geofence, this task
 * pushes the stop ID into a pending arrivals queue in AsyncStorage.
 * `useRouteCheckpointMonitor` drains that queue when the app resumes foreground.
 *
 * IMPORTANT: This file must be imported in `app/_layout.tsx` BEFORE any call to
 * `Location.startGeofencingAsync` so that `TaskManager.defineTask` is registered
 * at module-root level.
 */
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PENDING_ARRIVALS_STORE_KEY,
  resolveCheckpointQueueKey,
} from './checkpointArrivalQueue.ts';

export const CHECKPOINT_ARRIVAL_TASK = 'checkpoint-arrival';
// Re-exported for existing importers (e.g. useRouteCheckpointMonitor.ts) —
// the pure key-resolution/migration logic itself now lives in
// checkpointArrivalQueue.ts so it can be unit-tested without loading
// expo-task-manager's native runtime.
export { PENDING_ARRIVALS_STORE_KEY, resolveCheckpointQueueKey };

// TaskManager.defineTask must run at module load time (before startGeofencingAsync)
TaskManager.defineTask(
  CHECKPOINT_ARRIVAL_TASK,
  async ({ data, error }: TaskManager.TaskManagerTaskBody) => {
    if (error) return;
    const { eventType, region } = data as {
      eventType: Location.GeofencingEventType;
      region: Location.LocationRegion;
    };

    // We only care about enter events (arrival)
    if (eventType !== Location.GeofencingEventType.Enter) return;

    const stopId = region.identifier;
    if (!stopId) return;

    try {
      const key = await resolveCheckpointQueueKey(AsyncStorage);
      if (key === null) return; // defer — no resolvable account, never fall back to the legacy key
      const raw = await AsyncStorage.getItem(key);
      const pending: string[] = raw ? (JSON.parse(raw) as string[]) : [];
      if (!pending.includes(stopId)) {
        pending.push(stopId);
        await AsyncStorage.setItem(key, JSON.stringify(pending));
      }
    } catch {
      // Non-fatal: foreground fallback will still catch the arrival
    }
  },
);
