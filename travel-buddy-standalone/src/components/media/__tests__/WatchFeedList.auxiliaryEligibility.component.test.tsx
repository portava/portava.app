import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { AVPlaybackStatus, AVPlaybackStatusToSet } from 'expo-av';
import type { MediaFeedItem } from '../../../types/media.ts';
import * as captions from '../../../services/media/captions.ts';
import * as dubbing from '../../../services/media/dubbing.ts';
import { WatchFeedList } from '../WatchFeedList.tsx';
import { mediaEvents } from '../../../lib/mediaEvents.ts';

type FocusEntry = { enter: () => (() => void); leave?: () => void };
const mockFocusEntries = new Set<FocusEntry>();
const mockAppListeners = new Set<(state: string) => void>();
let mockTapToPlay = false;
let mockSingleTap: () => void;
let mockNativeStatus: (status: AVPlaybackStatus) => void;
let mockShouldPlay = false;
let mockPendingPause: Promise<void> | undefined;
let mockPendingLoad: Promise<void> | undefined;
const playingStatus = { isLoaded: true, isPlaying: true, isBuffering: false, positionMillis: 600, durationMillis: 2000, didJustFinish: false } as AVPlaybackStatus;
const mockVideo = {
  playAsync: jest.fn(async () => playingStatus),
  pauseAsync: jest.fn(async () => { await mockPendingPause; return playingStatus; }),
  setPositionAsync: jest.fn(async () => playingStatus),
  getStatusAsync: jest.fn(async () => playingStatus),
  setStatusAsync: jest.fn(async (_status: AVPlaybackStatusToSet) => playingStatus),
};
interface SoundFixture {
  state: { isLoaded: boolean; isPlaying: boolean; isMuted: boolean };
  setStatusAsync: jest.Mock;
  loadAsync: jest.Mock;
}
const mockSounds: SoundFixture[] = [];

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useFocusEffect: (enter: FocusEntry['enter']) => {
    require('react').useEffect(() => {
      const entry = { enter, leave: enter() };
      mockFocusEntries.add(entry);
      return () => { entry.leave?.(); mockFocusEntries.delete(entry); };
    }, [enter]);
  },
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const React = require('react');
  return new Proxy(actual, { get(target, key) {
    if (key === 'Modal') return ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? React.createElement(actual.View, null, children) : null;
    if (key === 'AppState') return { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => {
      mockAppListeners.add(listener); return { remove: () => mockAppListeners.delete(listener) };
    } };
    return Reflect.get(target, key);
  } });
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'),
  useFeatureFlags: () => ({ isEnabled: (key: string) => key === 'media_captions_enabled' || key === 'media_dubbing_enabled' || key === 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED' && mockTapToPlay, loading: false }),
}));
jest.mock('../../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../context/SessionContext.tsx'),
  useSession: () => ({ userId: '11111111-1111-4111-8111-111111111111', isAuthed: true }),
}));
jest.mock('../../../context/LanguagePreferenceContext.tsx', () => ({
  ...jest.requireActual('../../../context/LanguagePreferenceContext.tsx'),
  useLanguagePreference: () => ({ preferredLanguage: 'en' }),
}));
jest.mock('../../../services/media/captions.ts', () => ({
  ...jest.requireActual('../../../services/media/captions.ts'),
  resolveCaptionSource: jest.fn(), readCaptionTrack: jest.fn(),
}));
jest.mock('../../../services/media/dubbing.ts', () => ({
  ...jest.requireActual('../../../services/media/dubbing.ts'),
  getDubbingOptions: jest.fn(), dubbingAudioSource: jest.fn(), subscribeDubbingAuth: () => () => {},
}));
jest.mock('../WatchItemOverlay.tsx', () => ({ ...jest.requireActual('../WatchItemOverlay.tsx'), WatchItemOverlay: () => null }));
jest.mock('../WatchRadialMenu.tsx', () => ({ ...jest.requireActual('../WatchRadialMenu.tsx'), WatchRadialMenu: () => null }));
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  class GestureFixture {
    taps = 0;
    numberOfTaps = (count: number) => { this.taps = count; return this; };
    maxDuration = () => this;
    minDuration = () => this;
    minDistance = () => this;
    activeOffsetX = () => this;
    failOffsetY = () => this;
    requireExternalGestureToFail = () => this;
    runOnJS = () => this;
    onBegin = () => this;
    onChange = () => this;
    onStart = () => this;
    onFinalize = () => this;
    onEnd = (handler: () => void) => { if (this.taps === 1) mockSingleTap = handler; return this; };
  }
  return {
    ...jest.requireActual('react-native-gesture-handler'),
    GestureDetector: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    Gesture: { Tap: () => new GestureFixture(), LongPress: () => new GestureFixture(), Pan: () => new GestureFixture(), Exclusive: () => ({}) },
  };
});
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef(({ shouldPlay, onPlaybackStatusUpdate }: { shouldPlay: boolean; onPlaybackStatusUpdate: typeof mockNativeStatus }, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => mockVideo, []);
    mockShouldPlay = shouldPlay;
    mockNativeStatus = onPlaybackStatusUpdate;
    return <View testID="eligibility-video" />;
  });
  class Sound {
    state = { isLoaded: false, isPlaying: false, isMuted: true, positionMillis: 0, durationMillis: 2000 };
    loadAsync = jest.fn(async (_source: unknown, status: AVPlaybackStatusToSet) => {
      await mockPendingLoad;
      this.state = { ...this.state, ...status, isLoaded: true, isPlaying: status.shouldPlay === true }; return this.state;
    });
    setStatusAsync = jest.fn(async (status: AVPlaybackStatusToSet) => {
      this.state = { ...this.state, ...status, isPlaying: status.shouldPlay ?? this.state.isPlaying }; return this.state;
    });
    unloadAsync = jest.fn(async () => { this.state = { ...this.state, isLoaded: false, isPlaying: false }; return { isLoaded: false }; });
    setOnPlaybackStatusUpdate = jest.fn();
    constructor() { mockSounds.push(this); }
  }
  return { Video, Audio: { Sound }, ResizeMode: { COVER: 'cover', CONTAIN: 'contain', STRETCH: 'stretch' } };
});

