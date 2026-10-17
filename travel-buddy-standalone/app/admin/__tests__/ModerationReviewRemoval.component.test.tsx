import React from 'react';
import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockAuthListeners = new Set<(event: string, session: unknown) => void>();
const mockFocusListeners = new Set<(focused: boolean) => void>();
let mockFocused = true;
function mockSetFocused(focused: boolean) {
  mockFocused = focused;
  for (const listener of mockFocusListeners) listener(focused);
}
jest.mock('expo-router', () => {
  const actual = jest.requireActual('expo-router');
  return { ...actual,
    router: { ...actual.router, push: jest.fn(() => mockSetFocused(false)) },
    useFocusEffect: (callback: () => void | (() => void)) => {
      const react = jest.requireActual<typeof import('react')>('react');
      react.useEffect(() => {
        let active = false;
        let dispose: void | (() => void);
        const listener = (focused: boolean) => {
          if (focused === active) return;
          active = focused;
          if (focused) dispose = callback();
          else { dispose?.(); dispose = undefined; }
        };
        mockFocusListeners.add(listener);
        listener(mockFocused);
        return () => { mockFocusListeners.delete(listener); listener(false); };
      }, [callback]);
    },
  };
});
let mockUserId: string;
let mockToken: string;
jest.mock('../../../src/lib/supabase', () => {
  const actual = jest.requireActual('../../../src/lib/supabase');
  return { ...actual, isSupabaseConfigured: true, supabase: { ...actual.supabase, auth: { ...actual.supabase.auth,
    onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
      mockAuthListeners.add(callback);
      return { data: { subscription: { unsubscribe: () => mockAuthListeners.delete(callback) } } };
    },
  } } };
});
jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => ({ userId: mockUserId, isAuthed: true, loading: false }),
}));
jest.mock('../../../src/hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../../src/hooks/useRequireAdmin'), useRequireAdmin: jest.fn(),
}));
jest.mock('../../../src/services/apiToken', () => ({
  ...jest.requireActual('../../../src/services/apiToken'), freshToken: jest.fn(async () => mockToken),
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, { get(target, property, receiver) {
    if (property === 'Modal') {
      const react = jest.requireActual<typeof import('react')>('react');
      return ({ children, visible }: { children: React.ReactNode; visible?: boolean }) => visible ? react.createElement(target.View, null, children) : null;
    }
    if (property === 'Pressable') {
      const react = jest.requireActual<typeof import('react')>('react');
      return ({ children, ...props }: { children: React.ReactNode }) => react.createElement(target.View, props, children);
    }
    return Reflect.get(target, property, receiver);
  } });
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import ModerationReportsScreen from '../moderation-reports';
import { router } from 'expo-router';
import { freshToken } from '../../../src/services/apiToken';
import { disposeMessagingOwnerObserver, initializeMessagingOwnerObserver } from '../../../src/services/messagingOwnerRequest';
import { _resetDiscoveryViewerScopeForTests, setDiscoveryViewerFromSession } from '../../../src/services/discoveryViewerScope';

const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherAdmin = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const reportId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const reviewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const auditId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const rowToken = 'a'.repeat(64);
const context = { contractVersion: 1, reviewId, reportId, reportStatus: 'open', reviewToken: rowToken, reportToken: rowToken,
  review: { rating: 4, body: 'LIVE review for confirmation', state: 'published', entityType: 'trip', entityId: reviewId } };
const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
type Call = { url: URL; init?: RequestInit };
type Reply = { status: number; body: unknown; readBody?: () => Promise<unknown> };
let calls: Call[];
let respond: (call: Call) => Reply | Promise<Reply>;
let reports: Record<string, unknown>[];

function jwt(userId: string, sessionId = 'first-session') {
  return `e30.${btoa(JSON.stringify({ sub: userId, session_id: sessionId }))}.synthetic`;
}
function emit(event: string, userId: string | null, sessionId = 'first-session') {
  for (const callback of mockAuthListeners) callback(event, userId ? { user: { id: userId }, access_token: jwt(userId, sessionId) } : null);
}
function report(patch: Record<string, unknown> = {}) {
  return { id: reportId, subject_type: 'review', subject_id: reviewId, subject_user_id: otherAdmin, reporter_id: adminId,
    category: 'harassment', details: 'Private report', status: 'open', created_at: '2026-10-16T12:00:00Z', resolved_at: null,
    subject_snapshot: { state: 'ok', excerpt: 'OLD queue preview', reviewState: 'published', rating: 4 }, ...patch };
}
function normal(call: Call): Reply {
  if (call.url.pathname === '/api/admin/moderation/reports') return { status: 200, body: { reports, total: reports.length, page: 1 } };
  if (call.url.pathname.endsWith('/reported-removal-context')) return { status: 200, body: context };
  if (call.url.pathname.endsWith('/reported-removal')) return { status: 200, body: { ok: true, contractVersion: 1, reviewId, reportId,
    auditId, operationId: (call.init?.headers as Record<string, string>)['Idempotency-Key'], stateAtCommit: 'removed',
    committedAt: '2026-10-16T12:00:00+00:00', replayed: false } };
  throw new Error(`Unexpected request: ${call.init?.method ?? 'GET'} ${call.url}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const writes = () => calls.filter(call => call.init?.method === 'POST');

function pressHandler(testId: string): () => void {
  let node: ReturnType<typeof screen.getByTestId> | null = screen.getByTestId(testId);
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`No mounted press handler: ${testId}`);
  return node.props.onPress;
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  mockFocused = true;
  jest.mocked(router.push).mockClear();
  mockUserId = adminId;
  mockToken = jwt(adminId);
  disposeMessagingOwnerObserver();
  initializeMessagingOwnerObserver();
  emit('INITIAL_SESSION', adminId);
  _resetDiscoveryViewerScopeForTests();
  setDiscoveryViewerFromSession(adminId);
  jest.mocked(freshToken).mockReset().mockImplementation(async () => mockToken);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  calls = [];
  reports = [report()];
  respond = normal;
  globalThis.fetch = jest.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://api.test') throw new Error('External network forbidden');
    const call = { url, init };
    calls.push(call);
    const reply = await respond(call);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: reply.readBody ?? (async () => reply.body) } as Response;
  });
});
afterEach(async () => {
  await cleanup();
  disposeMessagingOwnerObserver();
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
  expect(calls.some(call => call.init?.method === 'DELETE' || call.url.pathname.endsWith('/review'))).toBe(false);
});
afterAll(() => {
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

async function open() {
  const view = await render(<ModerationReportsScreen />);
  await fireEvent.press(await screen.findByTestId(`modq-review-removal-context-${reportId}`));
  await screen.findByTestId('review-removal-preview');
  return view;
}
async function confirm(reason = 'Reviewed conduct') {
  await fireEvent.press(screen.getByTestId('review-removal-confirm'));
  await fireEvent.changeText(await screen.findByTestId('reason-input'), reason);
  await fireEvent.press(screen.getByTestId('reason-confirm-btn'));
}

test('mounted queue reads live context and writes only after explicit reason/confirmation', async () => {
  await open();
  expect(screen.getByTestId('review-removal-preview').props.children).toEqual(expect.arrayContaining(['LIVE review for confirmation']));
  expect(writes()).toHaveLength(0);
  await confirm();
  await waitFor(() => expect(writes()).toHaveLength(1));
  const sent = writes()[0];
  expect(sent.url.pathname).toBe(`/api/reviews/${reviewId}/reported-removal`);
  expect(JSON.parse(String(sent.init?.body))).toEqual({ report_id: reportId, reason: 'Reviewed conduct', expected_review_token: rowToken, expected_report_token: rowToken });
  expect((sent.init?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i);
  await waitFor(() => expect(screen.queryByTestId('review-removal-preview')).toBeNull());
  expect(screen.getByTestId(`modq-actioned-${reportId}`)).toBeTruthy();
});
test('cancelled reason prompt performs no write', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('review-removal-confirm'));
  await fireEvent.press(await screen.findByTestId('reason-cancel-btn'));
  expect(writes()).toHaveLength(0);
});
for (const reply of [{ status: 503, body: { message: 'Unavailable' } }, { status: 200, body: null }, { status: 200, body: { ...context, reviewId: reportId } }]) {
  test(`unavailable/malformed context never enables removal: ${JSON.stringify(reply).slice(0, 55)}`, async () => {
    respond = call => call.url.pathname.endsWith('/reported-removal-context') ? reply : normal(call);
    await render(<ModerationReportsScreen />);
    await fireEvent.press(await screen.findByTestId(`modq-review-removal-context-${reportId}`));
    await screen.findByTestId('review-removal-error');
    expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
    expect(writes()).toHaveLength(0);
  });
}
for (const patch of [{ subject_type: 'post' }, { status: 'actioned' }, { subject_snapshot: { state: 'unavailable' } }, { subject_snapshot: { state: 'ok', reviewState: 'removed' } }]) {
  test(`ineligible queue row does not expose removal: ${JSON.stringify(patch)}`, async () => {
    reports = [report(patch)];
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${reportId}`);
    expect(screen.queryByTestId(`modq-review-removal-context-${reportId}`)).toBeNull();
    expect(writes()).toHaveLength(0);
  });
}
for (const change of ['account', 'relogin', 'filter', 'unmount']) {
  test(`late context cannot restore removal after ${change}`, async () => {
    const pending = deferred<Reply>();
    respond = call => call.url.pathname.endsWith('/reported-removal-context') ? pending.promise : normal(call);
    const view = await render(<ModerationReportsScreen />);
    await fireEvent.press(await screen.findByTestId(`modq-review-removal-context-${reportId}`));
    await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith('/reported-removal-context'))).toBe(true));
    if (change === 'unmount') await view.unmount();
    else if (change === 'filter') await fireEvent.press(screen.getByTestId('modq-filter-reviewing'));
    else await act(async () => {
      if (change === 'relogin') emit('SIGNED_OUT', null);
      mockUserId = change === 'account' ? otherAdmin : adminId;
      mockToken = jwt(mockUserId, 'new-session');
      emit('SIGNED_IN', mockUserId, 'new-session');
      setDiscoveryViewerFromSession(mockUserId);
    });
    await act(async () => { pending.resolve({ status: 200, body: context }); });
    if (change !== 'unmount') expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
    expect(writes()).toHaveLength(0);
  });
}
test('token-await account window refuses a captured confirmation', async () => {
  await open();
  const pending = deferred<string>();
  jest.mocked(freshToken).mockReturnValueOnce(pending.promise);
  await confirm();
  await act(async () => {
    mockToken = jwt(otherAdmin);
    emit('SIGNED_IN', otherAdmin);
    setDiscoveryViewerFromSession(otherAdmin);
    pending.resolve(mockToken);
  });
  expect(writes()).toHaveLength(0);
});
test('captured confirm callback cannot act after cancellation', async () => {
  await open();
  const callback = pressHandler('review-removal-confirm');
  await fireEvent.press(screen.getByTestId('review-removal-close'));
  await act(async () => { callback(); });
  expect(screen.queryByTestId('reason-input')).toBeNull();
  expect(writes()).toHaveLength(0);
});
for (const failure of ['throw', 'malformed', '503']) {
  test(`unknown commit ${failure} retries the exact frozen operation and body`, async () => {
    let first = true;
    respond = call => {
      if (call.init?.method === 'POST' && first) {
        first = false;
        if (failure === 'throw') throw new Error('Lost response');
        return { status: failure === '503' ? 503 : 200, body: null };
      }
      return normal(call);
    };
    await open();
    await confirm();
    await fireEvent.press(await screen.findByTestId('review-removal-retry'));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[0].init?.body).toBe(writes()[1].init?.body);
    expect(writes()[0].init?.headers).toEqual(writes()[1].init?.headers);
  });
}
test('conflict requires a new context, not automatic retry or report closure', async () => {
  respond = call => call.init?.method === 'POST' ? { status: 409, body: { message: 'Context changed' } } : normal(call);
  await open();
  await confirm();
  await screen.findByTestId('review-removal-error');
  expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
  expect(screen.queryByTestId('review-removal-retry')).toBeNull();
  expect(writes()).toHaveLength(1);
});
test('1000 supplementary code points are accepted; 1001 do not send', async () => {
  await open();
  await confirm('😀'.repeat(1001));
  await screen.findByTestId('review-removal-error');
  expect(writes()).toHaveLength(0);
  await confirm('😀'.repeat(1000));
  await waitFor(() => expect(writes()).toHaveLength(1));
});

