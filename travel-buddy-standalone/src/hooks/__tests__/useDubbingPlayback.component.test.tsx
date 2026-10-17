import React from 'react';
import { Text } from 'react-native';
import { render, act, waitFor } from '@testing-library/react-native';
import { useDubbingPlayback, type DubbingPlaybackOptions, type DubbingPlayback } from '../useDubbingPlayback.ts';
import * as service from '../../services/media/dubbing.ts';
import type { AVPlaybackStatusToSet } from 'expo-av';
import { createDubbingPlaybackLifetime } from '../../services/media/dubbingPlaybackLifetime.ts';

let mockLifetime: ReturnType<typeof createDubbingPlaybackLifetime>;
jest.mock('../../services/media/dubbingPlaybackLifetime.ts', () => {
  const actual = jest.requireActual('../../services/media/dubbingPlaybackLifetime.ts');
  return new Proxy(actual, { get(target, key) { return key === 'dubbingPlaybackLifetime' ? mockLifetime : Reflect.get(target, key); } });
});

let mockUserId: string | null = '11111111-1111-4111-8111-111111111111';
let mockPreferred: string | null = 'fr';
let mockAppListener: ((state: string) => void) | undefined;
let mockAuthListener: (() => void) | undefined;
const mockSounds: any[] = [];
let mockNextLoad: Promise<unknown> | undefined;
jest.mock('../../context/SessionContext.tsx', () => { return { useSession: () => ({ userId: mockUserId, isAuthed: !!mockUserId }) }; });
jest.mock('../../context/LanguagePreferenceContext.tsx', () => { return { useLanguagePreference: () => ({ preferredLanguage: mockPreferred }) }; });
jest.mock('../../services/media/dubbing.ts', () => {
  return { dubbingAudioSource: jest.fn(), subscribeDubbingAuth: (listener: () => void) => { mockAuthListener = listener; return jest.fn(); } };
});
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, { get(target, key) { if (key === 'AppState') return { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => { mockAppListener = listener; return { remove: jest.fn() }; } }; return Reflect.get(target, key); } });
});
jest.mock('expo-av', () => {
  class Sound {
    state = { isLoaded: false, isPlaying: false, positionMillis: 0, durationMillis: 2000, isMuted: true };
    callback: ((status: unknown) => void) | null = null;
    loadAsync = jest.fn(async (_source: unknown, status: object) => { if (mockNextLoad) { const pending = mockNextLoad; mockNextLoad = undefined; await pending; } this.state = { ...this.state, ...status, isLoaded: true }; return this.state; });
    setStatusAsync = jest.fn(async (status: any) => { this.state = { ...this.state, ...status, isPlaying: status.shouldPlay ?? this.state.isPlaying }; return this.state; });
    unloadAsync = jest.fn(async () => { this.state.isLoaded = false; this.state.isPlaying = false; return this.state; });
    setOnPlaybackStatusUpdate = jest.fn((callback) => { this.callback = callback; });
    constructor() { mockSounds.push(this); }
  }
  return { Audio: { Sound } };
});

let playback: DubbingPlayback;
const videoStatus = { isLoaded: true, isPlaying: true, isBuffering: false, positionMillis: 600, durationMillis: 2000, didJustFinish: false };
const controller = { getStatusAsync: jest.fn(async () => videoStatus), setStatusAsync: jest.fn(async (_status: AVPlaybackStatusToSet) => videoStatus) };
const defaults = (): DubbingPlaybackOptions => ({ assetId: '22222222-2222-4222-8222-222222222222', sourceKey: 'video-v1/captions-v1/consent-v1', enabled: true, active: true, controller: controller as never, controlSource: { shouldPlay: true, isMuted: false, volume: 0.7, rate: 1 }, languages: ['en-US', 'fr'] });
function Mounted({ options }: { options: DubbingPlaybackOptions }) { playback = useDubbingPlayback(options); return <Text testID="state">{`${playback.status}:${playback.muteOriginal}:${playback.language}`}</Text>; }
async function select(language = 'fr') { await act(async () => { await playback.selectDubbed(language); }); }

