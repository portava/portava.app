/**
 * Global Input Intelligence — voice intake, the seam that makes W71 true.
 *
 * census-wall W71: "Voice input and typo normalization use the same global
 * engine." The typo half is executed and under test at the Wall. This file is
 * the voice half's ONLY job: make a spoken phrase enter the SAME shared
 * assistance path a typed phrase enters, so it gets the same typo handling, the
 * same suggestions and the same policy — and can never become a second engine.
 *
 * HOW THE ROW IS SATISFIED, MECHANICALLY
 * --------------------------------------
 *   1. `assistanceRequestFor()` builds the request EXACTLY as the typed path
 *      builds it — `hooks/useInputAssistance.ts` sends
 *      `{ context: policy.context, fieldId, text: trimmed, limit:
 *      policy.maxSuggestions, sessionContext }`, resolved through the SAME
 *      `resolveFieldPolicy`. Spoken and typed text go through this one builder.
 *   2. The wire body is produced by the typed path's OWN `buildSuggestBody`.
 *      Nothing voice-shaped is added to it, so the gateway literally cannot tell
 *      a transcript from a keystroke — which is the property the Wall's side of
 *      this contract already pins from the other end.
 *   3. Text handling is the SHARED `normalizeDisplay` from
 *      `services/queryNormalization.ts`. There is NO normalizer in this
 *      directory, and a test scans the source to keep it that way. Typo
 *      correction itself stays where it already is: the server's normalizer and
 *      alias table, reached through the gateway.
 *   4. The default gateway entry point is the shared
 *      `services/inputAssistance.ts#requestSuggestions` — the same function the
 *      typed hook calls. It is reached through a dynamic import so this module
 *      stays pure and node-testable (that module pulls in the Supabase-backed
 *      token helper); tests inject their own submitter.
 *
 * WHAT IT REFUSES. An empty, half-heard (low confidence) or still-changing
 * (interim) transcript is refused rather than forwarded. Feeding microphone
 * noise into the engine would produce confident suggestions for something nobody
 * said, and W71 is not satisfied by volume of traffic.
 *
 * WHAT IT CARRIES. The accepted outcome says the text came from speech
 * (`source: 'speech'`, plus confidence/language) so a surface can show "you
 * said…" and offer a correction — OUT OF BAND, never in the request. Which
 * engine handles the text does not change.
 *
 * Pure module — no React, no network, no RN, no capture library. node:test-safe.
 */
import type { InputContext } from '../types/inputContext.ts';
import type {
  InputSessionContext,
  SuggestRequest,
  SuggestResult,
  WritingDraft,
} from '../types/inputSuggestion.ts';
import { resolveFieldPolicy } from '../contexts/fieldRegistry.ts';
// THE SHARED PIECES — imported, never re-implemented (W71).
import { normalizeDisplay } from '../services/queryNormalization.ts';
import { buildSuggestBody } from '../services/suggestBody.ts';
// Type-only: binds this seam to the real gateway's signature without importing
// the RN/Supabase token helper at module load (the value comes from the dynamic
// import in `sharedGatewaySubmit` below).
import type { requestSuggestions } from '../services/inputAssistance.ts';
import {
  MIN_TRANSCRIPT_CONFIDENCE,
  type TranscriptionResult,
  type VoiceRefusalReason,
  type VoiceUnavailableReason,
} from './types.ts';
import {
  NO_TRANSCRIPTION_PROVIDER,
  isVoiceInputAvailable,
  resolveTranscriptionPort,
  type AudioCapturePort,
  type TranscriptionPort,
} from './transcriptionPort.ts';

/** The shared gateway entry point's signature — the typed path's own function. */
export type SuggestSubmitter = typeof requestSuggestions;

/**
 * What a surface knows about the field it is dictating into. These are the same
 * inputs the typed path's hook takes, because the request they produce must be
 * the same request.
 */
