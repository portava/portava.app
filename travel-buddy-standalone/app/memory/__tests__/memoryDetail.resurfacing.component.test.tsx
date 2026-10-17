import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import MemoryDetailScreen from '../[id]';

const ownerId = '11111111-1111-4111-8111-111111111111';
let mockUserId: string | null = ownerId;
let mockRouteId: string;
let mockMemoryOwner = ownerId;
let mockVisibility = 'only_me';
let mockSessionId = 'session-one';
const mockGetMemory = jest.fn();
const mockListeners = new Set<(event: string, session: unknown) => void>();
const mockToken = () => `header.${btoa(JSON.stringify({ sub: mockUserId, session_id: mockSessionId }))}.signature`;
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() }, useLocalSearchParams: () => ({ id: mockRouteId }),
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('../../../src/context/SessionContext', () => ({ ...jest.requireActual('../../../src/context/SessionContext'), useSession: () => ({ userId: mockUserId }) }));
jest.mock('../../../src/services/apiToken', () => ({ ...jest.requireActual('../../../src/services/apiToken'), freshToken: async () => mockToken() }));
jest.mock('../../../src/lib/supabase', () => ({ ...jest.requireActual('../../../src/lib/supabase'), supabase: { auth: { onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
  mockListeners.add(callback); callback('INITIAL_SESSION', { user: { id: mockUserId }, access_token: mockToken() });
  return { data: { subscription: { unsubscribe: () => mockListeners.delete(callback) } } };
} } } }));
jest.mock('../../../src/services/memories', () => ({
  ...jest.requireActual('../../../src/services/memories'),
  getMemory: (...args: unknown[]) => mockGetMemory(...args), newMemoryOperationId: () => `resurfacing-${Math.random()}`,
  deleteMemoryItem: jest.fn(), deleteMemory: jest.fn(), addMemoryItem: jest.fn(),
}));
jest.mock('../../../src/components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View testID="unchanged-photo" /> };
});
jest.mock('../../../src/features/memories/MemoryVideoSegments', () => {
  const { View } = require('react-native');
  return { MemoryVideoSegments: () => <View testID="unchanged-video" /> };
});
jest.mock('../../../src/features/memories/social/MemorySocialBar', () => ({ ...jest.requireActual('../../../src/features/memories/social/MemorySocialBar'), MemorySocialBar: () => null })); jest.mock('../../../src/features/memories/RememberTogetherPanel', () => ({ RememberTogetherPanel: () => null })); // H53's panel has its own suite (RememberTogether.component.test.tsx); this file pins the resurfacing control's transport
jest.mock('../../../src/features/memories/social/MemoryBrowseLinks', () => {
  const { Text } = require('react-native');
  return { MemoryBrowseLinks: () => <Text>Existing browse links</Text> };
});
jest.mock('../../../src/features/memories/social/MemoryParticipantsSection', () => ({ ...jest.requireActual('../../../src/features/memories/social/MemoryParticipantsSection'), MemoryParticipantsSection: () => null, MemoryTagConsentFallback: () => null }));
jest.mock('../../../src/features/memories/actions/MemoryActionBar', () => ({ ...jest.requireActual('../../../src/features/memories/actions/MemoryActionBar'), MemoryActionBar: () => null, isAutoAction: () => false }));
jest.mock('../../../src/features/passport/useMemoryViewedTelemetry', () => ({ ...jest.requireActual('../../../src/features/passport/useMemoryViewedTelemetry'), useMemoryViewedTelemetry: () => undefined }));
jest.mock('../../../src/hooks/useMediaPicker', () => ({ ...jest.requireActual('../../../src/hooks/useMediaPicker'), useMediaPicker: () => ({ pickMedia: jest.fn() }) }));
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({ ...jest.requireActual('../../../src/hooks/useNavBarCollapse'), useNavBarScrollHandler: () => undefined }));
jest.mock('../../../src/hooks/useBottomInset', () => ({ ...jest.requireActual('../../../src/hooks/useBottomInset'), PlainBottomFiller: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let sequence = 0;
let fetchMock: jest.Mock;
let on = false;
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
afterAll(async () => { await jest.requireActual('../../../src/lib/supabase').supabase.auth.stopAutoRefresh(); });
function memory(id = mockRouteId) { return { ok: true, memory: {
  id, ownerId: mockMemoryOwner, title: 'Retained owner Memory', visibility: mockVisibility, state: 'published',
  createdAt: '2026-10-16T10:00:00Z', items: [
    { id: 'photo', mediaType: 'image/jpeg', mediaUrl: 'local-photo' },
    { id: 'video', mediaType: 'video/mp4', mediaUrl: 'local-video' },
  ],
} }; }
function response(status: number, body?: unknown) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }
beforeEach(() => {
  jest.clearAllMocks(); sequence += 1;
  mockRouteId = `66666666-6666-4666-8666-${String(sequence).padStart(12, '0')}`;
  mockUserId = ownerId; mockMemoryOwner = ownerId; mockVisibility = 'only_me'; mockSessionId = 'session-one'; on = false;
  mockGetMemory.mockImplementation(async (id: string) => memory(id));
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  fetchMock = jest.fn(async (url: string, init) => {
    if (init.method !== 'GET') { on = init.method === 'PUT'; return response(204); }
    return response(200, { memoryId: url.split('/memories/')[1].split('/')[0], controls: [{ control: 'DO_NOT_RESURFACE', on }] });
  });
  global.fetch = fetchMock;
});
afterEach(() => {
  jest.restoreAllMocks(); global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

test.each(['only_me', 'public'])('owner %s detail reaches set/read/clear without changing other Memory actions', async visibility => {
  mockVisibility = visibility;
  const alert = jest.spyOn(Alert, 'alert');
  await render(<MemoryDetailScreen />);
  await screen.findByRole('switch', { name: 'Do not resurface' });
  expect(screen.getByTestId('unchanged-photo')).toBeTruthy();
  expect(screen.getByTestId('unchanged-video')).toBeTruthy();
  expect(screen.getByText('Existing browse links')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('memory-owner-menu'));
  expect(alert.mock.calls.at(-1)?.[2]?.map(button => button.text)).toEqual(['Edit', 'Delete', 'Cancel']);
  await fireEvent.press(screen.getByRole('switch')); await screen.findByText('Last checked: On.');
  await fireEvent.press(screen.getByRole('switch')); await screen.findByText('Last checked: Off.');
  expect(fetchMock.mock.calls.map(entry => entry[1].method)).toEqual(['GET', 'PUT', 'GET', 'DELETE', 'GET']);
  expect(mockVisibility).toBe(visibility);
  expect(screen.getAllByText('Retained owner Memory').length).toBeGreaterThan(0);
});

test.each(['anonymous', 'non-owner'])('%s detail has no owner control transport', async actor => {
  mockUserId = actor === 'anonymous' ? null : '33333333-3333-4333-8333-333333333333';
  await render(<MemoryDetailScreen />); await screen.findAllByText('Retained owner Memory');
  expect(screen.queryByRole('switch')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
});

test('a late old detail load cannot attach its controls to a different route', async () => {
  const oldId = mockRouteId;
  let resolveOld!: (value: ReturnType<typeof memory>) => void;
  mockGetMemory.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const view = await render(<MemoryDetailScreen />);
  mockRouteId = '77777777-7777-4777-8777-777777777777';
  await view.rerender(<MemoryDetailScreen />); await screen.findByRole('switch');
  await act(() => { resolveOld(memory(oldId)); });
  await waitFor(() => expect(screen.queryByRole('switch')).toBeNull());
  expect(fetchMock.mock.calls.every(entry => !entry[0].includes(oldId))).toBe(true);
});

test('unread current control is not a rendered false default', async () => {
  fetchMock.mockResolvedValue(response(503, { error: 'degraded_unavailable' }));
  await render(<MemoryDetailScreen />); await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByRole('switch')).toBeNull(); expect(screen.queryByText('Last checked: Off.')).toBeNull();
});

test('owner logout removes the setting and cannot leave an actionable old state', async () => {
  const view = await render(<MemoryDetailScreen />); await screen.findByRole('switch');
  mockUserId = null;
  await act(() => { for (const callback of mockListeners) callback('SIGNED_OUT', null); });
  await view.rerender(<MemoryDetailScreen />);
  expect(screen.queryByRole('switch')).toBeNull();
  expect(fetchMock.mock.calls.filter(entry => entry[1].method !== 'GET')).toHaveLength(0);
});
