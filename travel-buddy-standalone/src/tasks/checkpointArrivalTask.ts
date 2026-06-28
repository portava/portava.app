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

export const CHECKPOINT_ARRIVAL_TASK    = 'checkpoint-arrival';
export const PENDING_ARRIVALS_STORE_KEY = '@travel_buddy/pending_checkpoint_arrivals';

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
      const raw = await AsyncStorage.getItem(PENDING_ARRIVALS_STORE_KEY);
      const pending: string[] = raw ? (JSON.parse(raw) as string[]) : [];
      if (!pending.includes(stopId)) {
        pending.push(stopId);
        await AsyncStorage.setItem(PENDING_ARRIVALS_STORE_KEY, JSON.stringify(pending));
      }
    } catch {
      // Non-fatal: foreground fallback will still catch the arrival
    }
  },
);