test('a captured reason submit cannot write after cancelling the prompt', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('review-removal-confirm'));
  await fireEvent.changeText(await screen.findByTestId('reason-input'), 'Cancelled reason');
  const callback = pressHandler('reason-confirm-btn');
  await fireEvent.press(screen.getByTestId('reason-cancel-btn'));
  await act(async () => { callback(); });
  expect(writes()).toHaveLength(0);
});
for (const change of ['close', 'filter']) {
  test(`unknown commit survives ${change} for explicit same-session recovery`, async () => {
    let first = true;
    respond = call => {
      if (call.init?.method === 'POST' && first) { first = false; throw new Error('Lost acknowledgement'); }
      return normal(call);
    };
    await open();
    await confirm();
    await screen.findByTestId('review-removal-retry');
    const oldRetry = pressHandler('review-removal-retry');
    await fireEvent.press(screen.getByTestId(change === 'close' ? 'review-removal-close' : 'modq-filter-reviewing'));
    await act(async () => { oldRetry(); });
    expect(writes()).toHaveLength(1);
    await fireEvent.press(await screen.findByTestId('review-removal-recover'));
    await fireEvent.press(await screen.findByTestId('review-removal-retry'));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[0].init?.body).toBe(writes()[1].init?.body);
    expect(writes()[0].init?.headers).toEqual(writes()[1].init?.headers);
  });
}
test('same-session token refresh preserves valid confirmation', async () => {
  await open();
  await act(async () => { emit('TOKEN_REFRESHED', adminId); });
  await confirm();
  await waitFor(() => expect(writes()).toHaveLength(1));
});
for (const change of ['account', 'relogin', 'close', 'unmount']) {
  test(`late write result cannot publish or offer a different operation after ${change}`, async () => {
    const pending = deferred<Reply>();
    respond = call => call.init?.method === 'POST' ? pending.promise : normal(call);
    const view = await open();
    await confirm();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const queueCount = calls.filter(call => call.url.pathname === '/api/admin/moderation/reports').length;
    if (change === 'unmount') await view.unmount();
    else if (change === 'close') await fireEvent.press(screen.getByTestId('review-removal-close'));
    else await act(async () => {
      if (change === 'relogin') emit('SIGNED_OUT', null);
      mockUserId = change === 'account' ? otherAdmin : adminId;
      mockToken = jwt(mockUserId, 'next-session');
      emit('SIGNED_IN', mockUserId, 'next-session');
      setDiscoveryViewerFromSession(mockUserId);
    });
    await act(async () => { pending.resolve(normal(writes()[0])); });
    expect(writes()).toHaveLength(1);
    expect(calls.filter(call => call.url.pathname === '/api/admin/moderation/reports')).toHaveLength(queueCount);
    if (change !== 'unmount') expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
    if (change === 'account' || change === 'relogin') expect(screen.queryByTestId('review-removal-recover')).toBeNull();
  });
}

