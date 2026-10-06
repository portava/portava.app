/**
 * Global Input Intelligence — the PLATFORM speech recognizer seam (§25, census
 * G163; flow GII-F09).
 *
 * WHY A SECOND PORT BESIDE `transcriptionPort.ts`. That port is shaped for a
 * clip-based engine: capture audio, then hand the clip to a transcriber (a
 * cloud STT API). The platforms' own recognizers do not work that way — the
 * browser's `SpeechRecognition`, iOS `SFSpeechRecognizer` and Android
 * `SpeechRecognizer` own the microphone themselves and stream results. §25 says
 * speech-to-text is "an input transport, not a separate intelligence system",
 * so both shapes end in the SAME place: a `TranscriptionResult` handed to
 * `voiceIntake.ts`, whose request builder is the typed path's own.
 *
 * THE RULING THIS FOLLOWS. census-wall §13.2/§14.2 and the Compass/Wall
 * activation note: a new PAID speech service is prepared and priced for the
 * owner, never purchased, and the recommended route is the free platform
 * recognizer. So:
 *   - `createWebSpeechRecognizer` binds the platform API where the platform
 *     exposes one to JavaScript (web builds: `SpeechRecognition` /
 *     `webkitSpeechRecognition`). No dependency, no key, no spend.
 *   - `createNativeSpeechRecognizer` is the adapter for the native module the
 *     owner has not yet approved (`expo-speech-recognition`). It takes the
 *     module as an ARGUMENT and imports nothing, so this file loads today and
 *     the device build becomes one bootstrap line once the module ships.
 *   - With neither, `NO_SPEECH_RECOGNIZER` answers `unavailable/no_provider` —
 *     never a placeholder transcript.
 *
 * OD-INPUT-5, ENFORCED IN THE RESOLVER (2026-10-06, consolidated review). The
 * owner's rule — "use on-device operating-system speech recognition first; send
 * audio to a cloud provider only with separate, explicit consent" — is decided
 * HERE, once, by `resolveSpeechRecognizer`, so every surface that dictates
 * inherits it: the trip-destination button, the paste box, and anything added
 * later. The resolver returns a recognizer ONLY when that recognizer declares
 * `onDeviceOnly: true` (the guarantee that audio never leaves the device). It
 * never falls back to the browser's Web Speech API, whose default is remote
 * processing; `web-speech`, and any recognizer that declares nothing, resolve
 * to `NO_SPEECH_RECOGNIZER` — unavailable, said plainly, never a cloud engine.
 * The declaration is the same one the Wall's push-to-talk checks
 * (`isOnDeviceOnly`), so that check and this one can never disagree.
 *
 * THERE IS NO CLOUD PATH. A recognizer that may send audio away could be
 * returned only through a separate-consent path, and that path does not exist
 * yet: no function here returns an undeclared recognizer, and no consent flow
 * for it has been designed or approved. Building one is an owner decision.
 *
 * Pure module — no React, no RN import, no network. node:test-safe.
 */
import type { TranscriptionResult } from './types.ts';
import type { TranscriptionOutcome } from './transcriptionPort.ts';

export interface RecognizeOnceOptions {
  /** BCP-47 language, when the surface knows it. */
  language?: string | null;
  /** Abort = stop listening now; whatever was final so far is used. */
  signal?: AbortSignal;
  /** Live partials, for display only — they never enter the engine. */
  onPartial?: (r: TranscriptionResult) => void;
}

export interface SpeechRecognizerPort {
  /** 'web-speech', 'native-speech', 'none'. */
  readonly providerId: string;
  /**
   * The port's GUARANTEE that audio never leaves the device. Only the literal
   * `true` counts; absence means "may go to a server" (OD-INPUT-5). The
   * resolver returns no recognizer without it.
   */
  readonly onDeviceOnly?: true;
  isAvailable(): Promise<boolean>;
  /** Listen for one utterance. Resolves an outcome envelope; never throws. */
  recognizeOnce(opts?: RecognizeOnceOptions): Promise<TranscriptionOutcome>;
}

export const NO_SPEECH_RECOGNIZER: SpeechRecognizerPort = {
  providerId: 'none',
  async isAvailable() {
    return false;
  },
  async recognizeOnce(): Promise<TranscriptionOutcome> {
    return {
      ok: false,
      unavailable: true,
      reason: 'no_provider',
      error: 'This build has no on-device speech recognizer.',
    };
  },
};

let installed: SpeechRecognizerPort | null = null;

