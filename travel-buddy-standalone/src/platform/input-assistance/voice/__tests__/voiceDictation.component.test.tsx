/**
 * GII-F09 on the client: dictate into a field, and the transcript feeds the
 * same pipeline typed text does.
 *
 * Driven through the REAL button, hook, resolver, native adapter, intake and —
 * in the last test — the REAL paste review screen and extract client. Only the
 * speech engines underneath are faked: a native module (the shape of
 * `expo-speech-recognition`, installed the way a device bootstrap would) and a
 * stand-in `webkitSpeechRecognition` on the global, which is exactly where the
 * browser puts it.
 *
 *   - no recognizer on this build → the microphone is SHOWN, struck through,
 *     and says why when tapped; it never pretends to listen;
 *   - OD-INPUT-5: a BROWSER engine on the global is never used — the
 *     destination button constructs and starts nothing (the shared resolver
 *     returns only a recognizer that declares on-device processing);
 *   - an installed on-device recognizer → tap, speak, and the field receives
 *     the intake's text (the typed builder's shaping); a mumble or a refused
 *     permission says so;
 *   - dictating into the paste box sends the spoken words through the same
 *     `POST /api/input-assistance/extract` a typed paste uses.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { act, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { VoiceDictationButton } from '../VoiceDictationButton.tsx';
import { PasteReviewSheet } from '../../paste/PasteReviewSheet.tsx';
import { clearSpeechRecognizer, createNativeSpeechRecognizer, installSpeechRecognizer, type NativeSpeechModuleLike, type SpeechRecognizerPort } from '../speechRecognizer.ts';
import { useVoiceDictation } from '../../hooks/useVoiceDictation.ts';

// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

type Script = { text?: string; confidence?: number; error?: string };
let script: Script = {};

// The most permissive browser engine there is: it has the spec's on-device
// controls and answers "available". OD-INPUT-5 still keeps it out — the shared
// resolver never falls back to the browser — so every use is COUNTED.
const browser = { constructed: 0, started: 0, asked: 0 };
class FakeRecognition {
  static available = async (_o: { processLocally?: boolean }) => { browser.asked += 1; return 'available'; };
  processLocally = false;
  lang = '';
  interimResults = false;
  continuous = true;
  maxAlternatives = 1;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { browser.constructed += 1; }
  start() {
    browser.started += 1;
    setTimeout(() => {
      if (script.text !== undefined) {
        const results: any = { length: 1, 0: Object.assign([{ transcript: script.text, confidence: script.confidence ?? 0.9 }], { isFinal: true, length: 1 }) };
        this.onresult?.({ resultIndex: 0, results });
      }
      if (script.error) this.onerror?.({ error: script.error });
      this.onend?.();
    }, 0);
  }
  stop() {}
  abort() {}
}

/** An on-device native module playing the script — what a device build installs. */
function scriptedModule(): NativeSpeechModuleLike {
  const listeners: Record<string, (e: any) => void> = {};
  return {
    requestPermissionsAsync: async () => ({ granted: true }),
    isRecognitionAvailable: () => true,
    supportsOnDeviceRecognition: () => true,
    start() {
      setTimeout(() => {
        if (script.text !== undefined) listeners.result?.({ isFinal: true, results: [{ transcript: script.text, confidence: script.confidence ?? 0.9 }] });
        if (script.error) listeners.error?.({ error: script.error });
        listeners.end?.({});
      }, 0);
    },
    stop() {},
    addListener(event, cb) { listeners[event] = cb; return { remove() { delete listeners[event]; } }; },
  };
}

function deferredRecognizer(): SpeechRecognizerPort & {
  sessions: Array<{ signal?: AbortSignal; partial(text: string): void; finish(text: string): void }>;
} {
  const sessions: Array<{ signal?: AbortSignal; partial(text: string): void; finish(text: string): void }> = [];
  return {
    providerId: 'native-speech',
    onDeviceOnly: true,
    sessions,
    async isAvailable() { return true; },
    recognizeOnce({ signal, onPartial } = {}) {
      return new Promise(resolve => {
        sessions.push({
          signal,
          partial(text) { onPartial?.({ text, confidence: 0.95, isFinal: false, language: 'en-US' }); },
          finish(text) { resolve({ ok: true, result: { text, confidence: 0.95, isFinal: true, language: 'en-US' } }); },
        });
      });
    },
  };
}

beforeEach(() => {
  clearSpeechRecognizer();
  delete (global as any).webkitSpeechRecognition;
  script = {};
  browser.constructed = 0; browser.started = 0; browser.asked = 0;
});
afterAll(() => { delete (global as any).webkitSpeechRecognition; clearSpeechRecognizer(); });

test('no recognizer on this build: the mic is shown, struck through, and says why', async () => {
  const onTranscript = jest.fn();
  await render(<VoiceDictationButton fieldId="trip.destination" context="trip_destination" onTranscript={onTranscript} />);
  await waitFor(() => expect(screen.getByLabelText('Voice input unavailable')).toBeTruthy());
  expect(screen.queryByTestId('voice-dictate-status')).toBeNull();
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/isn’t available on this build/);
  expect(onTranscript).not.toHaveBeenCalled();
});

