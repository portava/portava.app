/**
 * Telegraph §6.2/§6.3 VOICE on the client — the player's rules, the player, and
 * the recorder's state machine.
 *
 * Spec:
 *   §6.2  VOICE is one of the thirteen kinds
 *   §6.3  "Voice: waveform, seek, playback speed, optional transcript/translation"
 *   §11.3 status is never colour alone; a derivative never gates the original
 *
 * WHAT IS EXERCISED: the real `voicePolicy.ts`, the real `VoiceMessagePlayer`,
 * the real `VoiceRecorderSheet`, and the real `TypedMessageRenderer` dispatch.
 * `expo-av` is native and cannot run here, so both components reach it through
 * an injected factory; everything either component DECIDES is its own code and
 * is the code under test.
 *
 * MODAL RULE 6 (src/components/__tests__/TESTING.md): `Modal` posts a macrotask
 * on mount that corrupts RNTL's act scope, so it is replaced with a synchronous
 * View, and this file mounts ONE Modal-rooted component (the recorder sheet).
 *
 * SHOWN RED before commit, each reverted — counts at the bottom of this file.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6. Only the `Modal` key is
// intercepted; every other react-native export falls through via Reflect.get.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react');
        return ({ children, visible }: any) =>
          visible ? R.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: intentional stub — `services/mediaUrl.ts` reaches lib/supabase, which
// builds a client at import time and fails outside an Expo runtime. The signed
// URL it returns is what the player feeds to the sound factory, and the test
// asserts that it is the SIGNED one rather than the raw storage reference.
jest.mock('../../../services/mediaUrl.ts', () => ({
  PRIVATE_BUCKETS: ['post-media', 'profile-media'],
  hydrateMediaUrls: jest.fn(async () => ({})),
  useHydratedMedia: (urls: (string | null | undefined)[]) => ({
    resolved: Object.fromEntries(
      urls.filter(Boolean).map((u) => [u as string, `https://signed.example/${u}`]),
    ),
    loading: false,
  }),
}));

// NOTE: intentional stub — voiceApi reaches lib/supabase and services/apiToken,
// both of which build clients at import time. The recorder's own state machine
// is the thing under test; these two are seams it is handed.
jest.mock('../voice/voiceApi.ts', () => ({
  uploadVoiceRecording: jest.fn(),
  sendVoiceMessage: jest.fn(),
}));

import {
  PLAYBACK_SPEEDS,
  VOICE_MAX_DURATION_SECONDS,
  WAVEFORM_MAX_PEAKS,
  barIndexForTap,
  downsampleWaveform,
  formatDuration,
  isSendableRecording,
  meteringToAmplitude,
  nextPlaybackSpeed,
  normaliseWaveform,
  playedFraction,
  recordingShouldStop,
  seekMillisForTap,
} from '../voice/voicePolicy.ts';
import { VoiceMessagePlayer, type VoiceSoundHandle } from '../voice/VoiceMessagePlayer.tsx';
import { VoiceRecorderSheet, type VoiceRecorderHandle } from '../voice/VoiceRecorderSheet.tsx';
import { rendersTypedKind } from '../kinds/TypedMessageRenderer.tsx';
import { parseKindEnvelope } from '../kinds/kindsApi.ts';

const URL_REF = 'post-media/u1/voice/1700000000000.m4a';

// ── the rules ────────────────────────────────────────────────────────────────

describe('§6.3 — the player rules, which a renderer cannot be trusted to get right', () => {
  it('the speed cycle RETURNS TO 1x, so a traveler is never stranded at 2x', () => {
    expect(PLAYBACK_SPEEDS[0]).toBe(1);
    let s: number = 1;
    const seen: number[] = [];
    for (let i = 0; i < PLAYBACK_SPEEDS.length; i++) {
      s = nextPlaybackSpeed(s);
      seen.push(s);
    }
    expect(seen).toEqual([1.5, 2, 1]);
  });

  it('an unknown persisted speed resets to 1x rather than freezing the control', () => {
    expect(nextPlaybackSpeed(3.7)).toBe(1);
    expect(nextPlaybackSpeed(Number.NaN)).toBe(1);
  });

  it('a tap in the padding before the first bar seeks to the START, not to index -1', () => {
    expect(barIndexForTap(-40, 200, 48)).toBe(0);
    expect(seekMillisForTap(-40, 200, 10, 48)).toBe(0);
  });

  it('a tap past the last bar seeks to the last bar, not past the end', () => {
    expect(barIndexForTap(9999, 200, 48)).toBe(47);
  });

  it('a tap in the middle seeks to the middle', () => {
    expect(seekMillisForTap(100, 200, 10, 48)).toBe(Math.round((24 / 48) * 10_000));
  });

  it('a zero-width or zero-duration player seeks to 0 instead of NaN', () => {
    expect(seekMillisForTap(50, 0, 10, 48)).toBe(0);
    expect(seekMillisForTap(50, 200, 0, 48)).toBe(0);
    expect(Number.isNaN(seekMillisForTap(50, 200, 0, 48))).toBe(false);
  });

  it('a zero-duration note is NOT drawn as fully played', () => {
    // Otherwise a note whose duration failed to load reads as already heard.
    expect(playedFraction(5000, 0)).toBe(0);
    expect(playedFraction(5000, 10)).toBe(0.5);
    expect(playedFraction(50_000, 10)).toBe(1);
  });

  it('formats as m:ss and never as a negative or NaN', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(-4)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });

  it('the meter is anchored at -60 dB, not at the -160 dB floor', () => {
    // Anchoring at -160 makes every ordinary recording a flat band near the top,
    // which is the one thing a waveform exists not to be.
    expect(meteringToAmplitude(0)).toBe(1);
    expect(meteringToAmplitude(-60)).toBe(0);
    expect(meteringToAmplitude(-160)).toBe(0);
    expect(meteringToAmplitude(-30)).toBeCloseTo(0.5, 5);
    expect(meteringToAmplitude(null)).toBe(0);
    expect(meteringToAmplitude(Number.NaN)).toBe(0);
  });

  it('downsampling AVERAGES a bucket rather than sampling one frame of it', () => {
    const alternating = new Array(240).fill(0).map((_, i) => (i % 2 === 0 ? 0 : 1));
    const out = downsampleWaveform(alternating, 120);
    expect(out).toHaveLength(120);
    expect(new Set(out)).toEqual(new Set([0.5]));
  });

  it('clamps and drops exactly as the server does — the two must not drift', () => {
    expect(normaliseWaveform([-5, 0.4, 900, NaN, Infinity])).toEqual([0, 0.4, 1]);
  });

  it('the recorder stops at the SERVER ceiling, so a long recording is never lost', () => {
    expect(recordingShouldStop(VOICE_MAX_DURATION_SECONDS - 0.5)).toBe(false);
    expect(recordingShouldStop(VOICE_MAX_DURATION_SECONDS)).toBe(true);
    expect(VOICE_MAX_DURATION_SECONDS).toBe(300);
    expect(WAVEFORM_MAX_PEAKS).toBe(120);
  });

  it('a sub-second fumble is not sendable', () => {
    expect(isSendableRecording(0)).toBe(false);
    expect(isSendableRecording(1)).toBe(true);
    expect(isSendableRecording(VOICE_MAX_DURATION_SECONDS + 1)).toBe(false);
  });
});

// ── dispatch ─────────────────────────────────────────────────────────────────

describe('a stored VOICE row reaches the renderer', () => {
  it('rendersTypedKind claims `voice`', () => {
    expect(rendersTypedKind('voice')).toBe(true);
  });

  it('parseKindEnvelope reads a VOICE envelope back — the parseable set is larger than the sendable one', () => {
    const body = JSON.stringify({
      kind: 'VOICE',
      envelopeVersion: '1',
      payload: { url: URL_REF, durationSeconds: 8, waveform: [0.2, 0.9], mimeType: 'audio/mp4' },
    });
    const parsed = parseKindEnvelope('voice', body);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('VOICE');
    expect(parsed!.payload.durationSeconds).toBe(8);
  });
});

// ── the player ───────────────────────────────────────────────────────────────

function fakeSound() {
  const calls: string[] = [];
  let statusCb: ((s: any) => void) | null = null;
  const handle: VoiceSoundHandle & { calls: string[]; emit(s: any): void; rate: number; position: number } = {
    calls,
    rate: 1,
    position: 0,
    async playAsync() { calls.push('play'); return null; },
    async pauseAsync() { calls.push('pause'); return null; },
    async setRateAsync(rate: number) { handle.rate = rate; calls.push(`rate:${rate}`); return null; },
    async setPositionAsync(ms: number) { handle.position = ms; calls.push(`seek:${ms}`); return null; },
    async unloadAsync() { calls.push('unload'); return null; },
    setOnPlaybackStatusUpdate(cb: (s: any) => void) { statusCb = cb; },
    emit(s: any) { statusCb?.(s); },
  };
  return handle;
}

describe('VoiceMessagePlayer — §6.3s three affordances over a PRIVATE bucket', () => {
  it('plays through the SIGNED url, never the raw storage reference', async () => {
    const sound = fakeSound();
    const seen: string[] = [];
    await render(
      <VoiceMessagePlayer
        url={URL_REF}
        durationSeconds={12}
        waveform={[0.2, 0.8]}
        createSound={async (uri) => { seen.push(uri); return sound; }}
      />,
    );
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-toggle')); });
    // The bucket is private: handing `post-media/...` to a player produces a
    // play button that silently never plays.
    expect(seen).toEqual([`https://signed.example/${URL_REF}`]);
    expect(sound.calls).toContain('play');
  });

  it('pauses on a second press rather than restarting', async () => {
    const sound = fakeSound();
    await render(
      <VoiceMessagePlayer url={URL_REF} durationSeconds={12} createSound={async () => sound} />,
    );
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-toggle')); });
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-toggle')); });
    expect(sound.calls.filter((c) => c === 'play')).toHaveLength(1);
    expect(sound.calls).toContain('pause');
  });

  it('SEEKS to the tapped position', async () => {
    const sound = fakeSound();
    await render(
      <VoiceMessagePlayer url={URL_REF} durationSeconds={10} createSound={async () => sound} />,
    );
    const wave = screen.getByTestId('telegraph-voice-wave');
    await act(async () => {
      fireEvent(wave, 'layout', { nativeEvent: { layout: { width: 200, height: 28 } } });
    });
    await act(async () => {
      fireEvent.press(wave, { nativeEvent: { locationX: 100 } });
    });
    expect(sound.position).toBeGreaterThan(4000);
    expect(sound.position).toBeLessThan(6000);
  });

  it('CYCLES playback speed, and the control states the speed as a WORD (§11.3)', async () => {
    const sound = fakeSound();
    await render(
      <VoiceMessagePlayer url={URL_REF} durationSeconds={10} createSound={async () => sound} />,
    );
    expect(screen.getByTestId('telegraph-voice-speed')).toHaveTextContent('1x');
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-speed')); });
    expect(screen.getByTestId('telegraph-voice-speed')).toHaveTextContent('1.5x');
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-speed')); });
    expect(screen.getByTestId('telegraph-voice-speed')).toHaveTextContent('2x');
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-speed')); });
    expect(screen.getByTestId('telegraph-voice-speed')).toHaveTextContent('1x');
  });

  it('a note with NO waveform still renders and still plays (§11.3)', async () => {
    const sound = fakeSound();
    await render(
      <VoiceMessagePlayer url={URL_REF} durationSeconds={7} waveform={[]} createSound={async () => sound} />,
    );
    // A derivative may not gate the original: the bars degrade to a flat band
    // and the transport is unaffected.
    //
    // `includeHiddenElements` since V4's accessibility sweep: the bars are
    // DECORATION and are now hidden from the accessibility tree, which RNTL's
    // default queries walk. The claim is unchanged — the flat band is rendered —
    // and `verifyA11yTelegraphVoice.component.test.tsx` W1 asserts the hiding
    // itself, so neither fact can be lost by the other changing.
    expect(screen.getByTestId('telegraph-voice-bar-0', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId('telegraph-voice-duration')).toHaveTextContent('0:07');
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-toggle')); });
    expect(sound.calls).toContain('play');
  });

  it('says so IN WORDS when the audio cannot be played', async () => {
    await render(
      <VoiceMessagePlayer
        url={URL_REF}
        durationSeconds={7}
        createSound={async () => { throw new Error('codec'); }}
      />,
    );
    expect(screen.queryByTestId('telegraph-voice-error')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-toggle')); });
    expect(screen.getByTestId('telegraph-voice-error')).toBeTruthy();
  });

  it('RELEASES the sound on unmount — audio must not follow the traveler off the screen', async () => {
    const sound = fakeSound();
    const view = await render(
      <VoiceMessagePlayer url={URL_REF} durationSeconds={10} createSound={async () => sound} />,
    );
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-toggle')); });
    await act(async () => { view.unmount(); });
    expect(sound.calls).toContain('unload');
  });
});

// ── the recorder ─────────────────────────────────────────────────────────────

function fakeRecorder() {
  let cb: ((s: any) => void) | null = null;
  const handle: VoiceRecorderHandle & { emit(s: any): void; stopped: boolean } = {
    stopped: false,
    async stopAndUnloadAsync() { handle.stopped = true; return null; },
    getURI() { return 'file:///tmp/rec.m4a'; },
    setOnRecordingStatusUpdate(next: (s: any) => void) { cb = next; },
    setProgressUpdateInterval() {},
    emit(s: any) { cb?.(s); },
  };
  return handle;
}

describe('VoiceRecorderSheet — the ceiling is the RECORDERs, and the send is a second press', () => {
  const uploadOk = jest.fn(async () => ({
    ok: true as const,
    data: {
      url: URL_REF,
      path: 'u1/voice/1.m4a',
      mimeType: 'audio/mp4',
      sizeBytes: 4096,
      maxDurationSeconds: 300,
      maxWaveformPeaks: 120,
    },
  }));

  beforeEach(() => { uploadOk.mockClear(); });

  it('records, reviews, then sends — and sending is NOT automatic', async () => {
    const rec = fakeRecorder();
    const send = jest.fn(async () => ({ ok: true as const, data: {} as any }));
    const onSent = jest.fn();
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        onSent={onSent}
        createRecorder={async () => ({ ok: true, recorder: rec })}
        upload={uploadOk as any}
        send={send as any}
      />,
    );
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-record')); });
    await act(async () => { rec.emit({ durationMillis: 4200, metering: -20 }); });

    // Still recording — nothing has been uploaded or sent.
    expect(uploadOk).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-stop')); });
    expect(rec.stopped).toBe(true);
    expect(screen.getByTestId('telegraph-voice-recorder-phase')).toHaveTextContent(/Ready to send/);
    expect(uploadOk).not.toHaveBeenCalled();

    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-send')); });
    expect(uploadOk).toHaveBeenCalledWith('file:///tmp/rec.m4a', 'audio/mp4');
    expect(send).toHaveBeenCalledTimes(1);
    const payload = (send.mock.calls[0] as any[])[1];
    expect(payload.durationSeconds).toBe(4);
    expect(payload.url).toBe(URL_REF);
    expect(payload.waveform.length).toBeGreaterThan(0);
    expect(onSent).toHaveBeenCalled();
  });

  it('STOPS ITSELF at the ceiling instead of letting the server refuse six minutes of audio', async () => {
    const rec = fakeRecorder();
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        createRecorder={async () => ({ ok: true, recorder: rec })}
        upload={uploadOk as any}
        send={jest.fn() as any}
      />,
    );
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-record')); });
    await act(async () => {
      rec.emit({ durationMillis: VOICE_MAX_DURATION_SECONDS * 1000, metering: -20 });
    });
    expect(rec.stopped).toBe(true);
    expect(screen.getByTestId('telegraph-voice-recorder-phase')).toHaveTextContent(/Ready to send/);
  });

  it('DISCARDS a sub-second fumble rather than collecting a 400', async () => {
    const rec = fakeRecorder();
    const send = jest.fn();
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        createRecorder={async () => ({ ok: true, recorder: rec })}
        upload={uploadOk as any}
        send={send as any}
      />,
    );
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-record')); });
    await act(async () => { rec.emit({ durationMillis: 200, metering: -20 }); });
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-stop')); });
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-send')); });
    expect(uploadOk).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId('telegraph-voice-recorder-error')).toHaveTextContent(/too short/);
  });

  it('states a denied microphone permission IN WORDS, once, with no retry loop', async () => {
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        createRecorder={async () => ({ ok: false, reason: 'permission' })}
        upload={uploadOk as any}
        send={jest.fn() as any}
      />,
    );
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-record')); });
    expect(screen.getByTestId('telegraph-voice-recorder-error')).toHaveTextContent(/microphone access/);
    // Back to idle, so the traveler can leave; no automatic second attempt.
    expect(screen.getByTestId('telegraph-voice-recorder-phase')).toHaveTextContent('Ready');
  });

  it('a failed SEND keeps the recording in review rather than throwing it away', async () => {
    const rec = fakeRecorder();
    const send = jest.fn(async () => ({ ok: false as const, error: 'degraded_unavailable', message: 'migration 2989' }));
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        createRecorder={async () => ({ ok: true, recorder: rec })}
        upload={uploadOk as any}
        send={send as any}
      />,
    );
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-record')); });
    await act(async () => { rec.emit({ durationMillis: 5000, metering: -20 }); });
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-stop')); });
    await act(async () => { fireEvent.press(screen.getByTestId('telegraph-voice-send')); });
    // The server's own sentence is shown, and the Send button is still there.
    expect(screen.getByTestId('telegraph-voice-recorder-error')).toHaveTextContent(/2989/);
    expect(screen.getByTestId('telegraph-voice-send')).toBeTruthy();
  });
});

/**
 * MUTATIONS RUN, WITH THE COUNTS THEY PRODUCED. Baseline 27/27. Every one
 * restored, and the baseline re-confirmed after each.
 *
 *   • `nextPlaybackSpeed` clamping at the last speed instead of wrapping →
 *     25/2: the cycle case and the rendered speed-control case.
 *   • `barIndexForTap` dropping both clamps → 25/2: the padding case and the
 *     past-the-end case. The middle-of-the-bar case STAYED GREEN, which is the
 *     measurement that matters — the suite can tell a clamp from an offset bug.
 *   • `recordingShouldStop` comparing `>` instead of `>=` → 25/2, red exactly
 *     at the boundary.
 *   • `isSendableRecording` dropping its one-second floor → 25/2.
 *   • The player handing `url` to the sound factory instead of the SIGNED url →
 *     26/1, and only the signed-url case. On a private bucket that mutant is a
 *     play button that never plays.
 *   • `playedFraction` dropping its `durationSeconds <= 0` guard → 26/1.
 *   • The player's unmount cleanup removed → 26/1.
 */