export function installSpeechRecognizer(port: SpeechRecognizerPort): SpeechRecognizerPort {
  installed = port;
  return port;
}

export function clearSpeechRecognizer(): void {
  installed = null;
}

/** Only an explicit, literal `onDeviceOnly: true` counts; absence is "may go to a server". */
export function declaresOnDeviceOnly(port: SpeechRecognizerPort): boolean {
  return (port as { onDeviceOnly?: unknown }).onDeviceOnly === true;
}

/**
 * The recognizer every dictating surface uses: the INSTALLED one, and only if
 * it declares on-device processing. Otherwise the honest none — and never the
 * platform's browser engine, which is not consulted at all (OD-INPUT-5; see the
 * file header). A cloud recognizer has no way through: the separate-consent
 * path it would need does not exist yet.
 */
export function resolveSpeechRecognizer(): SpeechRecognizerPort {
  return installed && declaresOnDeviceOnly(installed) ? installed : NO_SPEECH_RECOGNIZER;
}

// ── The web platform's own recognizer ──────────────────────────────────────

/** The slice of the Web Speech API this adapter uses. */
interface WebSpeechAlternative { transcript: string; confidence: number }
interface WebSpeechResult { isFinal: boolean; length: number; [i: number]: WebSpeechAlternative }
interface WebSpeechEvent { resultIndex: number; results: { length: number; [i: number]: WebSpeechResult } }
interface WebSpeechRecognition {
  /**
   * Web Speech API: "when set to true, indicates a requirement that the speech
   * recognition process MUST be performed locally on the user's device. If set
   * to false, the user agent can choose between local and remote processing.
   * The default value is false." (W3C CG draft, 18 Sep 2026, read 2026-10-05:
   * https://webaudio.github.io/web-speech-api/). Absent on engines that predate it.
   */
  processLocally?: boolean;
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: WebSpeechEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type WebAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type WebSpeechCtor = (new () => WebSpeechRecognition) & {
  /** Static, same spec: `available({ langs, processLocally })` → AvailabilityStatus. */
  available?: (options: { langs: string[]; processLocally?: boolean }) => Promise<WebAvailability>;
};

function defaultLanguage(scope: unknown): string {
  const nav = (scope as { navigator?: { language?: unknown } } | null)?.navigator;
  return typeof nav?.language === 'string' && nav.language ? nav.language : 'en-US';
}

/**
 * Can this engine recognise `lang` ON THE DEVICE right now? Only an explicit
 * "available" from the spec's own check counts. An engine without the check,
 * one that answers anything else ("downloadable" — the model is not installed;
 * "unavailable"), or one that throws, is NOT on-device — and therefore not used.
 */
async function webOnDeviceAvailable(Ctor: WebSpeechCtor, lang: string): Promise<boolean> {
  if (typeof Ctor.available !== 'function') return false;
  try {
    return (await Ctor.available({ langs: [lang], processLocally: true })) === 'available';
  } catch {
    return false;
  }
}

function webSpeechCtor(scope: unknown): WebSpeechCtor | null {
  if (!scope || typeof scope !== 'object') return null;
  const s = scope as Record<string, unknown>;
  const ctor = s.SpeechRecognition ?? s.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as WebSpeechCtor) : null;
}

/** Map a platform error name onto the intake's vocabulary. */
function reasonFor(code: string | undefined): 'permission_denied' | 'capture_failed' | 'provider_error' {
  if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'permission-denied') return 'permission_denied';
  if (code === 'audio-capture' || code === 'no-speech' || code === 'aborted') return 'capture_failed';
  return 'provider_error';
}

const ERROR_COPY: Record<'permission_denied' | 'capture_failed' | 'provider_error', string> = {
  permission_denied: 'Microphone or speech permission is off.',
  capture_failed: 'No speech was heard.',
  provider_error: 'Speech recognition stopped unexpectedly.',
};

/**
 * OD-INPUT-5 (docs/ops/owner-decisions-20261004.md): "Use on-device operating-
 * system speech recognition first. Send audio to a cloud provider only with
 * separate, explicit consent; don't retain raw audio by default."
 */
export const ON_DEVICE_UNAVAILABLE_COPY =
  'Voice input here needs on-device speech recognition, which isn’t available for this language on this device. ' +
  'Your voice is never sent to an online service without your permission.';

const ON_DEVICE_UNAVAILABLE: TranscriptionOutcome = {
  ok: false,
  unavailable: true,
  reason: 'on_device_unavailable',
  error: ON_DEVICE_UNAVAILABLE_COPY,
};