export interface VoiceIntakeOptions {
  /** The field's registered id — the policy lookup key, same as the typed path. */
  fieldId: string;
  /** Fallback context when the field was not pre-registered (same as the hook). */
  context?: InputContext;
  /** Bounded task/session context forwarded to the gateway (§16, §41). */
  sessionContext?: InputSessionContext;
  /** Preferred BCP-47 recognition language, when the surface knows it. */
  language?: string | null;
  /** Raise the confidence floor for a field where a mishearing is expensive. */
  minConfidence?: number;
  /** Default true: only a stabilised transcript enters the engine. */
  requireFinal?: boolean;
  /** §22 opt-in, forwarded exactly as the typed path forwards it. */
  aiAssist?: boolean;
  city?: string | null;
  draft?: WritingDraft;
  tz?: string | null;
}

/** The outcome of turning a transcript into an assistance request. */
export type VoiceIntakeOutcome =
  | {
      state: 'accepted';
      /** IDENTICAL to what the typed path sends for the same text. */
      request: SuggestRequest;
      /** The wire body, from the typed path's own builder. */
      body: Record<string, unknown>;
      /** Out-of-band provenance — never part of the request. */
      source: 'speech';
      confidence: number;
      language: string | null;
      isFinal: boolean;
    }
  | { state: 'refused'; reason: VoiceRefusalReason; confidence: number }
  | { state: 'unavailable'; reason: VoiceUnavailableReason; error?: string };

/** The outcome of running a transcript through the shared gateway. */
export type VoiceSubmission =
  | {
      state: 'accepted';
      request: SuggestRequest;
      result: SuggestResult;
      source: 'speech';
      confidence: number;
      language: string | null;
    }
  | { state: 'refused'; reason: VoiceRefusalReason; confidence: number }
  | { state: 'unavailable'; reason: VoiceUnavailableReason; error?: string };

/** Injected collaborators, so this module stays pure and node-testable. */
export interface VoiceIntakeDeps {
  /** Defaults to the SHARED `requestSuggestions` — the typed path's entry point. */
  submit?: SuggestSubmitter;
  /** Defaults to the installed provider, or the honest no-provider port. */
  port?: TranscriptionPort;
  signal?: AbortSignal;
}

/**
 * Build the assistance request for a piece of text — spoken or typed.
 *
 * THE SINGLE BUILDER. It mirrors `hooks/useInputAssistance.ts` field for field
 * and resolves the policy through the same registry, so "the same global engine"
 * is a structural fact rather than a promise. Returns null when the field has no
 * resolvable policy (unregistered and no fallback context), because a
 * half-built request is worse than none.
 */
export function assistanceRequestFor(text: string, opts: VoiceIntakeOptions): SuggestRequest | null {
  const policy = resolveFieldPolicy(opts.fieldId, opts.context);
  if (!policy) return null;

  // SHARED text handling. A dictated phrase can arrive decomposed or with
  // doubled spaces; `normalizeDisplay` is the SDK's own display-safe pass (NFC +
  // whitespace + trim) and is what the typed path's trim is the ASCII case of.
  // Typo/alias correction is NOT done here and never will be — that belongs to
  // the server normalizer reached through the gateway (W71's proven half).
  const request: SuggestRequest = {
    context: policy.context,
    fieldId: opts.fieldId,
    text: normalizeDisplay(text),
    limit: policy.maxSuggestions,
    sessionContext: opts.sessionContext,
  };

  // §22 opt-in + §29 coarse context — forwarded only when opted in, exactly as
  // the typed hook forwards them.
  if (opts.aiAssist === true) {
    request.aiAssist = true;
    request.city = opts.city;
    request.draft = opts.draft;
    request.tz = opts.tz;
  }

  return request;
}

/** The confidence floor in force for this call (never below "must be finite"). */
function confidenceFloor(opts: VoiceIntakeOptions): number {
  const raw = opts.minConfidence;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw);
  return MIN_TRANSCRIPT_CONFIDENCE;
}

/**
 * Turn a transcription result into the SAME request the typed path would build
 * for the same words — or refuse it.
 *
 * Refusals come first and are honest about which one applied, so a surface can
 * say "I didn't catch that" (low confidence) rather than silently doing nothing.
 */
