import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MemoryResurfacingControl } from '../MemoryResurfacingControl.tsx';
import { freshToken } from '../../../services/apiToken.ts';

const ownerId = '11111111-1111-4111-8111-111111111111';
let mockUserId: string | null = ownerId;
let mockFocused = true;
let mockInitial = true;
let mockSessionId = 'session-one';
const mockListeners = new Set<(event: string, session: unknown) => void>();
const mockToken = () => `header.${btoa(JSON.stringify({ sub: mockUserId, session_id: mockSessionId }))}.signature`;
jest.mock('../../../services/apiToken', () => ({ ...jest.requireActual('../../../services/apiToken'), freshToken: jest.fn() }));
jest.mock('../../../services/memories', () => ({ ...jest.requireActual('../../../services/memories'), newMemoryOperationId: () => `resurfacing-${Math.random()}` }));
jest.mock('../../../context/SessionContext', () => ({ ...jest.requireActual('../../../context/SessionContext'), useSession: () => ({ userId: mockUserId }) }));
jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), useFocusEffect: (callback: () => void) => {
  require('react').useEffect(() => mockFocused ? callback() : undefined, [callback, mockFocused]);
} }));
jest.mock('../../../lib/supabase', () => ({ ...jest.requireActual('../../../lib/supabase'), supabase: { auth: { onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
  mockListeners.add(callback);
  if (mockInitial) callback('INITIAL_SESSION', { user: { id: mockUserId }, access_token: mockToken() });
  return { data: { subscription: { unsubscribe: () => mockListeners.delete(callback) } } };
} } } }));

let sequence = 0;
let memoryId: string;
let on = false;
let fetchMock: jest.Mock;
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
afterAll(async () => { await jest.requireActual('../../../lib/supabase').supabase.auth.stopAutoRefresh(); });
function response(status = 200, value: unknown = { memoryId, controls: [{ control: 'DO_NOT_RESURFACE', on }] }) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(finish => { resolve = finish; });
  return { promise, resolve };
}
const element = (target = memoryId) => <MemoryResurfacingControl ownerId={ownerId} memoryId={target} />;
const writes = () => fetchMock.mock.calls.filter(entry => entry[1].method !== 'GET');
async function ready() { await screen.findByRole('switch', { name: 'Do not resurface' }); }
async function emit(event: string) {
  await act(() => { for (const callback of mockListeners) callback(event, mockUserId ? { user: { id: mockUserId }, access_token: mockToken() } : null); });
}

beforeEach(() => {
  jest.clearAllMocks(); sequence += 1;
  memoryId = `44444444-4444-4444-8444-${String(sequence).padStart(12, '0')}`;
  mockUserId = ownerId; mockFocused = true; mockInitial = true; mockSessionId = 'session-one'; on = false;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  (freshToken as jest.Mock).mockReset().mockImplementation(async () => mockToken());
  fetchMock = jest.fn(async (_url, init) => {
    if (init.method !== 'GET') { on = init.method === 'PUT'; return response(204); }
    return response();
  });
  global.fetch = fetchMock;
});
afterEach(() => {
  jest.useRealTimers(); global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

test.each([false, true])('only a validated GET makes %s known and mount never writes', async initial => {
  on = initial; await render(element()); await ready();
  expect(screen.getByRole('switch').props.accessibilityState.checked).toBe(initial);
  expect(screen.getByText(`Last checked: ${initial ? 'On' : 'Off'}.`)).toBeTruthy();
  expect(writes()).toHaveLength(0);
});

test('explicit set and clear each wait for 204 and confirmed readback', async () => {
  await render(element()); await ready();
  await fireEvent.press(screen.getByRole('switch')); await screen.findByText('Last checked: On.');
  await fireEvent.press(screen.getByRole('switch')); await screen.findByText('Last checked: Off.');
  expect(writes().map(entry => entry[1].method)).toEqual(['PUT', 'DELETE']);
  expect(fetchMock.mock.calls.map(entry => entry[1].method)).toEqual(['GET', 'PUT', 'GET', 'DELETE', 'GET']);
  expect(screen.getByText('Keep this Memory in your library; stop proactive resurfacing. Sharing and recap settings are unchanged.')).toBeTruthy();
});

test.each([
  ['disabled', 404, { error: 'feature_disabled' }, false],
  ['unread', 503, { error: 'degraded_unavailable' }, true],
  ['malformed', 200, { controls: [] }, true],
  ['deleted', 404, { error: 'not_found' }, false],
  ['unauthenticated', 401, { error: 'unauthenticated' }, false],
] as const)('%s does not display Off or allow a write', async (_label, status, body, retry) => {
  fetchMock.mockResolvedValue(response(status, body));
  await render(element());
  await waitFor(() => expect(screen.queryByText('Checking resurfacing setting…')).toBeNull());
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByText('Last checked: Off.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' }) !== null).toBe(retry);
  expect(writes()).toHaveLength(0);
});

test('loading and delayed readback do not expose an optimistic toggle', async () => {
  const waiting = deferred<ReturnType<typeof response>>();
  fetchMock.mockReturnValueOnce(waiting.promise);
  await render(element());
  expect(screen.queryByRole('switch')).toBeNull();
  waiting.resolve(response()); await ready();
  const confirmation = deferred<ReturnType<typeof response>>();
  fetchMock.mockResolvedValueOnce(response(204)).mockReturnValueOnce(confirmation.promise);
  await fireEvent.press(screen.getByRole('switch'));
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByText('Last checked: On.')).toBeNull();
  on = true; confirmation.resolve(response()); await screen.findByText('Last checked: On.');
});