/**
 * The Web Speech API, where the platform exposes it. Null when it does not
 * (every native build today, and browsers without it) — so a caller can never
 * mistake "absent" for "available but silent".
 *
 * NOT RETURNED BY THE RESOLVER, and it declares no `onDeviceOnly`. Its own
 * checks below make a single session local when the engine says it can be,
 * but that is the browser vendor's promise, re-asked on every call — not a
 * guarantee this port can make. OD-INPUT-5 puts the operating system's own
 * recognizer first, so this adapter is reachable only by a caller that passes
 * it in by hand; no production surface does.
 */
export function createWebSpeechRecognizer(scope: unknown = globalThis): SpeechRecognizerPort | null {
  const Ctor = webSpeechCtor(scope);
  if (!Ctor) return null;
  return {
    providerId: 'web-speech',
    // OD-INPUT-5: a browser recognizer is used ONLY on the device. Without the
    // spec's `processLocally` + `available()` the user agent may send the audio
    // to a remote service, which needs a separate consent this build does not
    // ask for — so such an engine is reported unavailable, not used.
    async isAvailable() {
      return webOnDeviceAvailable(Ctor, defaultLanguage(scope));
    },
    async recognizeOnce(opts: RecognizeOnceOptions = {}): Promise<TranscriptionOutcome> {
      const lang = opts.language ?? defaultLanguage(scope);
      if (!(await webOnDeviceAvailable(Ctor, lang))) return ON_DEVICE_UNAVAILABLE;
      return new Promise((resolve) => {
        let rec: WebSpeechRecognition;
        try {
          rec = new Ctor();
        } catch {
          resolve({ ok: false, unavailable: true, reason: 'provider_error', error: ERROR_COPY.provider_error });
          return;
        }
        // An engine that does not HAVE the attribute cannot be told to process
        // locally — assigning it would only create a plain property the engine
        // never reads. (The earlier "read it back" check could not fail: a plain
        // assignment always reads back; verifier finding 7.) Such an engine is
        // not used.
        if (!('processLocally' in rec)) {
          resolve(ON_DEVICE_UNAVAILABLE);
          return;
        }
        rec.processLocally = true;
        let final: TranscriptionResult | null = null;
        let failure: string | undefined;
        let settled = false;
        const settle = (out: TranscriptionOutcome) => {
          if (settled) return;
          settled = true;
          opts.signal?.removeEventListener('abort', onAbort);
          resolve(out);
        };
        const onAbort = () => {
          try { rec.stop(); } catch { /* already stopped */ }
        };
        rec.lang = lang;
        rec.interimResults = !!opts.onPartial;
        rec.continuous = false;
        rec.maxAlternatives = 1;
        rec.onresult = (e) => {
          for (let i = e.resultIndex; i < e.results.length; i += 1) {
            const r = e.results[i];
            const alt = r?.[0];
            if (!r || !alt) continue;
            const out: TranscriptionResult = { text: alt.transcript, confidence: alt.confidence, isFinal: r.isFinal, language: opts.language ?? null };
            if (r.isFinal) final = out;
            else opts.onPartial?.(out);
          }
        };
        rec.onerror = (e) => { failure = e?.error ?? 'unknown'; };
        rec.onend = () => {
          if (final) settle({ ok: true, result: final });
          else {
            const reason = reasonFor(failure ?? 'no-speech');
            settle({ ok: false, unavailable: reason === 'permission_denied', reason, error: ERROR_COPY[reason] });
          }
        };
        opts.signal?.addEventListener('abort', onAbort);
        try {
          rec.start();
        } catch {
          settle({ ok: false, unavailable: true, reason: 'provider_error', error: ERROR_COPY.provider_error });
        }
      });
    },
  };
}

// ── The native module the owner has not yet approved ─────────────────────────

/**
 * The slice of `expo-speech-recognition`'s `ExpoSpeechRecognitionModule` this
 * adapter needs. Declared structurally so nothing here imports a package that
 * is not a dependency. When the owner approves it, the device bootstrap is:
 *
 *   import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
 *   installSpeechRecognizer(createNativeSpeechRecognizer(ExpoSpeechRecognitionModule));
 */
