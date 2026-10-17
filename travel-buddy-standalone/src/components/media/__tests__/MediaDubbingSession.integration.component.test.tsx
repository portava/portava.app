import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { AVPlaybackStatusToSet } from 'expo-av';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { MediaDubbingSession, useMediaDubbingSession } from '../MediaDubbingSession.tsx';
import * as service from '../../../services/media/dubbing.ts';
import { resolveCaptionSource } from '../../../services/media/captions.ts';
import { LanguagePreferenceProvider, useLanguagePreference } from '../../../context/LanguagePreferenceContext.tsx';
import { readAutomaticDubbingPreference, writeAutomaticDubbingPreference } from '../../../services/languagePreferences.ts';
import AsyncStorage from '@react-native-async-storage/async-storage';

let mockActor = '11111111-1111-4111-8111-111111111111';
let mockEnabled = true;
let mockRealPreferences = false;
let mockLanguage: string | null = 'fr';
let mockSessionId = 'session-a';
let mockTokenVersion = 'initial';
let preference: ReturnType<typeof useLanguagePreference>;
const mockPreferenceAuthListeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>();
const mockAppListeners = new Set<(state: string) => void>();
const mockAuthListeners = new Set<() => void>();
let mockNextLoad: Promise<void> | undefined;
interface SoundFixture {
  state: { isLoaded: boolean; isPlaying: boolean; isMuted: boolean; positionMillis: number; durationMillis: number };
  loadAsync: jest.Mock;
  setStatusAsync: jest.Mock;
  unloadAsync: jest.Mock;
}
const mockSounds: SoundFixture[] = [];
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockActor, isAuthed: !!mockActor, configured: true }) }));
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({ ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'), useFeatureFlags: () => ({ isEnabled: () => mockEnabled }) }));
jest.mock('../../../context/LanguagePreferenceContext.tsx', () => ({ ...jest.requireActual('../../../context/LanguagePreferenceContext.tsx'), useLanguagePreference: () => mockRealPreferences ? jest.requireActual('../../../context/LanguagePreferenceContext.tsx').useLanguagePreference() : { preferredLanguage: 'fr' } }));
jest.mock('../../../services/messaging.ts', () => ({ ...jest.requireActual('../../../services/messaging.ts'),
  getMyLanguageSettings: jest.fn(async () => ({ ok: true, data: { preferred_language: mockLanguage } })),
  updateMyLanguageSettings: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../../lib/supabase.ts', () => ({ ...jest.requireActual('../../../lib/supabase.ts'), supabase: { auth: {
  getSession: async () => ({ data: { session: mockActor ? mockAuthSession() : null }, error: null }),
  onAuthStateChange: (listener: (event: AuthChangeEvent, session: Session | null) => void) => {
    mockPreferenceAuthListeners.add(listener);
    return { data: { subscription: { unsubscribe: () => mockPreferenceAuthListeners.delete(listener) } } };
  },
} } }));
jest.mock('../../../services/media/dubbing.ts', () => ({
  ...jest.requireActual('../../../services/media/dubbing.ts'),
  getDubbingOptions: jest.fn(), dubbingAudioSource: jest.fn(), getDubbingConsent: jest.fn(), requestDubbing: jest.fn(), revokeDubbing: jest.fn(),
  subscribeDubbingAuth: (listener: () => void) => { mockAuthListeners.add(listener); return () => mockAuthListeners.delete(listener); },
}));
jest.mock('../../../services/media/captions.ts', () => ({ ...jest.requireActual('../../../services/media/captions.ts'), resolveCaptionSource: jest.fn() }));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const React = require('react');
  const Modal = ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? React.createElement(actual.View, null, children) : null;
  return new Proxy(actual, { get(target, key) {
    if (key === 'Modal') return Modal;
    if (key === 'AppState') return { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => {
      mockAppListeners.add(listener); return { remove: () => mockAppListeners.delete(listener) };
    } };
    return Reflect.get(target, key);
  } });
});
jest.mock('expo-av', () => {
  class Sound {
    state = { isLoaded: false, isPlaying: false, isMuted: true, positionMillis: 0, durationMillis: 2000 };
    loadAsync = jest.fn(async (_source: unknown, status: AVPlaybackStatusToSet) => {
      const pending = mockNextLoad; mockNextLoad = undefined; await pending;
      this.state = { ...this.state, ...status, isLoaded: true, isPlaying: status.shouldPlay === true }; return this.state;
    });
    setStatusAsync = jest.fn(async (status: AVPlaybackStatusToSet) => {
      this.state = { ...this.state, ...status, isPlaying: status.shouldPlay ?? this.state.isPlaying }; return this.state;
    });
    unloadAsync = jest.fn(async () => { this.state = { ...this.state, isLoaded: false, isPlaying: false }; return { isLoaded: false }; });
    setOnPlaybackStatusUpdate = jest.fn();
    constructor() { mockSounds.push(this); }
  }
  return { Audio: { Sound } };
});

