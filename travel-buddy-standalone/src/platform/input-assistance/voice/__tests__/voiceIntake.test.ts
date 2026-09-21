/**
 * census-wall W71 — "Voice input and typo normalization use the same global engine."
 *
 * WHAT THIS PROVES. The typo half of W71 is already executed end to end (a
 * misspelling typed into the Wall reaches the database typo-normalized through
 * the shared gateway). The voice half had NO PRODUCER anywhere in the
 * repository. These tests pin the half that is provider-independent: that a
 * SPOKEN phrase enters the SAME shared assistance path a TYPED phrase enters —
 * one engine, not two — and that with no speech provider installed the answer is
 * honest unavailability rather than a fabricated transcript.
 *
 * TEST-FIRST. Every test in this file was written and RUN BEFORE
 * `types.ts` / `transcriptionPort.ts` / `voiceIntake.ts` existed. The first run
 * failed with `ERR_MODULE_NOT_FOUND: .../voice/voiceIntake.ts` — the right
 * reason (the seam did not exist), not an assertion mistake. Implementation
 * followed and turned it green.
 *
 * MUTATION LOG (each mutation applied ALONE to the source, whole suite re-run,
 * source restored before the next one). THREE CAME BACK GREEN ON THE FIRST PASS
 * and are recorded as they happened — the suite was then strengthened and they
 * were re-run:
 *   M1  voiceIntake.ts: build the request with `text: transcript.text` (skip the
 *       SHARED normalizeDisplay) so a dictated transcript is shaped by its own
 *       path                            → GREEN, then red after the fix below
 *       WHY GREEN: every fixture was plain ASCII, where the shared pass and a
 *       bare trim agree. Fixed by the decomposed-diacritics + doubled-whitespace
 *       case in "the transcript text is shaped by the SHARED normalizer".
 *   M2  voiceIntake.ts: `limit: 8` hardcoded instead of `policy.maxSuggestions`
 *       (a second, voice-only policy)   → GREEN, then red after the fix below
 *       WHY GREEN: the only field under test used the default maxSuggestions,
 *       which IS 8. Fixed by "the request obeys the FIELD POLICY", which
 *       registers a field capped at 3.
 *   M3  voiceIntake.ts: accept an empty transcript (drop the empty check) → red
 *   M4  voiceIntake.ts: drop the confidence floor (accept any confidence) → red
 *   M5  voiceIntake.ts: put `source:'speech'` INTO the wire body, so the engine
 *       could branch on where the text came from
 *                                       → GREEN, then red after the fix below
 *       WHY GREEN: the assertion rebuilt the body with `buildSuggestBody(...)`
 *       instead of reading the body the intake produced, so an extra key was
 *       invisible. Fixed by asserting on `outcome.body` itself.
 *   M6  transcriptionPort.ts: make the default no-provider port return
 *       `{ ok:true, result:{ text:'hello', confidence:1, isFinal:true } }`
 *       (a fabricated placeholder transcript)                           → red
 *   M7  transcriptionPort.ts: `isAvailable()` returns true with no provider
 *       installed                                                       → red
 *   M8  voiceIntake.ts: add a local `function normalizeTranscript()` doing its
 *       own NFKD + diacritic strip (a second normalizer)                → red
 *   M9  voiceIntake.ts: forward an interim (isFinal:false) transcript to the
 *       gateway                                                         → red
 *   M10 voiceIntake.ts: on unavailable, still call `submit` with an empty text → red
 *
 * Pure: node:test only — no React, no network, no RN, no expo-av.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InputSessionContext, SuggestRequest, SuggestResult } from '../../types/inputSuggestion.ts';
import { registerField, resolveFieldPolicy, unregisterField } from '../../contexts/fieldRegistry.ts';
import { buildSuggestBody } from '../../services/suggestBody.ts';
import { normalizeDisplay } from '../../services/queryNormalization.ts';

import { MIN_TRANSCRIPT_CONFIDENCE, VOICE_INTAKE_STATES } from '../types.ts';
import type { TranscriptionResult } from '../types.ts';
import {
  NO_TRANSCRIPTION_PROVIDER,
  clearTranscriptionPort,
  installTranscriptionPort,
  installedTranscriptionPort,
  isVoiceInputAvailable,
  resolveTranscriptionPort,
  type AudioCapturePort,
  type CapturedAudio,
  type TranscriptionPort,
} from '../transcriptionPort.ts';
import {
  assistanceRequestFor,
  submitVoiceIntake,
  voiceIntakeFromCapture,
  voiceIntakeRequest,
} from '../voiceIntake.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────

// Deliberately NOT named "voice.*": the wire-body assertion below proves the
// request carries no voice-shaped marker, and a fieldId containing the word
// would make that assertion meaningless.
const FIELD = 'w71.test.search';
const CONTEXT = 'global_search' as const;
const SESSION: InputSessionContext = { cityId: 'city_bkk', surface: 'wall' };
const SPOKEN = 'bangkok street food';

function transcript(overrides: Partial<TranscriptionResult> = {}): TranscriptionResult {
  return { text: SPOKEN, confidence: 0.94, isFinal: true, language: 'en-US', ...overrides };
}

function opts() {
  return { fieldId: FIELD, context: CONTEXT, sessionContext: SESSION };
}

/**
 * The request the TYPED path sends, constructed here the way
 * `hooks/useInputAssistance.ts` constructs it: the resolved policy's context,
 * the fieldId, the trimmed text, the policy's own maxSuggestions, and the
 * session context. Built from the typed path's OWN functions
 * (`resolveFieldPolicy`, `buildSuggestBody`) so the equality below is a claim
 * about the shared engine, not about a constant copied into this file.
 */
