import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { NearbyScreen } from '../NearbyScreen.tsx';
import { fetchOwnedApi } from '../../../../services/ownedApiRequest.ts';
import { searchUsers } from '../../../../services/follows.ts';
import { router } from 'expo-router';

let mockUser = 'me';
let mockCurrent = true;
// NOTE: intentionally isolated boundaries: synthetic sessions, HTTP, search and navigation only.
jest.mock('../../../../services/ownedApiRequest.ts', () => ({ fetchOwnedApi: jest.fn() }));
jest.mock('../../../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: mockUser }) }));
jest.mock('../../../../services/messagingOwnerRequest.ts', () => ({ captureMessagingOwnerRequest: () => {
  const user = mockUser; let valid = true;
  return { ownerId: user, sessionId: `session-${user}`, isCurrent: () => valid && mockCurrent && user === mockUser, invalidate: () => { valid = false; } };
} }));
// NOTE: this synthetic session supplies its own scope without subscribing to real authentication.
jest.mock('../../../../services/discoveryViewerScope.ts', () => ({ currentDiscoveryScope: () => ({ viewer: `u:${mockUser}`, revision: 1 }) }));
// NOTE: no real user search should leave this fixture.
jest.mock('../../../../services/follows.ts', () => ({ searchUsers: jest.fn() }));
// NOTE: focus/navigation are controlled here; no real navigation container is mounted.
jest.mock('expo-router', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]), router: { push: jest.fn(), back: jest.fn() } }));
// NOTE: native safe-area measurements are not available in the synthetic renderer.
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

const window = { id: 'window', startAt: '2099-11-05T10:00:00Z', endAt: '2099-11-05T15:00:00Z', intents: ['food'] };
const signal = { id: 'window', audiencePolicyId: null, proximityVisibility: 'HIDDEN', geographyScope: null };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let optedIn = false;
const reads: Record<string, unknown> = {};
const requests = () => jest.mocked(fetchOwnedApi).mock.calls.filter(([, options]) => options?.method !== 'GET');
beforeEach(() => {
  jest.clearAllMocks(); mockUser = 'me'; mockCurrent = true; optedIn = false;
  for (const key of Object.keys(reads)) delete reads[key];
  Object.assign(reads, {
    '/api/me/availability-windows': { enabled: true, windows: [window] },
    '/api/me/availability-windows/window/signal': signal,
    '/api/me/availability-audience-policies': { policies: [{ id: 'crew-policy', audience: 'crew_only' }] },
    '/api/me/eta-grants': { grants: [] },
    '/api/nearby/reachable': { enabled: true, people: [], generatedAt: new Date().toISOString() },
    '/api/users/peer': { id: 'peer', handle: 'peer', name: null },
  });
  jest.mocked(fetchOwnedApi).mockImplementation(async (path, options) => {
    if (path === '/api/me/nearby-consent') { if (options?.method === 'PUT') optedIn = (options.body as { optedIn: boolean }).optedIn; return response({ optedIn }); }
    if (options?.method === 'PATCH') return response({ ...signal, ...options.body });
    if (options?.method === 'DELETE' || options?.method === 'PUT') return response({});
    return response(reads[path]);
  });
  jest.mocked(searchUsers).mockResolvedValue({ ok: true, data: [{ id: 'peer', username: 'peer', displayName: null }] as any });
});

it('does not opt in or edit audiences on mount; a changed switch requires Save', async () => {
  await render(<NearbyScreen />);
  await waitFor(() => expect(screen.getByLabelText('Nearby sharing')).toBeTruthy());
  expect(requests()).toHaveLength(0);
  await fireEvent(screen.getByLabelText('Nearby sharing'), 'valueChange', true);
  expect(requests()).toHaveLength(0);
  await fireEvent.press(screen.getByText('Save Nearby setting'));
  await waitFor(() => expect(screen.getByText('Nearby setting saved.')).toBeTruthy());
  expect(requests()).toEqual([['/api/me/nearby-consent', expect.objectContaining({ method: 'PUT', body: { optedIn: true } })]]);
});

it('loads the selected window before editing and reuses an owned audience only on explicit save', async () => {
  await render(<NearbyScreen />);
  await waitFor(() => expect(screen.getByText(/^Edit sharing for/)).toBeTruthy());
  expect(jest.mocked(fetchOwnedApi).mock.calls.some(([path]) => path.endsWith('/signal'))).toBe(false);
  await fireEvent.press(screen.getByText(/^Edit sharing for/));
  await waitFor(() => expect(screen.getByText('○ Trip crew')).toBeTruthy());
  await fireEvent.press(screen.getByText('○ Trip crew'));
  await fireEvent.press(screen.getByText('○ Nearby only'));
  expect(requests()).toHaveLength(0);
  await fireEvent.press(screen.getByText('Save window sharing'));
  await waitFor(() => expect(screen.getByText('Window sharing saved.')).toBeTruthy());
  expect(requests()).toEqual([['/api/me/availability-windows/window/signal', expect.objectContaining({ method: 'PATCH', body: { audiencePolicyId: 'crew-policy', proximityVisibility: 'NEARBY', geographyScope: null } })]]);
});

