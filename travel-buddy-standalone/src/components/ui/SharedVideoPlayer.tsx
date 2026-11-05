/**
 * SharedVideoPlayer — reusable video player wrapping expo-av's Video.
 *
 * Features:
 *   - Play/pause overlay button when paused
 *   - Tap-to-unmute icon in non-fullscreen mode (muted by default)
 *   - Poster image shown while paused / loading
 *   - Load-error fallback view
 *   - onEnd callback
 *
 * ## URIs must be hydrated before they reach <Video>
 *
 * This used to pass `uri` through untouched, on the assumption that it was
 * already a signed URL. It is not: post-media is a PRIVATE bucket and the
 * stored value is a bare `post-media/<uid>/<file>.mp4` reference with no
 * scheme. expo-av cannot report a useful error for a URI it cannot even parse,
 * so this surface rendered a truly blank box — the worst of the four.
 *
 * Both `uri` and `poster` go through useHydratedMedia. A null resolve is
 * treated exactly like a playback error: the "Video unavailable" state, never
 * an empty frame.
 */
import React, { useRef, useCallback, useState, useEffect } from 'react';
import {
  View, ActivityIndicator, Platform, Modal,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePrivateSurfaceKey } from '../../hooks/usePrivateSurfaceKey.ts';
import { useMediaSurfaceActivity } from '../../hooks/useMediaSurfaceActivity.ts';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import { Play, Volume2, VolumeX, Maximize2, X } from 'lucide-react-native';
import { color, radius, avatar } from '../../theme/tokens.ts';
import { useSmartVideoFit } from '../../hooks/useSmartVideoFit.ts';
import { VideoBlurBackdrop } from './VideoBlurBackdrop.tsx';
import { useHydratedMedia } from '../../services/mediaUrl.ts'; import { playbackUriState } from '../../services/playbackUri.ts';
import { DisplayMediaImage } from './DisplayMediaImage.tsx';
import { MediaCaptionControls } from '../media/MediaCaptionControls.tsx';
import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx';
import { useAdaptivePlayback } from '../../hooks/useAdaptivePlayback.ts';
import { MediaDubbingSession, useMediaDubbingSession } from '../media/MediaDubbingSession.tsx';
import { useSession } from '../../context/SessionContext.tsx';

