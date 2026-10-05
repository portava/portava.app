/**
 * GII-F09 on the client: dictate into a field, and the transcript feeds the
 * same pipeline typed text does.
 *
 * Driven through the REAL button, hook, intake and — in the last test — the
 * REAL paste review screen and extract client. Only the platform speech API
 * (a stand-in `webkitSpeechRecognition` on the global, which is exactly where
 * the browser puts it) and `fetch` are faked.
 *
 *   - no recognizer on this build → the microphone is SHOWN, struck through,
 *     and says why when tapped; it never pretends to listen;
 *   - a recognizer present → tap, speak, and the field receives the intake's
 *     text (the typed builder's shaping);
 *   - a mumble or a refused permission says so;
 *   - dictating into the paste box sends the spoken words through the same
 *     `POST /api/input-assistance/extract` a typed paste uses.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { VoiceDictationButton } from '../VoiceDictationButton.tsx';
import { PasteReviewSheet } from '../../paste/PasteReviewSheet.tsx';
import { clearSpeechRecognizer } from '../speechRecognizer.ts';

// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

type Script = { text?: string; confidence?: number; error?: string };
let script: Script = {};

// OD-INPUT-5 (2026-10-05): this layer uses a browser recognizer ONLY when the
// engine can recognise on the device (the spec's `available({processLocally})`
// and `processLocally`). The stand-in models such an engine; an engine without
// those controls is refused, which speechRecognizer.test.ts proves.
class FakeRecognition {
  static available = async (_o: { processLocally?: boolean }) => 'available';
  processLocally = false;
  lang = '';
  interimResults = false;
  continuous = true;
  maxAlternatives = 1;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  start() {
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

beforeEach(() => {
  clearSpeechRecognizer();
  delete (global as any).webkitSpeechRecognition;
  script = {};
});
afterAll(() => { delete (global as any).webkitSpeechRecognition; });

test('no recognizer on this build: the mic is shown, struck through, and says why', async () => {
  const onTranscript = jest.fn();
  await render(<VoiceDictationButton fieldId="trip.destination" context="trip_destination" onTranscript={onTranscript} />);
  await waitFor(() => expect(screen.getByLabelText('Voice input unavailable')).toBeTruthy());
  expect(screen.queryByTestId('voice-dictate-status')).toBeNull();
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/isn’t available on this build/);
  expect(onTranscript).not.toHaveBeenCalled();
});

test('with the platform recognizer: tap, speak, and the field receives the shaped text', async () => {
  (global as any).webkitSpeechRecognition = FakeRecognition;
  script = { text: '  Hoi   An ', confidence: 0.93 };
  const onTranscript = jest.fn();
  await render(<VoiceDictationButton fieldId="trip.destination" context="trip_destination" onTranscript={onTranscript} />);
  await waitFor(() => expect(screen.getByLabelText('Dictate')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Hoi An'));
  expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/Added what you said/);
});

test('a mumble and a refused permission each say so, and nothing reaches the field', async () => {
  (global as any).webkitSpeechRecognition = FakeRecognition;
  const onTranscript = jest.fn();
  await render(<VoiceDictationButton fieldId="trip.destination" context="trip_destination" onTranscript={onTranscript} />);
  await waitFor(() => expect(screen.getByLabelText('Dictate')).toBeTruthy());

  script = { text: 'hoy an', confidence: 0.2 };
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  await waitFor(() => expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/Didn’t catch that/));

  script = { error: 'not-allowed' };
  await fireEvent.press(screen.getByTestId('voice-dictate'));
  await waitFor(() => expect(screen.getByTestId('voice-dictate-status').props.children).toMatch(/permission is off/));
  expect(onTranscript).not.toHaveBeenCalled();
});

test('dictating into the paste box feeds the same extract pipeline a typed paste uses', async () => {
  (global as any).webkitSpeechRecognition = FakeRecognition;
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