export interface NativeSpeechModuleLike {
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  isRecognitionAvailable(): boolean;
  /**
   * expo-speech-recognition: "Whether the device supports on-device speech
   * recognition." REQUIRED by OD-INPUT-5's posture: the module documents
   * `requiresOnDeviceRecognition` as "Prevent device from sending audio over
   * the network. Only enabled if the device supports it" — i.e. on a device
   * without on-device support the flag does NOT stop the network path. So the
   * adapter checks support itself and refuses, rather than trusting the flag.
   * (README read 2026-10-05: https://github.com/jamsch/expo-speech-recognition.)
   * Optional in the type only so an older module is REFUSED, not crashed on.
   */
  supportsOnDeviceRecognition?(): boolean;
  start(options: { lang?: string; interimResults?: boolean; continuous?: boolean; requiresOnDeviceRecognition?: boolean }): void;
  stop(): void;
  addListener(
    event: 'result' | 'error' | 'end',
    cb: (e: { isFinal?: boolean; results?: Array<{ transcript: string; confidence: number }>; error?: string }) => void,
  ): { remove(): void };
}

/**
 * `cloudConsentGranted` is the ONLY way audio may leave the device (OD-INPUT-5:
 * "only with separate, explicit consent"). No such consent exists in this build,
 * nothing passes `true`, and the default keeps recognition on the device.
 */
export interface NativeRecognizerConfig {
  cloudConsentGranted?: boolean;
}

export function createNativeSpeechRecognizer(
  mod: NativeSpeechModuleLike,
  config: NativeRecognizerConfig = {},
): SpeechRecognizerPort {
  const onDeviceOnly = config.cloudConsentGranted !== true;
  const onDeviceSupported = (): boolean => {
    try {
      return typeof mod.supportsOnDeviceRecognition === 'function' && mod.supportsOnDeviceRecognition() === true;
    } catch {
      return false;
    }
  };
  return {
    providerId: 'native-speech',
    // The guarantee the resolver requires — made only in the on-device-only
    // posture, which refuses (below) on a device that cannot recognise locally.
    // With `cloudConsentGranted`, audio may leave the device, so the port
    // declares nothing and the resolver will not return it.
    ...(onDeviceOnly ? { onDeviceOnly: true as const } : {}),
    async isAvailable() {
      try {
        return mod.isRecognitionAvailable() === true && (!onDeviceOnly || onDeviceSupported());
      } catch {
        return false;
      }
    },
    async recognizeOnce(opts: RecognizeOnceOptions = {}): Promise<TranscriptionOutcome> {
      // Checked BEFORE the microphone is asked for: a device that would send the
      // audio away is refused without a permission prompt.
      if (onDeviceOnly && !onDeviceSupported()) return ON_DEVICE_UNAVAILABLE;
      let perm: { granted: boolean };
      try {
        perm = await mod.requestPermissionsAsync();
      } catch {
        perm = { granted: false };
      }
      if (!perm.granted) return { ok: false, unavailable: true, reason: 'permission_denied', error: ERROR_COPY.permission_denied };
      return new Promise((resolve) => {
        let final: TranscriptionResult | null = null;
        let failure: string | undefined;
        const subs = [
          mod.addListener('result', (e) => {
            const alt = e.results?.[0];
            if (!alt) return;
            const out: TranscriptionResult = { text: alt.transcript, confidence: alt.confidence, isFinal: e.isFinal === true, language: opts.language ?? null };
            if (out.isFinal) final = out;
            else opts.onPartial?.(out);
          }),
          mod.addListener('error', (e) => { failure = e.error ?? 'unknown'; }),
          mod.addListener('end', () => {
            subs.forEach((s) => s.remove());
            opts.signal?.removeEventListener('abort', onAbort);
            if (final) resolve({ ok: true, result: final });
            else {
              const reason = reasonFor(failure ?? 'no-speech');
              resolve({ ok: false, unavailable: reason === 'permission_denied', reason, error: ERROR_COPY[reason] });
            }
          }),
        ];
        const onAbort = () => { try { mod.stop(); } catch { /* already stopped */ } };
        opts.signal?.addEventListener('abort', onAbort);
        try {
          // OD-INPUT-5: on the device, and NO `recordingOptions` — the module's
          // `persist` defaults to false, so no raw audio is written anywhere.
          mod.start({
            lang: opts.language ?? undefined,
            interimResults: !!opts.onPartial,
            continuous: false,
            requiresOnDeviceRecognition: onDeviceOnly,
          });
        } catch {
          subs.forEach((s) => s.remove());
          resolve({ ok: false, unavailable: true, reason: 'provider_error', error: ERROR_COPY.provider_error });
        }
      });
    },
  };
}
