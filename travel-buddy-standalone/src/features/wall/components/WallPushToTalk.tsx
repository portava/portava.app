/**
 * The Wall steer bar's microphone — PUSH-TO-TALK, and ON THE DEVICE OR NOT AT
 * ALL (census-wall W71; owner decisions OD-TRUST-8 and OD-INPUT-5).
 *
 * OD-TRUST-8 (docs/ops/owner-decisions-20261004.md): "On-device recognition by
 * default. Use push-to-talk; ask separately before any audio leaves the device,
 * and don't retain raw audio by default." OD-INPUT-5: "Send audio to a cloud
 * provider only with separate, explicit consent."
 *
 * HOW EACH CLAUSE IS MET, AND WHERE
 * - On-device only. This control accepts ONLY a recognizer that declares
 *   `onDeviceOnly: true` (`isOnDeviceOnly`, below) and treats every other one —
 *   including the browser's Web Speech API, which the shared resolver falls
 *   back to on the web build and which may process audio on a server — as
 *   UNAVAILABLE. No recognizer in this tree declares it today, so on every
 *   build the Wall's microphone says, truthfully, that it is not available.
 *   (Corrected 2026-10-06 after independent verification: the first version
 *   used whatever the shared resolver returned, so on the web build it would
 *   have sent a person's voice to the browser vendor with no consent asked.)
 *   There is therefore no consent screen: no path here sends audio anywhere.
 * - Push-to-talk: listening runs only while the control is HELD. Press-in
 *   starts the recognizer; release stops it and whatever was final is used. A
 *   release before the recognizer has even started starts nothing
 *   (pushToTalkPort). The platform VoiceDictationButton is tap-to-toggle,
 *   which is not push-to-talk; the Wall does not use it.
 * - No raw audio kept: the recognizer port returns text only; nothing here
 *   receives, stores or uploads audio.
 * - Same engine as typing (W71's own sentence): the transcript is handed to the
 *   steer field as if typed; nothing is submitted for the person.
 * - Behind the Wall's flag: the control renders only when `wall_enabled` is on
 *   (unknown or still loading = off), so a deep link to a dark Wall shows no
 *   microphone.
 *
 * WHAT A DEVICE MUST STILL SHOW (not provable here): an on-device native
 * recognizer (none is a dependency of this app), that release ends capture at
 * once, and that the microphone indicator clears on release.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Mic, MicOff } from 'lucide-react-native';
import { color, icon as iconToken, radius, type as t } from '../../../theme/tokens.ts';
import type { InputContext } from '../../../platform/input-assistance/types/inputContext.ts';
import { useVoiceDictation } from '../../../platform/input-assistance/hooks/useVoiceDictation.ts';
import { resolveSpeechRecognizer, type SpeechRecognizerPort } from '../../../platform/input-assistance/voice/speechRecognizer.ts';
import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx';

export interface WallPushToTalkProps {
  fieldId: string;
  context: InputContext;
  /** Receives the transcript as if it had been typed. Never submits. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** Injected in tests; defaults to the platform's on-device recognizer. */
  recognizer?: SpeechRecognizerPort;
}

/**
 * A release that lands BEFORE the recognizer has started must start nothing.
 *
 * useVoiceDictation awaits the recognizer's availability check before calling
 * `recognizeOnce`, and both platform adapters attach their abort listener only
 * when they start — so an AbortSignal that fired during that wait is never
 * seen, and the recognizer would go on listening after the finger lifted. That
 * is the one thing push-to-talk must never do. This wrapper refuses to start a
 * session whose signal is already aborted. (The adapters' own window — the
 * native permission prompt is awaited before the listener exists — is lane D's
 * file and is recorded there as a dependency.)
 */
export function pushToTalkPort(inner: SpeechRecognizerPort): SpeechRecognizerPort {
  const onDevice = isOnDeviceOnly(inner);
  return {
    providerId: inner.providerId,
    // A recognizer that does not GUARANTEE on-device processing is not one
    // this control may use, whatever it says about its own availability.
    isAvailable: async () => (onDevice ? inner.isAvailable() : false),
    recognizeOnce(opts = {}) {
      if (opts.signal?.aborted) {
        return Promise.resolve({ ok: false, unavailable: false, reason: 'capture_failed', error: 'Released before listening started.' });
      }
      return inner.recognizeOnce(opts);
    },
  };
}

