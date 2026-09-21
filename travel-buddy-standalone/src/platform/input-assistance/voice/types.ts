/**
 * Global Input Intelligence — voice intake vocabulary (census-wall W71).
 *
 * WHY THIS EXISTS (W71: "Voice input and typo normalization use the same global
 * engine"). The typo-normalization half of that row is proven end to end: a
 * misspelling typed into the Wall reaches the database already normalized by the
 * shared gateway, and the Wall owns no alias table of its own. The VOICE half had
 * no producer anywhere in the repository — nothing under this SDK mentioned
 * voice, speech or dictation.
 *
 * This file is the vocabulary for that missing half. It describes what a
 * speech-to-text engine HANDS US (a transcription result) and what a voice intake
 * can BE (its states) — deliberately without naming any provider, because the row
 * is about which engine handles the text, not about who produced the audio.
 *
 * Pure module — no React, no network, no RN, no capture library. node:test-safe.
 */

/**
 * One result from a speech-to-text engine.
 *
 * `confidence` is 0..1 as reported by the engine. `isFinal` distinguishes a
 * stabilised result from a live partial — a partial is for display only, and by
 * default never enters the assistance engine (see `voiceIntake.ts`). `language`
 * is the BCP-47 tag the engine recognised in, or null when it does not say.
 */
export interface TranscriptionResult {
  /** What the engine heard. RAW — normalization is the SHARED engine's job. */
  text: string;
  /** 0..1 engine-reported confidence. Anything not finite is treated as no confidence. */
  confidence: number;
  /** True once the engine has stabilised this result (not a live partial). */
  isFinal: boolean;
  /** BCP-47 tag (e.g. 'en-US'), or null/absent when the engine does not report one. */
  language?: string | null;
}

/**
 * The states a voice intake can be in.
 *
 * `unavailable` is EXPLICIT and first, because it is the state this app is
 * actually in today: no speech-to-text provider is installed (see
 * `transcriptionPort.ts`), and the honest answer to "can I dictate?" is "not on
 * this build" — never a fabricated transcript and never a silent no-op.
 */
export type VoiceIntakeState =
  | 'unavailable'
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'accepted'
  | 'refused'
  | 'error';

/** Enumeration of {@link VoiceIntakeState}, so a surface can exhaustively switch. */
export const VOICE_INTAKE_STATES: readonly VoiceIntakeState[] = [
  'unavailable',
  'idle',
  'listening',
  'transcribing',
  'accepted',
  'refused',
  'error',
] as const;

/**
 * Why a voice intake is unavailable. `no_provider` is the default state of this
 * build: the port exists, nothing is plugged into it.
 */
export type VoiceUnavailableReason =
  | 'no_provider'
  | 'permission_denied'
  | 'capture_failed'
  | 'provider_error';

/**
 * Why a transcript was REFUSED rather than passed to the shared engine.
 *
 * Refusing is the honest behaviour: a half-heard phrase is noise, and W71's
 * point is that the one engine gets real text, not that every microphone burp
 * gets a round trip.
 */
export type VoiceRefusalReason =
  | 'empty_transcript'
  | 'low_confidence'
  | 'interim_transcript'
  | 'no_policy';

/**
 * Minimum engine-reported confidence a transcript needs before it may enter the
 * shared assistance engine. A single auditable constant rather than a number
 * sprinkled through call sites; a surface may raise it per field, never silently
 * lower it to zero (a caller passing `minConfidence: 0` still cannot get an
 * empty transcript through).
 */
export const MIN_TRANSCRIPT_CONFIDENCE = 0.5;
