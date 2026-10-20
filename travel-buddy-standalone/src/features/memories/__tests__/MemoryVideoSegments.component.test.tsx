import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MemoryVideoSegments } from '../MemoryVideoSegments.tsx';

const ownerId = '11111111-1111-4111-8111-111111111111';
const props = { ownerId, memoryId: '22222222-2222-4222-8222-222222222222', itemId: '33333333-3333-4333-8333-333333333333', uri: `post-media/${ownerId}/original.mp4` };
const source = { assetId: '44444444-4444-4444-8444-444444444444', assetVersion: 3, durationMs: 10000, mediaRef: `post-media/${ownerId}/verified-original.mp4` };
const segment = { ...source, ownerId, memoryId: props.memoryId, itemId: props.itemId, id: '55555555-5555-4555-8555-555555555555', startMs: 1000, endMs: 4000, label: 'Arrival', source: 'owner_asserted' as const, createdAt: '2026-10-16T10:00:00Z' };
const mockList = jest.fn();
const mockCreate = jest.fn();
const mockDelete = jest.fn();
const mockResolve = jest.fn();
const mockPlayers: Array<Record<string, any>> = [];
const mockListeners = new Set<(event: string, session: unknown) => void>();
let mockUserId: string | null = ownerId;
let mockAppState: ((state: string) => void) | undefined;
let mockFocusCleanup: (() => void) | undefined;

jest.mock('../../../context/SessionContext', () => { return { useSession: () => ({ userId: mockUserId }) }; });
jest.mock('../../../lib/supabase', () => { return { supabase: { auth: {
  onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
    mockListeners.add(listener);
    return { data: { subscription: { unsubscribe: () => mockListeners.delete(listener) } } };
  },
} } }; });
jest.mock('expo-router', () => { return {
  useFocusEffect: (callback: () => (() => void)) => {
    require('react').useEffect(() => { const cleanup = callback(); mockFocusCleanup = cleanup; return cleanup; }, [callback]);
  },
}; });
jest.mock('../../../services/memoryVideoSegments', () => { return {
  ...jest.requireActual('../../../services/memoryVideoSegments'),
  listMemoryVideoSegments: (...args: unknown[]) => mockList(...args),
  createMemoryVideoSegment: (...args: unknown[]) => mockCreate(...args),
  deleteMemoryVideoSegment: (...args: unknown[]) => mockDelete(...args),
  resolveMemoryVideoOriginal: (...args: unknown[]) => mockResolve(...args),
}; });
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ResizeMode: { CONTAIN: 'contain' },
    Video: React.forwardRef((properties: any, ref: any) => {
      const video = React.useMemo(() => {
        const instance = {
          loadAsync: jest.fn().mockResolvedValue({ isLoaded: true }), unloadAsync: jest.fn().mockResolvedValue(undefined),
          playAsync: jest.fn().mockResolvedValue(undefined), pauseAsync: jest.fn().mockResolvedValue(undefined),
          setPositionAsync: jest.fn().mockResolvedValue(undefined), setStatusAsync: jest.fn().mockResolvedValue(undefined), props: properties,
        };
        mockPlayers.push(instance); return instance;
      }, []);
      video.props = properties;
      React.useImperativeHandle(ref, () => video);
      return <View testID="original-video" {...properties} />;
    }),
  };
});

function latestPlayer() { return mockPlayers[mockPlayers.length - 1]; }
async function ready() { await waitFor(() => expect(screen.queryByLabelText('Loading video segments')).toBeNull()); }
async function draft() {
  await fireEvent.changeText(screen.getByLabelText('Segment start in seconds'), '1.125');
  await fireEvent.changeText(screen.getByLabelText('Segment end in seconds'), '4');
  await fireEvent.changeText(screen.getByLabelText('Segment label'), 'Arrival');
}
beforeEach(() => {
  jest.clearAllMocks(); mockPlayers.length = 0; mockListeners.clear(); mockUserId = ownerId;
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockAppState = listener as (state: string) => void;
    return { remove: jest.fn() };
  });
  mockList.mockReset().mockResolvedValue({ ok: true, source, segments: [] });
  mockResolve.mockReset().mockResolvedValue({ ok: true, uri: 'https://storage.test/storage/v1/object/sign/post-media/original.mp4?token=private' });
  mockCreate.mockReset().mockResolvedValue({ ok: true, segment, created: true });
  mockDelete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

