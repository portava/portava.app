/**
 * The moderation queue screen (census-trust TV-4a; verifier finding 10).
 *
 * Run with: pnpm test:component
 *
 * The in-app Report button files into `moderation_reports`; until this screen
 * no client read that queue. What is pinned:
 *   - it reads GET /api/admin/moderation/reports (the real service function,
 *     over a mocked fetch — the URL is the assertion), never the legacy
 *     /api/admin/reports;
 *   - a failed load is an announced error with a retry, not "no reports";
 *   - a snapshot that could not be READ says so, and is not shown as deleted;
 *     a page with failed snapshot reads says it is incomplete;
 *   - a decision POSTs to /review with the decision and the optional note, and
 *     the row changes only to what the server confirmed;
 *   - a refusal (409: someone else closed it first) changes nothing on the
 *     row and tells the moderator why.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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

import ModerationReportsScreen, { snapshotLine } from '../moderation-reports';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, reporter_id: 'rep-1', subject_type: 'post', subject_id: 'p1', subject_user_id: 'author-1',
  category: 'harassment', details: 'they keep posting this', status: 'open',
  created_at: '2026-10-05T10:00:00.000Z', resolved_at: null,
  subject_snapshot: { state: 'ok', text: 'the reported post text' },
  ...over,
});

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let responder: (c: Call) => { status: number; body: unknown };

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  calls = [];
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    const r = responder(c);
    return json(r.status, r.body);
  });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

const gets = () => calls.filter((c) => !c.init?.method || c.init.method === 'GET');
const posts = () => calls.filter((c) => c.init?.method === 'POST');

describe('User reports — the moderation_reports queue reaches a client', () => {
  it('reads the moderation queue endpoint (not the legacy reports list) and shows each report with its snapshot', async () => {
    responder = () => ({ status: 200, body: { reports: [row(R1)], total: 1, page: 1 } });
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${R1}`);
    expect(gets()[0].url).toContain('/api/admin/moderation/reports?');
    expect(gets()[0].url).toContain('status=open');
    expect(calls.some((c) => /\/api\/admin\/reports\?/.test(c.url))).toBe(false);
    expect(screen.getByTestId(`modq-snapshot-${R1}`).props.children).toBe('the reported post text');
  });

  it('a failed load is an announced error with a retry — not "no reports"', async () => {
    let n = 0;
    responder = () => (n++ === 0 ? { status: 500, body: { message: 'db down' } } : { status: 200, body: { reports: [], total: 0, page: 1 } });
    await render(<ModerationReportsScreen />);
    const err = await screen.findByTestId('modq-error');
    expect(err.props.accessibilityRole).toBe('alert');
    expect(screen.queryByTestId('modq-empty')).toBeNull();
    await act(async () => { await fireEvent.press(screen.getByTestId('modq-retry')); });
    await screen.findByTestId('modq-empty');
  });

  it('a snapshot that could not be read says so (never "deleted"), and the page says it is incomplete', async () => {
    responder = () => ({
      status: 200,
      body: { reports: [row(R1, { subject_snapshot: { state: 'unavailable' } }), row(R2, { subject_snapshot: { state: 'not_found' } })], total: 2, page: 1, snapshotsUnavailableFor: ['post'] },
    });
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${R1}`);
    expect(String(screen.getByTestId(`modq-snapshot-${R1}`).props.children)).toMatch(/could not be read/);
    expect(String(screen.getByTestId(`modq-snapshot-${R1}`).props.children)).not.toMatch(/no longer exists/);
    expect(String(screen.getByTestId(`modq-snapshot-${R2}`).props.children)).toMatch(/no longer exists/);
    expect(screen.getByTestId('modq-incomplete')).toBeTruthy();
  });

  it('Start review POSTs {decision: reviewing} to /review and the row takes the status the server returned', async () => {
    responder = (c) => (c.init?.method === 'POST'
      ? { status: 200, body: { report: { id: R1, status: 'reviewing' }, audit: null } }
      : { status: 200, body: { reports: [row(R1)], total: 1, page: 1 } });
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${R1}`);
    await act(async () => { await fireEvent.press(screen.getByTestId(`modq-reviewing-${R1}`)); });
    await waitFor(() => expect(screen.getByTestId(`modq-status-${R1}`).props.children).toBe('reviewing'));
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toContain(`/api/admin/moderation/reports/${R1}/review`);
    expect(JSON.parse(String(posts()[0].init?.body))).toEqual({ decision: 'reviewing' });
  });

  it('Action asks for an optional note and sends it with the decision', async () => {
    responder = (c) => (c.init?.method === 'POST'
      ? { status: 200, body: { report: { id: R1, status: 'actioned' }, audit: 'recorded' } }
      : { status: 200, body: { reports: [row(R1)], total: 1, page: 1 } });
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${R1}`);
    await act(async () => { await fireEvent.press(screen.getByTestId(`modq-actioned-${R1}`)); });
    const input = await screen.findByPlaceholderText('Note (optional)');
    await act(async () => { await fireEvent.changeText(input, 'removed the post'); });
    await act(async () => { await fireEvent.press(screen.getAllByText('Action').slice(-1)[0]); });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0].init?.body))).toEqual({ decision: 'actioned', note: 'removed the post' });
    await waitFor(() => expect(screen.getByTestId(`modq-status-${R1}`).props.children).toBe('actioned'));
  });

  it('a refusal (409, closed by someone else first) leaves the row unchanged and says why', async () => {
    responder = (c) => (c.init?.method === 'POST'
      ? { status: 409, body: { error: 'conflict', message: 'This report changed while you were reviewing it. Nothing was recorded. Reload and try again.' } }
      : { status: 200, body: { reports: [row(R1)], total: 1, page: 1 } });
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${R1}`);
    await act(async () => { await fireEvent.press(screen.getByTestId(`modq-reviewing-${R1}`)); });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect((Alert.alert as jest.Mock).mock.calls[0][1]).toMatch(/changed while you were reviewing/);
    expect(screen.getByTestId(`modq-status-${R1}`).props.children).toBe('open');
  });

  it('a closed report offers no further decision', async () => {
    responder = () => ({ status: 200, body: { reports: [row(R1, { status: 'dismissed' })], total: 1, page: 1 } });
    await render(<ModerationReportsScreen />);
    await screen.findByTestId(`modq-row-${R1}`);
    expect(screen.queryByTestId(`modq-actioned-${R1}`)).toBeNull();
    expect(screen.queryByTestId(`modq-dismissed-${R1}`)).toBeNull();
  });

  it('snapshotLine: ok without text, unsupported and absent each have their own words', () => {
    expect(snapshotLine({ state: 'ok' })).toMatch(/present/);
    expect(snapshotLine({ state: 'unsupported' })).toMatch(/No preview/);
    expect(snapshotLine(undefined)).toMatch(/No preview/);
  });
});
