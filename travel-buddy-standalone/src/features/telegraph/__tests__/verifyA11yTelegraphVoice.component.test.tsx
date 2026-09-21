/**
 * VERIFICATION LANE V4 — ACCESSIBILITY on the Telegraph voice surfaces.
 *
 * The build lane shipped `VoiceRecorderSheet`, `VoiceMessagePlayer` and the
 * VOICE arm of `TypedMessageRenderer` with no accessibility pass at all. This
 * file asks each one four questions and asserts the answer:
 *
 *   1. Does every interactive element have an accessible LABEL and a ROLE?
 *   2. Is STATE — recording, playing, failed — ANNOUNCED, or only drawn?
 *   3. Does anything convey meaning by COLOUR alone?
 *   4. Is anything reachable ONLY by a gesture, with no button equivalent?
 *
 * Question 4 is the one that found the worst of it. §11.3 of the spec is about
 * colour and motion and the build lane read it carefully; nothing in it says
 * "a seek bar must be operable without pointing at a pixel", so nothing was.
 *
 * ── RED-FIRST RECORD (measured 2026-09-16, `pnpm test:component`) ───────────
 * Run against the unmodified build-lane code first: 11 of 21 RED.
 *
 *   ✕ W1  the bars are DECORATIVE and are UNREACHABLE by a screen reader
 *   ✕ W2  the seek control exposes an accessibilityValue
 *   ✕ W3  the seek control exposes increment and decrement actions
 *   ✕ W4  increment SEEKS — the gesture-free equivalent of the tap
 *   ✕ W5  decrement at the start CLAMPS
 *   ✕ W5b the step rule is pure and clamps at BOTH ends
 *   ✕ W6  a playback failure is ANNOUNCED, not just drawn
 *   ✕ W7  the duration says WHICH duration it is
 *   ✕ R1  the phase line is a LIVE REGION
 *   ✕ R2  a DENIED microphone permission is announced
 *   ✕ R4  the SENDING spinner is hidden rather than an unlabelled node
 *   ✓ P1, P2, S1, R3 passed unmodified — see PROVEN BY MUTATION below.
 *
 * DEFECT A1 — THE WAVEFORM WAS 48 UNLABELLED VIEWS IN THE ACCESSIBILITY TREE.
 *   RED: ✕ W1  Unable to find an element with testID: telegraph-voice-bars
 *              (the wrapper did not exist; every bar WAS findable by a default,
 *              accessibility-tree query, which is what a reader walks)
 *   What a screen-reader user got: the amplitude bars carry nothing the duration
 *   and the position do not, and each of the 48 was a stop that announced
 *   nothing, between the play button and the duration.
 *   FIXED: the bars moved inside an `accessibilityElementsHidden` /
 *   `importantForAccessibility="no-hide-descendants"` wrapper — the house
 *   pattern already used by `PostcardEmptyState.tsx` and `ShimmerBox.tsx`. W1
 *   now asserts the DEFAULT query cannot reach them and the hidden-inclusive one
 *   still can, so "hidden" cannot quietly become "deleted".
 *
 * DEFECT A2 — `accessibilityRole="adjustable"` WITH NOTHING TO ADJUST.
 *   RED: ✕ W2  expect(received).toBeTruthy()  Received: undefined
 *        ✕ W3  accessibilityActions was undefined
 *        ✕ W4  setPositionAsync was never called
 *   What a screen-reader user got: the role PROMISES a swipe-up / swipe-down
 *   adjustment, and there were no `accessibilityActions`, no
 *   `onAccessibilityAction` and no `accessibilityValue`. Seeking existed ONLY as
 *   `onPress(e.nativeEvent.locationX)` — a tap at a chosen horizontal pixel. A
 *   person using VoiceOver, TalkBack or Switch Control could play and pause a
 *   voice message and could not move within it at all. This is the brief's
 *   question 4, and it is the worst finding on the surface.
 *   FIXED: real `accessibilityValue` (min/max/now/text), labelled
 *   increment/decrement actions, and a handler that performs the SAME seek the
 *   tap does, via the new `seekMillisForStep` rule in `voicePolicy.ts`.
 *
 * DEFECT A3 — PLAYBACK FAILURE WAS DRAWN, NEVER ANNOUNCED.
 *   RED: ✕ W6  expect(received).toBe("alert")  Received: undefined
 *   They press Play, nothing happens, and the explanation is painted below the
 *   row where nothing sends them. Indistinguishable from a missed tap.
 *   FIXED: `accessibilityRole="alert"` + `accessibilityLiveRegion="assertive"`,
 *   matching `IntelObservabilityDashboard.tsx`.
 *
 * DEFECT A4 — THE DURATION READ AS A NAKED NUMBER AND CHANGED MEANING SILENTLY.
 *   RED: ✕ W7  expect(received).toMatch(/length/i)  Received: undefined
 *   The same `<Text>` is the TOTAL length before playback and the REMAINING time
 *   during it. A sighted reader has the play/pause icon beside it to tell them
 *   which; "0:12" on its own does not.
 *   FIXED: an `accessibilityLabel` that names which.
 *
 * DEFECT A5 — THE RECORDER'S PHASE AND ERROR WERE DRAWN, NEVER ANNOUNCED.
 *   RED: ✕ R1  expect(received).toBe("polite")  Received: undefined
 *        ✕ R2  expect(received).toBe("alert")   Received: undefined
 *   The build lane's own header says a denied microphone permission "is stated,
 *   once, in words". It is — and it was never spoken, because the press that
 *   triggered it leaves focus on a Record button that is still there. The same
 *   is true of "Recording", which is the most consequential state this surface
 *   has: a microphone is open.
 *   FIXED: the phase line is a polite live region; the error is an assertive
 *   alert. R4 additionally hides the SENDING spinner, because the phase line
 *   already says "Sending…" as a live region and a second unlabelled node
 *   announcing nothing is noise.
 *
 * PROVEN BY MUTATION (already correct — mutate, red, revert; one run, 7 red):
 *   M1  VoiceMessagePlayer speed label
 *       MUTATION: `Playback speed ${speed}x. Tap to change.` → `Playback speed. Tap to change.`
 *       RED: ✕ S1. the speed control announces the CURRENT speed, and cycles back to 1x
 *       Reverted. The brief named this as one of the two likely failures on this
 *       surface. It was NOT one: the label interpolates the live `speed`.
 *   M2  VoiceMessagePlayer play/pause label
 *       MUTATION: {playing ? 'Pause…' : 'Play…'} → 'Play voice message'
 *       RED: ✕ P2. the play control's LABEL follows the state
 *       Reverted.
 *   M3  TypedMessageRenderer SAFETY word
 *       MUTATION: {safetyWord(p.kind)} → a single space
 *       RED: ✕ T1 × 4 (need_help, all_clear, heads_up, something_else)
 *       Reverted.
 *   M4  VoiceRecorderSheet button label
 *       MUTATION: accessibilityLabel="Start recording" deleted
 *       RED: ✕ R3. every control in the recorder has a role AND a label
 *       Reverted. All four reverts confirmed with `git diff --stat` and a
 *       re-run: 21 passed, 21 total.
 *
 * MODAL RULE 6 (src/components/__tests__/TESTING.md): `Modal` posts a macrotask
 * on mount that corrupts RNTL's act scope, so it is replaced with a synchronous
 * View. This file mounts ONE Modal-rooted component (the recorder sheet).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6. Only the `Modal` key is
// intercepted; every other react-native export falls through via Reflect.get,
// so this cannot go stale when react-native gains an export.
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

// `services/mediaUrl.ts` reaches `lib/supabase`, which builds a client at import
// time and throws outside an Expo runtime, so requiring the real module in order
// to spread it is exactly what cannot be done here.
// NOTE: intentional stub, exhaustive on purpose — same seam, same three keys as
// the neighbouring `voice.component.test.tsx`; the signed URL it returns is what
// the player hands to the sound factory.
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

// `voiceApi` reaches `lib/supabase` and `services/apiToken`, both of which build
// clients at import time, so `jest.requireActual` cannot be spread in either.
// NOTE: intentional stub, exhaustive on purpose — the recorder takes both of
// these as explicit props in every case below, so this factory only has to keep
// the module importable.
jest.mock('../voice/voiceApi.ts', () => ({
  uploadVoiceRecording: jest.fn(),
  sendVoiceMessage: jest.fn(),
}));

import { VoiceMessagePlayer, type VoiceSoundHandle } from '../voice/VoiceMessagePlayer.tsx';
import { VoiceRecorderSheet, type VoiceRecorderHandle } from '../voice/VoiceRecorderSheet.tsx';
import { TypedMessageRenderer } from '../kinds/TypedMessageRenderer.tsx';
import {
  ACCESSIBILITY_SEEK_STEP_SECONDS,
  WAVEFORM_BARS,
  seekMillisForStep,
} from '../voice/voicePolicy.ts';

const URL_REF = 'post-media/u1/voice/1700000000000.m4a';

function makeSound(): VoiceSoundHandle & { _statusCb: null | ((s: any) => void) } {
  const s: any = {
    _statusCb: null,
    playAsync: jest.fn(async () => {}),
    pauseAsync: jest.fn(async () => {}),
    setRateAsync: jest.fn(async () => {}),
    setPositionAsync: jest.fn(async () => {}),
    unloadAsync: jest.fn(async () => {}),
    setOnPlaybackStatusUpdate: jest.fn((cb: (s: any) => void) => {
      s._statusCb = cb;
    }),
  };
  return s;
}

async function mountPlayer(
  over: Partial<React.ComponentProps<typeof VoiceMessagePlayer>> = {},
  sound?: VoiceSoundHandle,
) {
  const s = sound ?? makeSound();
  const view = await render(
    <VoiceMessagePlayer
      url={URL_REF}
      durationSeconds={60}
      waveform={Array.from({ length: 120 }, (_, i) => (i % 10) / 10)}
      createSound={async () => s}
      {...over}
    />,
  );
  return { view, sound: s as any };
}

/* ============================================================================
 * W. The waveform — decoration that was reaching the screen reader, and a seek
 *    that was reachable only by pointing at a pixel.
 * ==========================================================================*/