beforeEach(() => {
  mockLifetime = createDubbingPlaybackLifetime();
  jest.clearAllMocks(); mockSounds.length = 0; mockNextLoad = undefined; mockUserId = '11111111-1111-4111-8111-111111111111'; mockPreferred = 'fr';
  jest.mocked(service.dubbingAudioSource).mockResolvedValue({ uri: 'https://app.example/api/media/id/dubbing/audio?language=fr', headers: { Authorization: 'Bearer test' } });
  controller.getStatusAsync.mockResolvedValue(videoStatus); controller.setStatusAsync.mockResolvedValue(videoStatus);
});

it('mounts original audio by default; ordinary preferred language never opts in', async () => {
  await render(<Mounted options={defaults()} />);
  expect(playback.muteOriginal).toBe(false); expect(playback.status).toBe('original'); expect(service.dubbingAudioSource).not.toHaveBeenCalled();
});

it('explicit account-bound automatic setting selects only the exact preferred language', async () => {
  await render(<Mounted options={{ ...defaults(), automaticPreference: { userId: mockUserId!, enabled: true } }} />);
  await waitFor(() => expect(playback.status).toBe('ready'));
  expect(playback.language).toBe('fr'); expect(mockSounds).toHaveLength(1);
});

it('loads paused/muted, awaits original mute, then follows the existing source controller', async () => {
  await render(<Mounted options={defaults()} />); await select();
  expect(mockSounds[0].loadAsync).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ shouldPlay: false, isMuted: true }), false);
  expect(controller.setStatusAsync).toHaveBeenCalledWith({ isMuted: true });
  expect(mockSounds[0].state).toMatchObject({ isPlaying: true, positionMillis: 600, volume: 0.7, isMuted: false });
  expect(playback.muteOriginal).toBe(true);
  await act(async () => { playback.onSourceStatus({ ...videoStatus, isPlaying: false, positionMillis: 1200 } as never); });
  await waitFor(() => expect(mockSounds[0].state.isPlaying).toBe(false));
  expect(mockSounds[0].state.positionMillis).toBe(1200);
  await act(async () => { await playback.selectOriginal(); });
  expect(mockSounds[0].unloadAsync).toHaveBeenCalled(); expect(controller.setStatusAsync).toHaveBeenLastCalledWith({ isMuted: false });
  expect(playback.muteOriginal).toBe(false);
});

it('explicit pause intent wins even before a delayed playing status callback', async () => {
  const options = defaults(); const rendered = await render(<Mounted options={options} />); await select();
  await rendered.rerender(<Mounted options={{ ...options, controlSource: { ...options.controlSource, shouldPlay: false } }} />);
  await act(async () => { playback.onSourceStatus(videoStatus as never); });
  await waitFor(() => expect(mockSounds[0].state.isPlaying).toBe(false));
  expect(controller.setStatusAsync.mock.calls.every(([status]) => !('shouldPlay' in status))).toBe(true);
});

it('background unloads and returning foreground does not silently select or play again', async () => {
  await render(<Mounted options={defaults()} />); await select();
  await act(async () => { mockAppListener?.('background'); });
  await waitFor(() => expect(mockSounds[0].unloadAsync).toHaveBeenCalled());
  await act(async () => { mockAppListener?.('active'); });
  expect(playback.muteOriginal).toBe(false); expect(mockSounds).toHaveLength(1);
});

it('source and auth changes invalidate pending native loads; late completion never plays', async () => {
  let resolveLoad!: () => void; mockNextLoad = new Promise<void>((resolve) => { resolveLoad = resolve; });
  const options = defaults(); const rendered = await render(<Mounted options={options} />);
  let pending!: Promise<void>;
  await act(async () => { pending = playback.selectDubbed('fr'); });
  await waitFor(() => expect(mockSounds).toHaveLength(1));
  await rendered.rerender(<Mounted options={{ ...options, sourceKey: 'v2' }} />);
  await act(async () => { resolveLoad(); await pending; });
  expect(mockSounds[0].unloadAsync).toHaveBeenCalled(); expect(mockSounds[0].state.isPlaying).toBe(false); expect(playback.muteOriginal).toBe(false);
  await select(); await act(async () => { mockAuthListener?.(); });
  await waitFor(() => expect(mockSounds[1].unloadAsync).toHaveBeenCalled());
});