const assetId = '22222222-2222-4222-8222-222222222222';
const descriptor: service.DubbingOptions = { assetId, sourceVersion: 1, sourceKey: 'a'.repeat(64), canEdit: false, enabled: true,
  languages: [{ code: 'en', label: 'English', ready: true }, { code: 'fr', label: 'French', ready: false }] };
const videoStatus = { isLoaded: true as const, isPlaying: true, isBuffering: false, positionMillis: 600, durationMillis: 2000, didJustFinish: false };
const controller = { getStatusAsync: jest.fn(async () => videoStatus), setStatusAsync: jest.fn(async (_status: AVPlaybackStatusToSet) => videoStatus) };
let session: ReturnType<typeof useMediaDubbingSession>;
function Mounted({ source = 'original-a', active = true, shouldPlay = true }: { source?: string; active?: boolean; shouldPlay?: boolean }) {
  session = useMediaDubbingSession({ source, active, controller: controller as never, controlSource: { shouldPlay, isMuted: false, volume: 0.7, rate: 1 } });
  return <><Text testID="mute-original">{String(session.playback.muteOriginal)}</Text><MediaDubbingSession session={session} /></>;
}
async function select() { await act(async () => { await session.playback.selectDubbed('en'); }); }
function appState(state: string) { mockAppListeners.forEach(listener => listener(state)); }
function PreferencesProbe() { preference = useLanguagePreference(); return null; }
function WithPreferences() { return <LanguagePreferenceProvider><PreferencesProbe /><Mounted /></LanguagePreferenceProvider>; }

function mockAuthSession(): Session {
  return {
    access_token: `e30.${Buffer.from(JSON.stringify({ sub: mockActor, session_id: `${mockActor}-${mockSessionId}`, version: mockTokenVersion })).toString('base64url')}.synthetic`,
    refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: mockActor, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-16T00:00:00Z' },
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks(); mockAppListeners.clear(); mockAuthListeners.clear(); mockSounds.length = 0; mockNextLoad = undefined;
  mockPreferenceAuthListeners.clear(); mockRealPreferences = false; mockLanguage = 'fr';
  mockSessionId = 'session-a'; mockTokenVersion = 'initial';
  mockActor = '11111111-1111-4111-8111-111111111111'; mockEnabled = true;
  jest.mocked(resolveCaptionSource).mockResolvedValue({ assetId, version: 1, revisionKey: 'b'.repeat(64), durationMs: 2000, canEdit: false });
  jest.mocked(service.getDubbingOptions).mockResolvedValue(descriptor);
  jest.mocked(service.dubbingAudioSource).mockResolvedValue({ uri: 'https://app.example/api/media/id/dubbing/audio?language=en', headers: { Authorization: 'Bearer fixture' } });
  controller.getStatusAsync.mockResolvedValue(videoStatus); controller.setStatusAsync.mockResolvedValue(videoStatus);
});

it('integrates explicit selection, original mute and pause intent without preferred-language opt-in', async () => {
  const mounted = await render(<Mounted />);
  await waitFor(() => expect(session.options).toEqual(descriptor));
  expect(mockSounds).toHaveLength(0); expect(service.dubbingAudioSource).not.toHaveBeenCalled();
  await act(async () => { await session.playback.selectDubbed('fr'); });
  expect(mockSounds).toHaveLength(0);
  await fireEvent.press(mounted.getByLabelText('Audio language options'));
  await fireEvent.press(mounted.getByLabelText('English'));
  await fireEvent.press(mounted.getByLabelText('Play AI audio'));
  await waitFor(() => expect(session.playback.status).toBe('ready'));
  expect(controller.setStatusAsync).toHaveBeenCalledWith({ isMuted: true });
  expect(mockSounds[0].loadAsync).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ isMuted: true, shouldPlay: false }), false);
  expect(mockSounds[0].state).toMatchObject({ isPlaying: true, isMuted: false, positionMillis: 600, volume: 0.7 });
  expect(mounted.getByTestId('mute-original').props.children).toBe('true');
  await mounted.rerender(<Mounted shouldPlay={false} />);
  await act(async () => { session.playback.onSourceStatus(videoStatus as never); });
  await waitFor(() => expect(mockSounds[0].state.isPlaying).toBe(false));
  await fireEvent.press(mounted.getByLabelText('Original audio'));
  await waitFor(() => expect(session.playback.muteOriginal).toBe(false));
  expect(controller.setStatusAsync).toHaveBeenLastCalledWith({ isMuted: false });
  expect(service.requestDubbing).not.toHaveBeenCalled();
});

