/**
 * InvitePanel (media action rail → shared moment → "Invite people") — the
 * people search says a failed read, a genuine miss says no one was found, and
 * only the latest request writes the list.
 *
 * Driven through the REAL follows service (searchUsers → GET /api/users/search);
 * only `fetch` is faked, plus the session the service reads its bearer token
 * from. census-discovery §106 (lane tm-people).
 *
 * THE DEFECTS
 *  1. `.then((r) => setResults(r.ok && r.data ? r.data : []))` and
 *     `.catch(() => setResults([]))`: a failed search rendered as an empty list
 *     under the input — the same screen as "nobody by that name".
 *  2. No latest-request guard: a late answer for an earlier query overwrote the
 *     later one and ended its spinner.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — requireActual would construct the real
// Supabase client, whose auto-refresh timer outlives the test environment.
jest.mock('../../../lib/supabase', () => ({
  isSupabaseConfigured: true,
  authedClient: () => null,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

// NOTE: intentionally exhaustive — the ShareSheet this module also exports a
// panel for pulls messaging's native E2EE deps; it is not rendered here.
jest.mock('../../../components/ShareSheet.tsx', () => ({ ShareSheet: () => null }));

import { InvitePanel } from '../components/MediaActionPanels.tsx';

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
function user(id: string, name: string) {
  return { id, displayName: name, username: name.toLowerCase(), avatarUrl: null, followerCount: 0, isFollowing: false, isPrivate: false, friendRequestPending: false, reason: null, verified: false, isOfficial: false };
}
const FAILED: Reply = { status: 500, body: { error: 'db_error', message: 'A database error occurred. Please try again.' } };
const SEARCH_FAILED = /couldn.t search travellers/i;
const NONE_FOUND = 'No travellers found';
const pending = (q: string) => deferred.find((d) => d.q === q);

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
    throw new Error(`unexpected fetch ${url}`);
  });
  (globalThis as any).fetch = fetchMock;
});
afterEach(async () => { await act(async () => {}); });

async function open() {
  ui = await render(<InvitePanel momentId="m-1" mediaId={null} onBack={jest.fn()} />);
}
async function type(q: string) {
  await act(async () => { fireEvent.changeText(ui.getByLabelText('Search travellers to invite'), q); });
}

describe('InvitePanel — a failed search is said', () => {
  it('I1. a failed search shows the failed state with Retry, not an empty list; Retry reads again', async () => {
    await open();
    searchReplies.set('ali', FAILED);
    await type('ali');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy());
    expect(ui.queryByText(NONE_FOUND)).toBeNull();
    searchReplies.set('ali', { status: 200, body: { users: [user('u-ali', 'Alison')] } });
    await act(async () => { fireEvent.press(ui.getByLabelText('Retry')); });
    await waitFor(() => expect(ui.getByText('Alison')).toBeTruthy());
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });

  it('I2. an unreachable network is the same failed state', async () => {
    await open();
    searchReplies.set('bea', new TypeError('Network request failed'));
    await type('bea');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy());
  });

  it('I3. a genuine miss says no one was found, and is not the failed state', async () => {
    await open();
    await type('zzzz');
    await waitFor(() => expect(ui.getByText(NONE_FOUND)).toBeTruthy());
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });
});

describe('InvitePanel — only the latest request writes', () => {
  it('I4. a slower answer for an earlier query does not overwrite the later one', async () => {
    await open();
    deferSearch = true;
    await type('ca');
    await waitFor(() => expect(pending('ca')).toBeTruthy());
    await type('cam');
    await waitFor(() => expect(pending('cam')).toBeTruthy());
    await act(async () => { pending('cam')!.resolve({ status: 200, body: { users: [user('u-cam', 'Camille')] } }); });
    await waitFor(() => expect(ui.getByText('Camille')).toBeTruthy());
    await act(async () => { pending('ca')!.resolve({ status: 200, body: { users: [user('u-ca', 'Carlos')] } }); });
    await act(async () => {});
    expect(ui.queryByText('Carlos')).toBeNull();
    expect(ui.getByText('Camille')).toBeTruthy();
  });

  it('I5. a stale failure landing late does not replace the latest people with the failed state', async () => {
    await open();
    deferSearch = true;
    await type('da');
    await waitFor(() => expect(pending('da')).toBeTruthy());
    await type('dan');
    await waitFor(() => expect(pending('dan')).toBeTruthy());
    await act(async () => { pending('dan')!.resolve({ status: 200, body: { users: [user('u-dan', 'Daniela')] } }); });
    await waitFor(() => expect(ui.getByText('Daniela')).toBeTruthy());
    await act(async () => { pending('da')!.resolve(FAILED); });
    await act(async () => {});
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
    expect(ui.getByText('Daniela')).toBeTruthy();
  });
});
