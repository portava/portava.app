/**
 * acousticMeterSource — the METER behind the acoustic seam. §4.1's "optional
 * coarse acoustic energy/rhythm ONLY under separate explicit permission".
 *
 * ── WHAT CROSSES THIS BOUNDARY ───────────────────────────────────────────────
 * One number per tick: `status.metering`, a dBFS level. No PCM buffer, no file
 * handle, no URI. The OS recorder is started with the shortest viable settings
 * purely because metering is the only way any mobile OS exposes a level, it is
 * never played, read or uploaded, and `stopAndUnloadAsync` runs in a finally so
 * the temporary file the OS insists on is released on every path including a
 * throw.
 *
 * ── IT REFUSES TO EXIST WITHOUT THE SEPARATE PERMISSION ──────────────────────
 * `createAcousticMeterSource` returns `null` unless `acousticCaptureAllowed`
 * says both the purpose-scoped grant and the OS microphone permission are held.
 * Not "returns no samples" — returns no source, so `sensingCapture` never even
 * subscribes and no recorder is constructed. The microphone Portava already
 * holds for calls and video buys nothing here: that grant is enumerated in
 * `MICROPHONE_GRANTS_THAT_DO_NOT_SATISFY` and refused by scope.
 */
import { Platform } from 'react-native';
import {
  acousticCaptureAllowed,
  type AcousticPermission,
} from '../../lib/sensing/acousticPermission.ts';
import type { AcousticMeterSource, Unsubscribe } from './sensingCapture.ts';

/** How often a level is read. Fast enough for a tempo, far below speech rates. */
export const ACOUSTIC_METER_INTERVAL_MS = 250;

/**
 * Build the meter source, or null when it is not permitted or not possible.
 * Null is the normal state: this is off unless a user turned it on.
 */
export function createAcousticMeterSource(
  permission: AcousticPermission | null,
): AcousticMeterSource | null {
  if (!acousticCaptureAllowed(permission)) return null;
  if (Platform.OS === 'web') return null;

  return {
    subscribe(onSample): Unsubscribe {
      let stopped = false;
      let stop: (() => Promise<void>) | null = null;

      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const av = require('expo-av') as Record<string, any>;
          const Audio = av?.Audio;
          if (!Audio?.Recording) return;

          await Audio.setAudioModeAsync?.({ allowsRecordingIOS: true, playsInSilentModeIOS: false });
          const recording = new Audio.Recording();
          const preset = Audio.RecordingOptionsPresets?.LOW_QUALITY ?? {};
          await recording.prepareToRecordAsync({ ...preset, isMeteringEnabled: true });
          recording.setProgressUpdateInterval?.(ACOUSTIC_METER_INTERVAL_MS);
          recording.setOnRecordingStatusUpdate?.((status: any) => {
            if (stopped) return;
            const level = status?.metering;
            if (typeof level === 'number' && Number.isFinite(level)) {
              onSample({ t: Date.now(), dbfs: level });
            }
          });
          if (stopped) return;
          await recording.startAsync();

          stop = async () => {
            try {
              await recording.stopAndUnloadAsync();
            } finally {
              // The OS writes to a cache file whatever we do; forget the handle
              // immediately so nothing in this process can read it back.
              recording.setOnRecordingStatusUpdate?.(null);
              await Audio.setAudioModeAsync?.({ allowsRecordingIOS: false });
            }
          };
        } catch {
          // No module, no permission at the OS layer, or no recorder — silence
          // is the correct outcome, and the window simply carries no acoustic.
        }
      })();

      return () => {
        stopped = true;
        void stop?.().catch(() => undefined);
      };
    },
  };
}