test('OD-INPUT-5: a browser engine on the global is NEVER used — the destination button constructs and starts nothing', async () => {
  (global as any).webkitSpeechRecognition = FakeRecognition;
  script = { text: 'Hoi An', confidence: 0.95 };
  const onTranscript = jest.fn();
  // Exactly what DestinationListEditor renders (no recognizer passed: the shared resolver decides).
  await render(<VoiceDictationButton fieldId="trip.destination" context="trip_destination" onTranscript={onTranscript} />);
  await waitFor(() => expect(screen.getByLabelText('Voice input unavailable')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/isn’t available on this build/);
  expect(browser).toEqual({ constructed: 0, started: 0, asked: 0 });
  expect(onTranscript).not.toHaveBeenCalled();
});

test('with an installed on-device recognizer: speak and the field gets the shaped text; a mumble and a refused permission each say so', async () => {
  installSpeechRecognizer(createNativeSpeechRecognizer(scriptedModule()));
  const onTranscript = jest.fn();
  await render(<VoiceDictationButton fieldId="trip.destination" context="trip_destination" onTranscript={onTranscript} />);
  await waitFor(() => expect(screen.getByLabelText('Dictate')).toBeTruthy());

  script = { text: '  Hoi   An ', confidence: 0.93 };
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Hoi An'));
  expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/Added what you said/);
  onTranscript.mockClear();

  script = { text: 'hoy an', confidence: 0.2 };
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  await waitFor(() => expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/Didn’t catch that/));

  script = { error: 'not-allowed' };
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  await waitFor(() => expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/permission is off/));
  expect(onTranscript).not.toHaveBeenCalled();
});

test('dictating into the paste box feeds the same extract pipeline a typed paste uses', async () => {
  installSpeechRecognizer(createNativeSpeechRecognizer(scriptedModule()));
  script = { text: 'Da Nang then Hoi An', confidence: 0.9 };
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://portava.test';
  const bodies: any[] = [];
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ requestId: 'r', shape: 'list', truncated: false, mutated: false, items: [] }), { status: 200 });
  });
  await render(
    <PasteReviewSheet
      visible
      context="trip_destination"
      fieldId="trip.destination"
      onClose={() => {}}
      onConfirm={async () => []}
      renderInputAccessory={(append) => <VoiceDictationButton fieldId="trip.destination" context="trip_destination" onTranscript={append} />}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText('Dictate')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  await waitFor(() => expect(screen.getByTestId('paste-input').props.value).toBe('Da Nang then Hoi An'));
  await fireEvent.press(screen.getByTestId('paste-extract'));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0].url).toBe('https://portava.test/api/input-assistance/extract');
  expect(bodies[0].body).toMatchObject({ context: 'trip_destination', text: 'Da Nang then Hoi An' });
});

test('a superseded session cannot replace the current partial', async () => {
  const recognizer = deferredRecognizer();
  const onTranscript = jest.fn();
  const { result } = await renderHook(() => useVoiceDictation({ fieldId: 'trip.destination', context: 'trip_destination', onTranscript, recognizer }));
  await act(async () => { void result.current.start(); });
  await act(async () => { void result.current.start(); });
  expect(recognizer.sessions[0].signal?.aborted).toBe(true);
  await act(async () => { recognizer.sessions[1].partial('current words'); });
  await act(async () => { recognizer.sessions[0].partial('stale words'); });
  expect(result.current.state).toEqual({ phase: 'listening', partial: 'current words' });
  expect(onTranscript).not.toHaveBeenCalled();
});

test('a superseded final cannot overwrite a newer final, and completed sessions ignore late partials', async () => {
  const recognizer = deferredRecognizer();
  const onTranscript = jest.fn();
  const { result } = await renderHook(() => useVoiceDictation({ fieldId: 'trip.destination', context: 'trip_destination', onTranscript, recognizer }));
  await act(async () => { void result.current.start(); });
  await act(async () => { void result.current.start(); });
  await act(async () => { recognizer.sessions[1].finish('new destination'); });
  await act(async () => { recognizer.sessions[0].finish('old destination'); });
  expect(onTranscript.mock.calls).toEqual([['new destination']]);
  await act(async () => { recognizer.sessions[1].partial('late partial'); });
  expect(result.current.state).toEqual({ phase: 'heard', text: 'new destination' });
});

test('unmount stops dictation and ignores subsequent partials and final results', async () => {
  const recognizer = deferredRecognizer();
  const onTranscript = jest.fn();
  const view = await renderHook(() => useVoiceDictation({ fieldId: 'trip.destination', context: 'trip_destination', onTranscript, recognizer }));
  await act(async () => { void view.result.current.start(); });
  await view.unmount();
  expect(recognizer.sessions[0].signal?.aborted).toBe(true);
  await act(async () => {
    recognizer.sessions[0].partial('after unmount');
    recognizer.sessions[0].finish('after unmount');
  });
  expect(onTranscript).not.toHaveBeenCalled();
});

test('replacing the recognizer invalidates its pending callbacks without restarting capture', async () => {
  const previous = deferredRecognizer();
  const replacement = deferredRecognizer();
  const onTranscript = jest.fn();
  const { result, rerender } = await renderHook(
    ({ recognizer }: { recognizer: SpeechRecognizerPort }) => useVoiceDictation({ fieldId: 'trip.destination', context: 'trip_destination', onTranscript, recognizer }),
    { initialProps: { recognizer: previous } },
  );
  await act(async () => { void result.current.start(); });
  await rerender({ recognizer: replacement });
  expect(previous.sessions[0].signal?.aborted).toBe(true);
  await act(async () => {
    previous.sessions[0].partial('previous recognizer');
    previous.sessions[0].finish('previous recognizer');
  });
  expect(onTranscript).not.toHaveBeenCalled();
  expect(result.current.state).toEqual({ phase: 'idle' });
  expect(replacement.sessions).toHaveLength(0);
});
