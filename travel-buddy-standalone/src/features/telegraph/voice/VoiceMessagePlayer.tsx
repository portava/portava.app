/**
 * Telegraph §6.3 — a voice message, with waveform, seek and playback speed.
 *
 * Spec §6.3, verbatim: "Voice: waveform, seek, playback speed, optional
 * transcript/translation."
 *
 * Three of the four. There is no transcript, because there is no speech-to-text
 * provider in this tree — see `services/telegraph/voice.ts` for why a nullable
 * field nothing writes was not added instead.
 *
 * ── THE BUCKET IS PRIVATE, SO THE URL MUST BE SIGNED ────────────────────────
 * `post-media` is a private bucket. A stored voice note's `url` is a bare
 * `post-media/<path>` reference, which does not load in anything until
 * `useHydratedMedia` has exchanged it for a signed URL — the same gate every
 * image on every surface goes through. A player that handed the raw reference
 * to `Audio.Sound` would show a play button that silently never plays.
 *
 * ── §11.3, ENFORCED RATHER THAN ASSUMED ─────────────────────────────────────
 * "Do not encode delivery/availability solely by color." The player's state is
 * a WORD and an icon, never a colour alone: the duration is always shown, the
 * speed control shows "1x"/"1.5x"/"2x" as text, and a failure says so in words.
 *
 * ── §11.3 AND THE SEEK THAT WAS REACHABLE ONLY BY POINTING AT A PIXEL ───────
 * The waveform reads `locationX` from a tap. That is the whole of the seek, and
 * a person using VoiceOver, TalkBack or Switch Control cannot produce one — so
 * the control announced itself `adjustable`, promising an adjustment gesture,
 * and implemented none. It now carries a real `accessibilityValue`, real
 * increment/decrement actions and a handler that performs the same seek the tap
 * does. The BARS themselves are decoration and are hidden from the reader:
 * unhidden they were 48 unlabelled stops between the play button and the
 * duration, each announcing nothing.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It does not auto-play, it does not continue into the next voice note, and it
 * releases the sound when it unmounts. A conversation that started playing
 * audio on scroll would be a privacy event in a public place.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Play, Pause, AlertCircle } from 'lucide-react-native';
import { useHydratedMedia } from '../../../services/mediaUrl.ts';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  ACCESSIBILITY_SEEK_STEP_SECONDS,
  WAVEFORM_BARS,
  downsampleWaveform,
  formatDuration,
  nextPlaybackSpeed,
  playedFraction,
  seekMillisForStep,
  seekMillisForTap,
} from './voicePolicy.ts';

export interface VoiceMessagePlayerProps {
  /** The stored `post-media/<path>` reference. */
  url: string;
  durationSeconds: number;
  waveform?: number[] | null;
  mine?: boolean;
  /**
   * Injected in tests. Production passes nothing and the component loads
   * `expo-av` lazily, so a screen that renders no voice note never pulls the
   * native AV module in.
   */
  createSound?: (uri: string) => Promise<VoiceSoundHandle>;
}

/** The slice of `expo-av`'s `Audio.Sound` this player uses. */
export interface VoiceSoundHandle {
  playAsync(): Promise<unknown>;
  pauseAsync(): Promise<unknown>;
  setRateAsync(rate: number, shouldCorrectPitch: boolean): Promise<unknown>;
  setPositionAsync(millis: number): Promise<unknown>;
  unloadAsync(): Promise<unknown>;
  setOnPlaybackStatusUpdate(cb: (status: any) => void): void;
}

async function loadExpoAvSound(uri: string): Promise<VoiceSoundHandle> {
  const { Audio } = await import('expo-av');
  const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false });
  return sound as unknown as VoiceSoundHandle;
}

