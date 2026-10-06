/**
 * Global Input Intelligence — the speech-to-text PORT (census-wall W71).
 *
 * WHY A PORT AND NOT A PROVIDER. W71 says voice input and typo normalization use
 * the same global engine. Which engine TRANSCRIBES the audio is a separate,
 * swappable decision (on-device OS recognition, a cloud API, nothing at all) and
 * it must not be able to fork the ASSISTANCE engine. So this module declares the
 * shape of a speech-to-text provider and a registry to install one at bootstrap —
 * and binds NO provider itself.
 *
 * THE DEFAULT IS "NOT AVAILABLE", AND IT IS HONEST. With nothing installed,
 * `resolveTranscriptionPort()` returns {@link NO_TRANSCRIPTION_PROVIDER}, whose
 * `isAvailable()` is false and whose `transcribe()` returns
 * `{ ok:false, unavailable:true, reason:'no_provider' }`. It NEVER returns a
 * fabricated, placeholder or echoed transcript. A stub that returned
 * `"hello world"` would make the census row look satisfied while the product did
 * nothing — the exact failure mode W71's `?` is recording.
 *
 * AUDIO CAPTURE IS INJECTED. `expo-av` is already a dependency and its
 * `Audio.Recording` can capture the clip, but importing it here would make this
 * module un-loadable under node:test and would bind a capture library into a
 * provider-independent layer. So capture is an interface ({@link AudioCapturePort})
 * that a device-side bootstrap implements with expo-av and passes in.
 *
 * Pure module — no React, no network, no RN. node:test-safe.
 */
import type { TranscriptionResult, VoiceUnavailableReason } from './types.ts';

/**
 * A captured audio clip handed to a provider. Either a file URI (what
 * `expo-av`'s `Audio.Recording.getURI()` yields) or in-memory bytes — providers
 * differ, and this layer refuses to care which.
 */
export interface CapturedAudio {
  uri?: string | null;
  bytes?: Uint8Array;
  /** e.g. 'audio/m4a', 'audio/wav'. */
  mimeType?: string | null;
  durationMs?: number | null;
  /** Sample rate in Hz, when the capture surface reports it. */
  sampleRate?: number | null;
}

/**
 * The microphone surface, INJECTED. The device build implements this with
 * `expo-av`'s `Audio.Recording`; tests implement it with an object literal.
 * Nothing in this directory ever imports a capture library.
 */
export interface AudioCapturePort {
  /** Begin recording. Should reject/throw only on a real failure. */
  start(): Promise<void>;
  /** Stop and return the clip, or null when nothing usable was captured. */
  stop(): Promise<CapturedAudio | null>;
  /** Abandon the recording without producing a clip. */
  cancel(): Promise<void>;
  /**
   * OD-INPUT-5 "don't retain raw audio by default": delete the clip's file (or
   * drop its bytes). Called after EVERY transcription, success or failure. A
   * capture surface without it is not used at all — the intake refuses before
   * the microphone opens, rather than record audio it cannot remove.
   */
  discard?(clip: CapturedAudio): Promise<void>;
}

/** What a provider is asked to transcribe. */
export interface TranscriptionRequest {
  audio: CapturedAudio;
  /** Preferred BCP-47 language, when the surface knows it. */
  language?: string | null;
}

/**
 * A provider's answer. Deliberately a result envelope rather than a throw, so an
 * unavailable or failing provider degrades the same way the suggest gateway
 * degrades (§38 fallback ladder) instead of collapsing the input surface.
 */
export type TranscriptionOutcome =
  | { ok: true; result: TranscriptionResult }
  | { ok: false; unavailable: boolean; reason: VoiceUnavailableReason; error: string };

/**
 * The PORT. A speech-to-text engine implements this; nothing in the repository
 * does yet, which is the remaining decision W71 names.
 */
export interface TranscriptionPort {
  /** Stable id for telemetry / debugging, e.g. 'ios-speech', 'whisper-cloud'. */
  readonly providerId: string;
  /**
   * WHERE the audio is processed. OD-INPUT-5: "Send audio to a cloud provider
   * only with separate, explicit consent." A port that does not declare
   * `'on_device'` is treated as cloud — fail closed.
   */
  readonly processing?: 'on_device' | 'cloud';
  /** Can this device transcribe right now (module present, permission granted)? */
  isAvailable(): Promise<boolean>;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionOutcome>;
}