it('does not show editable defaults after a window policy read fails', async () => {
  reads['/api/me/availability-windows/window/signal'] = { ...signal, audiencePolicyId: 'unknown' };
  await render(<NearbyScreen />);
  await waitFor(() => expect(screen.getByText(/^Edit sharing for/)).toBeTruthy());
  await fireEvent.press(screen.getByText(/^Edit sharing for/));
  await waitFor(() => expect(screen.getByText('Your current sharing rules could not be read. Try again.')).toBeTruthy());
  expect(screen.queryByText('Save window sharing')).toBeNull();
  expect(requests()).toHaveLength(0);
});

it('requires an explicit traveler and a valid duration before granting ETA permission', async () => {
  await render(<NearbyScreen />);
  await waitFor(() => expect(screen.getByLabelText('Search traveler for ETA permission')).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('Search traveler for ETA permission'), 'peer');
  await fireEvent.press(screen.getByText('Find traveler'));
  await waitFor(() => expect(screen.getByText('Choose @peer')).toBeTruthy());
  expect(screen.queryByText('Grant ETA permission')).toBeNull();
  await fireEvent.press(screen.getByText('Choose @peer'));
  await fireEvent.changeText(screen.getByLabelText('ETA permission hours'), '13');
  await fireEvent.press(screen.getByText('Grant ETA permission'));
  expect(requests()).toHaveLength(0);
  await fireEvent.changeText(screen.getByLabelText('ETA permission hours'), '2');
  await fireEvent.press(screen.getByText('Grant ETA permission'));
  await waitFor(() => expect(screen.getByText('ETA permission saved.')).toBeTruthy());
  expect(requests()[0]).toEqual(['/api/me/eta-grants/peer', expect.objectContaining({ method: 'PUT', body: { hours: 2 } })]);
  expect(searchUsers).toHaveBeenCalledWith('peer', 8, expect.objectContaining({ owner: expect.objectContaining({ ownerId: 'me' }) }));
});

it('withdraws only the selected ETA permission and opens the canonical profile route', async () => {
  reads['/api/me/eta-grants'] = { grants: [{ userId: 'peer', expiresAt: '2099-11-05T15:00:00Z', mutual: false }] };
  await render(<NearbyScreen />);
  await waitFor(() => expect(screen.getByText("Open @peer's profile")).toBeTruthy());
  await fireEvent.press(screen.getByText("Open @peer's profile"));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/passport/[username]', params: { username: 'peer' } });
  await fireEvent.press(screen.getByText('Withdraw ETA permission'));
  await waitFor(() => expect(screen.getByText('ETA permission withdrawn.')).toBeTruthy());
  expect(requests()[0]).toEqual(['/api/me/eta-grants/peer', expect.objectContaining({ method: 'DELETE' })]);
});

it('distinguishes a release gate from an empty list and never enables the feature', async () => {
  const original = jest.mocked(fetchOwnedApi).getMockImplementation()!;
  jest.mocked(fetchOwnedApi).mockImplementation((path, options) => path === '/api/me/nearby-consent' ? Promise.resolve(response({ error: 'feature_disabled' }, 404)) : original(path, options));
  reads['/api/nearby/reachable'] = { enabled: false, people: [], generatedAt: null };
  await render(<NearbyScreen />);
  await waitFor(() => expect(screen.getByText('Nearby sharing is not available yet.')).toBeTruthy());
  expect(screen.queryByLabelText('Nearby sharing')).toBeNull();
  expect(screen.getByText('Nearby travelers are not available yet.')).toBeTruthy();
  expect(screen.queryByText('No shared availability is visible right now.')).toBeNull();
  expect(requests()).toHaveLength(0);
});

it('retires pending reads on account change and does not paint the old account', async () => {
  let finish!: (value: any) => void;
  const original = jest.mocked(fetchOwnedApi).getMockImplementation()!;
  jest.mocked(fetchOwnedApi).mockImplementation((path, options) => path === '/api/me/nearby-consent' && options?.owner?.ownerId === 'me' ? new Promise(done => { finish = done; }) : original(path, options));
  const view = await render(<NearbyScreen />);
  await waitFor(() => expect(finish).toBeDefined());
  const oldRequest = jest.mocked(fetchOwnedApi).mock.calls[0][1]!;
  mockUser = 'next';
  await view.rerender(<NearbyScreen />);
  await act(async () => { finish(response({ optedIn: true })); });
  await waitFor(() => expect(screen.getByLabelText('Nearby sharing').props.value).toBe(false));
  expect(oldRequest.signal?.aborted).toBe(true);
  expect(requests()).toHaveLength(0);
});

it('clears private content on background and refreshes with a new owner capture on foreground', async () => {
  let appChange!: (state: any) => void;
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => { appChange = callback; return { remove: jest.fn() }; });
  try {
    await render(<NearbyScreen />);
    await waitFor(() => expect(screen.getByLabelText('Nearby sharing')).toBeTruthy());
    const oldRequest = jest.mocked(fetchOwnedApi).mock.calls[0][1]!;
    await act(async () => appChange('background'));
    expect(screen.queryByLabelText('Nearby sharing')).toBeNull();
    expect(oldRequest.signal?.aborted).toBe(true);
    await act(async () => appChange('active'));
    await waitFor(() => expect(screen.getByLabelText('Nearby sharing')).toBeTruthy());
    expect(requests()).toHaveLength(0);
  } finally { spy.mockRestore(); }
});
