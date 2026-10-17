import React from 'react';
import { act, fireEvent, render, cleanup } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { SharedVideoPlayer } from '../../../components/ui/SharedVideoPlayer.tsx';
import { LanguagePreferenceProvider } from '../../../context/LanguagePreferenceContext.tsx';
import { writeAutomaticDubbingPreference } from '../../../services/languagePreferences.ts';
import { createDubbingPlaybackLifetime } from '../../../services/media/dubbingPlaybackLifetime.ts';

let mockLifetime: ReturnType<typeof createDubbingPlaybackLifetime>;
jest.mock('../../../services/media/dubbingPlaybackLifetime.ts', () => {
  const actual = jest.requireActual('../../../services/media/dubbingPlaybackLifetime.ts');
  return new Proxy(actual, { get(target, key) { return key === 'dubbingPlaybackLifetime' ? mockLifetime : Reflect.get(target, key); } });
});

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '33333333-3333-4333-8333-333333333333';
const asset = '22222222-2222-4222-8222-222222222222';
let mockActor: string | null = alice;
let mockEnabled = true;
const mockAuthListeners = new Set<() => void>();
const mockPreferenceListeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>();
const mockAppListeners = new Set<(state: string) => void>();
const mockSounds: any[] = [];
const mockVideos: any[] = [];
const mockNativeSounds = new Map<number, any>();
const mockNativeSet = jest.fn();
const mockNativeUnload = jest.fn();
const mockAudioSource = jest.fn();
let mockNextKey = 1;
const mockSource = (status: object = {}) => ({ isLoaded: true, isPlaying: true, isMuted: false, isBuffering: false,
  positionMillis: 600, durationMillis: 2000, didJustFinish: false, volume: 1, rate: 1, ...status });