it('cancels a descriptor even when background and foreground are batched together', async () => {
  let complete!: (value: service.DubbingOptions) => void;
  let signal: AbortSignal | undefined;
  jest.mocked(service.getDubbingOptions).mockImplementationOnce((_identity, abort) => { signal = abort; return new Promise(resolve => { complete = resolve; }); });
  await render(<Mounted />);
  await waitFor(() => expect(complete).toBeDefined());
  const fresh = { ...descriptor, sourceKey: 'c'.repeat(64) };
  jest.mocked(service.getDubbingOptions).mockResolvedValue(fresh);
  await act(async () => { appState('background'); appState('active'); });
  const aborted = signal?.aborted;
  await act(async () => { complete(descriptor); });
  expect(aborted).toBe(true);
  await waitFor(() => expect(session.options).toEqual(fresh));
  expect(mockSounds).toHaveLength(0);
});

it('invalidates same-account auth events before a pending descriptor can publish', async () => {
  let complete!: (value: service.DubbingOptions) => void;
  let signal: AbortSignal | undefined;
  jest.mocked(service.getDubbingOptions).mockImplementationOnce((_identity, abort) => { signal = abort; return new Promise(resolve => { complete = resolve; }); });
  await render(<Mounted />);
  await waitFor(() => expect(complete).toBeDefined());
  const fresh = { ...descriptor, sourceKey: 'd'.repeat(64) };
  jest.mocked(service.getDubbingOptions).mockResolvedValue(fresh);
  await act(async () => { mockAuthListeners.forEach(listener => listener()); });
  const aborted = signal?.aborted;
  await act(async () => { complete(descriptor); });
  expect(aborted).toBe(true);
  await waitFor(() => expect(session.options).toEqual(fresh));
  expect(mockSounds).toHaveLength(0);
});

it('does not start the options step when an invalidated resolver ignores cancellation', async () => {
  let complete!: (value: Awaited<ReturnType<typeof resolveCaptionSource>>) => void;
  jest.mocked(resolveCaptionSource).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await render(<Mounted />);
  await act(async () => { appState('background'); });
  await act(async () => { complete({ assetId, version: 1, revisionKey: 'b'.repeat(64), durationMs: 2000, canEdit: false }); });
  expect(service.getDubbingOptions).not.toHaveBeenCalled();
  expect(session.options).toBeNull();
});

it('keeps a retryable original-audio recovery control after metadata disappears', async () => {
  const mounted = await render(<Mounted />);
  await waitFor(() => expect(session.options).toEqual(descriptor)); await select();
  controller.setStatusAsync.mockRejectedValueOnce(new Error('original restoration failed'));
  jest.mocked(resolveCaptionSource).mockRejectedValue(new Error('metadata unavailable'));
  await act(async () => { session.invalidate(); });
  await waitFor(() => expect(session.playback.status).toBe('unavailable'));
  expect(session.options).toBeNull(); expect(session.playback.muteOriginal).toBe(true);
  expect(mockSounds[0].state.isLoaded).toBe(false);
  await fireEvent.press(mounted.getByLabelText('Retry original audio'));
  await waitFor(() => expect(session.playback.muteOriginal).toBe(false));
  expect(controller.setStatusAsync).toHaveBeenLastCalledWith({ isMuted: false });
  expect(mounted.queryByLabelText('Retry original audio')).toBeNull();
  expect(mockSounds).toHaveLength(1);
});

it('closes the options sheet across a source identity change', async () => {
  const mounted = await render(<Mounted />);
  await waitFor(() => expect(session.options).toEqual(descriptor));
  await fireEvent.press(mounted.getByLabelText('Audio language options'));
  expect(mounted.getByLabelText('Play AI audio')).toBeTruthy();
  jest.mocked(service.getDubbingOptions).mockResolvedValue({ ...descriptor, sourceKey: 'e'.repeat(64) });
  await mounted.rerender(<Mounted source="original-b" />);
  await waitFor(() => expect(session.options?.sourceKey).toBe('e'.repeat(64)));
  expect(mounted.queryByLabelText('Play AI audio')).toBeNull();
  expect(mockSounds).toHaveLength(0);
});