it('lists, validates manual bounds, saves and removes only references', async () => {
  await render(<MemoryVideoSegments {...props} />); await ready();
  expect(screen.getByText('No segments yet.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Save video segment'));
  expect(mockCreate).not.toHaveBeenCalled();
  await draft();
  mockList.mockResolvedValue({ ok: true, source, segments: [segment] });
  await fireEvent.press(screen.getByLabelText('Save video segment')); await ready();
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ ownerId, itemId: props.itemId }), source,
    expect.objectContaining({ assetId: source.assetId, assetVersion: 3, startMs: 1125, endMs: 4000, label: 'Arrival' }), expect.any(AbortSignal));
  expect(screen.getByLabelText('Segment start in seconds').props.value).toBe('');
  await fireEvent.press(screen.getByLabelText('Remove segment Arrival 1–4')); await ready();
  expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ ownerId }), segment.id, expect.any(AbortSignal));
  expect(screen.queryByText('Arrival')).toBeNull();
  expect(mockResolve).not.toHaveBeenCalled();
  expect(latestPlayer().loadAsync).not.toHaveBeenCalled();
});

it('seeks and plays the segment on the one original player, stopping at the end', async () => {
  mockList.mockResolvedValue({ ok: true, source, segments: [segment] });
  await render(<MemoryVideoSegments {...props} />); await ready();
  const video = latestPlayer();
  await fireEvent.press(screen.getByLabelText('Play segment Arrival 1–4')); await ready();
  expect(screen.getAllByTestId('original-video')).toHaveLength(1);
  expect(latestPlayer()).toBe(video);
  expect(video.props.source).toBeUndefined();
  expect(video.props.useNativeControls).toBe(false);
  expect(video.loadAsync).toHaveBeenCalledWith({ uri: expect.stringContaining('/object/sign/') }, expect.objectContaining({ shouldPlay: false, isLooping: false }));
  expect(video.setPositionAsync).toHaveBeenCalledWith(1000, { toleranceMillisBefore: 0, toleranceMillisAfter: 0 });
  expect(video.playAsync).toHaveBeenCalledTimes(1);
  expect(mockResolve).toHaveBeenCalledWith(expect.anything(), source.mediaRef, expect.any(AbortSignal));
  expect(source.mediaRef).not.toBe(props.uri);
  expect(mockList).toHaveBeenCalledTimes(3);
  await act(async () => video.props.onPlaybackStatusUpdate({ isLoaded: true, positionMillis: 4050, isPlaying: true }));
  expect(video.setStatusAsync).toHaveBeenLastCalledWith({ shouldPlay: false, positionMillis: 4000 });
  await fireEvent.press(screen.getByLabelText('Play original video')); await ready();
  expect(video.setPositionAsync).toHaveBeenLastCalledWith(0, { toleranceMillisBefore: 0, toleranceMillisAfter: 0 });
});

it.each(['feature_disabled', 'degraded_unavailable'])('keeps original playback available when segments are %s', async kind => {
  mockList.mockResolvedValue({ ok: false, kind });
  await render(<MemoryVideoSegments {...props} />); await ready();
  expect(screen.queryByLabelText('Save video segment')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Play original video')); await ready();
  expect(latestPlayer().playAsync).toHaveBeenCalledTimes(1);
  expect(mockResolve).toHaveBeenCalledTimes(1);
});

it('refuses stale source versions before playback and clears the old draft', async () => {
  mockList.mockResolvedValue({ ok: true, source, segments: [segment] });
  await render(<MemoryVideoSegments {...props} />); await ready(); await draft();
  mockList.mockResolvedValue({ ok: true, source: { ...source, assetVersion: 4 }, segments: [] });
  await fireEvent.press(screen.getByLabelText('Play segment Arrival 1–4')); await ready();
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockPlayers.every(video => video.playAsync.mock.calls.length === 0)).toBe(true);
  expect(screen.queryByText('Arrival')).toBeNull();
  expect(screen.getByLabelText('Segment start in seconds').props.value).toBe('');
});

