/**
 * ShareSheet and DiscoveryShareSheet — the "find someone" people search says a
 * failed read, and only its latest request writes the People section.
 *
 * The search runs through the REAL follows service (searchUsers → GET
 * /api/users/search); only `fetch` is faked, plus the session the service reads
 * its bearer token from. The messaging and posts services are stubbed as in the
 * sheets' other suites (they pull native E2EE/Supabase deps and are not under
 * test). census-discovery §106 (lane tm-people).
 *
 * THE DEFECTS (identical in both sheets)
 *  1. A failed search set `userResults` to [] — the sheet then printed
 *     `No results for "…"` (no chat matched either) or "No people found.".
 *  2. The debounced search had no latest-request guard, so an answer for an
 *     earlier query that landed late overwrote the later one's people and
 *     ended its spinner.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ShareSheet } from '../ShareSheet.tsx';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet.tsx';

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

// NOTE: intentionally exhaustive — messaging imports E2EE native deps; the
// sheets only read threads (none, so every result is a person) and open chats.
jest.mock('../../services/messaging.ts', () => ({
  getMyThreads: jest.fn(async () => ({ ok: true, data: { threads: [] } })),
  sendMessage: jest.fn(async () => ({ ok: true })),
  openDirectThread: jest.fn(async () => ({ ok: true, data: { threadId: 't-1' } })),
}));

// NOTE: intentionally exhaustive — the preview card is not under test.
jest.mock('../../services/posts.ts', () => ({
  getPostById: jest.fn(async () => ({ ok: false, data: null })),
}));

// NOTE: intentionally exhaustive — native module internals are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: any) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));

// NOTE: intentionally exhaustive — expo-clipboard needs a native module.
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => {}) }));

// NOTE: intentionally exhaustive — KeyboardAvoidingView hits native modules.
jest.mock('../ui/KeyboardSafeView.tsx', () => ({
  KeyboardSafeScrollView: ({ children, style }: any) => {
    const { View } = require('react-native');
    return <View style={style}>{children}</View>;
  },
}));

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
function user(id: string, name: string, username: string) {
  return { id, displayName: name, username, avatarUrl: null, followerCount: 0, isFollowing: false, isPrivate: false, friendRequestPending: false, reason: null, verified: false, isOfficial: false };
}
const FAILED: Reply = { status: 500, body: { error: 'db_error', message: 'A database error occurred. Please try again.' } };
const SEARCH_FAILED = /couldn.t search people/i;

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

const SHEETS: Array<[string, () => Promise<void>]> = [
  ['ShareSheet', async () => {
    ui = await render(<ShareSheet visible postId="post-1" onClose={jest.fn()} />);
    await act(async () => { fireEvent.press(await ui.findByText('Send in a chat')); });
  }],
  ['DiscoveryShareSheet', async () => {
    ui = await render(
      <DiscoveryShareSheet visible item={{ sourceId: 's-1', sourceType: 'place', title: 'Rooftop', category: 'Bar', city: 'Lisbon' }} onClose={jest.fn()} />,
    );
  }],
];

async function type(q: string) {
  await act(async () => { fireEvent.changeText(await ui.findByPlaceholderText('Search chats or find someone…'), q); });
}

describe.each(SHEETS)('%s — people search', (_name, open) => {
  it('P1. a failed search is said with Retry — not `No results for …` — and Retry reads again', async () => {
    await open();
    searchReplies.set('ali', FAILED);
    await type('ali');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy(), { timeout: 3000 });
    expect(ui.queryByText(/No results for/)).toBeNull();
    expect(ui.queryByText('No people found.')).toBeNull();

    searchReplies.set('ali', { status: 200, body: { users: [user('u-ali', 'Alison A', 'alison')] } });
    await act(async () => { fireEvent.press(ui.getByLabelText('Retry')); });
    await waitFor(() => expect(ui.getByText('Alison A')).toBeTruthy(), { timeout: 3000 });
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });

  it('P2. an unreachable network is the same failed state', async () => {
    await open();
    searchReplies.set('bea', new TypeError('Network request failed'));
    await type('bea');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy(), { timeout: 3000 });
    expect(ui.queryByText(/No results for/)).toBeNull();
  });

  it('P3. a genuine miss still says nothing matched', async () => {
    await open();
    await type('zzzz');
    await waitFor(() => expect(ui.getByText(/No results for/)).toBeTruthy(), { timeout: 3000 });
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });

  // Queries used by no other test: a debounce timer a previous test left behind
  // can still fire into this one, and must not be mistaken for its requests.
  const EARLY = 'ca';
  const LATE = 'cam';
  const pending = (q: string) => deferred.find((d) => d.q === q);

  it('P4. a slower answer for an earlier query does not overwrite the later one', async () => {
    await open();
    deferSearch = true;
    await type(EARLY);
    await waitFor(() => expect(pending(EARLY)).toBeTruthy(), { timeout: 3000 });
    await type(LATE);
    await waitFor(() => expect(pending(LATE)).toBeTruthy(), { timeout: 3000 });
    await act(async () => { pending(LATE)!.resolve({ status: 200, body: { users: [user('u-ali', 'Alison A', 'alison')] } }); });
    await waitFor(() => expect(ui.getByText('Alison A')).toBeTruthy());
    await act(async () => { pending(EARLY)!.resolve({ status: 200, body: { users: [user('u-al', 'Albert B', 'albert')] } }); });
    await act(async () => {});
    expect(ui.queryByText('Albert B')).toBeNull();
    expect(ui.getByText('Alison A')).toBeTruthy();
  });

  it('P5. an earlier answer landing while the later request is in flight writes nothing and keeps the spinner', async () => {
    await open();
    deferSearch = true;
    await type(EARLY);
    await waitFor(() => expect(pending(EARLY)).toBeTruthy(), { timeout: 3000 });
    await type(LATE);
    await waitFor(() => expect(pending(LATE)).toBeTruthy(), { timeout: 3000 });
    await act(async () => { pending(EARLY)!.resolve({ status: 200, body: { users: [] } }); });
    await act(async () => {});
    expect(ui.queryByText(/No results for/)).toBeNull();
    expect(ui.queryByText('No people found.')).toBeNull();
    await act(async () => { pending(LATE)!.resolve({ status: 200, body: { users: [user('u-ali', 'Alison A', 'alison')] } }); });
    await waitFor(() => expect(ui.getByText('Alison A')).toBeTruthy());
  });
});
