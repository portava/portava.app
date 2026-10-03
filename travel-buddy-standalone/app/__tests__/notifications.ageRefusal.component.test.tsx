/**
 * Activity Center → Requests — an age refusal of a circle invite is NAMED
 * (census-trust §31, TV-5b).
 *
 * The server refuses a circle-invite acceptance from someone outside the
 * circle's age limit with 403 `{ error: "age_not_eligible", reason, message }`
 * (routes/requests.ts through lib/gateAge.ts). Before §31 the screen's age
 * branch tested `res.reason === 'age_not_eligible'` — the ERROR code, which the
 * reason never is — so every age refusal but `dob_missing` reached an alert
 * titled "Error", the verified-minor refusal included.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, render, waitFor, screen, fireEvent, cleanup } from '@testing-library/react-native';
import { router } from 'expo-router';
import ActivityCenter from '../notifications.tsx';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — useNavBarCollapse calls makeMutable() at
// module scope (outside React), which is not supported under Jest.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => undefined,
  NavBarFiller: () => null,
}));

// NOTE: usePosts exports the TTL constant used by the focus-effect gate.
jest.mock('../../src/hooks/usePosts', () => ({
  FEED_FOCUS_TTL_MS: 0,
}));

// NOTE: intentionally exhaustive — useNotifications polls Supabase and SSE.
jest.mock('../../src/hooks/useNotifications', () => ({
  useNotifications: jest.fn(),
}));

// NOTE: intentionally exhaustive — useRequests fetches from the API server.
jest.mock('../../src/hooks/useRequests', () => ({
  useRequests: jest.fn(),
}));

// NOTE: intentionally exhaustive — the two calls the Requests pane makes.
jest.mock('../../src/services/requests', () => ({
  acceptRequest:  jest.fn(),
  declineRequest: jest.fn(),
}));

// NOTE: intentionally exhaustive — UserAvatarButton uses an Image that
// requires native modules not available under Jest.
jest.mock('../../src/components/interaction/UserAvatarButton', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    UserAvatarButton: () => React.createElement(View, { testID: 'user-avatar-btn' }),
  };
});

// NOTE: intentionally exhaustive — UserNameButton uses Pressable + router.
jest.mock('../../src/components/interaction/UserNameButton', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    UserNameButton: ({ handle }: { handle?: string }) => React.createElement(Text, null, handle ?? ''),
  };
});

// NOTE: displayIdentity may import native modules via the locale utils.
jest.mock('../../src/lib/displayIdentity', () => ({
  secondaryIdentityText: () => null,
}));

import { useNotifications } from '../../src/hooks/useNotifications.ts';
import { useRequests } from '../../src/hooks/useRequests.ts';
import { acceptRequest } from '../../src/services/requests.ts';
import type { InboxItem } from '../../src/services/requests.ts';

const mockUseNotifications = useNotifications as jest.Mock;
const mockUseRequests = useRequests as jest.Mock;
const mockAccept = acceptRequest as jest.Mock;

const CIRCLE_INVITE = {
  id: 'inv-1',
  type: 'circle_invite',
  direction: 'incoming',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00Z',
  actor: { id: 'owner-1', handle: 'circle_owner', name: 'Circle Owner', avatarUrl: null },
  targetName: null,
} as unknown as InboxItem;

beforeEach(() => {
  mockUseNotifications.mockReturnValue({
    notifications: [], loading: false, loadingMore: false, unreadCount: 0,
    reload: jest.fn(), loadMore: jest.fn(), markRead: jest.fn(), markAllRead: jest.fn(), dismiss: jest.fn(),
  });
  mockUseRequests.mockReturnValue({ incoming: [CIRCLE_INVITE], loading: false, reload: jest.fn() });
});

afterEach(async () => {
  cleanup();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  // Flush pending scheduler work so it cannot bleed into the next test's render.
  await act(async () => {});
});

async function acceptTheInvite() {
  await render(<ActivityCenter />);
  await waitFor(() => expect(screen.getByText('Requests')).toBeTruthy());
  await fireEvent.press(screen.getByText('Requests'));
  await waitFor(() => expect(screen.getByText('Accept')).toBeTruthy());
  await fireEvent.press(screen.getByText('Accept'));
  await waitFor(() => expect(mockAccept).toHaveBeenCalledWith('circle_invite', 'inv-1'));
}

describe('Requests — census-trust §31 (TV-5b): circle-invite age refusals are named', () => {
  it('a VERIFIED MINOR is told the identity check did not confirm 18+, not "Error"', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockAccept.mockResolvedValue({
      ok: false, data: null, reason: 'not_verified_adult',
      message: 'Your identity check did not confirm that you are 18 or over, so this is not available to you.',
    });
    await acceptTheInvite();
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    const [title, body, buttons] = alert.mock.calls[0]!;
    expect(title).toBe('Age requirement');
    expect(body).toMatch(/didn't confirm that you're 18 or over, so you can't join this circle/i);
    expect(buttons).toBeUndefined();
  });

  it("outside the circle's limit is an AGE LIMIT, in the server's own sentence", async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockAccept.mockResolvedValue({
      ok: false, data: null, reason: 'above_max_age',
      message: 'This circle is for users aged 30 or under.',
    });
    await acceptTheInvite();
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(alert.mock.calls[0]![0]).toBe('Age limit');
    expect(alert.mock.calls[0]![1]).toBe('This circle is for users aged 30 or under.');
  });

  it('a missing date of birth still offers the profile', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const push = jest.spyOn(router, 'push');
    mockAccept.mockResolvedValue({ ok: false, data: null, reason: 'dob_missing', message: 'x y' });
    await acceptTheInvite();
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    const [title, , buttons] = alert.mock.calls[0]!;
    expect(title).toBe('Date of birth required');
    const go = (buttons as Array<{ text: string; onPress?: () => void }>).find((b) => b.text === 'Go to profile');
    expect(go).toBeTruthy();
    go!.onPress!();
    expect(push).toHaveBeenCalledWith('/profile/edit');
  });

  it('CONTROL — a refusal that is not about age keeps the "Error" alert', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockAccept.mockResolvedValue({ ok: false, data: null, errorKind: 'db_error', message: 'Invite expired' });
    await acceptTheInvite();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Error', 'Invite expired'));
  });
});