it('keeps explicit owner withdrawal reachable while OFF with a native mute hold', async () => {
  const mounted = await render(<Mounted />);
  await waitFor(() => expect(session.options).toEqual(descriptor)); await select();
  controller.setStatusAsync.mockRejectedValueOnce(new Error('original restoration failed'));
  const resolutionCount = jest.mocked(resolveCaptionSource).mock.calls.length;
  const optionsCount = jest.mocked(service.getDubbingOptions).mock.calls.length;
  mockEnabled = false;
  await mounted.rerender(<Mounted />);
  await waitFor(() => expect(session.playback.muteOriginal).toBe(true));
  expect(session.options).toBeNull();
  expect(mounted.getByLabelText('Retry original audio')).toBeTruthy();
  expect(mounted.getByLabelText('Manage AI audio permission')).toBeTruthy();
  expect(resolveCaptionSource).toHaveBeenCalledTimes(resolutionCount);
  expect(service.getDubbingOptions).toHaveBeenCalledTimes(optionsCount);
});

it('discards a late native load after source and account replacement', async () => {
  let finish!: () => void;
  mockNextLoad = new Promise<void>(resolve => { finish = resolve; });
  const mounted = await render(<Mounted />);
  await waitFor(() => expect(session.options).toEqual(descriptor));
  let pending!: Promise<void>;
  await act(async () => { pending = session.playback.selectDubbed('en'); });
  await waitFor(() => expect(mockSounds[0]?.loadAsync).toHaveBeenCalled());
  mockActor = '33333333-3333-4333-8333-333333333333';
  await mounted.rerender(<Mounted source="original-b" />);
  await act(async () => { finish(); await pending; });
  expect(mockSounds[0].unloadAsync).toHaveBeenCalled();
  expect(mockSounds[0].setStatusAsync.mock.calls.some(([status]) => status.shouldPlay === true)).toBe(false);
  expect(session.playback.muteOriginal).toBe(false);
});

it('keeps disabled and inactive sessions network-free and unloads on background without resuming', async () => {
  mockEnabled = false;
  const mounted = await render(<Mounted />);
  expect(resolveCaptionSource).not.toHaveBeenCalled(); expect(service.getDubbingOptions).not.toHaveBeenCalled();
  mockEnabled = true;
  await mounted.rerender(<Mounted active={false} />);
  expect(resolveCaptionSource).not.toHaveBeenCalled(); expect(mockSounds).toHaveLength(0);
  await mounted.rerender(<Mounted />);
  await waitFor(() => expect(session.options).toEqual(descriptor)); await select();
  await act(async () => { appState('background'); appState('active'); });
  await waitFor(() => expect(mockSounds[0].unloadAsync).toHaveBeenCalled());
  expect(mockSounds[0].state.isPlaying).toBe(false); expect(session.playback.muteOriginal).toBe(false);
  expect(mockSounds).toHaveLength(1);
  await mounted.unmount();
  expect(mockAppListeners.size).toBe(0); expect(mockAuthListeners.size).toBe(0);
});

it('connects explicit viewer opt-in to durable preferences and ready-only audio without generation consent', async () => {
  mockRealPreferences = true;
  jest.mocked(service.getDubbingOptions).mockResolvedValue({ ...descriptor, languages: descriptor.languages.map(item => ({ ...item, ready: true })) });
  let mounted = await render(<WithPreferences />);
  await waitFor(() => expect(session.options).not.toBeNull());
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
  await fireEvent.press(mounted.getByLabelText('Audio language options'));
  await fireEvent.press(mounted.getByLabelText('Automatically use AI audio in my preferred language'));
  await waitFor(() => expect(session.playback.status).toBe('ready'));
  expect(session.playback.language).toBe('fr');
  expect(mounted.getByLabelText('Audio language options').props.accessibilityValue.text).toBe('AI-generated translated audio: French');
  expect(await readAutomaticDubbingPreference(mockActor)).toBe(true);
  await fireEvent.press(mounted.getByLabelText('Original audio'));
  await waitFor(() => expect(session.playback.muteOriginal).toBe(false));
  expect(await readAutomaticDubbingPreference(mockActor)).toBe(true);
  await mounted.unmount();
  mounted = await render(<WithPreferences />);
  await waitFor(() => expect(session.playback.status).toBe('ready'));
  expect(session.playback.language).toBe('fr');
  expect(service.getDubbingConsent).not.toHaveBeenCalled();
  expect(service.requestDubbing).not.toHaveBeenCalled();
  await mounted.unmount();
});