it('refuses withdrawal or source replacement that occurs while authorizing playback', async () => {
  mockList.mockResolvedValueOnce({ ok: true, source, segments: [segment] })
    .mockResolvedValueOnce({ ok: true, source, segments: [segment] })
    .mockResolvedValue({ ok: false, kind: 'not_found' });
  await render(<MemoryVideoSegments {...props} />); await ready();
  await fireEvent.press(screen.getByLabelText('Play segment Arrival 1–4')); await ready();
  expect(screen.queryByTestId('original-video')).toBeNull();
  expect(mockPlayers.every(video => video.playAsync.mock.calls.length === 0)).toBe(true);
  expect(screen.getByText('This video is no longer available.')).toBeTruthy();
});

it('reuses the operation ID for an uncertain save retry, but not for an edited intent', async () => {
  mockCreate.mockResolvedValue({ ok: false, kind: 'network_unreachable' });
  await render(<MemoryVideoSegments {...props} />); await ready(); await draft();
  await fireEvent.press(screen.getByLabelText('Save video segment')); await ready();
  await fireEvent.press(screen.getByLabelText('Save video segment')); await ready();
  expect(mockCreate.mock.calls[0][2].operationId).toBe(mockCreate.mock.calls[1][2].operationId);
  await fireEvent.changeText(screen.getByLabelText('Segment label'), 'Departure');
  await fireEvent.press(screen.getByLabelText('Save video segment')); await ready();
  expect(mockCreate.mock.calls[2][2].operationId).not.toBe(mockCreate.mock.calls[1][2].operationId);
});

it('discards late metadata on media switches and never starts playback after unmount', async () => {
  let finishList!: (value: unknown) => void;
  mockList.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve; }));
  const view = await render(<MemoryVideoSegments {...props} />);
  const firstSignal = mockList.mock.calls[0][1];
  await view.rerender(<MemoryVideoSegments {...props} itemId={source.assetId} uri={`post-media/${ownerId}/next.mp4`} />); await ready();
  await act(async () => finishList({ ok: true, source, segments: [segment] }));
  expect(firstSignal.aborted).toBe(true);
  expect(screen.queryByText('Arrival')).toBeNull();
  let finishSign!: (value: unknown) => void;
  mockResolve.mockImplementationOnce(() => new Promise(resolve => { finishSign = resolve; }));
  await fireEvent.press(screen.getByLabelText('Play original video'));
  await waitFor(() => expect(mockResolve).toHaveBeenCalled());
  await view.unmount();
  await act(async () => finishSign({ ok: true, uri: 'https://storage.test/signed' }));
  expect(mockPlayers.every(video => video.playAsync.mock.calls.length === 0)).toBe(true);
});

it('stops and discards playback preparation when the account changes', async () => {
  await render(<MemoryVideoSegments {...props} />); await ready();
  let finishLoad!: (value: unknown) => void;
  const video = latestPlayer();
  video.loadAsync.mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
  await fireEvent.press(screen.getByLabelText('Play original video'));
  await waitFor(() => expect(video.loadAsync).toHaveBeenCalled());
  await act(async () => { for (const listener of mockListeners) listener('SIGNED_OUT', null); });
  await act(async () => finishLoad({ isLoaded: true }));
  expect(video.playAsync).not.toHaveBeenCalled();
  expect(video.unloadAsync).toHaveBeenCalled();
  expect(screen.queryByTestId('original-video')).toBeNull();
  await act(async () => { for (const listener of mockListeners) listener('SIGNED_IN', { user: { id: ownerId } }); });
  await ready();
  expect(screen.getByText('No segments yet.')).toBeTruthy();
});

