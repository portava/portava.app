import React from 'react';
import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

let mockParams: Record<string, string | string[] | undefined> = {};
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { ...jest.requireActual('expo-router').router, push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, property, receiver) {
      if (property === 'Modal') {
        const react = jest.requireActual<typeof import('react')>('react');
        return ({ children, visible }: { children: React.ReactNode; visible?: boolean }) => visible ? react.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, property, receiver);
    },
  });
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../src/hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../../src/hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));
jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));
jest.mock('../../../src/services/apiToken', () => ({
  ...jest.requireActual('../../../src/services/apiToken'),
  freshToken: jest.fn(async () => 'admin-token'),
}));

import ModerationReportsScreen from '../moderation-reports';
import UserModerationScreen from '../user-moderation';
import { banUser, restrictUser, suspendUser, warnUser } from '../../../src/services/adminUsers';

const REPORT_ONE = 'aaaaaaaa-0000-4000-8000-000000000001';
const REPORT_TWO = 'aaaaaaaa-0000-4000-8000-000000000002';
const USER_ONE = 'bbbbbbbb-0000-4000-8000-000000000001';
const USER_TWO = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONTENT_ID = 'cccccccc-0000-4000-8000-000000000001';
const REASON = 'Reviewed the reported conduct';
const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
type Call = { url: URL; init?: RequestInit };
type Reply = { status: number; body: unknown };
let calls: Call[] = [];
let unexpected: string[] = [];
let respond: (call: Call) => Reply | Promise<Reply>;
let reports: ReturnType<typeof report>[] = [];

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ONE, subject_type: 'post', subject_id: CONTENT_ID, subject_user_id: USER_ONE,
    reporter_id: USER_TWO, category: 'harassment', details: 'private report details',
    status: 'open', created_at: '2026-10-16T10:00:00Z', resolved_at: null,
    subject_snapshot: { state: 'ok', excerpt: 'reported text' }, ...overrides,
  };
}

function summary(userId: string) {
  return {
    profile: { id: userId, handle: userId === USER_ONE ? 'first' : 'second', display_name: userId === USER_ONE ? 'First User' : 'Second User', account_status: 'active', role: 'user', verified: false, created_at: '2026-01-01' },
    accountStates: [], moderationActions: [], reportsReceived: [], reportsFiled: [], trustRestrictions: [],
    blockCount: 0, muteCount: 0, restrictCount: 0,
  };
}