describe('VoiceMessagePlayer — the waveform', () => {
  it('W1. the bars are DECORATIVE and are UNREACHABLE by a screen reader', async () => {
    await mountPlayer();
    // The strongest form this assertion takes: RNTL's default queries walk the
    // ACCESSIBILITY tree, so a bar that a default query cannot find is a bar a
    // reader cannot land on. Before the fix all 48 were findable.
    expect(screen.queryByTestId('telegraph-voice-bars')).toBeNull();
    expect(screen.queryByTestId('telegraph-voice-bar-0')).toBeNull();
    expect(screen.queryByTestId(`telegraph-voice-bar-${WAVEFORM_BARS - 1}`)).toBeNull();

    // …and they are HIDDEN, not GONE. The waveform is the point of the control
    // for everyone who can see it, so removing it would trade one group's
    // experience for another's.
    const bars = screen.getByTestId('telegraph-voice-bars', { includeHiddenElements: true });
    expect(bars.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(bars.props.accessibilityElementsHidden).toBe(true);
    expect(
      screen.getByTestId(`telegraph-voice-bar-${WAVEFORM_BARS - 1}`, { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it('W2. the seek control exposes an accessibilityValue, because it claims `adjustable`', async () => {
    await mountPlayer({ durationSeconds: 60 });
    const wave = screen.getByTestId('telegraph-voice-wave');
    expect(wave.props.accessibilityRole).toBe('adjustable');
    const value = wave.props.accessibilityValue;
    expect(value).toBeTruthy();
    expect(value.min).toBe(0);
    expect(value.max).toBe(60);
    expect(value.now).toBe(0);
    // `text` is what is actually spoken. A bare `now: 0` reads as "0 percent",
    // which is not what a position in a recording sounds like.
    expect(String(value.text)).toContain('0:00');
    expect(String(value.text)).toContain('1:00');
  });

  it('W3. the seek control exposes increment and decrement actions', async () => {
    await mountPlayer();
    const wave = screen.getByTestId('telegraph-voice-wave');
    const names = (wave.props.accessibilityActions ?? []).map((a: any) => a.name);
    expect(names).toEqual(expect.arrayContaining(['increment', 'decrement']));
    // Labelled, so the rotor says what the action does rather than "increment".
    for (const a of wave.props.accessibilityActions) {
      expect(typeof a.label).toBe('string');
      expect(a.label.length).toBeGreaterThan(0);
    }
    expect(typeof wave.props.onAccessibilityAction).toBe('function');
  });

  it('W4. increment SEEKS — the gesture-free equivalent of the tap', async () => {
    // This is question 4. Before the fix, seeking existed only as
    // `onPress(e.nativeEvent.locationX)`: a tap at a horizontal pixel. There was
    // no keyboard, switch-control or screen-reader route to it at all.
    const { sound } = await mountPlayer({ durationSeconds: 60 });
    const wave = screen.getByTestId('telegraph-voice-wave');

    await act(async () => {
      fireEvent(wave, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    });
    expect(sound.setPositionAsync).toHaveBeenCalledWith(ACCESSIBILITY_SEEK_STEP_SECONDS * 1000);

    // And the announced value follows the playhead, or the control tells the
    // person nothing moved.
    expect(screen.getByTestId('telegraph-voice-wave').props.accessibilityValue.now).toBe(
      ACCESSIBILITY_SEEK_STEP_SECONDS,
    );
  });

  it('W5. decrement at the start CLAMPS rather than seeking to a negative position', async () => {
    const { sound } = await mountPlayer({ durationSeconds: 60 });
    await act(async () => {
      fireEvent(screen.getByTestId('telegraph-voice-wave'), 'accessibilityAction', {
        nativeEvent: { actionName: 'decrement' },
      });
    });
    expect(sound.setPositionAsync).toHaveBeenCalledWith(0);
  });

  it('W5b. the step rule is pure and clamps at BOTH ends', () => {
    // Asserted directly, for the reason voicePolicy.ts's own header gives: a
    // seek that lands one bar off is a rule a renderer gets subtly wrong and
    // nobody notices.
    expect(seekMillisForStep(0, 60, -1)).toBe(0);
    expect(seekMillisForStep(0, 60, 1)).toBe(ACCESSIBILITY_SEEK_STEP_SECONDS * 1000);
    expect(seekMillisForStep(59_000, 60, 1)).toBe(60_000);
    expect(seekMillisForStep(30_000, 60, -1)).toBe((30 - ACCESSIBILITY_SEEK_STEP_SECONDS) * 1000);
    // A voice note whose duration failed to load must not seek to NaN.
    expect(seekMillisForStep(0, 0, 1)).toBe(0);
    expect(seekMillisForStep(Number.NaN, 60, 1)).toBe(ACCESSIBILITY_SEEK_STEP_SECONDS * 1000);
  });
});

/* ============================================================================
 * P/S. The two controls beside it.
 * ==========================================================================*/

describe('VoiceMessagePlayer — the controls and the state', () => {
  it('P1. the play control has a role and a label naming what it plays', async () => {
    await mountPlayer();
    const toggle = screen.getByTestId('telegraph-voice-toggle');
    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityLabel).toBe('Play voice message');
  });

  it('P2. the play control\'s LABEL follows the state — the icon is not the only signal', async () => {
    const { sound } = await mountPlayer();
    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-toggle'));
    });
    expect(sound.playAsync).toHaveBeenCalled();
    const toggle = screen.getByTestId('telegraph-voice-toggle');
    expect(toggle.props.accessibilityLabel).toBe('Pause voice message');
    // …and the state is on the node too, so a reader that announces state
    // rather than re-reading the label still says something true.
    expect(toggle.props.accessibilityState.selected).toBe(true);
  });

  it('S1. the speed control announces the CURRENT speed, and cycles back to 1x', async () => {
    // Named in the brief as one of the two likely failures on this surface. It
    // is not one: the label interpolates `speed` rather than saying "Speed".
    await mountPlayer();
    const read = () => screen.getByTestId('telegraph-voice-speed').props.accessibilityLabel;
    expect(read()).toContain('1x');

    for (const expected of ['1.5x', '2x', '1x']) {
      await act(async () => {
        fireEvent.press(screen.getByTestId('telegraph-voice-speed'));
      });
      expect(read()).toContain(expected);
    }
    expect(screen.getByTestId('telegraph-voice-speed').props.accessibilityRole).toBe('button');
  });

  it('W6. a playback failure is ANNOUNCED, not just drawn', async () => {
    const { sound } = await mountPlayer({}, {
      ...makeSound(),
      playAsync: jest.fn(async () => {
        throw new Error('decoder refused');
      }),
    } as any);
    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-toggle'));
    });
    void sound;
    const err = screen.getByTestId('telegraph-voice-error');
    expect(err.props.accessibilityRole).toBe('alert');
    expect(err.props.accessibilityLiveRegion).toBe('assertive');
    // Colour is not the signal: the failure is a sentence.
    expect(screen.getByText('This voice message could not be played.')).toBeTruthy();
  });

  it('W7. the duration says WHICH duration it is', async () => {
    // The same Text is the TOTAL before playback and the REMAINING during it.
    // "0:12" alone does not say which.
    const { sound } = await mountPlayer({ durationSeconds: 60 });
    const before = screen.getByTestId('telegraph-voice-duration').props.accessibilityLabel;
    expect(String(before)).toMatch(/length/i);
    expect(String(before)).toContain('1:00');

    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-toggle'));
    });
    await act(async () => {
      sound._statusCb?.({ isLoaded: true, isPlaying: true, positionMillis: 15_000 });
    });
    const during = screen.getByTestId('telegraph-voice-duration').props.accessibilityLabel;
    expect(String(during)).toMatch(/remaining|left/i);
  });
});