function typedRequestByHand(text: string): SuggestRequest {
  const policy = resolveFieldPolicy(FIELD, CONTEXT);
  assert.ok(policy, 'the typed path must resolve a policy for this field');
  return {
    context: policy.context,
    fieldId: FIELD,
    text: text.trim(),
    limit: policy.maxSuggestions,
    sessionContext: SESSION,
  };
}

/** A submit recorder standing in for the shared gateway entry point. */
function recorder() {
  const calls: { req: SuggestRequest }[] = [];
  const submit = async (req: SuggestRequest): Promise<SuggestResult> => {
    calls.push({ req });
    return { ok: true, requestId: 'req_1', policyVersion: 'v1', suggestions: [] };
  };
  return { calls, submit };
}

function fakePort(result: TranscriptionResult): TranscriptionPort {
  return {
    providerId: 'fake',
    isAvailable: async () => true,
    transcribe: async () => ({ ok: true, result }),
  };
}

function fakeCapture(): AudioCapturePort & { started: number; stopped: number } {
  const audio: CapturedAudio = { uri: 'file:///tmp/clip.m4a', mimeType: 'audio/m4a', durationMs: 1200 };
  const cap = {
    started: 0,
    stopped: 0,
    async start() {
      cap.started += 1;
    },
    async stop() {
      cap.stopped += 1;
      return audio;
    },
    async cancel() {},
  };
  return cap;
}

// ── THE ROW'S ACTUAL CLAIM ───────────────────────────────────────────────────

test('W71: a transcript produces the SAME request + body as the identical text typed by hand', () => {
  const spoken = voiceIntakeRequest(transcript(), opts());
  assert.equal(spoken.state, 'accepted');
  if (spoken.state !== 'accepted') return;

  const typed = typedRequestByHand(SPOKEN);

  // ONE engine: the spoken request IS the typed request.
  assert.deepEqual(spoken.request, typed);

  // And byte-for-byte the same wire body. `spoken.body` is the body the intake
  // itself produced — asserting on a recomputed one would let the intake smuggle
  // extra keys onto the wire unnoticed.
  assert.deepEqual(spoken.body, buildSuggestBody(typed));

  // Nothing voice-specific reaches the wire — the engine cannot tell the
  // difference, which is exactly what "the same global engine" means.
  const wire = JSON.stringify(spoken.body).toLowerCase();
  for (const word of ['voice', 'speech', 'transcript', 'confidence', 'audio']) {
    assert.equal(wire.includes(word), false, `the wire body must not carry "${word}": ${wire}`);
  }
});

