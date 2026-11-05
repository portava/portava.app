/**
 * close-friends.removeAndLoadHonesty.component.test.tsx
 *
 * Close Friends (Trusted Crew) decides who sees Close Friends stories, so the
 * list on screen has to be the list on the server.
 *
 * THE DEFECTS
 *  1. A failed list read showed "No Close Friends yet".
 *  2. Remove dropped the row whatever DELETE answered, so a failed remove
 *     looked done while that person could still see the stories.
 *
 * Driven through the real stories service; only `fetch` is faked.
 *
 * Run: pnpm --dir travel-buddy-standalone exec jest app/__tests__/close-friends.removeAndLoadHonesty.component.test.tsx
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

const ANA = { userId: 'u-ana', handle: 'ana', name: 'Ana', avatarUrl: null, addedAt: '2026-10-01T00:00:00Z' };
let listReplies: Array<{ status: number; body: unknown }> = [];
let deleteStatus = 204;
const fetchMock = jest.fn();
let alertSpy: jest.SpyInstance;

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });

beforeEach(() => {
  deleteStatus = 204;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/api/users/me/close-friends' && (!init?.method || init.method === 'GET')) {
      const r = listReplies.length > 1 ? listReplies.shift()! : listReplies[0];
      return { ok: r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
    }
    if (u.pathname.startsWith('/api/users/me/close-friends/') && init?.method === 'DELETE') {
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({}) } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  (globalThis as any).fetch = fetchMock;
  // Press the destructive button of whatever confirm is shown; record the rest.
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
    buttons?.find((b) => b.style === 'destructive')?.onPress?.();
  });
});

afterEach(() => alertSpy.mockRestore());

describe('Close Friends — the list on screen is the list on the server', () => {
  it('R1. a failed list read says so, not "No Close Friends yet", and Try again loads it', async () => {
    listReplies = [{ status: 503, body: {} }, { status: 200, body: { closeFriends: [ANA] } }];
    const ui = await render(<CloseFriendsScreen />);
    await waitFor(() => expect(ui.getByTestId('close-friends-error')).toBeTruthy());
    expect(ui.queryByText('No Close Friends yet')).toBeNull();
    await act(async () => { fireEvent.press(ui.getByText('Try again')); });
    await waitFor(() => expect(ui.getByText('Ana')).toBeTruthy());
  });

  it('R2. a failed remove keeps the row and says they can still see the stories', async () => {
    listReplies = [{ status: 200, body: { closeFriends: [ANA] } }];
    deleteStatus = 500;
    const ui = await render(<CloseFriendsScreen />);
    await waitFor(() => expect(ui.getByText('Ana')).toBeTruthy());
    await act(async () => { fireEvent.press(ui.getByLabelText('Remove Ana')); });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));
    expect(alertSpy.mock.calls[1][0]).toBe('Not removed');
    expect(ui.getByText('Ana')).toBeTruthy();
  });

  it('R3. control: a remove the server confirms drops the row', async () => {
    listReplies = [{ status: 200, body: { closeFriends: [ANA] } }];
    const ui = await render(<CloseFriendsScreen />);
    await waitFor(() => expect(ui.getByText('Ana')).toBeTruthy());
    await act(async () => { fireEvent.press(ui.getByLabelText('Remove Ana')); });
    await waitFor(() => expect(ui.queryByText('Ana')).toBeNull());
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });
});