/* ============================================================================
 * R. The recorder — the one surface where the state is "a microphone is open".
 * ==========================================================================*/

function makeRecorder() {
  const r: any = {
    _cb: null as null | ((s: any) => void),
    stopAndUnloadAsync: jest.fn(async () => {}),
    getURI: jest.fn(() => 'file:///tmp/rec.m4a'),
    setOnRecordingStatusUpdate: jest.fn((cb: (s: any) => void) => {
      r._cb = cb;
    }),
    setProgressUpdateInterval: jest.fn(),
  };
  return r as VoiceRecorderHandle & { _cb: null | ((s: any) => void) };
}

describe('VoiceRecorderSheet — recording is a state, and it must be heard', () => {
  it('R1. the phase line is a LIVE REGION, so starting to record is announced', async () => {
    const rec = makeRecorder();
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        createRecorder={async () => ({ ok: true, recorder: rec })}
      />,
    );
    const phase = screen.getByTestId('telegraph-voice-recorder-phase');
    expect(phase.props.accessibilityLiveRegion).toBe('polite');

    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-record'));
    });
    await act(async () => {
      (rec as any)._cb?.({ durationMillis: 3000, metering: -20 });
    });
    // The text itself already carried the word (the build lane got §11.3
    // right); what was missing was any reason for a reader to speak it.
    expect(
      String(screen.getByTestId('telegraph-voice-recorder-phase').props.children ?? ''),
    ).toMatch(/Recording/);
    expect(
      screen.getByTestId('telegraph-voice-recorder-phase').props.accessibilityLiveRegion,
    ).toBe('polite');
  });

  it('R2. a DENIED microphone permission is announced, not just printed', async () => {
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        createRecorder={async () => ({ ok: false, reason: 'permission' })}
      />,
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-record'));
    });
    const err = screen.getByTestId('telegraph-voice-recorder-error');
    expect(err.props.accessibilityRole).toBe('alert');
    expect(err.props.accessibilityLiveRegion).toBe('assertive');
    expect(String(err.props.children)).toMatch(/microphone access/i);
  });

  it('R3. every control in the recorder has a role AND a label', async () => {
    const rec = makeRecorder();
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        createRecorder={async () => ({ ok: true, recorder: rec })}
      />,
    );
    const expectLabelled = (id: string, label: string) => {
      const n = screen.getByTestId(id);
      expect(n.props.accessibilityRole).toBe('button');
      expect(n.props.accessibilityLabel).toBe(label);
    };
    expectLabelled('telegraph-voice-record', 'Start recording');
    expectLabelled('telegraph-voice-close', 'Close');

    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-record'));
    });
    expectLabelled('telegraph-voice-stop', 'Stop recording');

    await act(async () => {
      (rec as any)._cb?.({ durationMillis: 4000, metering: -20 });
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-stop'));
    });
    expectLabelled('telegraph-voice-discard', 'Discard recording');
    expectLabelled('telegraph-voice-send', 'Send voice message');
  });

  it('R4. the SENDING spinner is labelled — a bare ActivityIndicator says nothing', async () => {
    // Between pressing Send and the thread reloading there is an indeterminate
    // wait whose only marker was a spinning arc. The phase line covers it in
    // words, and the spinner itself must not be an unlabelled node next to it.
    const rec = makeRecorder();
    await render(
      <VoiceRecorderSheet
        visible
        threadId="t1"
        onClose={() => {}}
        createRecorder={async () => ({ ok: true, recorder: rec })}
        upload={jest.fn(async () => new Promise(() => {})) as any}
      />,
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-record'));
    });
    await act(async () => {
      (rec as any)._cb?.({ durationMillis: 4000, metering: -20 });
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-stop'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('telegraph-voice-send'));
    });
    // Not reachable by a default (accessibility-tree) query, because the phase
    // line beside it already says "Sending…" and says it as a live region. A
    // second unlabelled node announcing nothing is noise, not information.
    expect(screen.queryByTestId('telegraph-voice-sending')).toBeNull();
    const spinner = screen.getByTestId('telegraph-voice-sending', { includeHiddenElements: true });
    expect(spinner.props.accessibilityElementsHidden).toBe(true);
    expect(spinner.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(screen.getByText('Sending…')).toBeTruthy();
    expect(
      screen.getByTestId('telegraph-voice-recorder-phase').props.accessibilityLiveRegion,
    ).toBe('polite');
  });
});