jest.mock('../../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../context/SessionContext.tsx'),
  useSession: () => ({ userId: mockActor, isAuthed: !!mockActor, configured: true }),
}));
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'),
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mockEnabled && ['media_dubbing_enabled', 'media_captions_enabled'].includes(flag) }),
}));
jest.mock('../../../services/messaging.ts', () => ({
  ...jest.requireActual('../../../services/messaging.ts'),
  getMyLanguageSettings: async () => ({ ok: true, data: { preferred_language: 'fr' } }),
  updateMyLanguageSettings: async () => ({ ok: true }),
}));
jest.mock('../../../lib/supabase.ts', () => ({
  ...jest.requireActual('../../../lib/supabase.ts'),
  supabase: { auth: {
    getSession: async () => ({ data: { session: mockActor ? mockAuthSession(mockActor) : null }, error: null }),
    onAuthStateChange: (listener: (event: AuthChangeEvent, session: Session | null) => void) => {
    mockPreferenceListeners.add(listener);
    return { data: { subscription: { unsubscribe: () => mockPreferenceListeners.delete(listener) } } };
  } } },
}));
jest.mock('../../../services/mediaUrl.ts', () => ({
  ...jest.requireActual('../../../services/mediaUrl.ts'),
  useHydratedMedia: (sources: string[]) => ({ resolved: Object.fromEntries(sources.filter(Boolean).map(source => [source, `https://media.invalid/${encodeURIComponent(source)}`])) }),
}));
jest.mock('../../../components/media/MediaCaptionControls.tsx', () => ({
  ...jest.requireActual('../../../components/media/MediaCaptionControls.tsx'), MediaCaptionControls: () => null,
}));
jest.mock('../../../services/media/captions.ts', () => ({
  ...jest.requireActual('../../../services/media/captions.ts'),
  resolveCaptionSource: async (source: string) => ({ assetId: asset, version: source.includes('second') ? 2 : 1, revisionKey: 'b'.repeat(64), durationMs: 2000, canEdit: false }),
}));
jest.mock('../../../services/media/dubbing.ts', () => ({
  ...jest.requireActual('../../../services/media/dubbing.ts'),
  getDubbingOptions: async () => ({ assetId: asset, sourceVersion: mockDescriptorVersion, sourceKey: String(mockDescriptorVersion).repeat(64), canEdit: false, enabled: true,
    languages: [{ code: 'fr', label: 'French', ready: true }] }),
  dubbingAudioSource: (...args: unknown[]) => mockAudioSource(...args),
  subscribeDubbingAuth: (listener: () => void) => { mockAuthListeners.add(listener); return () => mockAuthListeners.delete(listener); },
}));
let mockDescriptorVersion = 1;
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native'); const React = require('react');
  return new Proxy(actual, { get(target, key) {
    if (key === 'Modal') return ({ visible, children }: any) => visible ? React.createElement(actual.View, null, children) : null;
    if (key === 'AppState') return { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => {
      mockAppListeners.add(listener); return { remove: () => mockAppListeners.delete(listener) };
    } };
    return Reflect.get(target, key);
  } });
});
jest.mock('expo-av/build/ExponentAV', () => ({ __esModule: true, default: {
  ...jest.requireActual('expo-av/build/ExponentAV.web').default,
  addListener: jest.fn(), removeListeners: jest.fn(),
  loadForSound: async (_source: unknown, status: any) => {
    const key = mockNextKey++;
    const state = mockSource({ ...status, isPlaying: status.shouldPlay === true });
    mockNativeSounds.set(key, state); return [key, state];
  },
  getStatusForSound: async (key: number) => mockNativeSounds.get(key),
  setStatusForSound: (key: number, status: any) => mockNativeSet(key, status),
  unloadForSound: (key: number) => mockNativeUnload(key),
} }));
jest.mock('expo-av', () => {
  const actual = jest.requireActual('expo-av/build/Audio/Sound');
  const React = require('react'); const { View } = require('react-native');
  class Sound extends actual.Sound { constructor() { super(); mockSounds.push(this); } }
  const Video = React.forwardRef((props: any, ref: any) => {
    const reference = React.useRef(null);
    if (!reference.current) {
      reference.current = {
        state: mockSource({ isMuted: props.isMuted, isPlaying: props.shouldPlay }),
        getStatusAsync: jest.fn(async () => reference.current.state),
        setStatusAsync: jest.fn(async (status: object) => { reference.current.state = { ...reference.current.state, ...status }; return reference.current.state; }),
        playAsync: jest.fn(async () => { reference.current.state.isPlaying = true; }),
        pauseAsync: jest.fn(async () => { reference.current.state.isPlaying = false; }),
      };
      mockVideos.push(reference.current);
    }
    reference.current.state.isMuted = props.isMuted;
    reference.current.state.isPlaying = props.shouldPlay;
    reference.current.props = props;
    React.useImperativeHandle(ref, () => reference.current, []);
    return React.createElement(View, { ...props, testID: 'native-video-boundary' });
  });
  return { Video, Audio: { Sound }, ResizeMode: { COVER: 'cover', CONTAIN: 'contain' } };
});

