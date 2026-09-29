/**
 * HostDashboardPanel — the Invite tab's people search says a failed read, and
 * only its latest request writes the list.
 *
 * Driven through the REAL follows service (searchUsers → GET /api/users/search)
 * and the real events service; only `fetch` is faked, plus the session the
 * services read their bearer token from. census-discovery §106 (lane tm-people).
 *
 * THE DEFECTS
 *  1. `if (res.ok) setInviteResults(res.data ?? [])`: a failed search left the
 *     PREVIOUS query's people on screen as the answer to the new one — or, with
 *     none, printed "No users found".
 *  2. A search fires per keystroke with no latest-request guard, so a slower
 *     answer for an earlier prefix overwrote the later one.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — requireActual would construct the real
// Supabase client, whose auto-refresh timer outlives the test environment.
jest.mock('../../lib/supabase', () => ({
  isSupabaseConfigured: true,
  authedClient: () => null,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

// NOTE: intentional stubs — the other tabs' panels are not under test here.
jest.mock('../events/EventAttendancePanel.tsx', () => ({ EventAttendancePanel: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../events/EventCohostsPanel.tsx', () => ({ EventCohostsPanel: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../events/EventCancelControl.tsx', () => ({ EventCancelControl: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../events/GenerateHeaderSheet.tsx', () => ({ GenerateHeaderSheet: () => null }));

import { HostDashboardPanel } from '../HostDashboardPanel.tsx';

type Reply = { status: number; body: unknown } | Error;
let searchReplies: Map<string, Reply> = new Map();
let deferred: Array<{ q: string; resolve: (r: Reply) => void }> = [];
let deferSearch = false;
const fetchMock = jest.fn();
let ui: Awaited<ReturnType<typeof render>>;

function toResponse(r: Reply) {
  if (r instanceof Error) throw r;
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
}
function user(id: string, username: string) {
  return { id, displayName: null, username, avatarUrl: null, followerCount: 0, isFollowing: false, isPrivate: false, friendRequestPending: false, reason: null, verified: false, isOfficial: false };
}
const FAILED: Reply = { status: 500, body: { error: 'db_error', message: 'A database error occurred. Please try again.' } };
const SEARCH_FAILED = /couldn.t search travelers/i;
const baseEvent: any = { id: 'ev-1', state: 'open', rsvpClosed: false, coverUrl: null, goingAttendees: [], isHost: true, myRole: 'host', hostId: 'host' };

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });

beforeEach(() => {
  searchReplies = new Map();
  deferred = [];
  deferSearch = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/api/users/search') {
      const q = u.searchParams.get('q') ?? '';
      if (deferSearch) return new Promise((resolve, reject) => {
        deferred.push({ q, resolve: (r) => { try { resolve(toResponse(r)); } catch (e) { reject(e); } } });
      });
      return toResponse(searchReplies.get(q) ?? { status: 200, body: { users: [] } });
    }
    // The panel's own reads (join requests and the like) — empty, not under test.
    return toResponse({ status: 200, body: { requests: [], waitlist: [] } });
  });
  (globalThis as any).fetch = fetchMock;
});
afterEach(async () => { await act(async () => {}); });

async function openInvite() {
  ui = await render(<HostDashboardPanel event={baseEvent} onDismiss={jest.fn()} onRefresh={jest.fn()} />);
  await act(async () => { fireEvent.press(ui.getByText('Invite')); });
}
async function type(q: string) {
  await act(async () => { fireEvent.changeText(ui.getByPlaceholderText('Search by name or @handle…'), q); });
}

describe('HostDashboardPanel Invite — a failed search is said', () => {
  it('H1. a failed search replaces the last query\'s people with a failed state and Retry — never "No users found"', async () => {
    await openInvite();
    searchReplies.set('al', { status: 200, body: { users: [user('u-al', 'albert')] } });
    await type('al');
    await waitFor(() => expect(ui.getByText('@albert')).toBeTruthy());

    searchReplies.set('ali', FAILED);
    await type('ali');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy());
    expect(ui.queryByText('@albert')).toBeNull();
    expect(ui.queryByText('No users found')).toBeNull();

    searchReplies.set('ali', { status: 200, body: { users: [user('u-ali', 'alison')] } });
    await act(async () => { fireEvent.press(ui.getByLabelText('Retry')); });
    await waitFor(() => expect(ui.getByText('@alison')).toBeTruthy());
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });

  it('H2. a genuine miss still says "No users found"', async () => {
    await openInvite();
    await type('zzzz');
    await waitFor(() => expect(ui.getByText('No users found')).toBeTruthy());
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });
});

describe('HostDashboardPanel Invite — only the latest request writes', () => {
  it('H3. a slower answer for an earlier prefix does not overwrite the later one', async () => {
    await openInvite();
    deferSearch = true;
    await type('al');
    await type('ali');
    await waitFor(() => expect(deferred.map((d) => d.q)).toEqual(['al', 'ali']));
    await act(async () => { deferred[1].resolve({ status: 200, body: { users: [user('u-ali', 'alison')] } }); });
    await waitFor(() => expect(ui.getByText('@alison')).toBeTruthy());
    await act(async () => { deferred[0].resolve({ status: 200, body: { users: [user('u-al', 'albert')] } }); });
    await act(async () => {});
    expect(ui.queryByText('@albert')).toBeNull();
    expect(ui.getByText('@alison')).toBeTruthy();
  });

  it('H4. a stale failure landing late does not replace the latest people with the failed state', async () => {
    await openInvite();
    deferSearch = true;
    await type('al');
    await type('ali');
    await waitFor(() => expect(deferred).toHaveLength(2));
    await act(async () => { deferred[1].resolve({ status: 200, body: { users: [user('u-ali', 'alison')] } }); });
    await waitFor(() => expect(ui.getByText('@alison')).toBeTruthy());
    await act(async () => { deferred[0].resolve(FAILED); });
    await act(async () => {});
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
    expect(ui.getByText('@alison')).toBeTruthy();
  });

  it('H5. shortening the query below two characters drops the in-flight answer', async () => {
    await openInvite();
    deferSearch = true;
    await type('al');
    await waitFor(() => expect(deferred).toHaveLength(1));
    await type('a');
    await act(async () => { deferred[0].resolve({ status: 200, body: { users: [user('u-al', 'albert')] } }); });
    await act(async () => {});
    expect(ui.queryByText('@albert')).toBeNull();
  });
});