function captureDeadline() {
  const originalTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 7000 && typeof callback === 'function') expire = () => callback(...args);
    return originalTimeout(callback, delay, ...args);
  });
  return () => {
    expect(expire).toBeDefined();
    expire?.();
  };
}

for (const failure of ['reject', 'null', 'wrong-session']) {
  test(`uncertain intent survives ${failure} token acquisition without allowing replacement`, async () => {
    let first = true;
    respond = call => {
      if (call.init?.method === 'POST' && first) { first = false; throw new Error('Lost acknowledgement'); }
      return normal(call);
    };
    const differentReport = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    reports.push(report({ id: differentReport }));
    await open();
    await confirm('Immutable original reason');
    await screen.findByTestId('review-removal-retry');
    const original = writes()[0];
    if (failure === 'reject') jest.mocked(freshToken).mockRejectedValueOnce(new Error('Temporary token outage'));
    else jest.mocked(freshToken).mockResolvedValueOnce(failure === 'null' ? null : jwt(adminId, 'wrong-session'));
    await fireEvent.press(screen.getByTestId('review-removal-retry'));
    await screen.findByTestId('review-removal-retry');
    expect(writes()).toHaveLength(1);
    await fireEvent.press(screen.getByTestId(`modq-review-removal-context-${differentReport}`));
    expect(Alert.alert).toHaveBeenCalledWith('Unresolved removal', expect.any(String));
    await fireEvent.press(screen.getByTestId(`modq-review-removal-context-${reportId}`));
    await fireEvent.press(screen.getByTestId(`modq-review-removal-context-${reportId}`));
    expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
    expect(screen.queryByTestId('reason-input')).toBeNull();
    expect(calls.filter(call => call.url.pathname.endsWith('/reported-removal-context'))).toHaveLength(1);
    await fireEvent.press(await screen.findByTestId('review-removal-retry'));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].init?.headers).toEqual(original.init?.headers);
    expect(writes()[1].init?.body).toBe(original.init?.body);
  });
}

