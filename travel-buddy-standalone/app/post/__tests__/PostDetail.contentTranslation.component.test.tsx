import React from 'react';
import { Share, StyleSheet } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

let mockRouteId = 'route-alias';
let mockFocus = 0;
let mockUserId: string | null = 'viewer-a';
let mockLanguage: string | null = 'es';
let mockRealLanguageProvider = false;
const mockGetSession = jest.fn();
const mockRefreshSession = jest.fn();
const mockLanguageSettings = jest.fn();
const mockAuthListeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>();

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const react = jest.requireActual('react');
  const modal = ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (
    visible ? react.createElement(actual.View, null, children) : null
  );
  return new Proxy(actual, {
    get(target, property, receiver) {
      return property === 'Modal' ? modal : Reflect.get(target, property, receiver);
    },
  });
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: mockRouteId }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    jest.requireActual('react').useEffect(effect, [effect, mockFocus]);
  },
  router: { ...jest.requireActual('expo-router').router, push: jest.fn() },
}));
jest.mock('expo-linking', () => ({
  ...jest.requireActual('expo-linking'),
  createURL: (path: string) => `portava:///${path}`,
}));
jest.mock('@supabase/supabase-js', () => ({
  ...jest.requireActual('@supabase/supabase-js'),
  createClient: () => ({
    auth: {
      getSession: () => mockGetSession(),
      refreshSession: () => mockRefreshSession(),
      onAuthStateChange: (listener: (event: AuthChangeEvent, session: Session | null) => void) => {
        mockAuthListeners.add(listener);
        return { data: { subscription: { unsubscribe: () => mockAuthListeners.delete(listener) } } };
      },
    },
  }),
}));
jest.mock('../../../src/context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../src/context/SessionContext.tsx'),
  useSession: () => ({ userId: mockUserId, isAuthed: Boolean(mockUserId), configured: true }),
}));
jest.mock('../../../src/context/LanguagePreferenceContext.tsx', () => ({
  ...jest.requireActual('../../../src/context/LanguagePreferenceContext.tsx'),
  useLanguagePreference: () => {
    const actual = jest.requireActual('../../../src/context/LanguagePreferenceContext.tsx').useLanguagePreference();
    return mockRealLanguageProvider ? actual : { ...actual, preferredLanguage: mockLanguage, loading: false };
  },
}));
jest.mock('../../../src/services/messaging.ts', () => ({
  ...jest.requireActual('../../../src/services/messaging.ts'),
  getMyLanguageSettings: (...args: unknown[]) => mockLanguageSettings(...args),
}));
jest.mock('../../../src/services/posts.ts', () => ({
  ...jest.requireActual('../../../src/services/posts.ts'),
  getPostById: jest.fn(),
}));
jest.mock('../../../src/hooks/useNavBarCollapse.ts', () => ({
  ...jest.requireActual('../../../src/hooks/useNavBarCollapse.ts'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));
jest.mock('../../../src/components/CommentsSheet.tsx', () => ({
  ...jest.requireActual('../../../src/components/CommentsSheet.tsx'),
  CommentsSection: () => null,
}));
jest.mock('../../../src/components/ReportSheet.tsx', () => ({
  ...jest.requireActual('../../../src/components/ReportSheet.tsx'),
  ReportSheet: () => null,
}));
jest.mock('../../../src/components/PostWrongPlaceSheet.tsx', () => ({
  ...jest.requireActual('../../../src/components/PostWrongPlaceSheet.tsx'),
  PostWrongPlaceSheet: () => null,
}));
jest.mock('../../../src/components/ui/SharedVideoPlayer.tsx', () => ({
  ...jest.requireActual('../../../src/components/ui/SharedVideoPlayer.tsx'),
  SharedVideoPlayer: (props: object) => jest.requireActual('react').createElement(
    jest.requireActual('react-native').View, { ...props, testID: 'detail-video' },
  ),
}));
jest.mock('../../../src/components/StampOverlayBadge.tsx', () => ({
  ...jest.requireActual('../../../src/components/StampOverlayBadge.tsx'),
  MediaStampOverlay: () => null,
}));
jest.mock('../../../src/components/ui/DisplayMediaImage.tsx', () => ({
  ...jest.requireActual('../../../src/components/ui/DisplayMediaImage.tsx'),
  AvatarImage: () => null,
  DisplayMediaImage: (props: object) => jest.requireActual('react').createElement(
    jest.requireActual('react-native').View, { ...props, testID: 'detail-image' },
  ),
}));
jest.mock('../../../src/components/ui/KeyboardSafeView.tsx', () => ({
  ...jest.requireActual('../../../src/components/ui/KeyboardSafeView.tsx'),
  KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => children,
}));

import PostDetail from '../[id].tsx';
import { router } from 'expo-router';
import { getPostById, type PostRow } from '../../../src/services/posts.ts';
import { LanguagePreferenceProvider } from '../../../src/context/LanguagePreferenceContext.tsx';
import type { ContentTranslationResponse } from '../../../src/services/contentTranslation.ts';

const canonicalId = '11111111-1111-4111-8111-111111111111';
const nextId = '22222222-2222-4222-8222-222222222222';
const original = 'An afternoon beside the river.';
const translated = 'Una tarde junto al río.';
const realFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const fetchMock = jest.fn();
const endpoint = (id = canonicalId, language = 'es') => `http://api.test/api/content/post/${id}/translation?lang=${language}`;
const output = (content = translated): ContentTranslationResponse => ({
  ok: true, status: 'translated', sourceLanguage: 'en', targetLanguage: 'es',
  translatedFields: { content }, translationLabel: 'Translated from English',
});
const source = (overrides: Partial<PostRow> = {}): PostRow => ({
  id: canonicalId, authorId: 'author-a', tripId: null, content: original, mediaUrls: [], media: [],
  visibility: 'public', status: 'active', createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z',
  author: { id: 'author-a', handle: 'traveler', name: 'Traveler', avatarUrl: null },
  likeCount: 0, stampCount: 0, commentCount: 0, shareCount: 0, likedByMe: false, savedByMe: false,
  saveCount: 0, canLike: true, canComment: true, canShare: true,
  filterId: 'original', filterIntensity: 0, tags: [], hashtagUsages: [], ...overrides,
});
function session(owner = 'viewer-a', sessionId = 'session-a'): Session {
  const payload = Buffer.from(JSON.stringify({ sub: owner, session_id: sessionId })).toString('base64url');
  return {
    access_token: `synthetic.${payload}.signature`, refresh_token: 'synthetic-refresh',
    token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: owner, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-16T10:00:00Z' },
  };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(finish => { resolve = finish; });
  return { promise, resolve };
}
function holdTranslation() {
  const pending = deferred<ContentTranslationResponse>();
  const json = jest.fn(() => pending.promise);
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json });
  return { ...pending, json };
}
async function complete(pending: ReturnType<typeof holdTranslation>, content = translated) {
  await act(async () => { pending.resolve(output(content)); });
}
async function waitForRequest(pending: ReturnType<typeof holdTranslation>) {
  await waitFor(() => expect(pending.json).toHaveBeenCalledTimes(1));
}
function expectOriginal(content = original) {
  expect(screen.getByText(content)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'See original' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'See translation' })).toBeNull();
}
async function emitAuth(event: AuthChangeEvent, nextSession: Session | null) {
  await act(async () => {
    mockGetSession.mockResolvedValue({ data: { session: nextSession } });
    for (const listener of mockAuthListeners) listener(event, nextSession);
  });
}

