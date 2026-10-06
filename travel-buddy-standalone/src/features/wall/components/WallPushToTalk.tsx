/**
 * The Wall steer bar's microphone — PUSH-TO-TALK, on the device (census-wall
 * W71; owner decision OD-TRUST-8).
 *
 * OD-TRUST-8 (docs/ops/owner-decisions-20261004.md): "On-device recognition by
 * default. Use push-to-talk; ask separately before any audio leaves the device,
 * and don't retain raw audio by default."
 *
 * HOW EACH CLAUSE IS MET, AND WHERE
 * - Push-to-talk: listening runs only while the control is HELD. Press-in
 *   starts the platform recognizer; release stops it and whatever was final is
 *   used. A release before the recognizer has even started starts nothing
 *   (pushToTalkPort, below). (The platform-wide VoiceDictationButton is
 *   tap-to-toggle — one tap on, another off — which is not push-to-talk; the
 *   Wall does not use it.)
 * - On-device: this control never names a provider. It uses the shared
 *   recognizer resolution (platform/input-assistance — lane D's), whose job is
 *   to answer "unavailable" rather than route audio to a cloud service; and it
 *   installs no transcription provider of its own. No consent screen is shown
 *   because no path here can send audio off the device — if one is ever added,
 *   the separate ask OD-TRUST-8 requires belongs in front of it.
 * - No raw audio kept: the recognizer port returns text only; nothing here
 *   receives, stores or uploads audio.
 * - Same engine as typing (W71's own sentence): the transcript is handed to the
 *   steer field as if typed, and from there it is ordinary text in the shared
 *   Global Input Intelligence pipeline. Nothing is submitted for the person;
 *   they see what was heard and press search themselves.
 *
 * Every state is said in words, never only by an icon: unavailable, listening,
 * heard, not understood. A build with no recognizer shows the control struck
 * through and says why when touched, rather than hiding it.
 *
 * WHAT A DEVICE MUST STILL SHOW (not provable here): that a release on a real
 * handset ends capture at once, that the OS recognizer runs on-device for the
 * language, and that the microphone indicator clears on release. These need an
 * EAS build with a native speech module (expo-speech-recognition is not a
 * dependency of this app today).
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Mic, MicOff } from 'lucide-react-native';
import { color, icon as iconToken, radius, type as t } from '../../../theme/tokens.ts';
import type { InputContext } from '../../../platform/input-assistance/types/inputContext.ts';
import { useVoiceDictation } from '../../../platform/input-assistance/hooks/useVoiceDictation.ts';
import { resolveSpeechRecognizer, type SpeechRecognizerPort } from '../../../platform/input-assistance/voice/speechRecognizer.ts';

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
  return {
    providerId: inner.providerId,
    isAvailable: () => inner.isAvailable(),
    recognizeOnce(opts = {}) {
      if (opts.signal?.aborted) {
        return Promise.resolve({ ok: false, unavailable: false, reason: 'capture_failed', error: 'Released before listening started.' });
      }
      return inner.recognizeOnce(opts);
    },
  };
}

export const WALL_PTT_HINT = 'Press and hold to speak, release to stop. Your voice is recognised on this device.';

export function WallPushToTalk({ fieldId, context, onTranscript, disabled = false, recognizer }: WallPushToTalkProps) {
  const port = React.useMemo(() => pushToTalkPort(recognizer ?? resolveSpeechRecognizer()), [recognizer]);
  const { state, start, stop } = useVoiceDictation({ fieldId, context, onTranscript, recognizer: port });
  const [explain, setExplain] = React.useState(false);
  const holding = React.useRef(false);

  const unavailable = state.phase === 'unavailable';
  const listening = state.phase === 'listening';
  const checking = state.phase === 'checking';

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
    unavailable ? (explain ? state.message : null)
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
        accessibilityHint={unavailable ? undefined : WALL_PTT_HINT}
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
