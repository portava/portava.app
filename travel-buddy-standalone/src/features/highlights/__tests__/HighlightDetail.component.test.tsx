jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
// NOTE: the SDK is intentionally replaced with an observable auth event source.
jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});
let mockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let mockFocus: (() => void | (() => void)) | undefined;
// NOTE: router effects are modeled as mount/focus callbacks; navigation is observed.
jest.mock('expo-router', () => ({
  router: { back: jest.fn() }, useLocalSearchParams: () => ({ id: mockId }),
  useFocusEffect: (callback: () => void | (() => void)) => { mockFocus = callback; require('react').useEffect(callback, [callback]); },
}));
jest.mock('../../../services/highlightDetail.ts', () => ({ ...jest.requireActual('../../../services/highlightDetail.ts'), fetchHighlightDetail: jest.fn() }));
// NOTE: exercise route lifecycle at the viewer boundary without a native AV runtime.
jest.mock('../../../components/HighlightViewer.tsx', () => ({ HighlightViewer: (props: any) => {
  const { Text, Pressable } = require('react-native');
  return <Pressable onPress={props.onClose} testID="detail-viewer"><Text>{`${props.highlights[0].id}:${props.currentUserId}:${props.highlights[0].mediaType}`}</Text></Pressable>;
} }));
import React from 'react';
import { AppState } from 'react-native';
import { act, render, screen, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import Screen from '../../../../app/highlights/[id].tsx';
import { fetchHighlightDetail } from '../../../services/highlightDetail.ts';
import type { Highlight, HighlightResult } from '../../../services/highlights.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession } from '../../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECOND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function data(id = ID, patch: Partial<Highlight> = {}): HighlightResult<Highlight> { return { ok: true, data: {
  id, ownerId: OWNER, mediaUrl: `post-media/${OWNER}/h.jpg`, mediaType: 'image/jpeg', videoDurationSeconds: null, caption: null,
  locationName: null, locationCity: null, locationCountry: null, visibility: 'public', createdAt: new Date().toISOString(), expiresAt: null,
  deletedAt: null, author: null, viewCount: 0, likeCount: 0, viewedByMe: false, likedByMe: false, filterId: 'original', filterIntensity: 100, ...patch,
} }; }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; }
beforeEach(() => { jest.clearAllMocks(); mockId = ID; setDiscoveryViewerFromSession(OWNER); seedObservedOwnerSession(OWNER, 'session-a'); jest.mocked(fetchHighlightDetail).mockResolvedValue(data()); });
afterEach(() => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); jest.useRealTimers(); jest.restoreAllMocks(); });

afterEach(() => { mockFocus = undefined; });
it('opens the current Highlight in the hydrated viewer and closes through navigation', async () => {
  await render(<Screen />); expect(screen.getByTestId('detail-viewer')).toBeTruthy();
  expect(screen.getByText(`${ID}:${OWNER}:image/jpeg`)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('detail-viewer')); expect(router.back).toHaveBeenCalledTimes(1);
});
it('shows a real unavailable state and preserves the saved item', async () => {
  jest.mocked(fetchHighlightDetail).mockResolvedValue({ ok: false, data: null, errorKind: 'not_found' });
  await render(<Screen />); expect(screen.getByTestId('highlight-detail-unavailable')).toBeTruthy(); expect(screen.queryByTestId('detail-viewer')).toBeNull(); expect(screen.queryByText('Try again')).toBeNull();
});
it('keeps an outage retryable and then opens the successful response', async () => {
  jest.mocked(fetchHighlightDetail).mockResolvedValueOnce({ ok: false, data: null, errorKind: 'degraded_unavailable' });
  await render(<Screen />); expect(screen.getByTestId('highlight-detail-error')).toBeTruthy();
  await fireEvent.press(screen.getByText('Try again')); expect(screen.getByTestId('detail-viewer')).toBeTruthy();
});
it('drops an old ID response after navigation replaces it', async () => {
  const old = deferred<HighlightResult<Highlight>>(); jest.mocked(fetchHighlightDetail).mockReturnValueOnce(old.promise);
  const mounted = await render(<Screen />); const signal = jest.mocked(fetchHighlightDetail).mock.calls[0]![1]!.signal!;
  mockId = SECOND; jest.mocked(fetchHighlightDetail).mockResolvedValueOnce(data(SECOND)); await mounted.rerender(<Screen />);
  await act(async () => { old.resolve(data()); }); expect(signal.aborted).toBe(true); expect(screen.getByText(`${SECOND}:${OWNER}:image/jpeg`)).toBeTruthy();
});
it('retires pending reads on unmount', async () => {
  const old = deferred<HighlightResult<Highlight>>(); jest.mocked(fetchHighlightDetail).mockReturnValueOnce(old.promise);
  const mounted = await render(<Screen />); const signal = jest.mocked(fetchHighlightDetail).mock.calls[0]![1]!.signal!;
  await mounted.unmount(); expect(signal.aborted).toBe(true); await act(async () => { old.resolve(data()); });
});
it('same-account replacement session removes loaded private content before its next read', async () => {
  const next = deferred<HighlightResult<Highlight>>(); const mounted = await render(<Screen />);
  jest.mocked(fetchHighlightDetail).mockReturnValueOnce(next.promise);
  await act(async () => { seedObservedOwnerSession(OWNER, 'session-b'); }); await mounted.rerender(<Screen />);
  expect(screen.queryByTestId('detail-viewer')).toBeNull(); expect(screen.getByTestId('highlight-detail-loading')).toBeTruthy();
  await act(async () => { next.resolve(data(ID, { mediaType: 'video/mp4' })); }); expect(screen.getByText(`${ID}:${OWNER}:video/mp4`)).toBeTruthy();
});
it('focus refresh rechecks current availability', async () => {
  await render(<Screen />); jest.mocked(fetchHighlightDetail).mockResolvedValueOnce({ ok: false, data: null, errorKind: 'not_found' });
  await act(async () => { mockFocus?.(); }); expect(screen.queryByTestId('detail-viewer')).toBeNull(); expect(screen.getByTestId('highlight-detail-unavailable')).toBeTruthy();
});
it('background hides the viewer and resume rechecks access', async () => {
  let onChange!: (state: any) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => { onChange = listener; return { remove: jest.fn() }; });
  await render(<Screen />); await act(async () => { onChange('background'); }); expect(screen.queryByTestId('detail-viewer')).toBeNull();
  jest.mocked(fetchHighlightDetail).mockResolvedValueOnce({ ok: false, data: null, errorKind: 'not_found' });
  await act(async () => { onChange('active'); }); expect(screen.getByTestId('highlight-detail-unavailable')).toBeTruthy();
});
it('an open Highlight disappears when its expiry passes', async () => {
  jest.useFakeTimers(); jest.mocked(fetchHighlightDetail).mockResolvedValue(data(ID, { expiresAt: new Date(Date.now() + 1000).toISOString() }));
  await render(<Screen />); await act(async () => { jest.advanceTimersByTime(1001); }); expect(screen.getByTestId('highlight-detail-unavailable')).toBeTruthy();
});
it('post references retain their explicit viewer media type', async () => {
  jest.mocked(fetchHighlightDetail).mockResolvedValue(data(ID, { mediaType: 'application/vnd.portava.post-reference+json', mediaUrl: `portava-post-reference:${SECOND}` }));
  await render(<Screen />); expect(screen.getByText(`${ID}:${OWNER}:application/vnd.portava.post-reference+json`)).toBeTruthy();
});