beforeEach(() => {
  mockRouteId = 'route-alias';
  mockFocus = 0;
  mockUserId = 'viewer-a';
  mockLanguage = 'es';
  mockRealLanguageProvider = false;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  jest.clearAllMocks();
  mockGetSession.mockReset().mockResolvedValue({ data: { session: session() } });
  mockRefreshSession.mockReset().mockRejectedValue(new Error('Unexpected auth refresh'));
  mockLanguageSettings.mockReset().mockResolvedValue({ ok: true, data: { preferred_language: 'es' } });
  jest.mocked(getPostById).mockReset().mockResolvedValue({ ok: true, data: source() });
  fetchMock.mockReset().mockRejectedValue(new Error('Unexpected HTTP request'));
  global.fetch = fetchMock;
});
afterEach(async () => {
  await cleanup();
  global.fetch = realFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  jest.restoreAllMocks();
  expect(mockAuthListeners.size).toBe(0);
});

test('real detail translates the loaded canonical post with no raw-text upload and retains the original roundtrip', async () => {
  const pending = holdTranslation();
  await render(<PostDetail />);
  await screen.findByText(original);
  const originalStyle = StyleSheet.flatten(screen.getByText(original).props.style);
  await waitForRequest(pending);
  expect(screen.getByText('Translating…')).toBeTruthy();
  expect(getPostById).toHaveBeenCalledWith('route-alias');
  expect(fetchMock).toHaveBeenCalledWith(endpoint(), { headers: { Authorization: `Bearer ${session().access_token}` } });
  await complete(pending);
  expect(screen.getByText(translated)).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByText(translated).props.style)).toEqual(originalStyle);
  expect(screen.getByText('Translated from English')).toBeTruthy();
  expect(screen.getByText('TRAVEL')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'See original' }));
  expect(screen.getByText(original)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'See translation' }));
  expect(screen.getByText(translated)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each(['image', 'video'] as const)('preserves the %s consumer while translating only its post description', async mediaType => {
  const uri = `http://media.test/${mediaType}`;
  jest.mocked(getPostById).mockResolvedValue({ ok: true, data: source({ media: [{
    id: 'media-a', url: uri, media_type: mediaType, thumbnail_url: null,
    duration_seconds: null, width: null, height: null, sort_order: 0, processing_status: 'ready',
  }], mediaUrls: [uri] }) });
  const pending = holdTranslation();
  await render(<PostDetail />);
  await waitForRequest(pending);
  await complete(pending);
  expect(screen.getByTestId(`detail-${mediaType}`).props.uri).toBe(uri);
  if (mediaType === 'video') {
    expect(screen.getByTestId('detail-video').props.autoplay).toBe(false);
    expect(screen.getByTestId('detail-video').props.muted).toBe(true);
  }
  expect(screen.getByText(translated)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]).toEqual([endpoint(), { headers: { Authorization: `Bearer ${session().access_token}` } }]);
});

