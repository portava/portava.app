/**
 * census-wall W71 / OD-TRUST-8 — the Wall's voice input is PUSH-TO-TALK, uses
 * the platform recognizer (no provider of its own), and hands the transcript to
 * the same steer field typing fills, without submitting it.
 *
 * The recognizer is injected (WallHeader's `voiceRecognizer`), so these tests
 * drive the REAL WallHeader → WallPushToTalk → useVoiceDictation → voiceIntake
 * path with a fake port that records exactly what it was asked to do, and that
 * keeps "listening" until its abort signal fires — which is what a hold is.
 *
 * What these tests cannot show, and a device run must: that the OS recognizer
 * runs on-device, and that the microphone indicator clears on release.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// Same thin SmartInput stub as WallHeader.smartInput: the field is a plain
// TextInput carrying `value`, so what voice put there is observable.
jest.mock('../../../../platform/input-assistance/components/SmartInput.tsx', () => {
  const ReactLocal = require('react');
  const { TextInput } = require('react-native');
  return {
    SmartInput: (props: { testID?: string; value: string; onChangeText: (t: string) => void; onSubmitEditing?: () => void }) =>
      ReactLocal.createElement(TextInput, {
        testID: props.testID,
        value: props.value,
        onChangeText: props.onChangeText,
        onSubmitEditing: props.onSubmitEditing,
      }),
  };
});

// NOTE: intentionally exhaustive — the provider fetches GET /api/feature-flags;
// the microphone reads only `isEnabled('wall_enabled')`, and the stand-in
// answers from the set below so each test chooses the Wall flag.
const mockFlags = { on: new Set<string>(['wall_enabled']) };
jest.mock('../../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags.on.has(k), isLivePlacesEnabled: () => false, loading: false }),
}));

import { WallHeader } from '../WallHeader.tsx';
import { WALL_PTT_UNAVAILABLE } from '../WallPushToTalk.tsx';
import type { SpeechRecognizerPort } from '../../../../platform/input-assistance/voice/speechRecognizer.ts';

interface FakeRecognizer extends SpeechRecognizerPort {
  sessions: Array<{ aborted: boolean }>;
  readonly onDeviceOnly?: true;
}

/** Listens until aborted (a hold), then answers `heard` as the final transcript. */
function holdingRecognizer(heard: string, opts: { available?: boolean; fail?: boolean; onDevice?: boolean } = {}): FakeRecognizer {
  const sessions: Array<{ aborted: boolean }> = [];
  return {
    providerId: 'native-speech',
    // Declares the guarantee the Wall requires; `onDevice: false` models a
    // recognizer that may send audio to a server.
    ...(opts.onDevice === false ? {} : { onDeviceOnly: true as const }),
    sessions,
    async isAvailable() { return opts.available !== false; },
    recognizeOnce({ signal } = {}) {
      const session = { aborted: false };
      sessions.push(session);
      return new Promise((resolve) => {
        const finish = () => {
          session.aborted = true;
          resolve(opts.fail
            ? { ok: false, unavailable: false, reason: 'capture_failed', error: 'nothing heard' }
            : { ok: true, result: { text: heard, confidence: 0.95, isFinal: true, language: 'en-US' } });
        };
        if (signal?.aborted) finish();
        else signal?.addEventListener('abort', finish);
      });
    },
  };
}

const field = () => screen.getByTestId('wall-intent-input');
const ptt = () => screen.getByTestId('wall-ptt');

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => { mockFlags.on = new Set(['wall_enabled']); });