export function voiceIntakeRequest(
  transcript: TranscriptionResult,
  opts: VoiceIntakeOptions,
): VoiceIntakeOutcome {
  const confidence = typeof transcript?.confidence === 'number' ? transcript.confidence : Number.NaN;
  const spoken = typeof transcript?.text === 'string' ? transcript.text : '';

  // Nothing was said — never hand the engine an empty query.
  if (normalizeDisplay(spoken).length === 0) {
    return { state: 'refused', reason: 'empty_transcript', confidence };
  }

  // Half-heard — noise must not become a confident suggestion.
  if (!Number.isFinite(confidence) || confidence < confidenceFloor(opts)) {
    return { state: 'refused', reason: 'low_confidence', confidence };
  }

  // Still changing — a live partial is for display; only a stabilised result
  // enters the engine unless the surface explicitly asks otherwise.
  if (opts.requireFinal !== false && transcript.isFinal !== true) {
    return { state: 'refused', reason: 'interim_transcript', confidence };
  }

  const request = assistanceRequestFor(spoken, opts);
  if (!request) return { state: 'refused', reason: 'no_policy', confidence };

  return {
    state: 'accepted',
    request,
    body: buildSuggestBody(request),
    source: 'speech',
    confidence,
    language: transcript.language ?? null,
    isFinal: transcript.isFinal === true,
  };
}

/**
 * The default submitter: the SHARED gateway the typed path uses.
 *
 * Imported dynamically because `services/inputAssistance.ts` pulls in the
 * Supabase-backed token helper, which cannot load under node:test. The dynamic
 * form keeps this module pure while still making the shared entry point the
 * default — tests inject a recorder and never reach this line.
 */
async function sharedGatewaySubmit(req: SuggestRequest, signal?: AbortSignal): Promise<SuggestResult> {
  const mod = await import('../services/inputAssistance.ts');
  return mod.requestSuggestions(req, signal);
}

/**
 * Run a transcript through the shared assistance engine. Refusals never reach
 * the gateway.
 */
export async function submitVoiceIntake(
  transcript: TranscriptionResult,
  opts: VoiceIntakeOptions,
  deps: VoiceIntakeDeps = {},
): Promise<VoiceSubmission> {
  const intake = voiceIntakeRequest(transcript, opts);
  if (intake.state !== 'accepted') return intake;

  const submit = deps.submit ?? sharedGatewaySubmit;
  const result = await submit(intake.request, deps.signal);
  return {
    state: 'accepted',
    request: intake.request,
    result,
    source: 'speech',
    confidence: intake.confidence,
    language: intake.language,
  };
}

/**
 * The whole device flow: check availability, capture, transcribe, then enter the
 * SAME engine typed text enters.
 *
 * With no provider installed this returns `unavailable` BEFORE the microphone is
 * opened — the app does not record audio it has no way to transcribe, and the
 * user is told the truth instead of being handed a placeholder transcript (W71).
 */
export async function voiceIntakeFromCapture(
  capture: AudioCapturePort,
  opts: VoiceIntakeOptions,
  deps: VoiceIntakeDeps = {},
): Promise<VoiceSubmission> {
  const port = deps.port ?? resolveTranscriptionPort();

  if (!(await isVoiceInputAvailable(port))) {
    return {
      state: 'unavailable',
      reason: port.providerId === NO_TRANSCRIPTION_PROVIDER.providerId ? 'no_provider' : 'provider_error',
      error: `Speech-to-text is not available (provider: ${port.providerId}).`,
    };
  }

  let audio;
  try {
    await capture.start();
    audio = await capture.stop();
  } catch {
    try {
      await capture.cancel();
    } catch {
      // Cancelling a failed capture must not mask the original failure.
    }
    return { state: 'unavailable', reason: 'capture_failed', error: 'Recording failed.' };
  }
  if (!audio) return { state: 'unavailable', reason: 'capture_failed', error: 'No audio was captured.' };

  const outcome = await port.transcribe({ audio, language: opts.language ?? null });
  if (!outcome.ok) {
    return { state: 'unavailable', reason: outcome.reason, error: outcome.error };
  }

  return submitVoiceIntake(outcome.result, opts, deps);
}