test('unknown commit has one same-intent retry, no opposite control', async () => {
  await render(element()); await ready();
  fetchMock.mockRejectedValueOnce(new Error('lost response'));
  await fireEvent.press(screen.getByRole('switch'));
  await screen.findByRole('button', { name: 'Retry change' });
  expect(screen.queryByRole('switch')).toBeNull();
  const key = writes()[0][1].headers['Idempotency-Key'];
  await fireEvent.press(screen.getByRole('button', { name: 'Retry change' }));
  await screen.findByText('Last checked: On.');
  expect(writes()).toHaveLength(2);
  expect(writes()[1][1].headers['Idempotency-Key']).toBe(key);
});

test('acknowledged but unread state offers readback, not another write', async () => {
  await render(element()); await ready();
  fetchMock.mockResolvedValueOnce(response(204)).mockResolvedValueOnce(response(503, { error: 'degraded_unavailable' }));
  await fireEvent.press(screen.getByRole('switch'));
  await screen.findByRole('button', { name: 'Check setting' });
  expect(screen.queryByRole('switch')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Check setting' }));
  await screen.findByText('Last checked: Off.');
  expect(screen.getByText('The current setting differs from that change. Review it before changing it again.')).toBeTruthy();
  expect(writes()).toHaveLength(1);
});

test.each(['anonymous', 'other'])('%s never reads or writes owner controls', async actor => {
  mockUserId = actor === 'anonymous' ? null : '33333333-3333-4333-8333-333333333333';
  await render(element());
  expect(screen.queryByText('Do not resurface')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('no read starts before the initial session is captured', async () => {
  mockInitial = false;
  await render(element());
  expect(freshToken).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  await emit('INITIAL_SESSION'); await ready();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a different session during token wait cannot replace the captured session', async () => {
  const waiting = deferred<string>();
  (freshToken as jest.Mock).mockReturnValueOnce(waiting.promise);
  await render(element());
  mockSessionId = 'session-two'; await emit('SIGNED_IN'); waiting.resolve(mockToken());
  await screen.findByText('Your session changed. Reopen this Memory.');
  expect(fetchMock).not.toHaveBeenCalled(); expect(screen.queryByRole('switch')).toBeNull();
});

test.each(['blur', 'unmount', 'logout', 'target'])('%s during write token wait cannot send or repaint', async change => {
  const view = await render(element()); await ready();
  const waiting = deferred<string>();
  (freshToken as jest.Mock).mockReturnValueOnce(waiting.promise);
  await fireEvent.press(screen.getByRole('switch'));
  if (change === 'unmount') await view.unmount();
  else if (change === 'blur') { mockFocused = false; await view.rerender(element()); }
  else if (change === 'logout') { mockUserId = null; await emit('SIGNED_OUT'); await view.rerender(element()); }
  else await view.rerender(element('55555555-5555-4555-8555-555555555555'));
  waiting.resolve(mockToken());
  await act(async () => { await Promise.resolve(); });
  expect(writes()).toHaveLength(0);
});

test('blur/refocus forgets known state and requires another GET without writing', async () => {
  const view = await render(element()); await ready();
  mockFocused = false; await view.rerender(element());
  expect(screen.queryByRole('switch')).toBeNull();
  on = true; mockFocused = true; await view.rerender(element());
  await screen.findByText('Last checked: On.');
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(writes()).toHaveLength(0);
});

test('missing initial session has a bounded unavailable state, not Off', async () => {
  jest.useFakeTimers(); mockInitial = false;
  await render(element());
  await act(async () => { await jest.advanceTimersByTimeAsync(15001); });
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('refocus cannot turn an unresolved intent into an opposite toggle', async () => {
  const view = await render(element()); await ready();
  fetchMock.mockRejectedValueOnce(new Error('lost response'));
  await fireEvent.press(screen.getByRole('switch'));
  await screen.findByRole('button', { name: 'Retry change' });
  const key = writes()[0][1].headers['Idempotency-Key'];
  mockFocused = false; await view.rerender(element());
  mockFocused = true; await view.rerender(element());
  await screen.findByRole('button', { name: 'Retry change' });
  expect(screen.queryByRole('switch')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry change' }));
  await screen.findByText('Last checked: On.');
  expect(writes()[1][1].headers['Idempotency-Key']).toBe(key);
});

test('a late old-target read cannot repaint the new target', async () => {
  const waiting = deferred<ReturnType<typeof response>>();
  fetchMock.mockReturnValueOnce(waiting.promise);
  const view = await render(element());
  const oldBody = { memoryId, controls: [{ control: 'DO_NOT_RESURFACE', on: true }] };
  memoryId = '99999999-9999-4999-8999-999999999999';
  await view.rerender(element()); await ready();
  waiting.resolve(response(200, oldBody));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('Last checked: Off.')).toBeTruthy();
  expect(screen.queryByText('Last checked: On.')).toBeNull();
});

test('an auth change before initial-session capture is not adopted by a late initial callback', async () => {
  mockInitial = false;
  await render(element());
  mockSessionId = 'session-two';
  await emit('SIGNED_IN'); await emit('INITIAL_SESSION');
  expect(screen.getByText('Your session changed. Reopen this Memory.')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a same-session token refresh preserves the setting without another read or write', async () => {
  await render(element()); await ready();
  await emit('TOKEN_REFRESHED');
  expect(screen.getByText('Last checked: Off.')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(writes()).toHaveLength(0);
});
