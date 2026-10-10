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
 *   2. OD-MAP-6's THREE separate consents (services/sensingConsent.ts; server
 *      migration 3703), read from the server:
 *        capture  not in effect → nothing starts (no sensor is read);
 *        upload   not in effect → the loop may run ON THE DEVICE (the Compass
 *                 zone hint) but nothing is sent: every submit is dropped here,
 *                 and the server's session issuer refuses without it too;
 *        surface  is the server's business (session scopes), not this loop's.
 *      An unreadable consent stops everything — never "probably still on".
 *      The general Quick Signals consent grants nothing here (OD-MAP-6: "don't
 *      bundle it with general app consent").
 *   3. Acoustic: off unless the SEPARATE `sensing.acoustic.energy` grant AND
 *      the OS microphone permission are both held. Not asked for here.
 *
 * Consent is read at boot, on every app foreground, and whenever a switch in
 * Settings changes it (onSensingConsentChange), so a withdrawal stops capture
 * or sending at once rather than at the next launch.
 */
import { AppState, type AppStateStatus } from 'react-native';
import { freshToken } from '../apiToken.ts';
import { onSensingConsentChange, readSensingConsent } from '../sensingConsent.ts';
import { sensingCaptureDecision } from '../../lib/sensing/consentSplit.ts';
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
import { registerSensingZoneSource } from './sensingZoneHint.ts';
import { SECURE_KEYS, getSecure, setSecure } from '../../lib/secureStore.ts';
import { deviceCommitment, deviceSecretFromBytes } from '../../lib/sensing/commitment.ts';
import {
  ACOUSTIC_PERMISSION_DENIED,
  acousticCaptureAllowed,
  type AcousticPermission,
} from '../../lib/sensing/acousticPermission.ts';

export interface SensingCaptureInstallation {
  dispose(): void;
}

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

/**
 * The device secret behind every commitment. Read from SecureStore, minted
 * from 32 CSPRNG bytes the first time, and kept in memory for the process.
 *
 * REFUSES rather than degrades: without `crypto.getRandomValues` there is no
 * secret, `commitmentFor` answers null, and the transport sends nothing. A
 * secret from `Math.random` would be a guessable commitment, and a guessable
 * commitment lets anyone holding the table recognise this device's rows.
 * On web SecureStore is a no-op, so the secret lives for the process only —
 * which means a web session can contribute but cannot withdraw after a
 * reload; sensing capture is not expected to run there.
 */
let memorySecret: string | null = null;
export async function sensingDeviceSecret(): Promise<string | null> {
  if (memorySecret) return memorySecret;
  const stored = await getSecure(SECURE_KEYS.SENSING_DEVICE_SECRET);
  if (typeof stored === 'string' && stored.length >= 64) {
    memorySecret = stored;
    return stored;
  }
  const g = globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } };
  if (typeof g.crypto?.getRandomValues !== 'function') return null;
  const bytes = new Uint8Array(32);
  g.crypto.getRandomValues(bytes);
  const secret = deviceSecretFromBytes(bytes);
  await setSecure(SECURE_KEYS.SENSING_DEVICE_SECRET, secret);
  memorySecret = secret;
  return secret;
}

/** TEST SEAM: forget the in-memory secret so the next call re-reads storage. */
export function _resetSensingDeviceSecret(): void {
  memorySecret = null;
}

export function installSensingCapture(): SensingCaptureInstallation {
  let capture: SensingCaptureHandle | null = null;
  let disposed = false;
  let acoustic: AcousticPermission = ACOUSTIC_PERMISSION_DENIED;
  /** Whether the person's upload consent is in effect. Checked before EVERY send. */
  let uploadAllowed = false;

  const transport = createSensingTransport({
    baseUrl: apiBase(),
    getEligibilityToken: freshToken,
    commitmentFor: async (epoch) => {
      const secret = await sensingDeviceSecret();
      return secret ? deviceCommitment(secret, epoch) : null;
    },
    fetchImpl: (...args) => fetch(...args),
    now: () => Date.now(),
    sessionPath: process.env.EXPO_PUBLIC_SENSING_SESSION_PATH,
    ingestPath: process.env.EXPO_PUBLIC_SENSING_INGEST_PATH,
  });

  function stop(): void {
    capture?.stop();
    capture = null;
    // The Compass zone hint dies with the loop: no capture, no zone to name.
    registerSensingZoneSource(null);
  }

  async function start(): Promise<void> {
    if (disposed || capture) return;
    if (!apiBase()) return;
    const decision = sensingCaptureDecision(await readSensingConsent());
    uploadAllowed = decision.upload;
    if (!decision.capture) return;
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
        // OD-MAP-6: capture alone never sends anything off the phone.
        if (!uploadAllowed) return;
        await transport.submit(payload);
      },
    });
    // While this loop runs, a Compass turn may name the zone it is in
    // (services/sensing/sensingZoneHint; census-sensing §21.4 blocker #3).
    const running = capture;
    registerSensingZoneSource(() => running.currentZone());
  }

  void start();

  // Re-check consent on every foreground AND on every change made in Settings:
  // a withdrawal (here or on another device) must stop capture or sending, not
  // wait for a relaunch.
  async function recheck(): Promise<void> {
    const decision = apiBase() !== '' ? sensingCaptureDecision(await readSensingConsent()) : { capture: false, upload: false };
    uploadAllowed = decision.upload;
    if (!decision.upload) transport.reset();
    if (!decision.capture) {
      stop();
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
  }
  const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state !== 'active') return;
    void recheck();
  });
  const unsubscribeConsent = onSensingConsentChange(() => { if (!disposed) void recheck(); });

  return {
    dispose() {
      disposed = true;
      stop();
      unsubscribeConsent();
      try {
        sub.remove();
      } catch {
        // A remove() that throws must not prevent the capture loop stopping.
      }
    },
  };
}
