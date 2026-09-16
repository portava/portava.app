/**
 * Telegraph §6.1 — the composer's Voice entry, as a recorder.
 *
 * Spec §6.1: "[ + ]  Message…  [🎤]" and the `+` menu's Voice entry.
 *
 * ── THE SHAPE OF THE FLOW, AND WHY EACH STEP IS WHERE IT IS ─────────────────
 *   idle → recording → review → sending → (sent | failed)
 *
 * There is a REVIEW step, and it is not decoration. A voice note is the one
 * message kind a traveller cannot proof-read before sending, and this is a
 * messaging surface where an unsend does not exist on every deployment. So the
 * recording stops, the traveller hears what they are about to send, and sending
 * is a second, separate press. Discard is always available and is destructive
 * only to the local file.
 *
 * ── THE CEILING IS ENFORCED BY THE RECORDER, NOT BY THE SERVER'S 400 ────────
 * `recordingShouldStop` is checked on every meter tick, so a recording ENDS at
 * the ceiling. Letting it run and refusing it afterwards would mean the
 * traveller records six minutes and is then told the message cannot be sent —
 * the failure mode `composerMenu.ts` was written to avoid in the first place.
 *
 * ── PERMISSION ──────────────────────────────────────────────────────────────
 * A denied microphone permission is stated, once, in words, with no retry loop.
 * The sheet closes and the traveller is left where they were; it does not open
 * Settings on their behalf.
 *
 * ── WHAT IS INJECTED, AND WHY ───────────────────────────────────────────────
 * `expo-av`'s recorder is native and cannot run in a component test. It is
 * reached through `createRecorder`, which production leaves undefined (the real
 * module is then imported lazily, so a thread with no voice note never loads
 * it) and a test supplies. The same is true of `upload`/`send`. Everything
 * else in this file — the state machine, the ceiling, the waveform assembly,
 * the refusal to send a fumble — is ordinary code and is tested.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { Mic, Square, Trash2, Send } from 'lucide-react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  VOICE_MAX_DURATION_SECONDS,
  WAVEFORM_MAX_PEAKS,
  downsampleWaveform,
  formatDuration,
  isSendableRecording,
  meteringToAmplitude,
  recordingShouldStop,
} from './voicePolicy.ts';
import { uploadVoiceRecording, sendVoiceMessage } from './voiceApi.ts';

/** The slice of `expo-av`'s `Audio.Recording` this sheet uses. */
export interface VoiceRecorderHandle {
  stopAndUnloadAsync(): Promise<unknown>;
  getURI(): string | null;
  setOnRecordingStatusUpdate(cb: (status: any) => void): void;
  setProgressUpdateInterval(ms: number): void;
}

export type RecorderFactory = () => Promise<
  { ok: true; recorder: VoiceRecorderHandle } | { ok: false; reason: 'permission' | 'error' }
>;

