/**
 * SessionContext sign-out — verifies the personalised compass feed cache is
 * cleared for the outgoing user when signOut() runs, alongside the existing
 * liked/saved cache clears, and that sign-out still succeeds if the clear
 * throws.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { Text, Pressable } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockSvcSignOut = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/auth', () => ({
  getSessionUserId: jest.fn().mockResolvedValue('user-out-1'),
  onAuthChange: jest.fn().mockReturnValue(() => {}),
  signOut: (...args: unknown[]) => mockSvcSignOut(...args),
  ensureProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { role: 'user' } }),
        }),
      }),
    }),
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

jest.mock('../../services/profile', () => ({
  getAccountStatus: jest.fn().mockResolvedValue({
    ok: true,
    data: { accountStatus: 'active', deletionScheduledAt: null },
  }),
}));

jest.mock('../../services/circle', () => ({
  pauseOnSessionEnd: jest.fn().mockResolvedValue(undefined),
}));

const mockClearLiked = jest.fn();
jest.mock('../../services/likedPostsCache', () => ({
  clearForUser: (...args: unknown[]) => mockClearLiked(...args),
  primeLikes: jest.fn(),
}));

const mockClearSaved = jest.fn();
jest.mock('../../services/savedPostsCache', () => ({
  clearForUser: (...args: unknown[]) => mockClearSaved(...args),
  primeSaved: jest.fn(),
}));

jest.mock('../../services/postEngagement', () => ({
  fetchMyLikedPostIds: jest.fn().mockResolvedValue([]),
  fetchMySavedPostIds: jest.fn().mockResolvedValue([]),
}));

const mockClearCachedFeed = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/compass', () => ({
  clearCachedFeed: (...args: unknown[]) => mockClearCachedFeed(...args),
}));

import { SessionProvider, useSession } from '../SessionContext';

// ── Test harness ──────────────────────────────────────────────────────────────

function Harness() {
  const { userId, signOut } = useSession();
  return (
    <>
      <Text testID="uid">{userId ?? 'none'}</Text>
      <Pressable testID="sign-out" onPress={() => { signOut(); }}>
        <Text>Sign out</Text>
      </Pressable>
    </>
  );
}

async function renderSignedIn() {
  render(
    <SessionProvider>
      <Harness />
    </SessionProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('uid').props.children).toBe('user-out-1'));
}

beforeEach(() => {
  mockSvcSignOut.mockClear();
  mockClearCachedFeed.mockClear().mockResolvedValue(undefined);
  mockClearLiked.mockClear();
  mockClearSaved.mockClear();
});

test('signOut clears the outgoing user\'s compass feed cache', async () => {
  await renderSignedIn();

  fireEvent.press(screen.getByTestId('sign-out'));

  await waitFor(() => expect(mockSvcSignOut).toHaveBeenCalled());
  expect(mockClearCachedFeed).toHaveBeenCalledWith('user-out-1');
  expect(mockClearLiked).toHaveBeenCalledWith('user-out-1');
  expect(mockClearSaved).toHaveBeenCalledWith('user-out-1');

  await waitFor(() => expect(screen.getByTestId('uid').props.children).toBe('none'));
});

test('signOut still completes when clearing the feed cache rejects', async () => {
  mockClearCachedFeed.mockRejectedValueOnce(new Error('storage broke'));
  await renderSignedIn();

  fireEvent.press(screen.getByTestId('sign-out'));

  await waitFor(() => expect(mockSvcSignOut).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('uid').props.children).toBe('none'));
});