test.each(['no preference', 'anonymous', 'empty description'] as const)('makes no translation request for %s', async condition => {
  if (condition === 'no preference') mockLanguage = null;
  if (condition === 'anonymous') mockUserId = null;
  if (condition === 'empty description') jest.mocked(getPostById).mockResolvedValue({ ok: true, data: source({ content: '' }) });
  await render(<PostDetail />);
  await screen.findByText('TRAVEL');
  if (condition !== 'empty description') expectOriginal();
  else expect(screen.queryByText(original)).toBeNull();
  expect(screen.queryByText('Translating…')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mockGetSession).not.toHaveBeenCalled();
});

test.each(['not_found', 'db_error', 'thrown'] as const)('does not translate or disclose a source refused with %s', async failure => {
  if (failure === 'thrown') jest.mocked(getPostById).mockRejectedValue(new Error('Synthetic post read failure'));
  else jest.mocked(getPostById).mockResolvedValue({ ok: false, data: null, errorKind: failure });
  await render(<PostDetail />);
  await screen.findByText(failure === 'not_found' ? 'Post not found.' : 'Could not load this post.');
  expect(screen.queryByText(original)).toBeNull();
  expect(screen.queryByText(translated)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  ['unavailable', { ok: false, status: 'failed', error: 'model_unavailable' }],
  ['disabled', { ok: false, error: 'translation_disabled' }],
  ['same or unknown source language', { ok: true, status: 'skipped', skipped: true }],
] satisfies Array<[string, ContentTranslationResponse]>)('retains readable original without dead controls when %s', async (_name, result) => {
  const pending = holdTranslation();
  await render(<PostDetail />);
  await waitForRequest(pending);
  await act(async () => { pending.resolve(result); });
  expectOriginal();
  expect(screen.queryByText('Translating…')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each(['404', '503', 'network rejection', 'JSON rejection'] as const)('falls back to original on translation %s without retry', async failure => {
  const json = jest.fn().mockResolvedValue({ message: 'not_found' });
  if (failure === 'network rejection') fetchMock.mockRejectedValueOnce(new Error('Synthetic offline'));
  else {
    if (failure === 'JSON rejection') json.mockRejectedValue(new Error('Synthetic invalid JSON'));
    fetchMock.mockResolvedValueOnce({ ok: failure === 'JSON rejection', status: Number(failure) || 200, json });
  }
  await render(<PostDetail />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText('Translating…')).toBeNull());
  expectOriginal();
  expect(screen.queryByText('not_found')).toBeNull();
});

test.each(['unconfigured API', 'unavailable token'] as const)('keeps original and makes no HTTP request with %s', async condition => {
  if (condition === 'unconfigured API') delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else mockGetSession.mockRejectedValue(new Error('Synthetic auth failure'));
  await render(<PostDetail />);
  await screen.findByText(original);
  await waitFor(() => expect(screen.queryByText('Translating…')).toBeNull());
  expectOriginal();
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(['language', 'viewer'] as const)('discards pending JSON from the previous %s while using the current result', async boundary => {
  const previous = holdTranslation();
  const current = holdTranslation();
  const mounted = await render(<PostDetail />);
  await waitForRequest(previous);
  if (boundary === 'language') mockLanguage = 'fr';
  else {
    mockUserId = 'viewer-b';
    mockGetSession.mockResolvedValue({ data: { session: session('viewer-b', 'session-b') } });
  }
  await mounted.rerender(<PostDetail />);
  await waitForRequest(current);
  await complete(current, 'Current translation');
  await complete(previous, 'Stale translation');
  expect(screen.getByText('Current translation')).toBeTruthy();
  expect(screen.queryByText('Stale translation')).toBeNull();
  expect(fetchMock).toHaveBeenNthCalledWith(2, endpoint(canonicalId, boundary === 'language' ? 'fr' : 'es'), {
    headers: { Authorization: `Bearer ${session(boundary === 'viewer' ? 'viewer-b' : 'viewer-a', boundary === 'viewer' ? 'session-b' : 'session-a').access_token}` },
  });
});

test.each(['language cleared', 'signed out'] as const)('discards late JSON and restores original when %s', async boundary => {
  const pending = holdTranslation();
  const mounted = await render(<PostDetail />);
  await waitForRequest(pending);
  if (boundary === 'language cleared') mockLanguage = null;
  else mockUserId = null;
  await mounted.rerender(<PostDetail />);
  await complete(pending, 'Stale translation');
  expectOriginal();
  expect(screen.queryByText('Stale translation')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each(['subject', 'content'] as const)('does not adopt pending translation after the loaded %s changes on a completed refocus', async boundary => {
  const previous = holdTranslation();
  const current = holdTranslation();
  const mounted = await render(<PostDetail />);
  await waitForRequest(previous);
  const next = source({ id: boundary === 'subject' ? nextId : canonicalId, content: 'Updated original.' });
  jest.mocked(getPostById).mockResolvedValue({ ok: true, data: next });
  mockFocus += 1;
  await mounted.rerender(<PostDetail />);
  await waitForRequest(current);
  expect(screen.getByText(next.content)).toBeTruthy();
  await complete(current, 'Updated translation');
  await complete(previous, 'Stale translation');
  expect(screen.getByText('Updated translation')).toBeTruthy();
  expect(screen.queryByText('Stale translation')).toBeNull();
  expect(fetchMock.mock.calls[1][0]).toBe(endpoint(next.id));
  await fireEvent.press(screen.getByRole('button', { name: 'See original' }));
  expect(screen.getByText(next.content)).toBeTruthy();
});

test('an unmounted route cannot seed a subsequent mount with late translation', async () => {
  const previous = holdTranslation();
  const first = await render(<PostDetail />);
  await waitForRequest(previous);
  await first.unmount();
  await complete(previous, 'Stale translation');
  const current = holdTranslation();
  await render(<PostDetail />);
  await waitForRequest(current);
  expectOriginal();
  await complete(current, 'Current translation');
  expect(screen.getByText('Current translation')).toBeTruthy();
  expect(screen.queryByText('Stale translation')).toBeNull();
});

test('preserves original share text and canonical edit target while translated text is displayed', async () => {
  mockUserId = 'author-a';
  mockGetSession.mockResolvedValue({ data: { session: session('author-a') } });
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
  const pending = holdTranslation();
  await render(<PostDetail />);
  await waitForRequest(pending);
  await complete(pending);
  await fireEvent.press(screen.getByLabelText('More options'));
  await fireEvent.press(screen.getByText('Share post'));
  expect(share).toHaveBeenCalledWith({ message: `${original}…\n\nportava:///post/${canonicalId}`, url: `portava:///post/${canonicalId}` });
  await fireEvent.press(screen.getByLabelText('More options'));
  await fireEvent.press(screen.getByText('Edit post'));
  expect(router.push).toHaveBeenCalledWith(`/post/edit/${canonicalId}`);
  expect(screen.getByText(translated)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('real preference provider fences a batched sign-out and sign-in to the same owner', async () => {
  mockRealLanguageProvider = true;
  const previous = holdTranslation();
  const current = holdTranslation();
  await render(<LanguagePreferenceProvider><PostDetail /></LanguagePreferenceProvider>);
  await waitForRequest(previous);
  await act(async () => {
    for (const listener of mockAuthListeners) {
      listener('SIGNED_OUT', null);
      listener('SIGNED_IN', session('viewer-a', 'session-b'));
    }
    mockGetSession.mockResolvedValue({ data: { session: session('viewer-a', 'session-b') } });
  });
  await waitForRequest(current);
  await complete(current, 'Current session translation');
  await complete(previous, 'Stale session translation');
  expect(screen.getByText('Current session translation')).toBeTruthy();
  expect(screen.queryByText('Stale session translation')).toBeNull();
});

test('real preference provider retains a pending translation through a healthy same-session token refresh', async () => {
  mockRealLanguageProvider = true;
  const pending = holdTranslation();
  await render(<LanguagePreferenceProvider><PostDetail /></LanguagePreferenceProvider>);
  await waitForRequest(pending);
  await emitAuth('TOKEN_REFRESHED', session());
  await complete(pending);
  expect(screen.getByText(translated)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('real preference provider does not adopt a pending result from a replaced same-owner auth session', async () => {
  mockRealLanguageProvider = true;
  const pending = holdTranslation();
  await render(<LanguagePreferenceProvider><PostDetail /></LanguagePreferenceProvider>);
  await waitForRequest(pending);
  await emitAuth('SIGNED_IN', session('viewer-a', 'replacement-session'));
  await complete(pending, 'Stale session translation');
  expect(screen.queryByText('Stale session translation')).toBeNull();
  expect(screen.getByText(original)).toBeTruthy();
});
