/**
 * §25 Voice and Dictation — the platform recognizer seam (GII-F09, census
 * G163). Pure; node:test.
 *
 * Proves:
 *   - with no platform recognizer the answer is `unavailable/no_provider`, and
 *     it is reached BEFORE anything asks for the microphone;
 *   - the web platform's own `SpeechRecognition` is bound when present, its
 *     final transcript enters the SAME intake typed text uses
 *     (`assistanceRequestFor`), and its partials never do;
 *   - a permission refusal, silence and a low-confidence result are three
 *     different, honest outcomes;
 *   - the native-module adapter keeps audio on the device by default and maps
 *     the module's events the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_SPEECH_RECOGNIZER,
  clearSpeechRecognizer,
  createNativeSpeechRecognizer,
  createWebSpeechRecognizer,
  installSpeechRecognizer,
  resolveSpeechRecognizer,
  type NativeSpeechModuleLike,
} from '../speechRecognizer.ts';
import { assistanceRequestFor, dictateIntoField } from '../voiceIntake.ts';

type Script = { results?: Array<{ text: string; confidence: number; isFinal: boolean }>; error?: string };

/** A stand-in for the browser's SpeechRecognition that plays a script. */
function fakeWebScope(script: Script, log: string[] = []) {
  class FakeRecognition {
    lang = '';
    interimResults = false;
    continuous = true;
    maxAlternatives = 5;
    onresult: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      log.push(`start lang=${this.lang} interim=${this.interimResults}`);
      queueMicrotask(() => {
        (script.results ?? []).forEach((r, i) => {
          const results: any = { length: i + 1 };
          results[i] = Object.assign([{ transcript: r.text, confidence: r.confidence }], { isFinal: r.isFinal, length: 1 });
          this.onresult?.({ resultIndex: i, results });
        });
        if (script.error) this.onerror?.({ error: script.error });
        this.onend?.();
      });
    }
    stop() { log.push('stop'); }
    abort() { log.push('abort'); }
  }
  return { webkitSpeechRecognition: FakeRecognition };
}

const FIELD = { fieldId: 'trip.destination', context: 'trip_destination' as const };

test('no platform recognizer → unavailable/no_provider, before the microphone is asked for', async () => {
  clearSpeechRecognizer();
  assert.equal(createWebSpeechRecognizer({}), null, 'absent is null, not a silent recognizer');
  assert.equal(resolveSpeechRecognizer({}), NO_SPEECH_RECOGNIZER);
  let asked = false;
  const spy = { ...NO_SPEECH_RECOGNIZER, recognizeOnce: async () => { asked = true; return NO_SPEECH_RECOGNIZER.recognizeOnce(); } };
  const out = await dictateIntoField(FIELD, { recognizer: spy });
  assert.equal(out.state, 'unavailable');
  assert.equal(out.state === 'unavailable' && out.reason, 'no_provider');
  assert.equal(asked, false, 'an unavailable recognizer is never asked to listen');
});

test('the web platform recognizer feeds the SAME intake the typed path uses; partials never enter it', async () => {
  const log: string[] = [];
  const partials: string[] = [];
  const rec = createWebSpeechRecognizer(fakeWebScope({
    results: [
      { text: 'hoi', confidence: 0.4, isFinal: false },
      { text: '  Hoi   An ', confidence: 0.92, isFinal: true },
    ],
  }, log));
  assert.ok(rec);
  assert.equal(rec.providerId, 'web-speech');
  const out = await dictateIntoField({ ...FIELD, language: 'en-US' }, { recognizer: rec, onPartial: (r) => partials.push(r.text) });
  assert.equal(out.state, 'accepted');
  if (out.state !== 'accepted') return;
  assert.deepEqual(out.request, assistanceRequestFor('  Hoi   An ', FIELD), 'dictated text becomes exactly the typed request');
  assert.equal(out.request.text, 'Hoi An');
  assert.deepEqual(partials, ['hoi']);
  assert.deepEqual(log, ['start lang=en-US interim=true']);
});

test('permission refused, silence and a mumble are three different honest outcomes', async () => {
  const denied = await dictateIntoField(FIELD, { recognizer: createWebSpeechRecognizer(fakeWebScope({ error: 'not-allowed' }))! });
  assert.deepEqual([denied.state, denied.state === 'unavailable' && denied.reason], ['unavailable', 'permission_denied']);
  const silence = await dictateIntoField(FIELD, { recognizer: createWebSpeechRecognizer(fakeWebScope({ error: 'no-speech' }))! });
  assert.deepEqual([silence.state, silence.state === 'unavailable' && silence.reason], ['unavailable', 'capture_failed']);
  const mumble = await dictateIntoField(FIELD, {
    recognizer: createWebSpeechRecognizer(fakeWebScope({ results: [{ text: 'hoy an', confidence: 0.2, isFinal: true }] }))!,
  });
  assert.deepEqual([mumble.state, mumble.state === 'refused' && mumble.reason], ['refused', 'low_confidence']);
});

test('an installed recognizer wins over the platform default', () => {
  const mine = { ...NO_SPEECH_RECOGNIZER, providerId: 'installed' };
  installSpeechRecognizer(mine);
  assert.equal(resolveSpeechRecognizer(fakeWebScope({})), mine);
  clearSpeechRecognizer();
  assert.equal(resolveSpeechRecognizer(fakeWebScope({})).providerId, 'web-speech');
});

test('the native-module adapter keeps audio on the device and maps events the same way', async () => {
  const listeners: Record<string, (e: any) => void> = {};
  let started: any = null;
  const mod: NativeSpeechModuleLike = {
    requestPermissionsAsync: async () => ({ granted: true }),
    isRecognitionAvailable: () => true,
    start(options) {
      started = options;
      queueMicrotask(() => {
        listeners.result?.({ isFinal: true, results: [{ transcript: 'Da Nang', confidence: 0.9 }] });
        listeners.end?.({});
      });
    },
    stop() {},
    addListener(event, cb) { listeners[event] = cb; return { remove() { delete listeners[event]; } }; },
  };
  const out = await dictateIntoField(FIELD, { recognizer: createNativeSpeechRecognizer(mod) });
  assert.equal(out.state, 'accepted');
  assert.equal(started.requiresOnDeviceRecognition, true, 'the recommended posture: audio stays on the device');
  const refused = await dictateIntoField(FIELD, {
    recognizer: createNativeSpeechRecognizer({ ...mod, requestPermissionsAsync: async () => ({ granted: false }) }),
  });
  assert.deepEqual([refused.state, refused.state === 'unavailable' && refused.reason], ['unavailable', 'permission_denied']);
});