test('transient context token failure settles without a false preview and permits explicit reread', async () => {
  await render(<ModerationReportsScreen />);
  await screen.findByTestId(`modq-review-removal-context-${reportId}`);
  jest.mocked(freshToken).mockRejectedValueOnce(new Error('Token temporarily unavailable'));
  await fireEvent.press(screen.getByTestId(`modq-review-removal-context-${reportId}`));
  await screen.findByTestId('review-removal-error');
  expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
  await fireEvent.press(screen.getByTestId(`modq-review-removal-context-${reportId}`));
  await screen.findByTestId('review-removal-preview');
  expect(writes()).toHaveLength(0);
});

test('an actual sign-out after token failure disposes the uncertain operation even if session IDs are reused', async () => {
  respond = call => {
    if (call.init?.method === 'POST') throw new Error('Lost acknowledgement');
    return normal(call);
  };
  await open();
  await confirm();
  await screen.findByTestId('review-removal-retry');
  jest.mocked(freshToken).mockRejectedValueOnce(new Error('Temporary token outage'));
  await fireEvent.press(screen.getByTestId('review-removal-retry'));
  await act(async () => { emit('SIGNED_OUT', null); emit('SIGNED_IN', adminId); });
  expect(screen.queryByTestId('review-removal-recover')).toBeNull();
  expect(screen.queryByTestId('review-removal-retry')).toBeNull();
  await fireEvent.press(screen.getByTestId(`modq-review-removal-context-${reportId}`));
  await screen.findByTestId('review-removal-preview');
  expect(writes()).toHaveLength(1);
});