/**
 * THE DEFAULT: no speech-to-text provider is installed in this app.
 *
 * It reports unavailable and produces NO transcript, ever. This is the truthful
 * encoding of the repository's actual state — no speech package is a dependency
 * — and it is what keeps a voice button from lying to a user (W71).
 */
export const NO_TRANSCRIPTION_PROVIDER: TranscriptionPort = {
  providerId: 'none',
  processing: 'on_device',
  async isAvailable(): Promise<boolean> {
    return false;
  },
  async transcribe(): Promise<TranscriptionOutcome> {
    return {
      ok: false,
      unavailable: true,
      reason: 'no_provider',
      error: 'No speech-to-text provider is installed on this build.',
    };
  },
};

// ── OD-INPUT-5: the cloud-audio consent, enforced INSIDE the port ─────────────
//
// "Use on-device operating-system speech recognition first. Send audio to a
// cloud provider only with separate, explicit consent; don't retain raw audio
// by default." No such consent exists in this build: the source below answers
// false until a consent flow is built and approved, and nothing here can make
// it answer true. It is consulted on EVERY transcription by a cloud port, by the
// guard every installed port is wrapped in — so installing a transcriber cannot
// bypass it, whoever calls `transcribe`.

let cloudConsentSource: () => boolean = () => false;

/** Bind the source of the cloud-audio consent (a future consent flow; tests). */
export function setCloudAudioConsentSource(source: (() => boolean) | null): void {
  cloudConsentSource = source ?? (() => false);
}

/** Has the person given the SEPARATE consent to send audio to a cloud provider? */
export function cloudAudioConsentGranted(): boolean {
  try {
    return cloudConsentSource() === true;
  } catch {
    return false;
  }
}

/** Does this port send audio off the device? Undeclared counts as yes. */
export function portSendsAudioOffDevice(port: TranscriptionPort): boolean {
  return port.processing !== 'on_device';
}

const CLOUD_CONSENT_REQUIRED: TranscriptionOutcome = {
  ok: false,
  unavailable: true,
  reason: 'cloud_consent_required',
  error: 'This voice option would send your recording to an online service, which needs your separate permission. Nothing was sent.',
};

/** The guard every installed port is wrapped in. */
function guardPort(port: TranscriptionPort): TranscriptionPort {
  return {
    providerId: port.providerId,
    processing: port.processing,
    isAvailable: () => port.isAvailable(),
    async transcribe(req) {
      if (portSendsAudioOffDevice(port) && !cloudAudioConsentGranted()) return CLOUD_CONSENT_REQUIRED;
      return port.transcribe(req);
    },
  };
}

/** Process-global installed provider (already guarded). One per app, set once at bootstrap. */
let installed: TranscriptionPort | null = null;

/**
 * Install the app's speech-to-text provider. Called once from the device-side
 * bootstrap when (and only when) a provider ships:
 *
 *   installTranscriptionPort(createOsSpeechPort())
 *
 * The port is WRAPPED in the OD-INPUT-5 guard, and the guarded port is what is
 * returned and resolved — there is no unguarded handle to call.
 */
export function installTranscriptionPort(port: TranscriptionPort): TranscriptionPort {
  installed = guardPort(port);
  return installed;
}

/** Remove the installed provider (tests, hot-reload hygiene, sign-out). */
export function clearTranscriptionPort(): void {
  installed = null;
}

/** The installed provider, or null when none has been installed. */
export function installedTranscriptionPort(): TranscriptionPort | null {
  return installed;
}

/**
 * The port to use: the installed provider, or the honest no-provider default.
 * Callers never branch on null — they get a port that tells the truth.
 */
export function resolveTranscriptionPort(): TranscriptionPort {
  return installed ?? NO_TRANSCRIPTION_PROVIDER;
}

/**
 * Can this build dictate? Never throws — a provider whose availability check
 * explodes is treated as unavailable, because the alternative is an input
 * surface that crashes on a microphone button.
 */
export async function isVoiceInputAvailable(port: TranscriptionPort = resolveTranscriptionPort()): Promise<boolean> {
  try {
    return (await port.isAvailable()) === true;
  } catch {
    return false;
  }
}
