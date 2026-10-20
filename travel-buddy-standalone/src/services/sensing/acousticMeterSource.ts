/**
 * acousticMeterSource — the METER behind the acoustic seam. §4.1's "optional
 * coarse acoustic energy/rhythm ONLY under separate explicit permission".
 *
 * ── WHAT CROSSES THIS BOUNDARY ───────────────────────────────────────────────
 * One number per tick: `status.metering`, a dBFS level. No PCM buffer, no file
 * handle, no URI. Expo creates a temporary recording for metering. This path
 * does not read, play or upload it. Recorder release and exact owned-cache-file
 * deletion are best-effort: native failures, pending operations or process exit
 * can delay release or leave the temporary file behind.
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

let lifecycle = Promise.resolve();
let releaseUncertain = false;

async function deleteOwnedRecording(uri: string | null): Promise<void> {
  if (!uri) return;
  try {
    const filesystem: typeof import('expo-file-system/legacy') = require('expo-file-system/legacy');
    const cache = filesystem.cacheDirectory;
    if (!cache?.startsWith('file://') || !cache.endsWith('/') || !uri.startsWith(cache)) return;
    if (!/^(AV|Audio)\/recording-[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(uri.slice(cache.length))) return;
    await filesystem.deleteAsync(uri, { idempotent: true });
  } catch {}
}

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
      let recording: InstanceType<typeof import('expo-av').Audio.Recording> | null = null;
      let finish!: () => void;
      const untilStopped = new Promise<void>((resolve) => { finish = resolve; });
      const detach = () => {
        try { recording?.setOnRecordingStatusUpdate(null); } catch {}
      };
      const run = async () => {
        if (stopped || releaseUncertain) return;
        let Audio: typeof import('expo-av').Audio | undefined;
        let modeAttempted = false;
        try {
          const av: typeof import('expo-av') = require('expo-av');
          Audio = av.Audio;
          if (!Audio?.Recording) return;
          modeAttempted = true;
          await Audio.setAudioModeAsync?.({ allowsRecordingIOS: true, playsInSilentModeIOS: false });
          if (stopped) return;
          recording = new Audio.Recording();
          const preset = Audio.RecordingOptionsPresets?.LOW_QUALITY ?? {};
          await recording.prepareToRecordAsync({ ...preset, isMeteringEnabled: true });
          if (stopped) return;
          recording.setProgressUpdateInterval?.(ACOUSTIC_METER_INTERVAL_MS);
          recording.setOnRecordingStatusUpdate?.((status) => {
            if (stopped) return;
            const level = status?.metering;
            if (typeof level === 'number' && Number.isFinite(level)) {
              onSample({ t: Date.now(), dbfs: level });
            }
          });
          if (stopped) return;
          await recording.startAsync();
          if (stopped) return;
          await untilStopped;
        } catch {
        } finally {
          stopped = true;
          detach();
          let releasedUri: string | null = null;
          if (recording) {
            let uri: string | null = null;
            try { uri = recording.getURI?.() ?? null; } catch {}
            let released = false;
            try {
              await recording.stopAndUnloadAsync();
              released = true;
            } catch {
              try {
                const status = await recording.getStatusAsync?.();
                released = status?.canRecord === false && status.isRecording === false && status.isDoneRecording === true;
              } catch {}
            }
            if (released) releasedUri = uri;
            else releaseUncertain = true;
          }
          if (modeAttempted) {
            try { await Audio?.setAudioModeAsync?.({ allowsRecordingIOS: false }); } catch { releaseUncertain = true; }
          }
          await deleteOwnedRecording(releasedUri);
        }
      };
      lifecycle = lifecycle.then(run, run);

      return () => {
        stopped = true;
        detach();
        finish();
      };
    },
  };
}