export interface SharedVideoPlayerProps {
  uri: string;
  captionSource?: string;
  poster?: string;
  /** Start playing immediately. Default: false */
  autoplay?: boolean;
  /** Start muted. Default: true. On web an AUTOPLAYING player always starts muted: browsers refuse to start a video with sound (the button unmutes). */
  muted?: boolean;
  loop?: boolean;
  onEnd?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function SharedVideoPlayer(props: SharedVideoPlayerProps) {
  const { userId } = useSession();
  const scope = usePrivateSurfaceKey();
  return <SharedVideoSession key={JSON.stringify([scope, userId, props.uri, props.captionSource])} {...props} />;
}

function SharedVideoSession({
  uri,
  captionSource,
  poster,
  autoplay = false,
  muted: mutedProp = true,
  loop = false,
  onEnd,
  style,
}: SharedVideoPlayerProps) {
  const videoRef = useRef<Video>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const switching = useRef(false);
  const position = useRef(0);
  const pendingResume = useRef<number | null>(null);
  const [resumeStatus, setResumeStatus] = useState<{ positionMillis?: number }>({});
  const [progress, setProgress] = useState({ position: 0, duration: 0 });
  const [viewError, setViewError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [controller, setController] = useState<Video | null>(null);
  const captureVideo = useCallback((video: Video | null) => { videoRef.current = video; setController(video); }, []);
  const [isPlaying, setIsPlaying] = useState(autoplay);
  const [intent, setIntent] = useState({ uri, autoplay, requested: autoplay });
  const activity = useMediaSurfaceActivity(() => {
    void videoRef.current?.pauseAsync().catch(() => {});
    pendingResume.current = null;
    setResumeStatus({});
    setIntent({ uri, autoplay, requested: false });
    setIsPlaying(false);
    setFullscreen(false);
  });
  const playIntent = activity.active && (intent.uri === uri && intent.autoplay === autoplay ? intent.requested : autoplay);
  const waitingForWebResume = Platform.OS === 'web' && resumeStatus.positionMillis !== undefined;
  const [isMuted, setIsMuted] = useState(mutedProp || (autoplay && Platform.OS === 'web'));
  const muteCommand = useRef(0);
  const [audioError, setAudioError] = useState(false);
  const [errorSource, setErrorSource] = useState<string | null>(null); // the SOURCE that failed: a new source (a late or refreshed signature) starts clean
  const [captionStatus, setCaptionStatus] = useState<{ version: number; status: AVPlaybackStatus } | null>(null);
  const captionsEnabled = useFeatureFlags().isEnabled('media_captions_enabled');
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // Private-bucket references resolve to signed URLs here, and NO player is mounted until one is loadable
  // (2026-10-24: a bare ref handed to <Video> failed at once and latched "Video unavailable", so the signed URL
  // that arrived a moment later was never played). services/playbackUri.ts playbackUriState decides.
  const { resolved: hydrated } = useHydratedMedia([uri, poster ?? null]);
  const sourceState = playbackUriState(uri, hydrated);
  const playbackUri = sourceState.state === 'ready' ? sourceState.uri : '';
  const playback = useAdaptivePlayback(captionSource ?? uri, playbackUri);
  const playbackKey = JSON.stringify([playback.source, fullscreen, activity.epoch]);
  const currentPlayback = useRef({ key: playbackKey, version: 0 });
  if (currentPlayback.current.key !== playbackKey) currentPlayback.current = { key: playbackKey, version: currentPlayback.current.version + 1 };
  const playbackVersion = currentPlayback.current.version;
  const isCurrentPlayback = useCallback(() => mounted.current && activity.isCurrent() && currentPlayback.current.version === playbackVersion, [playbackVersion, activity.isCurrent]);
  const hasError = errorSource !== null && errorSource === playbackKey;
  const posterUri = poster
    ? (typeof hydrated[poster] === 'string' ? (hydrated[poster] as string) : poster)
    : undefined;
  // Server said no: unreadable, same user-visible outcome as a decode failure.
  const unresolvable = sourceState.state === 'unavailable';
  const dubbing = useMediaDubbingSession({ source: captionSource ?? uri, active: activity.active && !hasError && !unresolvable,
    controller, controlSource: { shouldPlay: playIntent && !waitingForWebResume, isMuted, volume: 1, rate: 1 } });
  const { resizeMode, needsLetterbox, onReadyForDisplay } = useSmartVideoFit(
    containerSize.w,
    containerSize.h,
  );

  const handlePlaybackStatus = useCallback(
    (status: AVPlaybackStatus) => {
      if (!isCurrentPlayback()) return;
      dubbing.playback.onSourceStatus(status);
      if (captionsEnabled) setCaptionStatus({ version: playbackVersion, status });
      if (!status.isLoaded) {
        if ((status as any).error) {
          if (playback.rejectAdaptive()) return;
          setErrorSource(playbackKey);
        }
        return;
      }
      if (pendingResume.current === null) position.current = status.positionMillis;
      if (fullscreen) setProgress({ position: pendingResume.current ?? status.positionMillis, duration: status.durationMillis ?? 0 });
      setIsPlaying(status.isPlaying);
      if (status.didJustFinish && !loop) {
        setIntent({ uri, autoplay, requested: false });
        onEnd?.();
      }
    },
    [fullscreen, loop, onEnd, captionsEnabled, uri, autoplay, playback.rejectAdaptive, dubbing.playback.onSourceStatus, isCurrentPlayback, playbackVersion, playbackKey],
  );

  const togglePlay = useCallback(async () => {
    if (!videoRef.current || !isCurrentPlayback()) return;
    const requested = !(playIntent || isPlaying);
    setIntent({ uri, autoplay, requested });
    if (!requested) setIsPlaying(false);
    try {
      if (requested) await videoRef.current.playAsync();
      else await videoRef.current.pauseAsync();
    } catch {
      if (isCurrentPlayback()) {
        setIntent({ uri, autoplay, requested: false });
        setIsPlaying(false);
      }
    }
  }, [isPlaying, playIntent, uri, autoplay, isCurrentPlayback]);

  const toggleMute = useCallback(async () => {
    const target = videoRef.current;
    if (!target || !isCurrentPlayback()) return;
    const command = ++muteCommand.current;
    const next = !isMuted;
    setAudioError(false);
    setIsMuted(next);
    try { await target.setStatusAsync({ isMuted: next || dubbing.playback.muteOriginal }); }
    catch {
      if (isCurrentPlayback() && videoRef.current === target && muteCommand.current === command) {
        setIsMuted(isMuted);
        setAudioError(true);
      }
    }
  }, [isMuted, dubbing.playback.muteOriginal, isCurrentPlayback]);

  const changeFullscreen = useCallback(async (next: boolean) => {
    if (!isCurrentPlayback()) return;
    if (!next) {
      // Closing cannot depend on a stalled/failed native pause promise. The
      // departing decoder is unmounted, and its callbacks lose their version.
      void videoRef.current?.pauseAsync().catch(() => {});
      pendingResume.current = position.current;
      setResumeStatus({ positionMillis: position.current });
      setFullscreen(false);
      return;
    }
    if (switching.current) return;
    switching.current = true;
    setViewError(null);
    const target = videoRef.current;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Only one native decoder is mounted at a time. Stop the departing view
      // before moving it; restart the replacement at the last observed position.
      // An already paused view needs no additional native command. The old
      // decoder is still unmounted before the replacement view is attached.
      if (isPlaying) await Promise.race([target?.pauseAsync(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Video controls timed out')), 2000); })]);
      if (!isCurrentPlayback() || videoRef.current !== target) return;
      pendingResume.current = position.current;
      setResumeStatus({ positionMillis: position.current });
      setFullscreen(next);
    } catch {
      if (isCurrentPlayback()) setViewError('Couldn’t change the video view. Try again.');
    } finally { if (timeout) clearTimeout(timeout); switching.current = false; }
  }, [isCurrentPlayback, isPlaying]);

  const restorePosition = useCallback(async () => {
    const target = videoRef.current;
    const expected = pendingResume.current;
    if (!isCurrentPlayback() || !target) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Expo AV's web render path does not apply initial positionMillis. Seek
      // after loaded metadata and hold autoplay/status-zero callbacks until it
      // resolves. Native applies the initial status as part of loading.
      if (Platform.OS === 'web' && expected !== null) {
        await Promise.race([target.setPositionAsync(expected), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Seek timed out')), 2000); })]);
      }
      if (!isCurrentPlayback() || videoRef.current !== target || pendingResume.current !== expected) return;
      pendingResume.current = null;
      setResumeStatus({});
      setViewError(null);
    } catch {
      if (isCurrentPlayback() && videoRef.current === target) setViewError('Couldn’t restore playback position. Retry.');
    } finally { if (timeout) clearTimeout(timeout); }
  }, [isCurrentPlayback]);

  const seek = useCallback(async (value: number) => {
    if (!isCurrentPlayback()) return;
    const target = videoRef.current;
    try { await target?.setPositionAsync(Math.max(0, Math.min(progress.duration, value))); }
    catch { if (isCurrentPlayback() && videoRef.current === target) setViewError('Couldn’t seek. Try again.'); }
  }, [progress.duration, isCurrentPlayback]);

  function frame(content: React.ReactNode) {
    if (!fullscreen || !activity.active) return content;
    return <View style={[s.container, style]}><Modal visible animationType="fade" presentationStyle="fullScreen" supportedOrientations={['portrait', 'landscape']} onRequestClose={() => void changeFullscreen(false)}>
      <SafeAreaView style={s.fullscreenRoot} accessibilityViewIsModal>
        <View style={s.fullscreenHeader}><Text style={s.fullscreenTitle}>Video</Text><Pressable accessibilityRole="button" accessibilityLabel="Close full-screen video" style={s.closeBtn} onPress={() => void changeFullscreen(false)}><X color="#fff" size={26} /></Pressable></View>
        {content}
      </SafeAreaView>
    </Modal></View>;
  }

  if (hasError || unresolvable) {
    return frame(
      <View style={[s.container, s.error, style]}>
        <Text style={s.errorText}>Video unavailable</Text>
      </View>
    );
  }

  const content = (
    <View
      style={[s.container, fullscreen ? s.fullscreenPlayer : style]}
      onLayout={(e) =>
        setContainerSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
    >
      {needsLetterbox ? <VideoBlurBackdrop uri={posterUri} /> : null}
      {sourceState.state === 'ready' && activity.active ? (<Video key={playbackKey}
        ref={captureVideo}
        source={playback.source}
        style={StyleSheet.absoluteFill}
        videoStyle={{ width: '100%', height: '100%' }}
        resizeMode={fullscreen ? ResizeMode.CONTAIN : resizeMode}
        status={resumeStatus}
        onLoad={() => void restorePosition()}
        shouldPlay={playIntent && !waitingForWebResume}
        isLooping={loop}
        isMuted={isMuted || dubbing.playback.muteOriginal}
        useNativeControls={false}
        onPlaybackStatusUpdate={handlePlaybackStatus}
        onReadyForDisplay={event => { if (isCurrentPlayback()) onReadyForDisplay(event); }}
        progressUpdateIntervalMillis={captionsEnabled || dubbing.enabled ? 100 : 500}
      />) : null}

      {/* Poster shown while paused and poster uri is provided. DisplayMediaImage
          rather than a bare <Image>: the poster is a post-media object too, and
          a failed one must show the designed fallback, not an empty frame. */}
      {!isPlaying && posterUri && position.current === 0 ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <DisplayMediaImage
            testID="poster-image"
            uri={posterUri}
            width={containerSize.w}
            height={containerSize.h}
            resizeMode="cover"
            style={StyleSheet.absoluteFill}
            fallbackLabel=""
          />
        </View>
      ) : null}

      {/* Tap anywhere to play/pause */}
      <Pressable style={StyleSheet.absoluteFill} onPress={togglePlay} disabled={waitingForWebResume} accessibilityState={{ disabled: waitingForWebResume }} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'} />

      {/* Play overlay when paused; while the source is still being signed, a loading state over the poster */}{sourceState.state === 'resolving' ? (<View style={s.playOverlay} pointerEvents="none"><ActivityIndicator testID="video-resolving" accessibilityLabel="Loading video" color="#fff" /></View>) : null}
      {!isPlaying && sourceState.state === 'ready' && (
        <View style={s.playOverlay} pointerEvents="none">
          <View style={s.playBtn}>
            <Play size={28} color="#fff" fill="#fff" />
          </View>
        </View>
      )}

      {/* Mute toggle — bottom right */}
      <Pressable
        style={[s.muteBtn, fullscreen && { bottom: 100 }]}
        onPress={toggleMute}
        accessibilityRole="button"
        accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}
        hitSlop={8}
      >
        {isMuted ? (
          <VolumeX size={18} color="#fff" />
        ) : (
          <Volume2 size={18} color="#fff" />
        )}
      </Pressable>
      {!fullscreen && <Pressable style={s.expandBtn} onPress={() => void changeFullscreen(true)} accessibilityRole="button" accessibilityLabel="View video full screen"><Maximize2 size={22} color="#fff" /></Pressable>}
      {fullscreen && progress.duration > 0 ? <View style={s.seekBar}>
        <Text style={s.time}>{formatTime(progress.position)} / {formatTime(progress.duration)}</Text>
        <Slider testID="fullscreen-video-seek" accessibilityLabel="Video position" minimumValue={0} maximumValue={progress.duration} value={progress.position} onSlidingComplete={seek} minimumTrackTintColor="#fff" maximumTrackTintColor="#777" thumbTintColor="#fff" />
      </View> : null}
      {viewError ? <Text accessibilityRole="alert" style={s.audioError}>{viewError}</Text> : null}
      {viewError && pendingResume.current !== null ? <Pressable accessibilityRole="button" accessibilityLabel="Retry playback position" onPress={() => void restorePosition()} style={s.resumeRetry}><Text style={s.textRetry}>Retry playback position</Text></Pressable> : null}
      {audioError ? <Text accessibilityRole="alert" style={s.audioError}>Sound could not be changed. Try again.</Text> : null}
      <MediaCaptionControls source={captionSource ?? uri} status={captionStatus?.version === playbackVersion ? captionStatus.status : null} onSourceChanged={dubbing.invalidate} />
      <MediaDubbingSession session={dubbing} />
    </View>
  );
  return frame(content);
}

function formatTime(ms: number) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

const s = StyleSheet.create({
  fullscreenRoot: { flex: 1, backgroundColor: '#000' },
  fullscreenHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  fullscreenTitle: { color: '#fff', fontSize: 16 },
  closeBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  fullscreenPlayer: { flex: 1, borderRadius: 0, backgroundColor: '#000' },
  expandBtn: { position: 'absolute', top: 10, right: 10, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center' },
  seekBar: { position: 'absolute', bottom: 12, left: 16, right: 16, padding: 8, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.7)' },
  time: { color: '#fff', fontSize: 13 },
  container: {
    backgroundColor: color.haze,
    borderRadius: radius.md,
    overflow: 'hidden',
    position: 'relative',
  },
  error: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
  },
  errorText: {
    color: color.mute,
    fontSize: 13,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: avatar.s56, height: avatar.s56,
    borderRadius: avatar.s56 / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  muteBtn: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioError: { position: 'absolute', bottom: 50, left: 10, right: 10, backgroundColor: '#111', color: '#fff', padding: 8, fontSize: 13 },
  resumeRetry: { position: 'absolute', bottom: 150, alignSelf: 'center', padding: 12, borderRadius: 12, backgroundColor: '#222' },
  textRetry: { color: '#fff', fontSize: 14 },
});
