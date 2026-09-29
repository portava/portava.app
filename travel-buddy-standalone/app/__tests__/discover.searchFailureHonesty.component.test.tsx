/**
 * discover.searchFailureHonesty.component.test.tsx
 *
 * Find Travelers (app/discover.tsx) through the REAL follows service
 * (src/services/follows.ts). Only `fetch` is faked, plus the signed-in session
 * the service reads its bearer token from.
 *
 * Failure honesty (census-discovery DV-83's principle; §106, lane tm-people): a
 * failed read is never shown as an empty or complete result.
 *
 * THE DEFECTS
 *  1. `setResults(res.data ?? [])`: a failed search became an empty list, and
 *     the screen said "No travelers found".
 *  2. No latest-request guard: a slow answer for an earlier query overwrote the
 *     later query's results, and its `setLoading(false)` ended the later
 *     query's loading early.
 *  3. The service read `body.users ?? []`: a refusal envelope or a body with no
 *     list came back `ok: true` and empty.
 *  4. Suggestions: `res.data ?? []` turned a failed read into "You've seen
 *     everyone for now" (or the idle placeholder).
 *
 * Run: pnpm --dir travel-buddy-standalone exec jest app/__tests__/discover.searchFailureHonesty.component.test.tsx
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — only `router` is read by this screen; the
// real module needs a navigator context.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/discover',
}));

// NOTE: intentionally exhaustive — requireActual pulls native modules unavailable in jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// The session the service takes its bearer token from.
// NOTE: intentionally exhaustive — requireActual would construct the real
// Supabase client, whose auto-refresh timer outlives the test environment.
// `isSupabaseConfigured` is forced on because jest has no env.
jest.mock('../../src/lib/supabase', () => ({
  isSupabaseConfigured: true,
  authedClient: () => null,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

// NOTE: intentionally exhaustive — AppHeader renders native navigation chrome.
jest.mock('../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));

jest.mock('../../src/components/ui/KeyboardSafeView', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => R.createElement(RN.View, null, children),
  };
});

// NOTE: intentionally exhaustive — ProfileSkeleton uses Reanimated internals.
jest.mock('../../src/components/loading/ProfileSkeleton', () => ({ ProfileSkeleton: () => null }));

// NOTE: intentionally exhaustive — the real handler calls Reanimated internals.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
}));

// NOTE: intentionally exhaustive — reads native inset measurements.
jest.mock('../../src/hooks/useBottomInset', () => ({ PlainBottomFiller: () => null }));

// NOTE: intentionally exhaustive — expo-image loads native modules.
jest.mock('../../src/components/ui/DisplayMediaImage', () => ({ AvatarImage: () => null }));

import DiscoverScreen from '../discover';

// ── fetch: the only faked boundary ────────────────────────────────────────────

type Reply = { status: number; body: unknown } | Error;
type Pending = { q: string; resolve: (r: Reply) => void };

let searchReplies: Map<string, Reply> = new Map();
let deferred: Pending[] = [];
let deferSearch = false;
let suggestionReplies: Reply[] = [];
const fetchMock = jest.fn();
let ui: Awaited<ReturnType<typeof render>>;

function toResponse(r: Reply) {
  if (r instanceof Error) throw r;
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
}

function user(id: string, username: string) {
  return {
    id, displayName: null, username, avatarUrl: null, followerCount: 0, isFollowing: false,
    isPrivate: false, friendRequestPending: false, reason: null, verified: false, isOfficial: false,
  };
}

const FAILED: Reply = { status: 500, body: { error: 'db_error', message: 'A database error occurred. Please try again.' } };
const NO_TRAVELERS = 'No travelers found';
const SEARCH_FAILED = /couldn.t search travelers/i;

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });

beforeEach(() => {
  searchReplies = new Map();
  deferred = [];
  deferSearch = false;
  suggestionReplies = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/api/users/suggestions') {
      return toResponse(suggestionReplies.length > 1 ? suggestionReplies.shift()! : (suggestionReplies[0] ?? { status: 200, body: { users: [] } }));
    }
    if (u.pathname === '/api/users/search') {
      const q = u.searchParams.get('q') ?? '';
      if (deferSearch) return new Promise((resolve, reject) => {
        deferred.push({ q, resolve: (r) => { try { resolve(toResponse(r)); } catch (e) { reject(e); } } });
      });
      return toResponse(searchReplies.get(q) ?? { status: 200, body: { users: [] } });
    }
    if (u.pathname === '/api/users/suggestions/seen') return toResponse({ status: 200, body: { cleared: true } });
    if (/^\/api\/users\/[^/]+\/follow$/.test(u.pathname)) return toResponse({ status: 200, body: { following: true } });
    throw new Error(`unexpected fetch ${url}`);
  });
  (globalThis as any).fetch = fetchMock;
});

async function typeQuery(q: string) {
  await act(async () => { fireEvent.changeText(ui.getByPlaceholderText('Search by name or @username'), q); });
}

async function press(label: string) {
  await act(async () => { fireEvent.press(ui.getByLabelText(label)); });
}

async function settle(ms = 400) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

describe('Find Travelers — a failed search is said, and can be retried', () => {
  it('D1. a 500 shows the failed state with Retry, never "No travelers found"; Retry reads again', async () => {
    ui = await render(<DiscoverScreen />);
    searchReplies.set('ali', FAILED);
    await typeQuery('ali');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy());
    expect(ui.queryByText(NO_TRAVELERS)).toBeNull();

    searchReplies.set('ali', { status: 200, body: { users: [user('u-ali', 'alison')] } });
    await press('Retry');
    await waitFor(() => expect(ui.getByText('@alison')).toBeTruthy());
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });

  it('D2. an unreachable network is the failed state, not an empty result', async () => {
    ui = await render(<DiscoverScreen />);
    searchReplies.set('ali', new TypeError('Network request failed'));
    await typeQuery('ali');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy());
    expect(ui.queryByText(NO_TRAVELERS)).toBeNull();
  });

  it('D3. a refusal envelope (the search stop) is the failed state, not "No travelers found"', async () => {
    ui = await render(<DiscoverScreen />);
    searchReplies.set('ali', { status: 200, body: { users: [], refusal: { class: 'feature_disabled', code: 'profile_search_stopped', route: '/users/search', coverage: 'nothing' } } });
    await typeQuery('ali');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy());
    expect(ui.queryByText(NO_TRAVELERS)).toBeNull();
  });

  it('D4. a 200 with no users list is a failed read, not an empty one', async () => {
    ui = await render(<DiscoverScreen />);
    searchReplies.set('ali', { status: 200, body: {} });
    await typeQuery('ali');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy());
    expect(ui.queryByText(NO_TRAVELERS)).toBeNull();
  });

  it('D5. a genuine miss still says no one was found — and offers no Retry', async () => {
    ui = await render(<DiscoverScreen />);
    searchReplies.set('zzzz', { status: 200, body: { users: [] } });
    await typeQuery('zzzz');
    await waitFor(() => expect(ui.getByText(NO_TRAVELERS)).toBeTruthy());
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
    expect(ui.queryByLabelText('Retry')).toBeNull();
  });
});

describe('Find Travelers — only the latest request writes the results', () => {
  it('R1. a slow earlier answer arriving after the later one does not overwrite it', async () => {
    ui = await render(<DiscoverScreen />);
    deferSearch = true;
    await typeQuery('al');
    await waitFor(() => expect(deferred.map((d) => d.q)).toEqual(['al']));
    await typeQuery('ali');
    await waitFor(() => expect(deferred.map((d) => d.q)).toEqual(['al', 'ali']));

    // The later query answers first…
    await act(async () => { deferred[1].resolve({ status: 200, body: { users: [user('u-ali', 'alison')] } }); });
    await waitFor(() => expect(ui.getByText('@alison')).toBeTruthy());
    // …then the stale one lands.
    await act(async () => { deferred[0].resolve({ status: 200, body: { users: [user('u-al', 'albert')] } }); });
    await settle(50);
    expect(ui.queryByText('@albert')).toBeNull();
    expect(ui.getByText('@alison')).toBeTruthy();
  });

  it('R2. a stale FAILURE arriving late does not replace the latest results with the failed state', async () => {
    ui = await render(<DiscoverScreen />);
    deferSearch = true;
    await typeQuery('al');
    await waitFor(() => expect(deferred).toHaveLength(1));
    await typeQuery('ali');
    await waitFor(() => expect(deferred).toHaveLength(2));
    await act(async () => { deferred[1].resolve({ status: 200, body: { users: [user('u-ali', 'alison')] } }); });
    await waitFor(() => expect(ui.getByText('@alison')).toBeTruthy());
    await act(async () => { deferred[0].resolve(FAILED); });
    await settle(50);
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
    expect(ui.getByText('@alison')).toBeTruthy();
  });

  it('R3. a stale answer landing while the latest is in flight neither shows its rows nor ends the loading as "No travelers found"', async () => {
    ui = await render(<DiscoverScreen />);
    deferSearch = true;
    await typeQuery('al');
    await waitFor(() => expect(deferred).toHaveLength(1));
    await typeQuery('ali');
    await waitFor(() => expect(deferred).toHaveLength(2));
    await act(async () => { deferred[0].resolve({ status: 200, body: { users: [] } }); });
    await settle(50);
    expect(ui.queryByText(NO_TRAVELERS)).toBeNull();
    await act(async () => { deferred[1].resolve({ status: 200, body: { users: [user('u-ali', 'alison')] } }); });
    await waitFor(() => expect(ui.getByText('@alison')).toBeTruthy());
  });
  it('R4. an earlier answer landing in the debounce window before the next request starts does not write', async () => {
    ui = await render(<DiscoverScreen />);
    deferSearch = true;
    await typeQuery('al');
    await waitFor(() => expect(deferred).toHaveLength(1));
    await typeQuery('ali');
    // 'ali' is still debouncing — its request has not been sent — when 'al' answers.
    await act(async () => { deferred[0].resolve({ status: 200, body: { users: [user('u-al', 'albert')] } }); });
    expect(deferred).toHaveLength(1);
    expect(ui.queryByText('@albert')).toBeNull();
    await waitFor(() => expect(deferred).toHaveLength(2));
    await act(async () => { deferred[1].resolve({ status: 200, body: { users: [user('u-ali', 'alison')] } }); });
    await waitFor(() => expect(ui.getByText('@alison')).toBeTruthy());
    expect(ui.queryByText('@albert')).toBeNull();
  });
});

describe('Find Travelers — suggestions say a failed read', () => {
  it('S1. a failed suggestions read on open shows the failed state with Retry, not the idle placeholder', async () => {
    suggestionReplies = [FAILED, { status: 200, body: { users: [user('u-bo', 'bosco')] } }];
    ui = await render(<DiscoverScreen />);
    await waitFor(() => expect(ui.getByText(/couldn.t load suggestions/i)).toBeTruthy());
    expect(ui.queryByText('Find your next travel buddy')).toBeNull();
    await press('Retry');
    await waitFor(() => expect(ui.getByText('@bosco')).toBeTruthy());
  });

  it('S3. a suggestions 200 with no users list is a failed read, not an empty one', async () => {
    suggestionReplies = [{ status: 200, body: {} }];
    ui = await render(<DiscoverScreen />);
    await waitFor(() => expect(ui.getByText(/couldn.t load suggestions/i)).toBeTruthy());
    expect(ui.queryByText('Find your next travel buddy')).toBeNull();
  });

  it('S2. a failed refresh after the list ran out is not "You\'ve seen everyone for now"', async () => {
    // The one suggestion is followed, so the list runs out — a TRUE "seen
    // everyone" — and then "See new faces" re-reads, and that read FAILS.
    suggestionReplies = [{ status: 200, body: { users: [user('u-bo', 'bosco')] } }, FAILED];
    ui = await render(<DiscoverScreen />);
    await waitFor(() => expect(ui.getByText('@bosco')).toBeTruthy());
    await press('Follow');
    await waitFor(() => expect(ui.getByText("You've seen everyone for now")).toBeTruthy());
    await press('See new faces');
    await waitFor(() => expect(ui.getByText(/couldn.t load suggestions/i)).toBeTruthy());
    expect(ui.queryByText("You've seen everyone for now")).toBeNull();
  });
});