function defaultReply(call: Call): Reply {
  if (call.url.pathname === '/api/admin/moderation/reports' && call.init?.method !== 'POST') {
    return { status: 200, body: { reports, total: reports.length, page: 1 } };
  }
  if (call.url.pathname === '/api/admin/users') {
    return { status: 200, body: { profile: summary(call.url.searchParams.get('handle') === 'second' ? USER_TWO : USER_ONE).profile } };
  }
  for (const userId of [USER_ONE, USER_TWO]) {
    if (call.url.pathname === `/api/admin/users/${userId}/summary`) return { status: 200, body: summary(userId) };
    if (call.init?.method === 'POST' && ['warn', 'restrict', 'suspend', 'ban', 'restore'].some((slug) => call.url.pathname === `/api/admin/users/${userId}/${slug}`)) {
      return { status: 200, body: { ok: true, action: { target_user_id: userId } } };
    }
  }
  unexpected.push(`${call.init?.method ?? 'GET'} ${call.url}`);
  throw new Error('Unconfigured request denied');
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  mockParams = {};
  calls = [];
  unexpected = [];
  reports = [report()];
  respond = defaultReply;
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  globalThis.fetch = jest.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://api.test') {
      unexpected.push(String(url));
      throw new Error('External request denied');
    }
    const call = { url, init };
    calls.push(call);
    const reply = await respond(call);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, headers: { get: () => null }, json: async () => reply.body } as unknown as Response;
  });
});
afterEach(async () => {
  await cleanup();
  expect(unexpected).toEqual([]);
  expect(calls.some((call) => call.url.pathname.endsWith('/review'))).toBe(false);
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

const posts = () => calls.filter((call) => call.init?.method === 'POST');
const body = (call: Call) => JSON.parse(String(call.init?.body));

async function linkedScreen(reportId = REPORT_ONE, userId = USER_ONE) {
  mockParams = { reportId, userId };
  const view = await render(<UserModerationScreen />);
  await screen.findByTestId('action-warn');
  return view;
}

async function searchUser(handle = 'second') {
  await fireEvent.changeText(screen.getByTestId('user-search-input'), handle);
  await fireEvent.press(screen.getByTestId('user-search-btn'));
  await screen.findByText(handle === 'second' ? 'Second User' : 'First User');
}

function alertButton(label: string) {
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2];
  const button = buttons?.find((entry) => entry.text === label);
  expect(button).toBeDefined();
  return button!;
}

async function chooseAction(slug = 'warn') {
  await fireEvent.press(screen.getByTestId(`action-${slug}`));
  if (slug === 'suspend' || slug === 'ban') await act(async () => { alertButton('Continue').onPress?.(); });
  await screen.findByTestId('reason-input');
}

async function confirmReason() {
  await fireEvent.changeText(screen.getByTestId('reason-input'), REASON);
  await fireEvent.press(screen.getByTestId('reason-confirm-btn'));
}

describe('TV-4a report handoff — queue, real wrappers and mocked HTTP', () => {
  it('requires an explicit queue choice, carries only the report/user IDs, and does not enforce or close anything on navigation', async () => {
    const queue = await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${REPORT_ONE}`);
    expect(router.push).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
    await fireEvent.press(screen.getByTestId(`modq-moderate-${REPORT_ONE}`));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/admin/user-moderation', params: { reportId: REPORT_ONE, userId: USER_ONE } });
    expect(screen.getByTestId(`modq-status-${REPORT_ONE}`).props.children).toBe('open');
    const destination = jest.mocked(router.push).mock.calls[0][0];
    if (typeof destination === 'string') throw new Error('Expected a structured report handoff');
    mockParams = destination.params as typeof mockParams;
    await queue.unmount();
    await render(<UserModerationScreen />);
    await screen.findByText('First User');
    expect(screen.getByTestId('moderation-report-link').props.children).toEqual(expect.arrayContaining([REPORT_ONE]));
    expect(posts()).toEqual([]);
    await chooseAction();
    expect(posts()).toEqual([]);
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url.pathname).toBe(`/api/admin/users/${USER_ONE}/warn`);
    expect(body(posts()[0])).toEqual({ reason: REASON, report_id: REPORT_ONE });
    await screen.findByTestId('action-warn');
  });

  it.each([
    { subject_user_id: null }, { subject_user_id: undefined }, { subject_user_id: '' },
    { subject_user_id: 'not-a-uuid' }, { subject_type: 'place' }, { subject_type: 'unknown' },
    { subject_type: 'user', subject_id: USER_TWO }, { status: 'dismissed' }, { status: 'actioned' },
    { id: 'not-a-report-uuid' },
  ])('offers no guessed or closed-report handoff for %j', async (overrides) => {
    reports = [report(overrides)];
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${reports[0].id}`);
    expect(screen.queryByTestId(`modq-moderate-${reports[0].id}`)).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
  });

  it.each([
    { subject_type: 'user', subject_id: USER_ONE, subject_user_id: null },
    { status: 'reviewing', subject_snapshot: { state: 'unavailable' } },
    { subject_snapshot: { state: 'ok', deleted: true, authorId: USER_TWO } },
  ])('uses only the direct user or recorded accountable user for %j', async (overrides) => {
    reports = [report(overrides)];
    await render(<ModerationReportsScreen />);
    await fireEvent.press(await screen.findByTestId(`modq-moderate-${REPORT_ONE}`));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/admin/user-moderation', params: { reportId: REPORT_ONE, userId: USER_ONE } });
    expect(posts()).toEqual([]);
  });

  it.each(['warn', 'restrict', 'suspend', 'ban'])('keeps the existing %s confirmation and sends the exact report_id', async (slug) => {
    await linkedScreen();
    await fireEvent.press(screen.getByTestId(`action-${slug}`));
    expect(posts()).toEqual([]);
    if (slug === 'suspend' || slug === 'ban') {
      expect(screen.queryByTestId('reason-input')).toBeNull();
      await act(async () => { alertButton('Continue').onPress?.(); });
    }
    await screen.findByTestId('reason-input');
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url.pathname).toBe(`/api/admin/users/${USER_ONE}/${slug}`);
    expect(body(posts()[0])).toEqual({ reason: REASON, report_id: REPORT_ONE });
    await screen.findByTestId('action-warn');
  });

  it('does not offer an unlinked restore or unrelated action while a report is selected', async () => {
    await linkedScreen();
    for (const slug of ['restore', 'restrict-bio', 'restrict-messaging', 'restrict-visibility', 'hide-posts']) {
      expect(screen.queryByTestId(`action-${slug}`)).toBeNull();
    }
  });

  it.each([403, 409, 503])('retains the selected report on HTTP %s; an explicit retry still sends it', async (status) => {
    respond = (call) => call.init?.method === 'POST' ? { status, body: { message: 'Report action refused; nothing changed' } } : defaultReply(call);
    await linkedScreen();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Warn failed', 'Report action refused; nothing changed'));
    expect(posts()).toHaveLength(1);
    expect(screen.getByTestId('moderation-report-link')).toBeTruthy();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts().map(body)).toEqual([{ reason: REASON, report_id: REPORT_ONE }, { reason: REASON, report_id: REPORT_ONE }]);
  });

  it('cancelling a reason makes no request and retains the visible handoff for a new explicit choice', async () => {
    await linkedScreen();
    await chooseAction();
    await fireEvent.press(screen.getByTestId('reason-cancel-btn'));
    expect(screen.queryByTestId('reason-input')).toBeNull();
    expect(posts()).toEqual([]);
    expect(screen.getByTestId('moderation-report-link')).toBeTruthy();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body(posts()[0]).report_id).toBe(REPORT_ONE);
  });

  it('cancelling the native confirmation does not enforce or silently remove the report', async () => {
    await linkedScreen();
    await fireEvent.press(screen.getByTestId('action-ban'));
    const continueOld = alertButton('Continue').onPress;
    await act(async () => { alertButton('Cancel').onPress?.(); });
    continueOld?.();
    await waitFor(() => expect(screen.queryByTestId('reason-input')).toBeNull());
    expect(screen.getByTestId('moderation-report-link')).toBeTruthy();
    expect(posts()).toEqual([]);
  });

  it('leaving the handoff invalidates a delayed native confirmation', async () => {
    const view = await linkedScreen();
    await fireEvent.press(screen.getByTestId('action-ban'));
    const continueOld = alertButton('Continue').onPress;
    await view.unmount();
    mockParams = {};
    await render(<UserModerationScreen />);
    continueOld?.();
    await waitFor(() => expect(screen.queryByTestId('reason-input')).toBeNull());
    expect(screen.queryByTestId('moderation-report-link')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('explicitly cancelling the handoff clears the target and invalidates a delayed native confirmation', async () => {
    await linkedScreen();
    await fireEvent.press(screen.getByTestId('action-ban'));
    const continueOld = alertButton('Continue').onPress;
    await fireEvent.press(screen.getByTestId('cancel-report-handoff'));
    continueOld?.();
    await waitFor(() => expect(screen.queryByTestId('reason-input')).toBeNull());
    expect(screen.queryByTestId('moderation-report-link')).toBeNull();
    expect(screen.queryByTestId('action-warn')).toBeNull();
    await searchUser();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url.pathname).toBe(`/api/admin/users/${USER_TWO}/warn`);
    expect(body(posts()[0])).toEqual({ reason: REASON });
  });

  it('switching the searched target clears linkage and invalidates a stale confirmation', async () => {
    await linkedScreen();
    await fireEvent.press(screen.getByTestId('action-suspend'));
    const continueOld = alertButton('Continue').onPress;
    await searchUser();
    continueOld?.();
    await waitFor(() => expect(screen.queryByTestId('reason-input')).toBeNull());
    expect(screen.queryByTestId('moderation-report-link')).toBeNull();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url.pathname).toBe(`/api/admin/users/${USER_TWO}/warn`);
    expect(body(posts()[0])).toEqual({ reason: REASON });
  });

  it('switching reports on the same user discards the old reason and sends only the newly selected report', async () => {
    const view = await linkedScreen();
    await chooseAction();
    await fireEvent.changeText(screen.getByTestId('reason-input'), 'old report reason');
    mockParams = { reportId: REPORT_TWO, userId: USER_ONE };
    await view.rerender(<UserModerationScreen />);
    await screen.findByTestId('action-warn');
    await waitFor(() => expect(posts()).toEqual([]));
    expect(screen.queryByTestId('reason-input')).toBeNull();
    await chooseAction();
    expect(screen.getByTestId('reason-input').props.value).toBe('');
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ reason: REASON, report_id: REPORT_TWO });
  });

  it('a late summary for the previous handoff cannot replace the new target', async () => {
    let resolveOld!: (reply: Reply) => void;
    const held = new Promise<Reply>((resolve) => { resolveOld = resolve; });
    respond = (call) => call.url.pathname === `/api/admin/users/${USER_ONE}/summary` ? held : defaultReply(call);
    mockParams = { reportId: REPORT_ONE, userId: USER_ONE };
    const view = await render(<UserModerationScreen />);
    await waitFor(() => expect(calls.some((call) => call.url.pathname.endsWith(`${USER_ONE}/summary`))).toBe(true));
    mockParams = { reportId: REPORT_TWO, userId: USER_TWO };
    await view.rerender(<UserModerationScreen />);
    await screen.findByText('Second User');
    await act(async () => { resolveOld({ status: 200, body: summary(USER_ONE) }); });
    await waitFor(() => expect(screen.queryByText('First User')).toBeNull());
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url.pathname).toBe(`/api/admin/users/${USER_TWO}/warn`);
    expect(body(posts()[0]).report_id).toBe(REPORT_TWO);
  });

  it('a late refused action does not replace the new handoff or offer an unlinked retry', async () => {
    let resolveOld!: (reply: Reply) => void;
    const held = new Promise<Reply>((resolve) => { resolveOld = resolve; });
    respond = (call) => call.init?.method === 'POST' ? held : defaultReply(call);
    const view = await linkedScreen();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    mockParams = { reportId: REPORT_TWO, userId: USER_TWO };
    await view.rerender(<UserModerationScreen />);
    await screen.findByText('Second User');
    await act(async () => { resolveOld({ status: 409, body: { message: 'old report closed' } }); });
    await waitFor(() => expect(screen.getByTestId('moderation-report-link').props.children).toEqual(expect.arrayContaining([REPORT_TWO])));
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(body(posts()[0]).report_id).toBe(REPORT_ONE);
  });

  it('a late standalone lookup cannot replace the newly searched target', async () => {
    let resolveOld!: (reply: Reply) => void;
    const held = new Promise<Reply>((resolve) => { resolveOld = resolve; });
    respond = (call) => call.url.pathname === '/api/admin/users' && call.url.searchParams.get('handle') === 'first' ? held : defaultReply(call);
    await linkedScreen();
    await fireEvent.changeText(screen.getByTestId('user-search-input'), 'first');
    await userEvent.press(screen.getByTestId('user-search-btn'));
    await waitFor(() => expect(calls.some((call) => call.url.searchParams.get('handle') === 'first')).toBe(true));
    await searchUser();
    await act(async () => { resolveOld({ status: 200, body: { profile: summary(USER_ONE).profile } }); });
    expect(screen.queryByText('First User')).toBeNull();
    expect(screen.queryByTestId('moderation-report-link')).toBeNull();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url.pathname).toBe(`/api/admin/users/${USER_TWO}/warn`);
    expect(body(posts()[0])).toEqual({ reason: REASON });
  });

  it('a completed linked action cannot reload the old target after a new standalone search', async () => {
    let resolveOld!: (reply: Reply) => void;
    const held = new Promise<Reply>((resolve) => { resolveOld = resolve; });
    respond = (call) => call.init?.method === 'POST' ? held : defaultReply(call);
    await linkedScreen();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    await searchUser();
    expect(screen.queryByTestId('moderation-report-link')).toBeNull();
    await act(async () => { resolveOld({ status: 200, body: { ok: true } }); });
    expect(screen.queryByText('First User')).toBeNull();
    expect(calls.filter((call) => call.url.pathname.endsWith(`${USER_ONE}/summary`))).toHaveLength(1);
    expect(body(posts()[0]).report_id).toBe(REPORT_ONE);
    respond = defaultReply;
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].url.pathname).toBe(`/api/admin/users/${USER_TWO}/warn`);
    expect(body(posts()[1])).toEqual({ reason: REASON });
  });

  it.each([
    { status: 200, body: summary(USER_TWO) },
    { status: 503, body: { message: 'Summary unavailable' } },
  ])('a refused or wrong-user summary disables actions and preserves linkage on retry: %j', async (reply) => {
    respond = (call) => call.url.pathname.endsWith('/summary') ? reply : defaultReply(call);
    mockParams = { reportId: REPORT_ONE, userId: USER_ONE };
    await render(<UserModerationScreen />);
    await screen.findByTestId('user-search-error');
    expect(screen.queryByTestId('action-warn')).toBeNull();
    expect(posts()).toEqual([]);
    expect(screen.getByTestId('moderation-report-link')).toBeTruthy();
    respond = defaultReply;
    await fireEvent.press(screen.getByTestId('retry-user-summary'));
    await screen.findByTestId('action-warn');
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body(posts()[0]).report_id).toBe(REPORT_ONE);
  });

  it.each([
    { reportId: REPORT_ONE }, { userId: USER_ONE }, { reportId: '', userId: USER_ONE },
    { reportId: [REPORT_ONE, REPORT_TWO], userId: USER_ONE }, { reportId: REPORT_ONE, userId: 'bad' },
  ])('refuses malformed handoff parameters instead of silently treating them as standalone: %j', async (params) => {
    mockParams = params;
    await render(<UserModerationScreen />);
    await screen.findByTestId('user-search-error');
    expect(screen.queryByTestId('action-warn')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('preserves standalone moderation and its existing action choices without report_id', async () => {
    await render(<UserModerationScreen />);
    await searchUser('first');
    expect(screen.getByTestId('action-restore')).toBeTruthy();
    expect(screen.getByTestId('action-hide-posts')).toBeTruthy();
    await chooseAction();
    await confirmReason();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ reason: REASON });
    await screen.findByTestId('action-warn');
  });
});