it('denial and audio errors fall back to original without starting or seeking video', async () => {
  await render(<Mounted options={defaults()} />);
  jest.mocked(service.dubbingAudioSource).mockRejectedValueOnce(new Error('denied'));
  await select(); expect(playback.status).toBe('unavailable'); expect(playback.muteOriginal).toBe(false);
  await select();
  expect(mockSounds[1].callback).toEqual(expect.any(Function));
  await act(async () => { mockSounds[1].callback({ isLoaded: false, error: 'native error' }); });
  await waitFor(() => expect(playback.muteOriginal).toBe(false));
  expect(controller.setStatusAsync.mock.calls.every(([status]) => !('positionMillis' in status) && !('shouldPlay' in status))).toBe(true);
});

it('scroll deactivation and unmount unload; account-mismatched auto setting does nothing', async () => {
  const options = { ...defaults(), automaticPreference: { userId: 'someone-else', enabled: true } };
  const rendered = await render(<Mounted options={options} />); expect(mockSounds).toHaveLength(0);
  await select(); await rendered.rerender(<Mounted options={{ ...options, active: false }} />);
  await waitFor(() => expect(mockSounds[0].unloadAsync).toHaveBeenCalled());
  await rendered.rerender(<Mounted options={options} />); await select(); await rendered.unmount();
  await waitFor(() => expect(mockSounds[1].unloadAsync).toHaveBeenCalled());
});

it('a selection queued before background cannot reauthorize after foreground', async () => {
  await render(<Mounted options={defaults()} />); await select();
  let finishUnload!: () => void;
  mockSounds[0].unloadAsync.mockImplementationOnce(() => new Promise((resolve) => { finishUnload = () => { mockSounds[0].state.isLoaded = false; resolve({ isLoaded: false }); }; }));
  let pending!: Promise<void>;
  await act(async () => { pending = playback.selectDubbed('en-US'); });
  await waitFor(() => expect(finishUnload).toBeDefined());
  await act(async () => { mockAppListener?.('background'); mockAppListener?.('active'); });
  await act(async () => { finishUnload(); await pending; });
  expect(mockSounds).toHaveLength(1); expect(playback.muteOriginal).toBe(false);
});

it('removing an approved language unloads an already playing dub', async () => {
  const options = defaults(); const mounted = await render(<Mounted options={options} />); await select();
  await mounted.rerender(<Mounted options={{ ...options, languages: ['en-US'] }} />);
  await waitFor(() => expect(mockSounds[0].unloadAsync).toHaveBeenCalled());
  expect(mockSounds[0].state.isPlaying).toBe(false); expect(playback.muteOriginal).toBe(false);
});

it('failed native stop and unload cannot be cleared by Expo losing its native handle', async () => {
  await render(<Mounted options={defaults()} />); await select();
  mockSounds[0].setStatusAsync.mockRejectedValueOnce(new Error('native stop failed'));
  mockSounds[0].unloadAsync.mockImplementationOnce(async () => { mockSounds[0].state.isLoaded = false; throw new Error('native unload failed after handle cleared'); });
  await act(async () => { await playback.selectOriginal(); });
  expect(playback.status).toBe('unavailable'); expect(playback.muteOriginal).toBe(true);
  expect(controller.setStatusAsync).toHaveBeenLastCalledWith({ isMuted: true });
  await act(async () => { await playback.selectOriginal(); });
  await select('en-US');
  expect(playback.status).toBe('unavailable'); expect(playback.muteOriginal).toBe(true);
  expect(mockSounds).toHaveLength(1); expect(mockSounds[0].unloadAsync).toHaveBeenCalledTimes(1);
});