/** A recognizer that guarantees audio never leaves the device. */
export interface OnDeviceSpeechRecognizerPort extends SpeechRecognizerPort {
  readonly onDeviceOnly: true;
}

/** Only an explicit, literal `onDeviceOnly: true` counts; absence is "may go to a server". */
export function isOnDeviceOnly(port: SpeechRecognizerPort): port is OnDeviceSpeechRecognizerPort {
  return (port as { onDeviceOnly?: unknown }).onDeviceOnly === true;
}

export const WALL_PTT_UNAVAILABLE =
  'Voice input here needs speech recognition that runs on this device, and this build doesn’t have it. ' +
  'Your voice is never sent to an online service.';

export const WALL_PTT_HINT = 'Press and hold to speak, release to stop. Your voice is recognised on this device.';

export function WallPushToTalk(props: WallPushToTalkProps) {
  // isEnabled() is false for an unknown key and while the first fetch is in
  // flight, so a dark Wall reached by deep link shows no microphone.
  const { isEnabled } = useFeatureFlags();
  if (!isEnabled('wall_enabled')) return null;
  return <WallPushToTalkControl {...props} />;
}

function WallPushToTalkControl({ fieldId, context, onTranscript, disabled = false, recognizer }: WallPushToTalkProps) {
  const port = React.useMemo(() => pushToTalkPort(recognizer ?? resolveSpeechRecognizer()), [recognizer]);
  const { state, start, stop } = useVoiceDictation({ fieldId, context, onTranscript, recognizer: port });
  const [explain, setExplain] = React.useState(false);
  const holding = React.useRef(false);

  const unavailable = state.phase === 'unavailable';
  const listening = state.phase === 'listening';
  const checking = state.phase === 'checking';
  /** Availability CONFIRMED on the device — the only state in which the hint is true. */
  const available = !checking && !unavailable;

  const onPressIn = () => {
    if (disabled || checking) return;
    if (unavailable) { setExplain(true); return; }
    holding.current = true;
    void start();
  };
  const onPressOut = () => {
    if (!holding.current) return;
    holding.current = false;
    stop();
  };

  const message =
    unavailable ? (explain ? WALL_PTT_UNAVAILABLE : null)
      : listening ? (state.partial ? `“${state.partial}”` : 'Listening — release to stop')
        : state.phase === 'heard' ? 'Added what you said — press search to steer.'
          : state.phase === 'refused' || state.phase === 'error' ? state.message
            : null;

  return (
    <View style={s.wrap}>
      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={unavailable ? 'Voice input unavailable' : listening ? 'Listening' : 'Hold to talk'}
        accessibilityHint={available ? WALL_PTT_HINT : undefined}
        accessibilityState={{ disabled: disabled || unavailable || checking, busy: listening }}
        hitSlop={8}
        style={[s.btn, listening && s.btnOn, (unavailable || disabled) && s.btnOff]}
        testID="wall-ptt"
      >
        {checking ? (
          <ActivityIndicator size="small" color={color.mute} />
        ) : unavailable ? (
          <MicOff size={iconToken.s16} color={color.mute} />
        ) : (
          <Mic size={iconToken.s16} color={listening ? color.onInk : color.deep} />
        )}
      </Pressable>
      {message ? (
        <Text
          style={[s.msg, (state.phase === 'error' || state.phase === 'refused') && s.msgBad]}
          accessibilityLiveRegion="polite"
          numberOfLines={2}
          testID="wall-ptt-status"
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { alignItems: 'flex-end', maxWidth: 140 },
  btn: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnOn: { backgroundColor: color.ink },
  btnOff: { opacity: 0.6 },
  msg: { ...t.small, color: color.deep, textAlign: 'right' },
  msgBad: { color: color.ink },
});