const assetId = '22222222-2222-4222-8222-222222222222';
const source: captions.CaptionSource = { assetId, version: 1, revisionKey: 'b'.repeat(64), durationMs: 2000, canEdit: false };
const track: captions.CaptionTrackResult = { ...source, vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic caption', cues: [{ startMs: 0, endMs: 1000, text: 'Synthetic caption' }] };
const item: MediaFeedItem = {
  id: 'eligibility-cell', videoUrl: 'https://example.invalid/synthetic.mp4', posterUrl: null, duration: null,
  creator: { id: 'creator', displayName: 'Fixture', username: 'fixture', avatarUrl: null },
  caption: '', hashtags: [], place: null, linkedEntity: null, audioLabel: null,
  likeCount: 0, commentCount: 0, saveCount: 0, likedByMe: false, savedByMe: false,
};
const feedProps = { items: [item], activeIndex: 0, savedSet: {}, onActiveIndexChange: jest.fn(), onEndReached: jest.fn(), onComment: jest.fn(), onSave: jest.fn(), onMore: jest.fn() };

function blur() { mockFocusEntries.forEach(entry => { entry.leave?.(); entry.leave = undefined; }); }
function focus() { mockFocusEntries.forEach(entry => { entry.leave = entry.enter(); }); }
async function leave(kind: 'blur' | 'global pause') {
  await act(async () => { if (kind === 'blur') blur(); else mediaEvents.emit('MEDIA_PAUSE_ALL'); });
}
async function selectAudio(view: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(view.getByLabelText('Audio language options'));
  await fireEvent.press(view.getByLabelText('English'));
  await fireEvent.press(view.getByLabelText('Play AI audio'));
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks(); mockFocusEntries.clear(); mockAppListeners.clear(); mockSounds.length = 0;
  mockPendingPause = undefined; mockPendingLoad = undefined; mockTapToPlay = false;
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  jest.mocked(captions.resolveCaptionSource).mockResolvedValue(source);
  jest.mocked(captions.readCaptionTrack).mockResolvedValue(track);
  jest.mocked(dubbing.getDubbingOptions).mockResolvedValue({ assetId, sourceVersion: 1, sourceKey: 'a'.repeat(64), canEdit: false, enabled: true, languages: [{ code: 'en', label: 'English', ready: true }] });
  jest.mocked(dubbing.dubbingAudioSource).mockResolvedValue({ uri: 'https://example.invalid/synthetic.wav' });
});
afterEach(() => { expect(global.fetch).not.toHaveBeenCalled(); jest.restoreAllMocks(); });