it('unload failure remains unresolved even when pausing succeeds', async () => {
  await render(<Mounted options={defaults()} />); await select();
  mockSounds[0].unloadAsync.mockRejectedValueOnce(new Error('native unload failed'));
  await act(async () => { await playback.selectOriginal(); });
  await act(async () => { await playback.selectOriginal(); });
  expect(mockSounds[0].unloadAsync).toHaveBeenCalledTimes(1);
  expect(playback.status).toBe('unavailable'); expect(playback.muteOriginal).toBe(true);
});

it('volume, mute, rate, buffering, seek and loop follow source intent without controlling video', async () => {
  const options = defaults(); const mounted = await render(<Mounted options={options} />); await select();
  await mounted.rerender(<Mounted options={{ ...options, controlSource: { ...options.controlSource, volume: 0.3, rate: 1.5, isMuted: true } }} />);
  await act(async () => { playback.onSourceStatus({ ...videoStatus, isBuffering: true, positionMillis: 1800 } as never); });
  expect(mockSounds[0].state).toMatchObject({ isPlaying: false, positionMillis: 1800, volume: 0.3, rate: 1.5, isMuted: true, isLooping: false });
  await act(async () => { playback.onSourceStatus({ ...videoStatus, positionMillis: 0 } as never); });
  expect(mockSounds[0].state).toMatchObject({ isPlaying: true, positionMillis: 0 });
  await act(async () => { await playback.selectOriginal(); });
  expect(controller.setStatusAsync).toHaveBeenLastCalledWith({ isMuted: true });
});

it('controller replacement discards old callbacks and account change unloads', async () => {
  const options = defaults(); const mounted = await render(<Mounted options={options} />); await select();
  const oldCallback = playback.onSourceStatus;
  const replacement = { ...controller, getStatusAsync: jest.fn(async () => videoStatus) };
  await mounted.rerender(<Mounted options={{ ...options, controller: replacement as never }} />); await select();
  await act(async () => { oldCallback({ ...videoStatus, positionMillis: 1900 } as never); });
  expect(mockSounds[1].state.positionMillis).toBe(600);
  mockUserId = null;
  await mounted.rerender(<Mounted options={{ ...options, controller: replacement as never }} />);
  await waitFor(() => expect(mockSounds[1].unloadAsync).toHaveBeenCalled());
  expect(playback.muteOriginal).toBe(false);
});

it('rejects duration mismatch and periodically checks authorization of loaded audio', async () => {
  const mounted = await render(<Mounted options={defaults()} />);
  controller.getStatusAsync.mockResolvedValueOnce({ ...videoStatus, durationMillis: 5000 });
  await select(); expect(playback.status).toBe('unavailable'); expect(playback.muteOriginal).toBe(false);
  jest.useFakeTimers();
  try {
    await select();
    jest.mocked(service.dubbingAudioSource).mockRejectedValueOnce(new Error('withdrawn'));
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(mockSounds[1].state.isPlaying).toBe(false); expect(mockSounds[1].state.isLoaded).toBe(false);
    expect(playback.muteOriginal).toBe(false);
    await mounted.unmount();
  } finally { jest.useRealTimers(); }
});

it('a second stop retains the original mute hold while a native stop is still pending', async () => {
  await render(<Mounted options={defaults()} />); await select();
  let finishStop!: () => void;
  mockSounds[0].setStatusAsync.mockImplementationOnce(() => new Promise((resolve) => {
    finishStop = () => { mockSounds[0].state.isPlaying = false; mockSounds[0].state.isMuted = true; resolve(mockSounds[0].state); };
  }));
  let pending!: Promise<void>;
  await act(async () => { pending = playback.selectOriginal(); });
  await waitFor(() => expect(finishStop).toBeDefined());
  await act(async () => { mockAppListener?.('background'); mockAppListener?.('active'); });
  const heldDuringStop = playback.muteOriginal;
  await act(async () => { finishStop(); await pending; });
  expect(heldDuringStop).toBe(true); expect(playback.muteOriginal).toBe(false);
});