/* ============================================================================
 * T. The typed-kind renderer — the colour question.
 * ==========================================================================*/

describe('TypedMessageRenderer — meaning is never carried by colour alone', () => {
  // The stored envelope shape `parseKindEnvelope` accepts: kind, version, payload.
  const body = (kind: string, payload: unknown) =>
    JSON.stringify({ kind, envelopeVersion: '1', payload });

  // §11.1 reserves the attention colour for safety, and a 2px red border is the
  // entire visual difference between a SAFETY card and a LOCATION one. One
  // mount per case: RNTL cleans up between tests, and three mounts inside one
  // test leaves `screen` pointing at whichever tree rendered last.
  it.each([
    ['need_help', 'NEEDS HELP'],
    ['all_clear', 'ALL CLEAR'],
    ['heads_up', 'HEADS UP'],
    ['something_else', 'CHECK-IN'],
  ])('T1. SAFETY %s states its kind in WORDS, not in the attention colour', async (kind, word) => {
    await render(
      <TypedMessageRenderer
        msgType="safety"
        mine={false}
        body={body('SAFETY', { kind, label: 'Ben Thanh' })}
      />,
    );
    expect(screen.getByText(word)).toBeTruthy();
  });

  it('T2. the VOICE arm renders the player, so the waveform fix reaches the thread', async () => {
    // The player is reached through the STORED ENVELOPE, not the send path, so
    // a11y fixes made in the player are only real if this dispatch uses it.
    await render(
      <TypedMessageRenderer
        msgType="voice"
        mine={false}
        body={body('VOICE', { url: URL_REF, durationSeconds: 30, waveform: [0.2, 0.4] })}
      />,
    );
    expect(screen.getByTestId('telegraph-kind-voice')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-voice-bars')).toBeNull();
    expect(screen.getByTestId('telegraph-voice-wave').props.accessibilityValue).toBeTruthy();
  });

  it('T3. the two inert-affordance notices are TEXT, so they are readable at all', async () => {
    // A surface that cannot confirm an ACTION or acknowledge an ANNOUNCEMENT
    // says so. If it said so only by omitting a button, a screen-reader user
    // would have no way to know the affordance was ever meant to be there.
    await render(
      <TypedMessageRenderer msgType="action" mine={false} body={body('ACTION', { title: 'Meet at 7', action: 'meet_up' })} />,
    );
    expect(screen.getByText('Confirmation is not available on this screen')).toBeTruthy();
  });
});