test('W71: the shared builder is the ONE builder — typed text and spoken text agree', () => {
  const viaBuilder = assistanceRequestFor(SPOKEN, opts());
  const spoken = voiceIntakeRequest(transcript(), opts());
  assert.equal(spoken.state, 'accepted');
  if (spoken.state !== 'accepted') return;
  assert.deepEqual(spoken.request, viaBuilder);
  assert.deepEqual(viaBuilder, typedRequestByHand(SPOKEN));
});

test('W71: the transcript text is shaped by the SHARED normalizer, not a voice-local one', () => {
  // A dictated phrase arrives decomposed and with doubled whitespace. The one
  // correct answer is the SDK's own `normalizeDisplay` — the same display-safe
  // pass the typed path's trim is the ASCII case of. If voice ever grows its own
  // text handling, this diverges.
  const raw = '  Đà  Nãng \n';
  const spoken = voiceIntakeRequest(transcript({ text: raw }), opts());
  assert.equal(spoken.state, 'accepted');
  if (spoken.state !== 'accepted') return;
  assert.equal(spoken.request.text, normalizeDisplay(raw));
  assert.notEqual(spoken.request.text, raw.trim(), 'the fixture must actually require the shared pass');
});

test('W71: the request obeys the FIELD POLICY, not a voice-local default', () => {
  // A field whose policy differs from the defaults: a voice-only constant would
  // silently serve the wrong cap (and a different engine's behaviour).
  const id = 'w71.test.capped';
  const policy = registerField(id, 'city_picker', { maxSuggestions: 3 });
  try {
    const spoken = voiceIntakeRequest(transcript(), { fieldId: id, sessionContext: SESSION });
    assert.equal(spoken.state, 'accepted');
    if (spoken.state !== 'accepted') return;
    assert.equal(policy.maxSuggestions, 3);
    assert.equal(spoken.request.limit, policy.maxSuggestions);
    assert.equal(spoken.request.context, policy.context);
  } finally {
    unregisterField(id);
  }
});

test('the typed shape mirrored here is the shape the hook actually sends (source fence)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const hook = readFileSync(join(here, '..', '..', 'hooks', 'useInputAssistance.ts'), 'utf8');
  // If the typed path's request shape changes, this fence fails and the
  // equality test above stops being a claim about the real engine.
  for (const frag of ['context: policy.context', 'text: trimmed', 'limit: policy.maxSuggestions', 'sessionContext,']) {
    assert.ok(hook.includes(frag), `useInputAssistance must still send \`${frag}\``);
  }
  assert.ok(hook.includes('requestSuggestions('), 'the typed path must still route through requestSuggestions');
});

test('speech origin is carried OUT OF BAND — it never changes which engine handles the text', () => {
  const spoken = voiceIntakeRequest(transcript(), opts());
  assert.equal(spoken.state, 'accepted');
  if (spoken.state !== 'accepted') return;
  // The surface can show "you said this" …
  assert.equal(spoken.source, 'speech');
  assert.equal(spoken.confidence, 0.94);
  assert.equal(spoken.language, 'en-US');
  // … while the request itself carries only the typed path's keys.
  assert.deepEqual(Object.keys(spoken.request).sort(), ['context', 'fieldId', 'limit', 'sessionContext', 'text']);
});

// ── NO PROVIDER → HONEST UNAVAILABILITY, NEVER A TRANSCRIPT ──────────────────