it.each(['blur', 'global pause'] as const)('%s retires playing auxiliary audio and captions despite an unresolved native pause and stale playing callback', async kind => {
  const view = await render(<WatchFeedList {...feedProps} />);
  await waitFor(() => expect(view.getByLabelText('Audio language options')).toBeTruthy());
  await fireEvent.press(view.getByLabelText('Unmute'));
  await fireEvent.press(view.getByLabelText('Show timed captions'));
  await act(async () => { mockNativeStatus(playingStatus); });
  await waitFor(() => expect(view.getByText('Synthetic caption')).toBeTruthy());
  await selectAudio(view);
  await waitFor(() => expect(mockSounds[0]?.state).toMatchObject({ isLoaded: true, isPlaying: true, isMuted: false }));
  let finishPause!: () => void;
  mockPendingPause = new Promise(resolve => { finishPause = resolve; });
  const lateStatus = mockNativeStatus;
  await leave(kind);
  await act(async () => { lateStatus(playingStatus); mockNativeStatus(playingStatus); });
  await waitFor(() => expect(mockSounds[0].state).toMatchObject({ isLoaded: false, isPlaying: false }));
  expect(mockShouldPlay).toBe(false);
  expect(view.queryByText('Synthetic caption')).toBeNull();
  expect(view.queryByLabelText('Show timed captions')).toBeNull();
  expect(view.queryByLabelText('Audio language options')).toBeNull();
  await act(async () => { finishPause(); });
  expect(mockShouldPlay).toBe(false);
  expect(mockSounds[0].state.isPlaying).toBe(false);
  await act(async () => { if (kind === 'global pause') blur(); focus(); });
  await waitFor(() => expect(view.getByLabelText('Audio language options')).toBeTruthy());
  expect(mockShouldPlay).toBe(true);
  expect(mockSounds).toHaveLength(1);
  expect(mockSounds[0].state.isPlaying).toBe(false);
  expect(view.queryByText('Synthetic caption')).toBeNull();
});

it.each(['blur', 'global pause'] as const)('%s cancels pending auxiliary admission independently of late native load/status and caption responses', async kind => {
  let finishLoad!: () => void;
  let finishTrack!: (value: captions.CaptionTrackResult) => void;
  let trackSignal: AbortSignal | undefined;
  mockPendingPause = new Promise(() => {});
  mockPendingLoad = new Promise(resolve => { finishLoad = resolve; });
  jest.mocked(captions.readCaptionTrack).mockImplementationOnce((_source, signal) => {
    trackSignal = signal; return new Promise(resolve => { finishTrack = resolve; });
  });
  const view = await render(<WatchFeedList {...feedProps} />);
  await waitFor(() => expect(view.getByLabelText('Audio language options')).toBeTruthy());
  await fireEvent.press(view.getByLabelText('Show timed captions'));
  await selectAudio(view);
  await waitFor(() => expect(mockSounds[0]?.loadAsync).toHaveBeenCalled());
  const lateStatus = mockNativeStatus;
  await leave(kind);
  await act(async () => { finishLoad(); finishTrack(track); lateStatus(playingStatus); });
  await waitFor(() => expect(mockSounds[0].state.isLoaded).toBe(false));
  expect(mockSounds[0].setStatusAsync.mock.calls.some(([status]) => status.shouldPlay === true)).toBe(false);
  expect(trackSignal?.aborted).toBe(true);
  expect(view.queryByText('Synthetic caption')).toBeNull();
  expect(view.queryByLabelText('Audio language options')).toBeNull();
  expect(mockShouldPlay).toBe(false);
});

it('preserves a manual tap pause across focus restoration without admitting auxiliary playback', async () => {
  const view = await render(<WatchFeedList {...feedProps} />);
  await waitFor(() => expect(view.getByLabelText('Audio language options')).toBeTruthy());
  await act(async () => { mockSingleTap(); });
  await leave('blur');
  await act(async () => { focus(); mockNativeStatus(playingStatus); });
  expect(mockShouldPlay).toBe(false);
  expect(view.queryByLabelText('Audio language options')).toBeNull();
  expect(view.queryByLabelText('Show timed captions')).toBeNull();
  expect(mockSounds).toHaveLength(0);
  await act(async () => { mockSingleTap(); });
  await waitFor(() => expect(view.getByLabelText('Audio language options')).toBeTruthy());
  expect(mockShouldPlay).toBe(true);
  expect(mockSounds).toHaveLength(0);
});
