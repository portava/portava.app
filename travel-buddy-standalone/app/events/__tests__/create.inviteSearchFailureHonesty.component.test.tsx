/**
 * Create Event → step 8 "Invite friends" — the people search says a failed
 * read, a genuine miss says no one was found, and only the latest request
 * writes the list.
 *
 * Driven through the REAL follows and events services (searchUsers → GET
 * /api/users/search; the draft through GET /api/events/drafts/:id); only
 * `fetch` is faked, plus the session the services read their bearer token from.
 * The screen is opened on a resumed draft whose next gap is Tickets, and one
 * "Next" reaches the Invite step. census-discovery §106 (lane tm-people).
 *
 * THE DEFECTS
 *  1. `setInviteResults(res.ok ? (res.data ?? []) : [])`: a failed search
 *     rendered exactly as nobody matching — an empty space under the input.
 *  2. The 400 ms debounce cleared the TIMER but not an in-flight request, so a
 *     late answer for an earlier query overwrote the later one.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the screen reads only the resumed draft id.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ draftId: 'd-1' }),
  usePathname: () => '/events/create',
}));

// NOTE: intentionally exhaustive — requireActual pulls native modules unavailable in jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — requireActual would construct the real
// Supabase client, whose auto-refresh timer outlives the test environment.
jest.mock('../../../src/lib/supabase', () => ({
  isSupabaseConfigured: true,
  authedClient: () => null,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

// NOTE: intentionally exhaustive — KeyboardAvoidingView hits native modules.
jest.mock('../../../src/components/ui/KeyboardSafeView', () => ({
  KeyboardSafeScrollView: ({ children }: any) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));

// NOTE: intentionally exhaustive — the cover picker needs expo-image-picker's native module.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: jest.fn(async () => null), pickerElement: null }),
}));

type Reply = { status: number; body: unknown } | Error;
let searchReplies: Map<string, Reply> = new Map();
let deferred: Array<{ q: string; resolve: (r: Reply) => void }> = [];
let deferSearch = false;
const fetchMock = jest.fn();
let ui: Awaited<ReturnType<typeof render>>;

const DRAFT = {
  id: 'd-1', title: 'Sunset walk', description: null, category: null,
  startsAt: '2030-06-01T18:00:00.000Z', endsAt: '2030-06-01T20:00:00.000Z',
  locationName: 'Alfama', city: 'Lisbon', country: 'Portugal',
  maxAttendees: 10, visibility: 'public', priceType: null,
  chatEnabled: true, waitlistEnabled: false,
};

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
    const u = new URL(url, 'http://api.test');
    if (u.pathname === '/api/users/search') {
      const q = u.searchParams.get('q') ?? '';
      if (deferSearch) return new Promise((resolve, reject) => {
        deferred.push({ q, resolve: (r) => { try { resolve(toResponse(r)); } catch (e) { reject(e); } } });
      });
      return toResponse(searchReplies.get(q) ?? { status: 200, body: { users: [] } });
    }
    if (u.pathname.startsWith('/api/events/drafts')) return toResponse({ status: 200, body: DRAFT });
    // Everything else the screen reads on the way (assistance, compass hints) — not under test.
    return toResponse({ status: 404, body: { error: 'not_found' } });
  });
  (globalThis as any).fetch = fetchMock;
});
afterEach(async () => { await act(async () => {}); });

async function openInviteStep() {
  const CreateEventScreen = require('../create/index').default;
  ui = await render(<CreateEventScreen />);
  await waitFor(() => expect(ui.getByText('Next')).toBeTruthy());
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/events/drafts/d-1'))).toBe(true));
  await act(async () => {});
  await act(async () => { fireEvent.press(ui.getByText('Next')); });
  await waitFor(() => expect(ui.getByPlaceholderText('Search travellers…')).toBeTruthy());
}
async function type(q: string) {
  await act(async () => { fireEvent.changeText(ui.getByPlaceholderText('Search travellers…'), q); });
}

describe('Create Event invite step — a failed search is said', () => {
  it('E1. a failed search shows the failed state with Retry, not an empty list; Retry reads again', async () => {
    await openInviteStep();
    searchReplies.set('ali', FAILED);
    await type('ali');
    await waitFor(() => expect(ui.getByText(SEARCH_FAILED)).toBeTruthy());
    expect(ui.queryByText(NONE_FOUND)).toBeNull();
    searchReplies.set('ali', { status: 200, body: { users: [user('u-ali', 'Alison')] } });
    await act(async () => { fireEvent.press(ui.getByLabelText('Retry')); });
    await waitFor(() => expect(ui.getByText('Alison')).toBeTruthy());
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });

  it('E2. a genuine miss says no one was found, and is not the failed state', async () => {
    await openInviteStep();
    await type('zzzz');
    await waitFor(() => expect(ui.getByText(NONE_FOUND)).toBeTruthy());
    expect(ui.queryByText(SEARCH_FAILED)).toBeNull();
  });
});

describe('Create Event invite step — only the latest request writes', () => {
  it('E3. a slower answer for an earlier query does not overwrite the later one', async () => {
    await openInviteStep();
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

  it('E4. a stale failure landing late does not replace the latest people with the failed state', async () => {
    await openInviteStep();
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