it('failed restoration remains retryable instead of claiming original audio was restored', async () => {
  await render(<Mounted options={defaults()} />); await select();
  controller.setStatusAsync.mockRejectedValueOnce(new Error('original restore failed'));
  await act(async () => { await playback.selectOriginal(); });
  expect(playback.status).toBe('unavailable'); expect(playback.muteOriginal).toBe(true);
  await act(async () => { await playback.selectOriginal(); });
  expect(playback.status).toBe('original'); expect(playback.muteOriginal).toBe(false);
});

it.each([
  { isLoaded: false },
  { isLoaded: true, isPlaying: true, isMuted: true },
  { isLoaded: true, isPlaying: false, isMuted: false },
])('an unconfirmed native stop %j cannot be cleared by a later unloaded wrapper result', async stopStatus => {
  await render(<Mounted options={defaults()} />); await select();
  mockSounds[0].setStatusAsync.mockResolvedValueOnce(stopStatus);
  await act(async () => { await playback.selectOriginal(); });
  expect(playback.status).toBe('unavailable'); expect(playback.muteOriginal).toBe(true);
  expect(mockSounds[0].unloadAsync).toHaveBeenCalledTimes(1);
  await select();
  expect(mockSounds).toHaveLength(1); expect(mockSounds[0].unloadAsync).toHaveBeenCalledTimes(1);
});

it.each([null, 'de', 'fr-CA', 'FR'])('automatic audio never substitutes another language for %s', async preferred => {
  mockPreferred = preferred;
  await render(<Mounted options={{ ...defaults(), automaticPreference: { userId: mockUserId!, enabled: true } }} />);
  expect(playback.status).toBe('original');
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
});

it('disabling the automatic preference or losing its supported language restores original audio', async () => {
  const options = { ...defaults(), automaticPreference: { userId: mockUserId!, enabled: true } };
  const mounted = await render(<Mounted options={options} />);
  await waitFor(() => expect(playback.status).toBe('ready'));
  await mounted.rerender(<Mounted options={{ ...options, automaticPreference: { ...options.automaticPreference, enabled: false } }} />);
  await waitFor(() => expect(playback.muteOriginal).toBe(false));
  expect(mockSounds[0].unloadAsync).toHaveBeenCalled();
  await mounted.rerender(<Mounted options={options} />);
  await waitFor(() => expect(playback.status).toBe('ready'));
  mockPreferred = 'unsupported';
  await mounted.rerender(<Mounted options={options} />);
  await waitFor(() => expect(playback.muteOriginal).toBe(false));
  expect(mockSounds).toHaveLength(2);
});

it('Original remains a per-viewer-source override across late preference and readiness updates', async () => {
  const options = { ...defaults(), sessionKey: 'viewer/source/session', automaticPreference: { userId: mockUserId!, enabled: true } };
  mockPreferred = null;
  const mounted = await render(<Mounted options={options} />);
  await act(async () => { await playback.selectOriginal(); });
  mockPreferred = 'fr';
  await mounted.rerender(<Mounted options={options} />);
  await mounted.rerender(<Mounted options={{ ...options, languages: [] }} />);
  await mounted.rerender(<Mounted options={options} />);
  expect(mockSounds).toHaveLength(0);
  await mounted.rerender(<Mounted options={{ ...options, sessionKey: 'viewer/next-source/session' }} />);
  await waitFor(() => expect(playback.language).toBe('fr'));
});

it('manual dubbed language wins over automatic changes and unrelated available-language updates', async () => {
  const options = { ...defaults(), automaticPreference: { userId: mockUserId!, enabled: true } };
  const mounted = await render(<Mounted options={options} />);
  await waitFor(() => expect(playback.status).toBe('ready'));
  await select('en-US');
  mockPreferred = 'de';
  await mounted.rerender(<Mounted options={{ ...options, languages: [...options.languages, 'de'] }} />);
  expect(playback.language).toBe('en-US');
  expect(mockSounds).toHaveLength(2);
  expect(mockSounds[1].unloadAsync).not.toHaveBeenCalled();
});

it('does not load when the feature is OFF even with a saved automatic preference', async () => {
  const options = { ...defaults(), enabled: false, automaticPreference: { userId: mockUserId!, enabled: true } };
  await render(<Mounted options={options} />);
  expect(mockSounds).toHaveLength(0);
  await select();
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
});