it('stops and clears content on background or navigation blur; account switches render no owner controls', async () => {
  const view = await render(<MemoryVideoSegments {...props} />); await ready();
  const signal = mockList.mock.calls[0][1];
  await act(async () => mockAppState?.('background'));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByTestId('original-video')).toBeNull();
  await act(async () => mockAppState?.('active')); await ready();
  await act(async () => mockFocusCleanup?.());
  expect(screen.queryByTestId('original-video')).toBeNull();
  mockUserId = source.assetId;
  await view.rerender(<MemoryVideoSegments {...props} />);
  expect(screen.queryByTestId('memory-video-segments')).toBeNull();
});

it('rechecks an active preview and stops when the reference is withdrawn', async () => {
  jest.useFakeTimers();
  mockList.mockResolvedValue({ ok: true, source, segments: [segment] });
  await render(<MemoryVideoSegments {...props} />); await ready();
  await fireEvent.press(screen.getByLabelText('Play segment Arrival 1–4')); await ready();
  const video = latestPlayer();
  mockList.mockResolvedValue({ ok: false, kind: 'not_found' });
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(video.pauseAsync).toHaveBeenCalled();
  expect(video.unloadAsync).toHaveBeenCalled();
  expect(screen.queryByText('Arrival')).toBeNull();
});

it('does not keep a preview playing indefinitely when its authorization recheck hangs', async () => {
  jest.useFakeTimers();
  mockList.mockResolvedValue({ ok: true, source, segments: [segment] });
  await render(<MemoryVideoSegments {...props} />); await ready();
  await fireEvent.press(screen.getByLabelText('Play segment Arrival 1–4')); await ready();
  const video = latestPlayer();
  video.pauseAsync.mockClear();
  mockList.mockImplementation(() => new Promise(() => {}));
  await act(async () => { jest.advanceTimersByTime(15000); });
  expect(video.pauseAsync).toHaveBeenCalled();
  expect(screen.queryByText('Arrival')).toBeNull();
  expect(screen.getByText('Could not connect. Refresh to try again.')).toBeTruthy();
});

it.each([
  { ok: false, kind: 'not_found' },
  { ok: false, kind: 'feature_disabled' },
  { ok: true, source: { ...source, assetVersion: 4 }, segments: [] },
  { ok: true, source: { ...source, mediaRef: props.uri }, segments: [] },
])('rechecks the original source after signing and rejects withdrawal, downgrade or replacement %#', async rechecked => {
  mockList.mockResolvedValueOnce({ ok: true, source, segments: [] })
    .mockResolvedValueOnce({ ok: true, source, segments: [] }).mockResolvedValue(rechecked);
  await render(<MemoryVideoSegments {...props} />); await ready();
  await fireEvent.press(screen.getByLabelText('Play original video')); await ready();
  expect(mockResolve).toHaveBeenCalledTimes(1);
  expect(mockPlayers.every(video => video.loadAsync.mock.calls.length === 0 && video.playAsync.mock.calls.length === 0)).toBe(true);
});

it('periodically rechecks original playback and refuses a withdrawn Memory source', async () => {
  jest.useFakeTimers();
  await render(<MemoryVideoSegments {...props} />); await ready();
  await fireEvent.press(screen.getByLabelText('Play original video')); await ready();
  const video = latestPlayer();
  video.pauseAsync.mockClear(); video.unloadAsync.mockClear();
  mockList.mockResolvedValue({ ok: false, kind: 'not_found' });
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(video.pauseAsync).toHaveBeenCalled();
  expect(video.unloadAsync).toHaveBeenCalled();
  expect(screen.queryByTestId('original-video')).toBeNull();
});

it.each(['feature_disabled', 'degraded_unavailable'])('independently renews original authorization when segments are %s', async kind => {
  jest.useFakeTimers();
  mockList.mockResolvedValue({ ok: false, kind });
  await render(<MemoryVideoSegments {...props} />); await ready();
  await fireEvent.press(screen.getByLabelText('Play original video')); await ready();
  const video = latestPlayer();
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(mockResolve).toHaveBeenCalledTimes(2);
  expect(mockResolve).toHaveBeenLastCalledWith(expect.anything(), props.uri, expect.any(AbortSignal));
  expect(video.playAsync).toHaveBeenCalledTimes(1);
  video.pauseAsync.mockClear(); video.unloadAsync.mockClear();
  mockResolve.mockResolvedValue({ ok: false, kind: 'not_found' });
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(video.pauseAsync).toHaveBeenCalled();
  expect(video.unloadAsync).toHaveBeenCalled();
  expect(screen.queryByTestId('original-video')).toBeNull();
});