describe('TV-4a action transport', () => {
  it.each([
    ['warn', () => warnUser(USER_ONE, REASON, REPORT_ONE)],
    ['restrict', () => restrictUser(USER_ONE, REASON, REPORT_ONE)],
    ['ban', () => banUser(USER_ONE, REASON, REPORT_ONE)],
    ['suspend', () => suspendUser(USER_ONE, REASON, undefined, REPORT_ONE)],
  ] as const)('%s sends report_id, never a camelCase transport key', async (slug, invoke) => {
    await invoke();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url.pathname).toBe(`/api/admin/users/${USER_ONE}/${slug}`);
    expect(body(posts()[0])).toEqual({ reason: REASON, report_id: REPORT_ONE });
  });

  it('keeps the suspension expiry argument and standalone body compatible', async () => {
    const expiresAt = '2030-01-01T00:00:00Z';
    await suspendUser(USER_ONE, REASON, expiresAt, REPORT_ONE);
    await suspendUser(USER_ONE, REASON, expiresAt);
    await warnUser(USER_ONE, null);
    expect(posts().map(body)).toEqual([
      { reason: REASON, expires_at: expiresAt, report_id: REPORT_ONE },
      { reason: REASON, expires_at: expiresAt }, { reason: null },
    ]);
  });
});