async function createExpoAvRecorder(): ReturnType<RecorderFactory> {
  try {
    const { Audio } = await import('expo-av');
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'permission' };
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const { recording } = await Audio.Recording.createAsync({
      ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
    return { ok: true, recorder: recording as unknown as VoiceRecorderHandle };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

type Phase = 'idle' | 'recording' | 'review' | 'sending';

export interface VoiceRecorderSheetProps {
  visible: boolean;
  threadId: string;
  onClose: () => void;
  /** Called after the message is written, so the thread can reload. */
  onSent?: () => void;
  replyToId?: string | null;
  /** Test seams. Production passes none of these. */
  createRecorder?: RecorderFactory;
  upload?: typeof uploadVoiceRecording;
  send?: typeof sendVoiceMessage;
}

export function VoiceRecorderSheet({
  visible,
  threadId,
  onClose,
  onSent,
  replyToId = null,
  createRecorder,
  upload = uploadVoiceRecording,
  send = sendVoiceMessage,
}: VoiceRecorderSheetProps) {
  const palette = useTelegraphPalette();
  const styles = React.useMemo(() => makeStyles(palette), [palette]);

  const [phase, setPhase] = React.useState<Phase>('idle');
  const [elapsed, setElapsed] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [localUri, setLocalUri] = React.useState<string | null>(null);

  const recorderRef = React.useRef<VoiceRecorderHandle | null>(null);
  const peaksRef = React.useRef<number[]>([]);
  const finalWaveRef = React.useRef<number[]>([]);
  const finalSecondsRef = React.useRef(0);
  // Guards the ceiling stop from re-entering while the async stop is running.
  const stoppingRef = React.useRef(false);

  const reset = React.useCallback(() => {
    setPhase('idle');
    setElapsed(0);
    setError(null);
    setLocalUri(null);
    peaksRef.current = [];
    finalWaveRef.current = [];
    finalSecondsRef.current = 0;
    stoppingRef.current = false;
  }, []);

  // A sheet that closes mid-recording must not leave the microphone open.
  React.useEffect(() => {
    if (visible) return;
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec) void rec.stopAndUnloadAsync().catch(() => {});
    reset();
  }, [visible, reset]);

  const finishRecording = React.useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) {
      setPhase('idle');
      stoppingRef.current = false;
      return;
    }
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      finalWaveRef.current = downsampleWaveform(peaksRef.current, WAVEFORM_MAX_PEAKS);
      if (!uri) {
        setError('The recording could not be saved.');
        setPhase('idle');
        return;
      }
      setLocalUri(uri);
      setPhase('review');
    } catch {
      setError('The recording could not be saved.');
      setPhase('idle');
    } finally {
      stoppingRef.current = false;
    }
  }, []);

  const startRecording = React.useCallback(async () => {
    setError(null);
    peaksRef.current = [];
    setElapsed(0);
    finalSecondsRef.current = 0;
    const make = createRecorder ?? createExpoAvRecorder;
    const started = await make();
    if (!started.ok) {
      setError(
        started.reason === 'permission'
          ? 'Portava needs microphone access to record a voice message. You can turn it on in your device settings.'
          : 'The microphone could not be started.',
      );
      setPhase('idle');
      return;
    }
    const rec = started.recorder;
    recorderRef.current = rec;
    rec.setProgressUpdateInterval(200);
    rec.setOnRecordingStatusUpdate((status: any) => {
      const millis = typeof status?.durationMillis === 'number' ? status.durationMillis : 0;
      const seconds = millis / 1000;
      finalSecondsRef.current = seconds;
      setElapsed(seconds);
      peaksRef.current.push(meteringToAmplitude(status?.metering));
      // The ceiling is the RECORDER's, not the server's 400.
      if (recordingShouldStop(seconds)) void finishRecording();
    });
    setPhase('recording');
  }, [createRecorder, finishRecording]);

  const onSend = React.useCallback(async () => {
    if (!localUri) return;
    const seconds = Math.round(finalSecondsRef.current);
    if (!isSendableRecording(seconds)) {
      // A mis-tap on the mic button. Discard it rather than collecting a 400.
      setError('That recording was too short to send.');
      setPhase('idle');
      setLocalUri(null);
      return;
    }
    setPhase('sending');
    setError(null);

    const uploaded = await upload(localUri, 'audio/mp4');
    if (!uploaded.ok) {
      setError(uploaded.message ?? 'The recording could not be uploaded.');
      setPhase('review');
      return;
    }

    const sent = await send(
      threadId,
      {
        url: uploaded.data.url,
        durationSeconds: seconds,
        waveform: finalWaveRef.current,
        mimeType: uploaded.data.mimeType,
        sizeBytes: uploaded.data.sizeBytes,
      },
      { replyToId },
    );
    if (!sent.ok) {
      setError(sent.message ?? 'The voice message could not be sent.');
      setPhase('review');
      return;
    }
    onSent?.();
    onClose();
  }, [localUri, upload, send, threadId, replyToId, onSent, onClose]);

  if (!visible) return null;

  const remaining = Math.max(0, VOICE_MAX_DURATION_SECONDS - Math.floor(elapsed));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="telegraph-voice-recorder">
          <Text style={styles.title}>Voice message</Text>

          {/*
            §11.3 — the state is a WORD, never a colour alone. And a LIVE
            REGION: "Recording" is the most consequential state this surface
            has (a microphone is open), and the press that starts it leaves
            focus on a button, so nothing was ever spoken. Drawn is not
            announced.
          */}
          <Text
            style={styles.phase}
            accessibilityLiveRegion="polite"
            testID="telegraph-voice-recorder-phase"
          >
            {phase === 'idle'
              ? 'Ready'
              : phase === 'recording'
                ? `Recording · ${formatDuration(elapsed)} · ${formatDuration(remaining)} left`
                : phase === 'review'
                  ? `Ready to send · ${formatDuration(Math.round(finalSecondsRef.current))}`
                  : 'Sending…'}
          </Text>

          {error ? (
            <Text
              style={styles.error}
              // The header says a denied permission "is stated, once, in words".
              // It is — and until this it was never spoken, so the one statement
              // the flow makes was inaudible to the people most likely to need
              // it repeated.
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              testID="telegraph-voice-recorder-error"
            >
              {error}
            </Text>
          ) : null}

          <View style={styles.row}>
            {phase === 'idle' ? (
              <Pressable
                onPress={() => void startRecording()}
                style={styles.primary}
                accessibilityRole="button"
                accessibilityLabel="Start recording"
                testID="telegraph-voice-record"
              >
                <Mic size={18} color={palette.operationalOn} />
                <Text style={styles.primaryText}>Record</Text>
              </Pressable>
            ) : null}

            {phase === 'recording' ? (
              <Pressable
                onPress={() => void finishRecording()}
                style={styles.primary}
                accessibilityRole="button"
                accessibilityLabel="Stop recording"
                testID="telegraph-voice-stop"
              >
                <Square size={16} color={palette.operationalOn} />
                <Text style={styles.primaryText}>Stop</Text>
              </Pressable>
            ) : null}

            {phase === 'review' ? (
              <>
                <Pressable
                  onPress={reset}
                  style={styles.secondary}
                  accessibilityRole="button"
                  accessibilityLabel="Discard recording"
                  testID="telegraph-voice-discard"
                >
                  <Trash2 size={16} color={palette.mute} />
                  <Text style={styles.secondaryText}>Discard</Text>
                </Pressable>
                <Pressable
                  onPress={() => void onSend()}
                  style={styles.primary}
                  accessibilityRole="button"
                  accessibilityLabel="Send voice message"
                  testID="telegraph-voice-send"
                >
                  <Send size={16} color={palette.operationalOn} />
                  <Text style={styles.primaryText}>Send</Text>
                </Pressable>
              </>
            ) : null}

            {phase === 'sending' ? (
              // The phase line above already says "Sending…" and is a live
              // region. A second, unlabelled node saying the same nothing is
              // noise, so the spinner is decoration.
              <ActivityIndicator
                size="small"
                color={palette.operational}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                testID="telegraph-voice-sending"
              />
            ) : null}
          </View>

          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="telegraph-voice-close"
          >
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: {
      backgroundColor: p.surfaceRaised,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: space.lg,
      gap: space.sm,
    },
    title: { ...t.body, color: p.recvText, fontWeight: '700' },
    phase: { ...t.small, color: p.mute },
    error: { ...t.small, color: p.attention },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
    primary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: space.md,
      paddingVertical: 8,
      borderRadius: radius.pill,
      backgroundColor: p.operational,
    },
    primaryText: { ...t.small, color: p.operationalOn, fontWeight: '700' },
    secondary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: space.md,
      paddingVertical: 8,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: p.recvBorder,
    },
    secondaryText: { ...t.small, color: p.mute, fontWeight: '700' },
    close: { ...t.small, color: p.mute, marginTop: space.sm },
  });
}

export default VoiceRecorderSheet;