test('the default port reports unavailable and NEVER returns a transcript', async () => {
  clearTranscriptionPort();
  assert.equal(installedTranscriptionPort(), null);
  assert.equal(resolveTranscriptionPort().providerId, NO_TRANSCRIPTION_PROVIDER.providerId);
  assert.equal(await isVoiceInputAvailable(), false);
  assert.equal(await NO_TRANSCRIPTION_PROVIDER.isAvailable(), false);

  const outcome = await NO_TRANSCRIPTION_PROVIDER.transcribe({ audio: { uri: 'file:///tmp/clip.m4a' } });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.unavailable, true);
  assert.equal(outcome.reason, 'no_provider');
  // No fabricated / placeholder text anywhere in the outcome.
  assert.equal(JSON.stringify(outcome).includes('"text"'), false, 'an unavailable port must produce no transcript');

  assert.ok(VOICE_INTAKE_STATES.includes('unavailable'), 'UNAVAILABLE must be an explicit state');
});

test('with no provider installed, intake is unavailable and nothing reaches the gateway', async () => {
  clearTranscriptionPort();
  const rec = recorder();
  const capture = fakeCapture();

  const outcome = await voiceIntakeFromCapture(capture, opts(), { submit: rec.submit });

  assert.equal(outcome.state, 'unavailable');
  if (outcome.state !== 'unavailable') return;
  assert.equal(outcome.reason, 'no_provider');
  assert.equal(rec.calls.length, 0, 'an unavailable intake must never call the gateway');
  assert.equal(capture.started, 0, 'an unavailable intake must not even open the microphone');
  assert.equal(JSON.stringify(outcome).includes('"text"'), false);
});

test('an INSTALLED provider transcribes and its text reaches the SAME gateway entry point', async () => {
  installTranscriptionPort(fakePort(transcript()));
  try {
    const rec = recorder();
    const capture = fakeCapture();
    const outcome = await voiceIntakeFromCapture(capture, opts(), { submit: rec.submit });

    assert.equal(outcome.state, 'accepted');
    assert.equal(capture.started, 1);
    assert.equal(capture.stopped, 1);
    assert.equal(rec.calls.length, 1, 'the transcript must be submitted exactly once');
    // THE ROW: what the gateway received is the typed path's request.
    assert.deepEqual(rec.calls[0].req, typedRequestByHand(SPOKEN));
    assert.deepEqual(buildSuggestBody(rec.calls[0].req), buildSuggestBody(typedRequestByHand(SPOKEN)));
  } finally {
    clearTranscriptionPort();
  }
});

// ── REFUSALS: NOISE NEVER ENTERS THE ENGINE ──────────────────────────────────

test('an empty or whitespace-only transcript is refused, not forwarded', async () => {
  for (const text of ['', '   ', '\n\t ']) {
    const outcome = voiceIntakeRequest(transcript({ text }), opts());
    assert.equal(outcome.state, 'refused', `"${text}" must be refused`);
    if (outcome.state !== 'refused') continue;
    assert.equal(outcome.reason, 'empty_transcript');
  }

  const rec = recorder();
  const res = await submitVoiceIntake(transcript({ text: '  ' }), opts(), { submit: rec.submit });
  assert.equal(res.state, 'refused');
  assert.equal(rec.calls.length, 0, 'an empty transcript must never reach the gateway');
});