describe('W71 — the Wall microphone is push-to-talk, on the shared engine', () => {
  it('holding listens; releasing stops it, and the words land in the steer field as if typed — NOT submitted', async () => {
    const rec = holdingRecognizer('bangkok street food');
    const onSetIntent = jest.fn();
    await render(<WallHeader onSetIntent={onSetIntent} voiceRecognizer={rec} />);
    await settle();

    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await settle();
    expect(rec.sessions).toHaveLength(1);
    expect(rec.sessions[0].aborted).toBe(false);
    expect(screen.getByTestId('wall-ptt-status').props.children).toMatch(/Listening — release to stop/);

    await act(async () => { await fireEvent(ptt(), 'pressOut'); });
    await settle();
    expect(rec.sessions[0].aborted).toBe(true);
    expect(field().props.value).toBe('bangkok street food');
    expect(onSetIntent).not.toHaveBeenCalled();

    // From here it is ordinary text: submitting it is exactly the typed path.
    await act(async () => { await fireEvent(field(), 'submitEditing'); });
    expect(onSetIntent).toHaveBeenCalledWith({ text: 'bangkok street food' });
  });

  it('is not a toggle: releasing ends the session, and only a new hold starts another', async () => {
    const rec = holdingRecognizer('night market');
    await render(<WallHeader voiceRecognizer={rec} />);
    await settle();

    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await act(async () => { await fireEvent(ptt(), 'pressOut'); });
    await settle();
    // A stray release with no hold starts nothing.
    await act(async () => { await fireEvent(ptt(), 'pressOut'); });
    await settle();
    expect(rec.sessions).toHaveLength(1);
    expect(rec.sessions.every((x) => x.aborted)).toBe(true);

    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await settle();
    expect(rec.sessions).toHaveLength(2);
    expect(rec.sessions[1].aborted).toBe(false);
  });

  it('a release that lands before the recognizer has started starts NOTHING (real adapters miss a pre-aborted signal)', async () => {
    // Like both platform adapters: the abort listener is attached at start, so a
    // signal that is ALREADY aborted is never seen. And availability is slow.
    let releaseAvailability!: () => void;
    const gate = new Promise<void>((r) => { releaseAvailability = r; });
    const started: string[] = [];
    const rec: SpeechRecognizerPort & { onDeviceOnly: true } = {
      providerId: 'native-speech',
      onDeviceOnly: true,
      async isAvailable() { await gate; return true; },
      recognizeOnce({ signal } = {}) {
        started.push('start');
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ ok: true, result: { text: 'late', confidence: 1, isFinal: true, language: null } }));
        });
      },
    };
    await render(<WallHeader voiceRecognizer={rec} />);
    await act(async () => { releaseAvailability(); });
    await settle();
    // Now hold and release while the per-session availability check is pending.
    let releaseSecond!: () => void;
    const second = new Promise<void>((r) => { releaseSecond = r; });
    rec.isAvailable = async () => { await second; return true; };
    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await act(async () => { await fireEvent(ptt(), 'pressOut'); });
    await act(async () => { releaseSecond(); });
    await settle();
    expect(started).toEqual([]);
    expect(field().props.value).toBe('');
  });

  it('with no recognizer on this build, a hold starts nothing and says why', async () => {
    const rec = holdingRecognizer('x', { available: false });
    await render(<WallHeader voiceRecognizer={rec} />);
    await settle();
    expect(ptt().props.accessibilityLabel).toBe('Voice input unavailable');

    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await settle();
    expect(rec.sessions).toHaveLength(0);
    expect(screen.getByTestId('wall-ptt-status').props.children).toBe(WALL_PTT_UNAVAILABLE);
    expect(field().props.value).toBe('');
  });

  it('a hold that hears nothing leaves the field as it was and says so', async () => {
    const rec = holdingRecognizer('ignored', { fail: true });
    await render(<WallHeader voiceRecognizer={rec} />);
    await settle();
    await act(async () => { fireEvent.changeText(field(), 'food'); });
    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await act(async () => { await fireEvent(ptt(), 'pressOut'); });
    await settle();
    expect(field().props.value).toBe('food');
    expect(screen.getByTestId('wall-ptt-status').props.children).toMatch(/Didn’t hear anything/);
  });

  it('while a steer is being applied, the microphone does not listen', async () => {
    const rec = holdingRecognizer('x');
    await render(<WallHeader voiceRecognizer={rec} intentPending />);
    await settle();
    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await settle();
    expect(rec.sessions).toHaveLength(0);
  });

  it('tells a screen-reader user how to use it, and that recognition is on the device', async () => {
    await render(<WallHeader voiceRecognizer={holdingRecognizer('x')} />);
    await settle();
    expect(ptt().props.accessibilityLabel).toBe('Hold to talk');
    expect(ptt().props.accessibilityHint).toMatch(/hold to speak, release to stop/i);
    expect(ptt().props.accessibilityHint).toMatch(/on this device/);
  });
});

// ── Verifier finding 1 (2026-10-06): on-device or not at all, and behind the Wall flag ──
describe('W71 — the Wall never sends a voice off the device, and is dark when the Wall is', () => {
  afterEach(() => { delete (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition; });

  it('on a WEB build with the browser recognizer present, nothing is started and it says why', async () => {
    // What the shared resolver falls back to on react-native-web: the Web
    // Speech API, which may process audio on the browser vendor's servers.
    const constructed: string[] = [];
    class FakeWebSpeech {
      lang = ''; interimResults = false; continuous = false; maxAlternatives = 1;
      onresult = null; onerror = null; onend = null;
      constructor() { constructed.push('new'); }
      start() { constructed.push('start'); }
      stop() { constructed.push('stop'); }
      abort() { constructed.push('abort'); }
    }
    (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeWebSpeech;

    await render(<WallHeader />);
    await settle();
    expect(ptt().props.accessibilityLabel).toBe('Voice input unavailable');
    expect(ptt().props.accessibilityHint).toBeUndefined();

    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await act(async () => { await fireEvent(ptt(), 'pressOut'); });
    await settle();
    expect(constructed).toEqual([]);
    expect(screen.getByTestId('wall-ptt-status').props.children).toBe(WALL_PTT_UNAVAILABLE);
    expect(field().props.value).toBe('');
  });

  it('a recognizer that does not declare on-device processing is never started, even if it says it is available', async () => {
    const rec = holdingRecognizer('sent to a server', { onDevice: false });
    await render(<WallHeader voiceRecognizer={rec} />);
    await settle();
    await act(async () => { await fireEvent(ptt(), 'pressIn'); });
    await act(async () => { await fireEvent(ptt(), 'pressOut'); });
    await settle();
    expect(rec.sessions).toHaveLength(0);
    expect(field().props.value).toBe('');
  });

  it('with wall_enabled off (or not yet loaded) there is no microphone at all', async () => {
    mockFlags.on = new Set();
    const rec = holdingRecognizer('x');
    await render(<WallHeader voiceRecognizer={rec} />);
    await settle();
    expect(screen.queryByTestId('wall-ptt')).toBeNull();
    // The steer bar itself is unchanged.
    expect(field()).toBeTruthy();
  });

  it('the on-device hint is not shown while availability is still being checked', async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    const rec = holdingRecognizer('x');
    rec.isAvailable = async () => { await pending; return true; };
    await render(<WallHeader voiceRecognizer={rec} />);
    expect(ptt().props.accessibilityHint).toBeUndefined();
    await act(async () => { release(); });
    await settle();
    expect(ptt().props.accessibilityHint).toMatch(/on this device/);
  });
});