const originalFetch = global.fetch;
const originalAudioSampleCallback = (globalThis as any).__EXAV_setOnAudioSampleReceivedCallback;
const pendingResolutions: Array<() => void> = [];
function mockAuthSession(owner: string): Session {
  return {
    access_token: `e30.${Buffer.from(JSON.stringify({ sub: owner, session_id: `${owner}-session-a` })).toString('base64url')}.synthetic`,
    refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-16T00:00:00Z' },
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await act(async () => { for (let turn = 0; turn < 100; turn += 1) await Promise.resolve(); }); }
function tree(source = 'original.mp4', muted = false, instance = 'first') {
  return <LanguagePreferenceProvider><SharedVideoPlayer key={instance} uri={`post-media/${alice}/${source}`} autoplay muted={muted} /></LanguagePreferenceProvider>;
}
async function mount(source = 'original.mp4', muted = false, instance = 'first') {
  const screen = await render(tree(source, muted, instance)); await settle(); return screen;
}
async function manualSelect(screen: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(screen.getByLabelText('Audio language options'));
  await fireEvent.press(screen.getByLabelText('Play AI audio'));
  await settle();
}
function nativeAudible(key: number) {
  const state = mockNativeSounds.get(key);
  return state?.isLoaded === true && state.isPlaying === true && state.isMuted === false && state.volume > 0;
}
beforeEach(async () => {
  mockLifetime = createDubbingPlaybackLifetime();
  await AsyncStorage.clear(); mockActor = alice; mockEnabled = true; mockDescriptorVersion = 1;
  mockSounds.length = 0; mockVideos.length = 0; mockNativeSounds.clear(); mockNextKey = 1;
  mockAuthListeners.clear(); mockPreferenceListeners.clear(); mockAppListeners.clear();
  (globalThis as any).__EXAV_setOnAudioSampleReceivedCallback = jest.fn();
  global.fetch = jest.fn(async () => { throw Error('Unexpected network attempt in private proof'); });
  mockAudioSource.mockReset().mockResolvedValue({ uri: 'https://media.invalid/authorized-synthetic-dubbing.wav', headers: { Authorization: 'Bearer synthetic' } });
  mockNativeSet.mockReset().mockImplementation(async (key, patch) => {
    const state = { ...mockNativeSounds.get(key), ...patch, isPlaying: patch.shouldPlay ?? mockNativeSounds.get(key).isPlaying };
    mockNativeSounds.set(key, state); return state;
  });
  mockNativeUnload.mockReset().mockImplementation(async key => { mockNativeSounds.set(key, { isLoaded: false, isPlaying: false }); return { isLoaded: false }; });
});
afterEach(async () => {
  pendingResolutions.splice(0).forEach(resolve => resolve()); await settle(); await cleanup(); await settle();
  global.fetch = originalFetch; (globalThis as any).__EXAV_setOnAudioSampleReceivedCallback = originalAudioSampleCallback;
});

test('CONTROL actual shared player selects synthetic audio, then restores original without seeking/starting original', async () => {
  const screen = await mount(); expect(mockSounds).toHaveLength(0);
  await manualSelect(screen); expect(nativeAudible(1)).toBe(true);
  expect(screen.getByTestId('native-video-boundary').props.isMuted).toBe(true);
  await fireEvent.press(screen.getByLabelText('Original audio')); await settle();
  expect(nativeAudible(1)).toBe(false);
  expect(screen.getByTestId('native-video-boundary').props.isMuted).toBe(false);
  expect(mockVideos[0].setStatusAsync.mock.calls.every(([status]: any) => !('shouldPlay' in status) && !('positionMillis' in status))).toBe(true);
});

test('CONTROL user-muted original stays muted after successful dub cleanup', async () => {
  const screen = await mount('original.mp4', true); await manualSelect(screen);
  expect(nativeAudible(1)).toBe(false);
  await fireEvent.press(screen.getByLabelText('Original audio')); await settle();
  expect(screen.getByTestId('native-video-boundary').props.isMuted).toBe(true);
  expect(mockNativeSounds.get(1).isLoaded).toBe(false);
});

test('CONTROL feature OFF never authorizes or constructs auxiliary sound', async () => {
  mockEnabled = false; const screen = await mount();
  expect(mockSounds).toHaveLength(0); expect(mockAudioSource).not.toHaveBeenCalled();
  expect(screen.getByTestId('native-video-boundary').props.isMuted).toBe(false);
});

test('CONTROL same mounted hook retains quarantine after installed Expo wrapper loses its native handle', async () => {
  const screen = await mount(); await manualSelect(screen);
  mockNativeSet.mockRejectedValueOnce(Error('stop failed')); mockNativeUnload.mockRejectedValueOnce(Error('unload failed'));
  await fireEvent.press(screen.getByLabelText('Original audio')); await settle();
  expect(mockSounds[0]._key).toBeNull(); expect(mockSounds[0]._loaded).toBe(false);
  expect(nativeAudible(1)).toBe(true);
  expect(await mockSounds[0].unloadAsync()).toMatchObject({ isLoaded: false });
  expect(mockNativeUnload).toHaveBeenCalledTimes(1);
  expect(nativeAudible(1)).toBe(true);
  expect(screen.getByTestId('native-video-boundary').props.isMuted).toBe(true);
  await fireEvent.press(screen.getByLabelText('Play AI audio')); await settle();
  expect(mockSounds).toHaveLength(1);
  expect(screen.getByText(/Audio cleanup or restoration failed/)).toBeTruthy();
});

test('RED remount after lost-handle cleanup failure must not create another dubbing sound', async () => {
  const first = await mount(); await manualSelect(first);
  mockNativeSet.mockRejectedValueOnce(Error('stop failed')); mockNativeUnload.mockRejectedValueOnce(Error('unload failed'));
  await first.unmount(); await settle();
  expect(nativeAudible(1)).toBe(true); expect(mockSounds[0]._key).toBeNull();
  const second = await mount(); await manualSelect(second);
  const observation = { retainedNativeAudible: nativeAudible(1), replacementNativeAudible: nativeAudible(2), soundCount: mockSounds.length };
  expect(observation).toEqual({ retainedNativeAudible: true, replacementNativeAudible: false, soundCount: 1 });
});

test('RED keyed content replacement during pending unload must retain the unresolved admission barrier', async () => {
  const screen = await mount(); await manualSelect(screen);
  const held = deferred<void>(); pendingResolutions.push(() => held.resolve());
  mockNativeSet.mockRejectedValueOnce(Error('stop failed'));
  mockNativeUnload.mockImplementationOnce(async key => { await held.promise; mockNativeSounds.set(key, { isLoaded: false, isPlaying: false }); return { isLoaded: false }; });
  mockDescriptorVersion = 2;
  await screen.rerender(tree('second.mp4', false, 'replacement')); await settle();
  expect(nativeAudible(1)).toBe(true);
  await manualSelect(screen);
  expect({ old: nativeAudible(1), new: nativeAudible(2), count: mockSounds.length }).toEqual({ old: true, new: false, count: 1 });
});

test('RED account replacement after failed teardown must not forget the previous audible private track', async () => {
  const first = await mount(); await manualSelect(first);
  mockNativeSet.mockRejectedValueOnce(Error('stop failed')); mockNativeUnload.mockRejectedValueOnce(Error('unload failed'));
  await first.unmount(); await settle(); mockActor = bob;
  const second = await mount(); await manualSelect(second);
  expect(mockAudioSource).toHaveBeenCalledTimes(1);
  expect({ old: nativeAudible(1), new: nativeAudible(2), count: mockSounds.length }).toEqual({ old: true, new: false, count: 1 });
});

test.each(['unmount', 'account', 'content', 'preference'] as const)('CONTROL pending native play then %s invalidation eventually silences after successful native stop/unload', async reason => {
  const held = deferred<void>(); pendingResolutions.push(() => held.resolve());
  mockNativeSet.mockImplementationOnce(async (key, patch) => {
    await held.promise;
    const state = { ...mockNativeSounds.get(key), ...patch, isPlaying: patch.shouldPlay === true };
    mockNativeSounds.set(key, state); return state;
  });
  await writeAutomaticDubbingPreference({ userId: alice, enabled: true }, () => true);
  const screen = await mount();
  expect(mockNativeSet).toHaveBeenCalledWith(1, expect.objectContaining({ shouldPlay: true }));
  if (reason === 'unmount') await screen.unmount();
  if (reason === 'account') { mockActor = null; await screen.rerender(tree()); }
  if (reason === 'content') { mockDescriptorVersion = 2; await screen.rerender(tree('second.mp4')); }
  if (reason === 'preference') {
    await fireEvent.press(screen.getByLabelText('Audio language options'));
    await fireEvent.press(screen.getByLabelText('Automatically use AI audio in my preferred language'));
  }
  await settle();
  expect(mockNativeUnload).not.toHaveBeenCalled();
  await act(async () => { held.resolve(); }); await settle();
  expect(nativeAudible(1)).toBe(false); expect(mockNativeSounds.get(1).isLoaded).toBe(false);
  expect(mockNativeSet).toHaveBeenCalledWith(1, { shouldPlay: false, isMuted: true });
  expect(mockNativeUnload).toHaveBeenCalledWith(1);
});

test('retained dubbing uncertainty never mutes a different mounted original or disables global audio', async () => {
  const first = await mount(); await manualSelect(first);
  mockNativeSet.mockRejectedValueOnce(Error('stop failed')); mockNativeUnload.mockRejectedValueOnce(Error('unload failed'));
  await first.unmount(); await settle(); mockActor = bob;
  const second = await mount('original.mp4', false, 'unrelated');
  expect(second.getByTestId('native-video-boundary').props.isMuted).toBe(false);
  expect(second.getByTestId('native-video-boundary').props.shouldPlay).toBe(true);
  expect(mockVideos[1].setStatusAsync).not.toHaveBeenCalled();
  await manualSelect(second);
  expect(mockSounds).toHaveLength(1); expect(mockAudioSource).toHaveBeenCalledTimes(1);
  expect(second.getByTestId('native-video-boundary').props.isMuted).toBe(false);
  expect(second.getByText('AI audio is unavailable. Original audio is selected.')).toBeTruthy();
});

test('feature-OFF original playback remains independent of an old dubbing quarantine', async () => {
  const first = await mount(); await manualSelect(first);
  mockNativeUnload.mockRejectedValueOnce(Error('unload failed'));
  await first.unmount(); await settle(); mockEnabled = false;
  const second = await mount();
  expect(second.getByTestId('native-video-boundary').props.isMuted).toBe(false);
  expect(second.getByTestId('native-video-boundary').props.shouldPlay).toBe(true);
  expect(mockVideos[1].setStatusAsync).not.toHaveBeenCalled();
  expect(mockSounds).toHaveLength(1); expect(mockAudioSource).toHaveBeenCalledTimes(1);
});

test('new-mount Original and repeated selection cannot clear lost-handle uncertainty', async () => {
  const first = await mount(); await manualSelect(first);
  mockNativeSet.mockRejectedValueOnce(Error('stop failed')); mockNativeUnload.mockRejectedValueOnce(Error('unload failed'));
  await first.unmount(); await settle();
  const second = await mount(); await manualSelect(second);
  await fireEvent.press(second.getByLabelText('Original audio')); await settle();
  await fireEvent.press(second.getByLabelText('Play AI audio')); await settle();
  expect(mockNativeUnload).toHaveBeenCalledTimes(1);
  expect(mockSounds).toHaveLength(1); expect(mockAudioSource).toHaveBeenCalledTimes(1);
  expect(nativeAudible(1)).toBe(true);
});

test('confirmed retirement permits a later explicit selection without touching the old original controller', async () => {
  const first = await mount(); await manualSelect(first);
  const oldVideo = mockVideos[0];
  await first.unmount(); await settle();
  const second = await mount(); await manualSelect(second);
  expect(mockSounds).toHaveLength(2); expect(nativeAudible(1)).toBe(false); expect(nativeAudible(2)).toBe(true);
  expect(oldVideo.setStatusAsync.mock.calls).toEqual([[{ isMuted: true }]]);
  expect(mockVideos[1].setStatusAsync.mock.calls).toEqual([[{ isMuted: true }]]);
});

test('pending acknowledged retirement blocks remounted automatic admission without silently retrying after release', async () => {
  await writeAutomaticDubbingPreference({ userId: alice, enabled: true }, () => true);
  const first = await mount(); expect(nativeAudible(1)).toBe(true);
  const held = deferred<void>(); pendingResolutions.push(() => held.resolve());
  mockNativeUnload.mockImplementationOnce(async key => {
    await held.promise; mockNativeSounds.set(key, { isLoaded: false, isPlaying: false }); return { isLoaded: false };
  });
  await first.unmount(); await settle();
  expect(nativeAudible(1)).toBe(false);
  const second = await mount();
  expect(mockSounds).toHaveLength(1); expect(mockAudioSource).toHaveBeenCalledTimes(1);
  expect(second.getByTestId('native-video-boundary').props.isMuted).toBe(false);
  await act(async () => { held.resolve(); }); await settle();
  expect(mockSounds).toHaveLength(1); expect(mockAudioSource).toHaveBeenCalledTimes(1);
  await manualSelect(second);
  expect(mockSounds).toHaveLength(2); expect(nativeAudible(2)).toBe(true);
});