it('a late native automatic load cannot play after the viewer disables automatic audio', async () => {
  let finish!: () => void;
  mockNextLoad = new Promise<void>(resolve => { finish = resolve; });
  const options = { ...defaults(), automaticPreference: { userId: mockUserId!, enabled: true } };
  const mounted = await render(<Mounted options={options} />);
  await waitFor(() => expect(mockSounds[0]?.loadAsync).toHaveBeenCalled());
  await mounted.rerender(<Mounted options={{ ...options, automaticPreference: { ...options.automaticPreference, enabled: false } }} />);
  await act(async () => { finish(); });
  await waitFor(() => expect(mockSounds[0].unloadAsync).toHaveBeenCalled());
  expect(mockSounds[0].setStatusAsync.mock.calls.some(([status]: [AVPlaybackStatusToSet]) => status.shouldPlay === true)).toBe(false);
  expect(playback.muteOriginal).toBe(false);
});

it('an unavailable automatic track stays original without a polling retry loop but permits explicit retry', async () => {
  jest.mocked(service.dubbingAudioSource).mockRejectedValueOnce(new Error('unavailable'));
  const options = { ...defaults(), automaticPreference: { userId: mockUserId!, enabled: true } };
  const mounted = await render(<Mounted options={options} />);
  await waitFor(() => expect(playback.status).toBe('unavailable'));
  await mounted.rerender(<Mounted options={{ ...options, languages: [...options.languages, 'de'] }} />);
  expect(mockSounds).toHaveLength(1);
  expect(playback.muteOriginal).toBe(false);
  await select();
  expect(playback.status).toBe('ready');
});

it('never restores an unmounted original controller during asynchronous retirement', async () => {
  const mounted = await render(<Mounted options={defaults()} />); await select();
  await mounted.unmount();
  await waitFor(() => expect(mockSounds[0].unloadAsync).toHaveBeenCalledTimes(1));
  expect(controller.setStatusAsync.mock.calls).toEqual([[{ isMuted: true }]]);
});

it('a replacement original controller never inherits the old controller mute hold or restoration', async () => {
  const options = defaults(); const mounted = await render(<Mounted options={options} />); await select();
  let finish!: () => void;
  mockSounds[0].unloadAsync.mockImplementationOnce(() => new Promise(resolve => {
    finish = () => { mockSounds[0].state.isLoaded = false; resolve({ isLoaded: false }); };
  }));
  const replacement = { getStatusAsync: jest.fn(async () => videoStatus), setStatusAsync: jest.fn(async () => videoStatus) };
  await mounted.rerender(<Mounted options={{ ...options, controller: replacement as never }} />);
  expect(playback.muteOriginal).toBe(false);
  await act(async () => { finish(); });
  expect(controller.setStatusAsync.mock.calls).toEqual([[{ isMuted: true }]]);
  expect(replacement.setStatusAsync).not.toHaveBeenCalled();
  expect(playback.muteOriginal).toBe(false);
});

it('a changed mute intent during original restoration stays held until exact-controller retry', async () => {
  const options = defaults(); const mounted = await render(<Mounted options={options} />); await select();
  let finish!: () => void;
  controller.setStatusAsync.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(videoStatus); }));
  let pending!: Promise<void>;
  await act(async () => { pending = playback.selectOriginal(); });
  await waitFor(() => expect(finish).toBeDefined());
  await mounted.rerender(<Mounted options={{ ...options, controlSource: { ...options.controlSource, isMuted: true } }} />);
  await act(async () => { finish(); await pending; });
  expect(playback.status).toBe('unavailable'); expect(playback.muteOriginal).toBe(true);
  await act(async () => { await playback.selectOriginal(); });
  expect(controller.setStatusAsync).toHaveBeenLastCalledWith({ isMuted: true });
  expect(mockSounds[0].unloadAsync).toHaveBeenCalledTimes(1);
  expect(playback.status).toBe('original'); expect(playback.muteOriginal).toBe(false);
});
