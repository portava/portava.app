/**
 * installSensingCapture — the one call that makes §4.1 a thing this app does
 * rather than a thing it could do.
 *
 * `app/_layout.tsx` mounts `<SensingCaptureSetup />`, which calls this. Without
 * that line the whole sensing tree would be a module nothing imports, which is
 * the state the sensing census recorded for S28 ("no client capture module
 * produces the nine named features") and the state this closes.
 * `installSensingCapture.test.ts` reads `app/_layout.tsx` and fails if the
 * mount disappears, the same guard `installInputTelemetry.test.ts` keeps over
 * the §44 sink for the same reason.
 *
 * ── FAIL-CLOSED, IN THIS ORDER ───────────────────────────────────────────────
 *   1. No API base configured            → nothing starts.
 *   2. No Intelligence-Contribution consent (the EXISTING server-authoritative
 *      consent, `services/intelConsent.ts` — §4.2 says to use the existing
 *      consent architecture rather than invent a parallel one) → nothing starts.
 *   3. Acoustic: off unless the SEPARATE `sensing.acoustic.energy` grant AND
 *      the OS microphone permission are both held. Not asked for here.
 *
 * Consent is read once at boot and again on every app foreground, so a
 * withdrawal takes effect at the next window rather than at the next launch.
 */
import { AppState, type AppStateStatus } from 'react-native';
import { freshToken } from '../apiToken.ts';
import { getIntelConsent, hasValidConsent } from '../intelConsent.ts';
import {
  startSensingCapture,
  type SensingCaptureHandle,
} from './sensingCapture.ts';
import {
  createDeviceLocationSource,
  createDeviceMotionSource,
} from './deviceSensorSources.ts';
import { createAcousticMeterSource } from './acousticMeterSource.ts';
import { readAcousticSensingPermission } from './acousticSensingPermission.ts';
import { createSensingTransport } from './sensingTransport.ts';
import {
  ACOUSTIC_PERMISSION_DENIED,
  acousticCaptureAllowed,
  type AcousticPermission,
} from '../../lib/sensing/acousticPermission.ts';

export interface SensingCaptureInstallation {
  dispose(): void;
}

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export function installSensingCapture(): SensingCaptureInstallation {
  let capture: SensingCaptureHandle | null = null;
  let disposed = false;
  let acoustic: AcousticPermission = ACOUSTIC_PERMISSION_DENIED;

  const transport = createSensingTransport({
    baseUrl: apiBase(),
    getEligibilityToken: freshToken,
    fetchImpl: (...args) => fetch(...args),
    now: () => Date.now(),
    sessionPath: process.env.EXPO_PUBLIC_SENSING_SESSION_PATH,
    ingestPath: process.env.EXPO_PUBLIC_SENSING_INGEST_PATH,
  });

  function stop(): void {
    capture?.stop();
    capture = null;
  }

  async function start(): Promise<void> {
    if (disposed || capture) return;
    if (!apiBase()) return;
    if (!hasValidConsent(await getIntelConsent())) return;
    if (disposed) return;

    acoustic = await readAcousticSensingPermission();
    if (disposed) return;

    capture = startSensingCapture({
      motion: createDeviceMotionSource(),
      location: createDeviceLocationSource(),
      acoustic: createAcousticMeterSource(acoustic),
      acousticPermission: () => acoustic,
      now: () => Date.now(),
      schedule: (fn, everyMs) => {
        const id = setInterval(fn, everyMs);
        return () => clearInterval(id);
      },
      submit: async (payload) => {
        await transport.submit(payload);
      },
    });
  }

  void start();

  // Re-check consent on every foreground: a withdrawal made in settings (or on
  // another device) must stop capture, not wait for a relaunch.
  const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state !== 'active') return;
    void (async () => {
      const allowed = apiBase() !== '' && hasValidConsent(await getIntelConsent());
      if (!allowed) {
        stop();
        transport.reset();
        return;
      }
      const before = acousticCaptureAllowed(acoustic);
      acoustic = await readAcousticSensingPermission();
      // The meter source is built at start(), so a grant that arrived while the
      // loop was running needs a restart to attach it — and a revocation needs
      // one to detach it, which matters far more. (`sensingCapture` also
      // re-checks the permission per window, so a revocation never produces an
      // acoustic feature even in the instant before this restart.)
      if (acousticCaptureAllowed(acoustic) !== before) stop();
      await start();
    })();
  });

  return {
    dispose() {
      disposed = true;
      stop();
      try {
        sub.remove();
      } catch {
        // A remove() that throws must not prevent the capture loop stopping.
      }
    },
  };
}