for (const navigation of ['blur', 'user-moderation']) {
  test(`${navigation} revokes a token-await dispatch while retaining the mounted screen`, async () => {
    await open();
    const pendingToken = deferred<string>();
    jest.mocked(freshToken).mockReturnValueOnce(pendingToken.promise);
    await confirm();
    if (navigation === 'blur') await act(async () => { mockSetFocused(false); });
    else {
      await fireEvent.press(screen.getByTestId(`modq-moderate-${reportId}`));
      expect(router.push).toHaveBeenCalledWith({ pathname: '/admin/user-moderation', params: { userId: otherAdmin, reportId } });
    }
    await act(async () => { pendingToken.resolve(mockToken); });
    expect(writes()).toHaveLength(0);
    expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
    expect(screen.queryByTestId('review-removal-retry')).toBeNull();
    await act(async () => { mockSetFocused(true); });
    await fireEvent.press(await screen.findByTestId('review-removal-recover'));
    await fireEvent.press(await screen.findByTestId('review-removal-retry'));
    await waitFor(() => expect(writes()).toHaveLength(1));
  });
}

test('blur revokes captured prompt and inspect callbacks even after focus returns', async () => {
  await open();
  const inspect = pressHandler(`modq-review-removal-context-${reportId}`);
  await fireEvent.press(screen.getByTestId('review-removal-confirm'));
  await fireEvent.changeText(await screen.findByTestId('reason-input'), 'Old focus reason');
  const reasonSubmit = pressHandler('reason-confirm-btn');
  await act(async () => { mockSetFocused(false); inspect(); reasonSubmit(); });
  expect(screen.queryByTestId('reason-input')).toBeNull();
  await act(async () => { mockSetFocused(true); reasonSubmit(); });
  expect(writes()).toHaveLength(0);
  expect(calls.filter(call => call.url.pathname.endsWith('/reported-removal-context'))).toHaveLength(1);
});