it.each(['segment', 'original', 'disabled original'])('stops a late native %s start after its playback lease expires', async mode => {
  jest.useFakeTimers();
  mockList.mockResolvedValue(mode === 'disabled original' ? { ok: false, kind: 'feature_disabled' } : { ok: true, source, segments: [segment] });
  await render(<MemoryVideoSegments {...props} />); await ready();
  const video = latestPlayer();
  let finish!: () => void;
  video.playAsync.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await fireEvent.press(screen.getByLabelText(mode === 'segment' ? 'Play segment Arrival 1–4' : 'Play original video'));
  await waitFor(() => expect(video.playAsync).toHaveBeenCalled());
  const lateStatus = video.props.onPlaybackStatusUpdate;
  await act(async () => { jest.advanceTimersByTime(15000); });
  expect(screen.getByText('Could not connect. Refresh to try again.')).toBeTruthy();
  video.pauseAsync.mockClear(); video.unloadAsync.mockClear();
  await act(async () => {
    finish();
    lateStatus({ isLoaded: true, isPlaying: true, positionMillis: 1000 });
  });
  await ready();
  expect(video.pauseAsync).toHaveBeenCalled();
  expect(video.unloadAsync).toHaveBeenCalled();
  await act(async () => video.props.onPlaybackStatusUpdate({ isLoaded: true, isPlaying: true, positionMillis: 1000 }));
  expect(screen.queryByLabelText('Pause video')).toBeNull();
  expect(video.playAsync).toHaveBeenCalledTimes(1);
});

it.each(['unloadAsync', 'loadAsync', 'setPositionAsync'])('fences pending %s when the authorization lease expires', async method => {
  jest.useFakeTimers();
  await render(<MemoryVideoSegments {...props} />); await ready();
  const video = latestPlayer();
  let finish!: () => void;
  video[method].mockClear().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await fireEvent.press(screen.getByLabelText('Play original video'));
  await waitFor(() => expect(video[method]).toHaveBeenCalled());
  await act(async () => { jest.advanceTimersByTime(15000); });
  video.pauseAsync.mockClear(); video.unloadAsync.mockClear();
  await act(async () => finish()); await ready();
  expect(video.playAsync).not.toHaveBeenCalled();
  expect(video.pauseAsync).toHaveBeenCalled();
  expect(video.unloadAsync).toHaveBeenCalled();
  expect(screen.queryByLabelText('Pause video')).toBeNull();
});

it('does not renew a stopped generation from a delayed authorization response or status callback', async () => {
  jest.useFakeTimers();
  await render(<MemoryVideoSegments {...props} />); await ready();
  await fireEvent.press(screen.getByLabelText('Play original video')); await ready();
  const video = latestPlayer();
  const lateStatus = video.props.onPlaybackStatusUpdate;
  await act(async () => lateStatus({ isLoaded: true, isPlaying: true, positionMillis: 1000 }));
  let finish!: (value: unknown) => void;
  mockList.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { jest.advanceTimersByTime(5000); });
  await fireEvent.press(screen.getByLabelText('Pause video'));
  video.pauseAsync.mockClear();
  await act(async () => {
    finish({ ok: true, source, segments: [] });
    lateStatus({ isLoaded: true, isPlaying: true, positionMillis: 1200 });
  });
  expect(video.pauseAsync).toHaveBeenCalled();
  expect(screen.queryByLabelText('Pause video')).toBeNull();
  const checks = mockList.mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(15000); });
  expect(mockList).toHaveBeenCalledTimes(checks);
  expect(video.playAsync).toHaveBeenCalledTimes(1);
});