it('saved automatic audio stays original for unready, unsupported and unset language preferences', async () => {
  mockRealPreferences = true;
  await writeAutomaticDubbingPreference({ userId: mockActor, enabled: true }, () => true);
  const mounted = await render(<WithPreferences />);
  await waitFor(() => expect(session.options).not.toBeNull());
  await waitFor(() => expect(preference.automaticDubbingLoading).toBe(false));
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
  await act(async () => { await preference.updateLanguage('de'); });
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
  await act(async () => { await preference.updateLanguage(null); });
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
  expect(session.playback.muteOriginal).toBe(false);
  await mounted.unmount();
});

it('can turn off a saved preference while the feature is OFF without resolving media', async () => {
  mockRealPreferences = true; mockEnabled = false;
  await writeAutomaticDubbingPreference({ userId: mockActor, enabled: true }, () => true);
  const mounted = await render(<WithPreferences />);
  await fireEvent.press(await mounted.findByLabelText('Audio language options'));
  await fireEvent.press(mounted.getByLabelText('Automatically use AI audio in my preferred language'));
  await waitFor(() => expect(preference.automaticDubbingLoading).toBe(false));
  expect(await readAutomaticDubbingPreference(mockActor)).toBe(false);
  expect(service.getDubbingOptions).not.toHaveBeenCalled();
  expect(resolveCaptionSource).not.toHaveBeenCalled();
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
});

it('restores the correct saved preference after account switches and batched same-account logout/login', async () => {
  mockRealPreferences = true; mockLanguage = 'en';
  const alice = mockActor;
  await writeAutomaticDubbingPreference({ userId: alice, enabled: true }, () => true);
  const mounted = await render(<WithPreferences />);
  await waitFor(() => expect(session.playback.status).toBe('ready'));
  mockActor = '33333333-3333-4333-8333-333333333333';
  await mounted.rerender(<WithPreferences />);
  await waitFor(() => expect(preference.automaticDubbingLoading).toBe(false));
  await waitFor(() => expect(session.playback.muteOriginal).toBe(false));
  expect(preference.automaticDubbingPreference?.enabled).toBe(false);
  expect(mockSounds).toHaveLength(1);
  mockActor = alice;
  await mounted.rerender(<WithPreferences />);
  await waitFor(() => expect(session.playback.status).toBe('ready'));
  expect(mockSounds).toHaveLength(2);
  await act(async () => {
    mockPreferenceAuthListeners.forEach(listener => listener('SIGNED_OUT', null));
    mockAuthListeners.forEach(listener => listener());
    mockSessionId = 'session-b';
    mockPreferenceAuthListeners.forEach(listener => listener('SIGNED_IN', mockAuthSession()));
    mockAuthListeners.forEach(listener => listener());
  });
  await waitFor(() => expect(session.playback.status).toBe('ready'));
  expect(mockSounds).toHaveLength(3);
  expect(mockSounds[1].unloadAsync).toHaveBeenCalled();
  expect(preference.automaticDubbingPreference).toEqual({ userId: alice, enabled: true });
});

it('does not start automatic audio after a rejected preference write and shows the failure', async () => {
  mockRealPreferences = true; mockLanguage = 'en';
  const mounted = await render(<WithPreferences />);
  await waitFor(() => expect(session.options).not.toBeNull());
  await waitFor(() => expect(preference.automaticDubbingLoading).toBe(false));
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await fireEvent.press(mounted.getByLabelText('Audio language options'));
  await fireEvent.press(mounted.getByLabelText('Automatically use AI audio in my preferred language'));
  await mounted.findByText('Automatic audio preference was not saved.');
  expect(service.dubbingAudioSource).not.toHaveBeenCalled();
  expect(await readAutomaticDubbingPreference(mockActor)).toBe(false);
});

it('keeps explicit Original across token refresh, metadata invalidation and background/foreground', async () => {
  mockRealPreferences = true; mockLanguage = 'en';
  await writeAutomaticDubbingPreference({ userId: mockActor, enabled: true }, () => true);
  await render(<WithPreferences />);
  await waitFor(() => expect(session.playback.status).toBe('ready'));
  await act(async () => { await session.playback.selectOriginal(); });
  await act(async () => {
    mockTokenVersion = 'refreshed';
    mockPreferenceAuthListeners.forEach(listener => listener('TOKEN_REFRESHED', mockAuthSession()));
    mockAuthListeners.forEach(listener => listener());
  });
  await waitFor(() => expect(session.options).not.toBeNull());
  await act(async () => { session.invalidate(); });
  await waitFor(() => expect(session.options).not.toBeNull());
  await act(async () => { appState('background'); appState('active'); });
  await waitFor(() => expect(session.options).not.toBeNull());
  expect(session.playback.muteOriginal).toBe(false);
  expect(mockSounds).toHaveLength(1);
  expect(await readAutomaticDubbingPreference(mockActor)).toBe(true);
});