test('blur fences late context without unmounting or automatically refetching on focus', async () => {
  const pending = deferred<Reply>();
  respond = call => call.url.pathname.endsWith('/reported-removal-context') ? pending.promise : normal(call);
  await render(<ModerationReportsScreen />);
  await fireEvent.press(await screen.findByTestId(`modq-review-removal-context-${reportId}`));
  await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith('/reported-removal-context'))).toBe(true));
  await act(async () => { mockSetFocused(false); });
  await act(async () => { mockSetFocused(true); pending.resolve({ status: 200, body: context }); });
  expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
  expect(calls.filter(call => call.url.pathname.endsWith('/reported-removal-context'))).toHaveLength(1);
});

test('already-sent removal survives blur as uncertain and recovers the same intent after focus', async () => {
  const pending = deferred<Reply>();
  respond = call => call.init?.method === 'POST' ? pending.promise : normal(call);
  await open();
  await confirm();
  await waitFor(() => expect(writes()).toHaveLength(1));
  const original = writes()[0];
  const queueCount = calls.filter(call => call.url.pathname === '/api/admin/moderation/reports').length;
  await act(async () => { mockSetFocused(false); });
  expect(original.init?.signal?.aborted).toBe(true);
  await act(async () => { mockSetFocused(true); });
  await fireEvent.press(await screen.findByTestId('review-removal-recover'));
  const oldRetry = pressHandler('review-removal-retry');
  await act(async () => { mockSetFocused(false); mockSetFocused(true); oldRetry(); });
  expect(writes()).toHaveLength(1);
  await act(async () => { pending.resolve(normal(original)); });
  expect(calls.filter(call => call.url.pathname === '/api/admin/moderation/reports')).toHaveLength(queueCount);
  respond = normal;
  await fireEvent.press(await screen.findByTestId('review-removal-recover'));
  await fireEvent.press(await screen.findByTestId('review-removal-retry'));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1].init?.headers).toEqual(original.init?.headers);
  expect(writes()[1].init?.body).toBe(original.init?.body);
});