test('a low-confidence transcript is refused, not forwarded', async () => {
  const low = voiceIntakeRequest(transcript({ confidence: 0.2 }), opts());
  assert.equal(low.state, 'refused');
  if (low.state === 'refused') assert.equal(low.reason, 'low_confidence');

  // The floor is a real threshold, not a formality.
  assert.ok(MIN_TRANSCRIPT_CONFIDENCE > 0 && MIN_TRANSCRIPT_CONFIDENCE < 1);
  assert.equal(voiceIntakeRequest(transcript({ confidence: MIN_TRANSCRIPT_CONFIDENCE }), opts()).state, 'accepted');
  assert.equal(
    voiceIntakeRequest(transcript({ confidence: MIN_TRANSCRIPT_CONFIDENCE - 0.01 }), opts()).state,
    'refused',
  );
  // A non-numeric / NaN confidence is not a pass.
  assert.equal(voiceIntakeRequest(transcript({ confidence: Number.NaN }), opts()).state, 'refused');

  const rec = recorder();
  const res = await submitVoiceIntake(transcript({ confidence: 0.1 }), opts(), { submit: rec.submit });
  assert.equal(res.state, 'refused');
  assert.equal(rec.calls.length, 0, 'a low-confidence transcript must never reach the gateway');
});

test('an interim (non-final) transcript is not forwarded by default', async () => {
  const interim = voiceIntakeRequest(transcript({ isFinal: false }), opts());
  assert.equal(interim.state, 'refused');
  if (interim.state === 'refused') assert.equal(interim.reason, 'interim_transcript');

  // A surface that wants live partials must ask for them explicitly.
  const explicit = voiceIntakeRequest(transcript({ isFinal: false }), { ...opts(), requireFinal: false });
  assert.equal(explicit.state, 'accepted');

  const rec = recorder();
  await submitVoiceIntake(transcript({ isFinal: false }), opts(), { submit: rec.submit });
  assert.equal(rec.calls.length, 0);
});

test('an unregistered field with no context degrades to refused, never to a half-built request', () => {
  const outcome = voiceIntakeRequest(transcript(), { fieldId: 'voice.test.unknown.field' });
  assert.equal(outcome.state, 'refused');
  if (outcome.state === 'refused') assert.equal(outcome.reason, 'no_policy');
});

// ── STRUCTURAL: NO SECOND NORMALIZER LIVES HERE ──────────────────────────────

test('this directory contains NO second normalizer — it imports the shared one', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const voiceDir = join(here, '..');
  const sources = readdirSync(voiceDir)
    .filter((n) => n.endsWith('.ts'))
    .map((n) => ({ name: n, src: readFileSync(join(voiceDir, n), 'utf8') }));

  assert.ok(sources.length >= 3, `expected the voice sources to be scanned, found ${sources.length}`);

  // A locally DEFINED fold/normalize function would be a second engine.
  const definesOwn = /(?:function\s+|const\s+|let\s+|var\s+)[A-Za-z0-9_]*(?:fold|normali[sz]e)[A-Za-z0-9_]*\s*(?:\(|=|:)/i;
  // The shared normalizer's own machinery must not be reproduced here.
  const machinery = [/\bNFKD\b/, /\bNFC\b/, /\\u0300/, /̀-ͯ/, /ALIASES/, /\.normalize\(/];

  for (const { name, src } of sources) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(definesOwn.test(code), false, `${name} defines its own normalizer — W71 requires ONE engine`);
    for (const re of machinery) {
      assert.equal(re.test(code), false, `${name} reproduces shared normalizer machinery (${re}) — import it instead`);
    }
  }

  const intake = sources.find((s) => s.name === 'voiceIntake.ts');
  assert.ok(intake, 'voiceIntake.ts must exist');
  assert.ok(
    intake.src.includes("from '../services/queryNormalization.ts'"),
    'voiceIntake.ts must import the SHARED normalizer',
  );
  assert.ok(
    intake.src.includes("from '../services/suggestBody.ts'"),
    'voiceIntake.ts must import the SHARED request-body builder',
  );
  assert.ok(
    intake.src.includes('../services/inputAssistance.ts'),
    'voiceIntake.ts must default to the SHARED gateway entry point',
  );
  // No provider is bound into this layer (the port is provider-independent).
  for (const { name, src } of sources) {
    assert.equal(/expo-av|expo-speech|react-native-voice|googleapis|deepgram/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false,
      `${name} must not bind a provider or a capture library`);
  }
});
