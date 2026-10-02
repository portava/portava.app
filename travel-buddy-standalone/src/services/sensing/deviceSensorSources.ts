/**
 * deviceSensorSources — the real hardware behind `sensingCapture`'s seams.
 *
 * This is the ONLY file in the sensing path that names `expo-sensors` or
 * `expo-location`. Everything else takes a `MotionSource` / `LocationSource`,
 * which is why the reduction and the privacy boundary are unit-testable with
 * real arithmetic and no handset.
 *
 * ── WHY THE NATIVE MODULES ARE PRE-CHECKED, NOT TRY/CAUGHT ───────────────────
 * Same reason `src/lib/safeNotifications.ts` gives: in Hermes a "Cannot find
 * native module" thrown inside a module factory fires during Metro's evaluation
 * phase, before the caller's try frame is active, so try/catch around
 * `require()` does not intercept it. `NativeModules` is populated synchronously
 * at startup, so we ask it first and skip the require entirely when the module
 * is absent. A build without `expo-sensors` therefore gets `null` and a capture
 * loop with no motion source — degraded, named in `sensor_health.degraded`,
 * never a crash.
 *
 * `expo-sensors` IS declared in package.json. It is required at runtime through
 * this guard rather than imported statically so that (a) Expo Go and older dev
 * clients keep working, and (b) the whole feature is testable in an environment
 * where the native module cannot exist.
 *
 * ── THE LOCATION SOURCE HOLDS A COORDINATE FOR ONE WINDOW ────────────────────
 * It has to: the reduction needs two fixes to tell walking from riding. What it
 * must not do is let one escape. The fixes go into `sensingCapture`'s private
 * buffer, are handed only to `reduceSensingWindow`, and are dropped when the
 * window closes. `contributionPayload.privacy.test.ts` is what holds that line.
 */
import { NativeModules, Platform } from 'react-native';
import type {
  LocationSource,
  MotionSource,
  Unsubscribe,
} from './sensingCapture.ts';

/** Accelerometer sample rate. 20 Hz is enough for a 0.5–4 Hz cadence estimate. */
export const MOTION_SAMPLE_INTERVAL_MS = 50;
/** Minimum seconds between position fixes. Deliberately not continuous GPS. */
export const LOCATION_INTERVAL_MS = 30_000;
/** Minimum metres of movement before a new fix is delivered. */
export const LOCATION_DISTANCE_M = 25;

type AnyModule = Record<string, any>;

let _sensors: AnyModule | null | undefined;

function sensorsModule(): AnyModule | null {
  if (_sensors !== undefined) return _sensors;
  if (Platform.OS === 'web') {
    _sensors = null;
    return null;
  }
  const nm = NativeModules as Record<string, unknown>;
  // expo-sensors registers these; absence means an older dev client or Expo Go.
  if (!nm['ExpoAccelerometer'] && !nm['ExponentAccelerometer'] && !nm['ExpoDeviceMotion']) {
    _sensors = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _sensors = require('expo-sensors') as AnyModule;
  } catch {
    _sensors = null;
  }
  return _sensors;
}

/** True when this build can actually read the accelerometer. */
export function motionSensingAvailable(): boolean {
  return sensorsModule() !== null;
}

/**
 * The accelerometer as a `MotionSource`, or null when the native module is not
 * present in this build. Null is a supported state, not a failure: the capture
 * loop runs on location alone and says so in `sensor_health.degraded`.
 */
export function createDeviceMotionSource(): MotionSource | null {
  const sensors = sensorsModule();
  const Accelerometer = sensors?.Accelerometer;
  if (!Accelerometer) return null;

  return {
    subscribe(onSample): Unsubscribe {
      try {
        Accelerometer.setUpdateInterval(MOTION_SAMPLE_INTERVAL_MS);
      } catch {
        // A device that refuses the rate still delivers at its default.
      }
      const sub = Accelerometer.addListener((d: { x: number; y: number; z: number }) => {
        onSample({ t: Date.now(), x: d.x, y: d.y, z: d.z });
      });
      return () => {
        try {
          sub?.remove?.();
        } catch {
          // Teardown must never throw into the capture loop's stop().
        }
      };
    },
  };
}

/**
 * `expo-location`'s watch as a `LocationSource`. Subscription is asynchronous,
 * so the returned unsubscribe cancels a watch that may not have started yet —
 * a stop() racing a start() must still stop.
 *
 * Requests only FOREGROUND permission, and only if it is already granted: this
 * path never raises a new prompt. Contribution sensing is not a reason to ask a
 * traveller for background location.
 */
export function createDeviceLocationSource(): LocationSource {
  return {
    subscribe(onSample): Unsubscribe {
      let cancelled = false;
      let remove: (() => void) | null = null;

      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const Location = require('expo-location') as AnyModule;
          const perm = await Location.getForegroundPermissionsAsync();
          if (cancelled || !perm?.granted) return;
          const sub = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy?.Balanced ?? 3,
              timeInterval: LOCATION_INTERVAL_MS,
              distanceInterval: LOCATION_DISTANCE_M,
            },
            (pos: any) => {
              const c = pos?.coords;
              if (!c) return;
              onSample({
                t: typeof pos.timestamp === 'number' ? pos.timestamp : Date.now(),
                lat: c.latitude,
                lng: c.longitude,
                accuracyM: typeof c.accuracy === 'number' ? c.accuracy : null,
                speedMps: typeof c.speed === 'number' && c.speed >= 0 ? c.speed : null,
              });
            },
          );
          if (cancelled) {
            sub?.remove?.();
            return;
          }
          remove = () => sub?.remove?.();
        } catch {
          // No permission, no provider, no module — the window degrades.
        }
      })();

      return () => {
        cancelled = true;
        try {
          remove?.();
        } catch {
          // As above.
        }
      };
    },
  };
}
