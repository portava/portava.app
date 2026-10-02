/**
 * close-friends.lookupFailureHonesty.component.test.tsx
 *
 * Close Friends' "Add by @username" resolves the handle through the people
 * search (searchUsers → GET /api/users/search). Driven through the REAL follows
 * and stories services; only `fetch` is faked, plus the session the services
 * read their bearer token from.
 *
 * census-discovery §106 (lane tm-people), failure honesty: a failed read is
 * never presented as empty.
 *
 * THE DEFECTS
 *  1. `if (!sr.ok || !sr.data?.length)` → Alert "Not found — No traveler found
 *     with username …": a failed search told the user the person does not exist.
 *  2. `searchUsers(raw, 1)` took the FIRST fuzzy match (the route matches
 *     `%raw%` on name, handle and username), so "@ali" could add "@alison".
 *
 * Run: pnpm --dir travel-buddy-standalone exec jest app/__tests__/close-friends.lookupFailureHonesty.component.test.tsx
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — requireActual pulls native modules unavailable in jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — requireActual would construct the real
// Supabase client, whose auto-refresh timer outlives the test environment.
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

// NOTE: intentionally exhaustive — the real handler calls Reanimated internals.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
}));

import CloseFriendsScreen from '../close-friends';

type Reply = { status: number; body: unknown } | Error;
let searchReplies: Reply[] = [];
let added: string[] = [];
const fetchMock = jest.fn();
let ui: Awaited<ReturnType<typeof render>>;
let alertSpy: jest.SpyInstance;

function toResponse(r: Reply) {
  if (r instanceof Error) throw r;
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
}
function user(id: string, username: string) {
  return { id, displayName: null, username, avatarUrl: null, followerCount: 0, isFollowing: true, isPrivate: false, friendRequestPending: false, reason: null, verified: false, isOfficial: false };
}
const FAILED: Reply = { status: 500, body: { error: 'db_error', message: 'A database error occurred. Please try again.' } };

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });

beforeEach(() => {
  searchReplies = [];
  added = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/api/users/search') return toResponse(searchReplies.length > 1 ? searchReplies.shift()! : searchReplies[0]);
    if (u.pathname === '/api/users/me/close-friends') {
      if (init?.method === 'POST') { added.push(JSON.parse(String(init.body)).userId); return toResponse({ status: 200, body: { ok: true } }); }
      return toResponse({ status: 200, body: { closeFriends: [] } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  (globalThis as any).fetch = fetchMock;
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => alertSpy.mockRestore());

async function add(handle: string) {
  await act(async () => { fireEvent.changeText(ui.getByPlaceholderText('Add by @username'), handle); });
  await act(async () => { fireEvent.press(ui.getByText('Add')); });
}

function lastAlert() {
  const c = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
  return { title: c?.[0] as string, message: c?.[1] as string, buttons: (c?.[2] ?? []) as Array<{ text: string; onPress?: () => void }> };
}

describe('Close Friends — a failed handle lookup is not "Not found"', () => {
  it('C1. a failed search says the lookup failed, offers Retry, and Retry adds the friend', async () => {
    searchReplies = [FAILED, { status: 200, body: { users: [user('u-ali', 'ali')] } }];
    ui = await render(<CloseFriendsScreen />);
    await add('@ali');
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const a = lastAlert();
    expect(a.title).not.toBe('Not found');
    expect(a.message).not.toMatch(/No traveler found/);
    expect(a.title).toMatch(/couldn.t look up/i);
    const retry = a.buttons.find((b) => b.text === 'Retry');
    expect(retry).toBeTruthy();
    await act(async () => { retry!.onPress!(); });
    await waitFor(() => expect(added).toEqual(['u-ali']));
  });

  it('C2. an unreachable network is the same failed lookup, not "Not found"', async () => {
    searchReplies = [new TypeError('Network request failed')];
    ui = await render(<CloseFriendsScreen />);
    await add('@ali');
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(lastAlert().title).toMatch(/couldn.t look up/i);
    expect(added).toEqual([]);
  });

  it('C3. a genuine miss still says "Not found"', async () => {
    searchReplies = [{ status: 200, body: { users: [] } }];
    ui = await render(<CloseFriendsScreen />);
    await add('@nobody');
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(lastAlert().title).toBe('Not found');
    expect(added).toEqual([]);
  });

  it('C4. "@ali" adds @ali — not the first fuzzy match (@alison)', async () => {
    searchReplies = [{ status: 200, body: { users: [user('u-alison', 'alison'), user('u-ali', 'Ali')] } }];
    ui = await render(<CloseFriendsScreen />);
    await add('@ali');
    await waitFor(() => expect(added).toEqual(['u-ali']));
  });

  it('C5. fuzzy matches without the exact handle are "Not found", never someone else added', async () => {
    searchReplies = [{ status: 200, body: { users: [user('u-alison', 'alison')] } }];
    ui = await render(<CloseFriendsScreen />);
    await add('@ali');
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(lastAlert().title).toBe('Not found');
    expect(added).toEqual([]);
  });
});
