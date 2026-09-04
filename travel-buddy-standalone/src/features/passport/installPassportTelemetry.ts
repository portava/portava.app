/**
 * installPassportTelemetry — binds the §32 Passport telemetry seam to the real
 * transport at app boot.
 *
 * `passportTelemetry.ts` defaults to a dev-log sink, so every `track*` call
 * made before this runs is harmless but goes nowhere. The root layout mounts a
 * `PassportTelemetrySetup` component (app/_layout.tsx) that calls `install`
 * once; from then on the seam's events are queued, batched and POSTed by
 * `passportTelemetryTransport.ts` with the app's authenticated fetch.
 *
 * Kept separate from the transport so the boot wiring — sink installed,
 * AppState subscribed, dispose reverses both — is testable without rendering
 * the root layout, and so app/_layout.tsx stays a one-line call.
 */
import {
  setPassportTelemetrySink,
  resetPassportTelemetrySink,
} from './passportTelemetry.ts';
import {
  createPassportTelemetryTransport,
  type PassportTelemetryTransport,
  type PassportTelemetryTransportOptions,
} from './passportTelemetryTransport.ts';

/** The subset of React Native's AppState this module needs (injectable). */
export interface AppStateLike {
  addEventListener: (
    type: 'change',
    handler: (state: string) => void,
  ) => { remove: () => void };
}

export interface InstallPassportTelemetryOptions extends PassportTelemetryTransportOptions {
  /** React Native `AppState` (or a test double). Optional — web has no lifecycle here. */
  appState?: AppStateLike | null;
}

export interface PassportTelemetryHandle {
  transport: PassportTelemetryTransport;
  /** Flush what is queued, unsubscribe AppState and restore the default sink. */
  dispose: () => void;
}

let current: PassportTelemetryHandle | null = null;

/**
 * Install (idempotent — a second call while one is live returns the live
 * handle, so a re-mounting root layout cannot double-subscribe or lose events).
 */
export function installPassportTelemetry(opts: InstallPassportTelemetryOptions): PassportTelemetryHandle {
  if (current) return current;

  const transport = createPassportTelemetryTransport(opts);
  setPassportTelemetrySink(transport.sink);

  let sub: { remove: () => void } | null = null;
  try {
    sub = opts.appState?.addEventListener('change', transport.notifyAppStateChange) ?? null;
  } catch {
    sub = null;
  }

  const handle: PassportTelemetryHandle = {
    transport,
    dispose: () => {
      if (current !== handle) return;
      current = null;
      try { sub?.remove(); } catch { /* never throw */ }
      // Last chance to send what is queued, then stop accepting.
      void transport.flush().finally(() => transport.dispose());
      resetPassportTelemetrySink();
    },
  };
  current = handle;
  return handle;
}

/** The live handle, or null when nothing is installed (tests / diagnostics). */
export function currentPassportTelemetry(): PassportTelemetryHandle | null {
  return current;
}