export function VoiceMessagePlayer({
  url,
  durationSeconds,
  waveform,
  mine = false,
  createSound,
}: VoiceMessagePlayerProps) {
  const palette = useTelegraphPalette();
  const styles = React.useMemo(() => makeStyles(palette), [palette]);

  const urlList = React.useMemo(() => [url], [url]);
  const { resolved, loading: signing } = useHydratedMedia(urlList);
  const signedUrl = resolved[url] ?? null;

  const [playing, setPlaying] = React.useState(false);
  const [positionMillis, setPositionMillis] = React.useState(0);
  const [speed, setSpeed] = React.useState<number>(1);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [barWidth, setBarWidth] = React.useState(0);

  const soundRef = React.useRef<VoiceSoundHandle | null>(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Release the native player. Without this, backing out of a thread while
      // a voice note is playing leaves the audio running over the next screen.
      const s = soundRef.current;
      soundRef.current = null;
      if (s) void s.unloadAsync().catch(() => {});
    };
  }, []);

  const bars = React.useMemo(() => {
    const down = downsampleWaveform(waveform ?? [], WAVEFORM_BARS);
    // §11.3: a missing derivative degrades, it does not block. A voice note
    // with no waveform draws an even band and is fully playable.
    if (down.length === 0) return new Array(WAVEFORM_BARS).fill(0.35);
    return down;
  }, [waveform]);

  const ensureSound = React.useCallback(async (): Promise<VoiceSoundHandle | null> => {
    if (soundRef.current) return soundRef.current;
    if (!signedUrl) return null;
    try {
      const make = createSound ?? loadExpoAvSound;
      const sound = await make(signedUrl);
      if (!mountedRef.current) {
        void sound.unloadAsync().catch(() => {});
        return null;
      }
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (!mountedRef.current) return;
        if (status?.isLoaded === false) return;
        if (typeof status?.positionMillis === 'number') setPositionMillis(status.positionMillis);
        if (status?.didJustFinish) {
          setPlaying(false);
          setPositionMillis(0);
        } else if (typeof status?.isPlaying === 'boolean') {
          setPlaying(status.isPlaying);
        }
      });
      soundRef.current = sound;
      return sound;
    } catch {
      if (mountedRef.current) setFailed(true);
      return null;
    }
  }, [signedUrl, createSound]);

  const onToggle = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const sound = await ensureSound();
      if (!sound) {
        setFailed(true);
        return;
      }
      setFailed(false);
      if (playing) {
        await sound.pauseAsync();
        setPlaying(false);
      } else {
        await sound.setRateAsync(speed, true);
        await sound.playAsync();
        setPlaying(true);
      }
    } catch {
      setFailed(true);
      setPlaying(false);
    } finally {
      setBusy(false);
    }
  }, [busy, ensureSound, playing, speed]);

  const onCycleSpeed = React.useCallback(async () => {
    const next = nextPlaybackSpeed(speed);
    setSpeed(next);
    const sound = soundRef.current;
    if (sound) {
      try {
        await sound.setRateAsync(next, true);
      } catch {
        /* a rate the device will not take is not a reason to stop playback */
      }
    }
  }, [speed]);

  const onSeek = React.useCallback(
    async (x: number) => {
      const millis = seekMillisForTap(x, barWidth, durationSeconds, bars.length);
      // Move the playhead immediately so the bar responds to the tap even if
      // the sound has not loaded yet; the status update will confirm it.
      setPositionMillis(millis);
      const sound = await ensureSound();
      if (!sound) return;
      try {
        await sound.setPositionAsync(millis);
      } catch {
        /* a seek the device refuses leaves the playhead where the user put it */
      }
    },
    [barWidth, bars.length, durationSeconds, ensureSound],
  );

  /**
   * The same seek, reached without a gesture.
   *
   * Shares `ensureSound` and `setPositionMillis` with `onSeek` on purpose: two
   * code paths to the playhead is how one of them drifts, and the one that
   * drifts is always the one nobody can see.
   */
  const onAccessibilitySeek = React.useCallback(
    async (actionName: string) => {
      if (actionName !== 'increment' && actionName !== 'decrement') return;
      const millis = seekMillisForStep(
        positionMillis,
        durationSeconds,
        actionName === 'increment' ? 1 : -1,
      );
      setPositionMillis(millis);
      const sound = await ensureSound();
      if (!sound) return;
      try {
        await sound.setPositionAsync(millis);
      } catch {
        /* same posture as the tap: the playhead stays where the person put it */
      }
    },
    [positionMillis, durationSeconds, ensureSound],
  );

  const fraction = playedFraction(positionMillis, durationSeconds);
  const playedBars = Math.round(fraction * bars.length);
  const remaining = Math.max(0, durationSeconds - Math.floor(positionMillis / 1000));
  const positionSeconds = Math.floor(positionMillis / 1000);
  // The duration field changes MEANING when playback starts — total before,
  // remaining during — and "0:12" does not say which it is. Sighted readers have
  // the play/pause icon beside it; the label is that icon, in words.
  const showingRemaining = playing || positionMillis > 0;
  const durationLabel = showingRemaining
    ? `${formatDuration(remaining)} remaining`
    : `Length ${formatDuration(durationSeconds)}`;

  return (
    <View style={[styles.wrap, mine ? styles.wrapMine : null]} testID="telegraph-kind-voice">
      <Text style={styles.kindWord}>VOICE</Text>

      <View style={styles.row}>
        <Pressable
          onPress={onToggle}
          disabled={signing}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
          accessibilityState={{ disabled: signing, selected: playing }}
          hitSlop={8}
          style={styles.playButton}
          testID="telegraph-voice-toggle"
        >
          {signing ? (
            <ActivityIndicator size="small" color={palette.operational} testID="telegraph-voice-loading" />
          ) : playing ? (
            <Pause size={18} color={palette.operational} />
          ) : (
            <Play size={18} color={palette.operational} />
          )}
        </Pressable>

        <Pressable
          style={styles.waveWrap}
          onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
          onPress={(e) => void onSeek(e.nativeEvent.locationX)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Seek within voice message"
          // `adjustable` PROMISES a swipe-up/swipe-down adjustment. These three
          // props are that promise kept; without them the role was a lie and the
          // seek was reachable only by tapping a chosen pixel.
          accessibilityValue={{
            min: 0,
            max: Math.max(0, Math.round(durationSeconds)),
            now: positionSeconds,
            text: `${formatDuration(positionSeconds)} of ${formatDuration(durationSeconds)}`,
          }}
          accessibilityActions={[
            { name: 'increment', label: `Forward ${ACCESSIBILITY_SEEK_STEP_SECONDS} seconds` },
            { name: 'decrement', label: `Back ${ACCESSIBILITY_SEEK_STEP_SECONDS} seconds` },
          ]}
          onAccessibilityAction={(e) => void onAccessibilitySeek(e.nativeEvent.actionName)}
          testID="telegraph-voice-wave"
        >
          {/*
            DECORATION. The bars carry nothing the value above does not, and
            unhidden they are 48 unlabelled nodes a reader stops at one by one.
          */}
          <View
            style={styles.waveBars}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID="telegraph-voice-bars"
          >
            {bars.map((amp, i) => (
              <View
                key={i}
                testID={`telegraph-voice-bar-${i}`}
                style={[
                  styles.bar,
                  {
                    height: 4 + amp * 22,
                    backgroundColor: i < playedBars ? palette.operational : palette.hairline,
                  },
                ]}
              />
            ))}
          </View>
        </Pressable>

        <Text
          style={styles.duration}
          accessibilityLabel={durationLabel}
          testID="telegraph-voice-duration"
        >
          {formatDuration(showingRemaining ? remaining : durationSeconds)}
        </Text>

        <Pressable
          onPress={() => void onCycleSpeed()}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${speed}x. Tap to change.`}
          hitSlop={8}
          style={styles.speed}
          testID="telegraph-voice-speed"
        >
          {/* §11.3 — the speed is a WORD, not a colour or a bar height. */}
          <Text style={styles.speedText}>{speed}x</Text>
        </Pressable>
      </View>

      {failed ? (
        <View
          style={styles.errorRow}
          // Drawn is not announced. Pressing Play and hearing nothing is
          // indistinguishable from a missed tap unless this speaks.
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          testID="telegraph-voice-error"
        >
          <AlertCircle size={13} color={palette.attention} />
          <Text style={styles.errorText}>This voice message could not be played.</Text>
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    wrap: {
      backgroundColor: p.surfaceRaised,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.recvBorder,
      paddingVertical: space.sm,
      paddingHorizontal: space.md,
      maxWidth: 300,
      gap: 4,
    },
    wrapMine: { alignSelf: 'flex-end' },
    kindWord: { ...t.small, color: p.mute, letterSpacing: 0.5 },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    playButton: { width: 30, alignItems: 'center', justifyContent: 'center' },
    waveWrap: { flex: 1, height: 28, justifyContent: 'center' },
    waveBars: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: 28,
    },
    bar: { width: 2, borderRadius: 1 },
    duration: { ...t.small, color: p.mute, minWidth: 34, textAlign: 'right' },
    speed: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: p.recvBorder,
    },
    speedText: { ...t.small, fontWeight: '700', color: p.mute },
    errorRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    errorText: { ...t.small, color: p.attention },
  });
}

export default VoiceMessagePlayer;
