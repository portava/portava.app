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

/**
 * A stand-in for the browser's SpeechRecognition that plays a script.
 *
 * `onDevice` models the spec's on-device controls (OD-INPUT-5): the static
 * `available({ langs, processLocally })` answer, or `null` for an engine that
 * predates them (no `available`, no `processLocally`). The default is an engine
 * that CAN recognise on the device — the only kind this layer may use.
 */
function fakeWebScope(
  script: Script,
  log: string[] = [],
  onDevice: 'available' | 'downloadable' | 'unavailable' | null = 'available',
  hasProcessLocally = onDevice !== null,
) {
  class FakeRecognition {
    static available = onDevice === null
      ? undefined
      : async (o: { langs: string[]; processLocally?: boolean }) => {
          log.push(`available langs=${o.langs.join(',')} local=${o.processLocally === true}`);
          return o.processLocally === true ? onDevice : 'available';
        };
    lang = '';
    interimResults = false;
    continuous = true;
    maxAlternatives = 5;
    onresult: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      // `processLocally` is defined on the prototype below only for an engine that
      // implements the spec attribute, so it is read reflectively here.
      log.push(`start lang=${this.lang} interim=${this.interimResults} local=${Reflect.get(this, 'processLocally') === true}`);
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
  // The spec attribute lives on engines that implement it; one that predates it
  // simply does not have the property.
  if (hasProcessLocally) Object.defineProperty(FakeRecognition.prototype, 'processLocally', { value: false, writable: true, configurable: true });
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
  assert.deepEqual(log, [
    'available langs=en-US local=true',
    'available langs=en-US local=true',
    'start lang=en-US interim=true local=true',
  ]);
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
    supportsOnDeviceRecognition: () => true,
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

// ── OD-INPUT-5 — on the device first; the cloud only with consent; no audio kept ──

test('OD-INPUT-5 web: an engine WITHOUT on-device controls is not used — audio would be free to leave the device', async () => {
  const log: string[] = [];
  const rec = createWebSpeechRecognizer(fakeWebScope({ results: [{ text: 'Hoi An', confidence: 0.9, isFinal: true }] }, log, null))!;
  assert.equal(await rec.isAvailable(), false);
  const out = await rec.recognizeOnce({ language: 'en-US' });
  assert.deepEqual([out.ok, !out.ok && out.reason], [false, 'on_device_unavailable']);
  assert.ok(!log.some((l) => l.startsWith('start')), 'the microphone was never started');
});

test('OD-INPUT-5 web: an on-device model that is only DOWNLOADABLE is not used (no silent remote fallback)', async () => {
  const log: string[] = [];
  const rec = createWebSpeechRecognizer(fakeWebScope({ results: [{ text: 'Hoi An', confidence: 0.9, isFinal: true }] }, log, 'downloadable'))!;
  assert.equal(await rec.isAvailable(), false);
  const out = await dictateIntoField({ ...FIELD, language: 'vi-VN' }, { recognizer: rec });
  assert.equal(out.state, 'unavailable');
  assert.ok(!log.some((l) => l.startsWith('start')));
});

test('OD-INPUT-5 web: when used, recognition is REQUIRED to be local (processLocally = true)', async () => {
  const log: string[] = [];
  const rec = createWebSpeechRecognizer(fakeWebScope({ results: [{ text: 'Hoi An', confidence: 0.9, isFinal: true }] }, log))!;
  const out = await rec.recognizeOnce({ language: 'en-US' });
  assert.equal(out.ok, true);
  assert.ok(log.includes('start lang=en-US interim=false local=true'), log.join(' | '));
});

function nativeMod(over: Partial<NativeSpeechModuleLike> = {}, seen: { started: any[]; asked: number } = { started: [], asked: 0 }) {
  const listeners: Record<string, (e: any) => void> = {};
  const mod: NativeSpeechModuleLike = {
    requestPermissionsAsync: async () => { seen.asked += 1; return { granted: true }; },
    isRecognitionAvailable: () => true,
    supportsOnDeviceRecognition: () => true,
    start(options) {
      seen.started.push(options);
      queueMicrotask(() => {
        listeners.result?.({ isFinal: true, results: [{ transcript: 'Da Nang', confidence: 0.9 }] });
        listeners.end?.({});
      });
    },
    stop() {},
    addListener(event, cb) { listeners[event] = cb; return { remove() { delete listeners[event]; } }; },
    ...over,
  };
  return { mod, seen };
}

test('OD-INPUT-5 native: a device WITHOUT on-device support is refused before the microphone is asked for', async () => {
  // The module documents its on-device flag as "only enabled if the device
  // supports it" — so on such a device the flag alone would not keep the audio
  // home. The adapter refuses instead of trusting it.
  const { mod, seen } = nativeMod({ supportsOnDeviceRecognition: () => false });
  const rec = createNativeSpeechRecognizer(mod);
  assert.equal(await rec.isAvailable(), false);
  const out = await rec.recognizeOnce({});
  assert.deepEqual([out.ok, !out.ok && out.reason], [false, 'on_device_unavailable']);
  assert.equal(seen.asked, 0, 'no permission prompt');
  assert.equal(seen.started.length, 0, 'never started');
});

test('OD-INPUT-5 native: a module that cannot SAY whether it is on-device is refused (fail closed)', async () => {
  const { mod, seen } = nativeMod({ supportsOnDeviceRecognition: undefined });
  const out = await createNativeSpeechRecognizer(mod).recognizeOnce({});
  assert.deepEqual([out.ok, !out.ok && out.reason], [false, 'on_device_unavailable']);
  assert.equal(seen.started.length, 0);
});

test('OD-INPUT-5 native: audio is never persisted — start() carries no recording options at all', async () => {
  const { mod, seen } = nativeMod();
  const out = await createNativeSpeechRecognizer(mod).recognizeOnce({ language: 'vi-VN' });
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(seen.started[0]).sort(), ['continuous', 'interimResults', 'lang', 'requiresOnDeviceRecognition']);
  assert.equal(seen.started[0].requiresOnDeviceRecognition, true);
});

test('OD-INPUT-5 native: only an explicit cloud consent lets recognition leave the device', async () => {
  const { mod, seen } = nativeMod({ supportsOnDeviceRecognition: () => false });
  const out = await createNativeSpeechRecognizer(mod, { cloudConsentGranted: true }).recognizeOnce({});
  assert.equal(out.ok, true, 'the consented path exists — and is the ONLY way to it');
  assert.equal(seen.started[0].requiresOnDeviceRecognition, false);
});

test('OD-INPUT-5 web: an engine that answers available() but has NO processLocally attribute is not used', async () => {
  // Assigning an attribute an engine does not implement only creates a plain
  // property it never reads; that engine is not on-device by our say-so.
  const log: string[] = [];
  const rec = createWebSpeechRecognizer(fakeWebScope({ results: [{ text: 'Hoi An', confidence: 0.9, isFinal: true }] }, log, 'available', false))!;
  const out = await rec.recognizeOnce({ language: 'en-US' });
  assert.deepEqual([out.ok, !out.ok && out.reason], [false, 'on_device_unavailable']);
  assert.ok(!log.some((l) => l.startsWith('start')), 'never started');
});