for (const stage of ['token', 'fetch', 'body']) {
  for (const interruption of ['deadline', 'close']) {
    test(`${interruption} settles pending ${stage}, keeps one intent and ignores late completion`, async () => {
      await open();
      const pendingToken = deferred<string>();
      const pendingReply = deferred<Reply>();
      const pendingBody = deferred<unknown>();
      let readBody = false;
      let posted: Call | undefined;
      if (stage === 'token') jest.mocked(freshToken).mockReturnValueOnce(pendingToken.promise);
      respond = call => {
        if (call.init?.method !== 'POST') return normal(call);
        posted = call;
        if (stage === 'fetch') return pendingReply.promise;
        if (stage === 'body') return { ...normal(call), readBody: () => { readBody = true; return pendingBody.promise; } };
        return normal(call);
      };
      const expire = captureDeadline();
      await confirm('Frozen across interruption');
      if (stage !== 'token') await waitFor(() => expect(writes()).toHaveLength(1));
      if (stage === 'body') await waitFor(() => expect(readBody).toBe(true));
      if (interruption === 'deadline') await act(async () => { expire(); });
      else {
        await fireEvent.press(screen.getByTestId('review-removal-close'));
        await fireEvent.press(await screen.findByTestId('review-removal-recover'));
      }
      await screen.findByTestId('review-removal-retry');
      const oldWrites = writes().length;
      const queueCount = calls.filter(call => call.url.pathname === '/api/admin/moderation/reports').length;
      respond = normal;
      await fireEvent.press(screen.getByTestId('review-removal-retry'));
      await waitFor(() => expect(writes()).toHaveLength(oldWrites + 1));
      await waitFor(() => expect(screen.queryByTestId('review-removal-retry')).toBeNull());
      if (posted) {
        expect(writes()[1].init?.headers).toEqual(posted.init?.headers);
        expect(writes()[1].init?.body).toBe(posted.init?.body);
      }
      await act(async () => {
        pendingToken.resolve(mockToken);
        if (posted) { pendingReply.resolve(normal(posted)); pendingBody.resolve(normal(posted).body); }
      });
      expect(writes()).toHaveLength(oldWrites + 1);
      expect(calls.filter(call => call.url.pathname === '/api/admin/moderation/reports')).toHaveLength(queueCount + 1);
      expect(screen.queryByTestId('review-removal-recover')).toBeNull();
    });
  }

  test(`context deadline settles pending ${stage} and ignores its late preview`, async () => {
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-review-removal-context-${reportId}`);
    const pendingToken = deferred<string>();
    const pendingReply = deferred<Reply>();
    const pendingBody = deferred<unknown>();
    let readBody = false;
    if (stage === 'token') jest.mocked(freshToken).mockReturnValueOnce(pendingToken.promise);
    respond = call => {
      if (!call.url.pathname.endsWith('/reported-removal-context')) return normal(call);
      if (stage === 'fetch') return pendingReply.promise;
      if (stage === 'body') return { ...normal(call), readBody: () => { readBody = true; return pendingBody.promise; } };
      return normal(call);
    };
    const expire = captureDeadline();
    await fireEvent.press(screen.getByTestId(`modq-review-removal-context-${reportId}`));
    if (stage !== 'token') await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith('/reported-removal-context'))).toBe(true));
    if (stage === 'body') await waitFor(() => expect(readBody).toBe(true));
    await act(async () => { expire(); });
    await screen.findByTestId('review-removal-error');
    await act(async () => { pendingToken.resolve(mockToken); pendingReply.resolve({ status: 200, body: context }); pendingBody.resolve(context); });
    expect(screen.queryByTestId('review-removal-preview')).toBeNull();
    expect(screen.queryByTestId('review-removal-confirm')).toBeNull();
    expect(writes()).toHaveLength(0);
    respond = normal;
    await fireEvent.press(screen.getByTestId(`modq-review-removal-context-${reportId}`));
    await screen.findByTestId('review-removal-preview');
  });
}
