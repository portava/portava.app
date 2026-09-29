/**
 * Global Input Intelligence — the microphone beside a field (§25, flow GII-F09).
 *
 * Always visible, never lying: on a build with no speech recognizer the button
 * shows a struck-through microphone and, when tapped, SAYS voice input is not
 * available here — it neither disappears (which reads as "this app has no
 * voice input by design") nor pretends to listen.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Mic, MicOff, Square } from 'lucide-react-native';
import { color, icon as iconToken, radius, space, type as t } from '../../../theme/tokens.ts';
import type { InputContext } from '../types/inputContext.ts';
import { useVoiceDictation } from '../hooks/useVoiceDictation.ts';
import type { SpeechRecognizerPort } from './speechRecognizer.ts';

export interface VoiceDictationButtonProps {
  fieldId: string;
  context: InputContext;
  onTranscript: (text: string) => void;
  language?: string | null;
  recognizer?: SpeechRecognizerPort;
}

export function VoiceDictationButton({ fieldId, context, onTranscript, language, recognizer }: VoiceDictationButtonProps) {
  const { state, start, stop } = useVoiceDictation({ fieldId, context, onTranscript, language, recognizer });
  const [explain, setExplain] = React.useState(false);

  const listening = state.phase === 'listening';
  const unavailable = state.phase === 'unavailable';
  const onPress = () => {
    if (state.phase === 'checking') return;
    if (unavailable) { setExplain((v) => !v); return; }
    if (listening) { stop(); return; }
    void start();
  };

  const message =
    state.phase === 'unavailable' ? (explain ? state.message : null)
      : state.phase === 'listening' ? (state.partial ? `“${state.partial}”` : 'Listening…')
        : state.phase === 'heard' ? 'Added what you said.'
          : state.phase === 'refused' || state.phase === 'error' ? state.message
            : null;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={listening ? 'Stop dictation' : unavailable ? 'Voice input unavailable' : 'Dictate'}
        accessibilityState={{ disabled: unavailable || state.phase === 'checking', busy: listening }}
        style={[styles.btn, listening && styles.btnOn, unavailable && styles.btnOff]}
        hitSlop={6}
        testID="voice-dictate"
      >
        {state.phase === 'checking' ? (
          <ActivityIndicator size="small" color={color.mute} />
        ) : listening ? (
          <Square size={iconToken.s16} color={color.onInk} />
        ) : unavailable ? (
          <MicOff size={iconToken.s18} color={color.mute} />
        ) : (
          <Mic size={iconToken.s18} color={color.deep} />
        )}
      </Pressable>
      {message ? (
        <Text
          style={[styles.msg, (state.phase === 'error' || state.phase === 'refused') && styles.msgBad]}
          accessibilityLiveRegion="polite"
          testID="voice-dictate-status"
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.xs, maxWidth: 120 },
  btn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  btnOn: { backgroundColor: color.deep, borderColor: color.deep },
  btnOff: { opacity: 0.7 },
  msg: { ...t.small, color: color.mute, textAlign: 'center' },
  msgBad: { color: color.ink, fontWeight: '600' },
});
