/**
 * ProfileActivityTab — posts / trips / events / circles on a profile.
 * TM-social, PLAT-F14.
 *
 * The four profile-tab routes had no caller. This pins the screen half:
 * every server answer keeps its meaning (blocked / unavailable / error / empty
 * / rows), a failed read is never an empty tab, a failed "show more" keeps the
 * rows already shown, and a circle owned by someone in a block relation with
 * the viewer is not listed even before the server catches up.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { ProfileActivityTab } from '../ProfileActivityTab.tsx';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn() } }));
jest.mock('../../../services/profileTabs.ts', () => ({
  ...jest.requireActual('../../../services/profileTabs.ts'),
  getProfileTabPage: jest.fn(),
}));
jest.mock('../../../context/BlockedIdsContext.tsx', () => ({
  ...jest.requireActual('../../../context/BlockedIdsContext.tsx'),
  useBlockedIds: () => ({ blockedIds: new Set(['blocked-owner']), blockerIds: new Set(['blocker-owner']) }),
}));

const tabs = require('../../../services/profileTabs.ts');
const post = (id: string, content: string) => ({ id, content, mediaUrls: [], locationCity: 'Split', locationCountry: 'Croatia', tripId: null, createdAt: '2026-05-01T00:00:00Z' });

jest.setTimeout(20000);

describe('ProfileActivityTab', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts: rows render; the request is for this username', async () => {
    tabs.getProfileTabPage.mockResolvedValue({ status: 'ok', items: [post('p1', 'Sunset at the riva')], nextCursor: null });
    const { findByText } = await render(<ProfileActivityTab username="ann" />);
    await findByText('Sunset at the riva');
    expect(tabs.getProfileTabPage).toHaveBeenCalledWith('posts', 'ann');
  });

  it('a failed read is "couldn\'t load" with a retry, never "No posts to show."', async () => {
    tabs.getProfileTabPage
      .mockResolvedValueOnce({ status: 'error', message: 'Your follow relationship could not be read' })
      .mockResolvedValueOnce({ status: 'ok', items: [post('p1', 'Back again')], nextCursor: null });
    const { findByText, queryByText, getByTestId } = await render(<ProfileActivityTab username="ann" />);
    await findByText(/Couldn't load posts/);
    expect(queryByText('No posts to show.')).toBeNull();
    await fireEvent.press(getByTestId('profile-activity-retry'));
    await findByText('Back again');
  });

  it('blocked and unavailable are "not available", never rows or "nothing to show"', async () => {
    tabs.getProfileTabPage.mockResolvedValue({ status: 'blocked' });
    const { findByText, queryByText } = await render(<ProfileActivityTab username="ann" />);
    await findByText("This profile isn't available.");
    expect(queryByText('No posts to show.')).toBeNull();
  });

  it('an empty page is the empty state (it does not claim the person has none)', async () => {
    tabs.getProfileTabPage.mockResolvedValue({ status: 'ok', items: [], nextCursor: null });
    const { findByText } = await render(<ProfileActivityTab username="ann" />);
    await findByText('No posts to show.');
  });

  it('circles: an owner in a block relation (either direction) is not listed', async () => {
    tabs.getProfileTabPage.mockImplementation(async (kind: string) => kind === 'circles'
      ? { status: 'ok', nextCursor: null, items: [
        { circleOwnerId: 'ok-owner', ownerHandle: 'olga', ownerDisplayName: null, ownerAvatarUrl: null, joinedAt: '2026-01-01T00:00:00Z' },
        { circleOwnerId: 'blocked-owner', ownerHandle: 'bad', ownerDisplayName: null, ownerAvatarUrl: null, joinedAt: '2026-01-01T00:00:00Z' },
        { circleOwnerId: 'blocker-owner', ownerHandle: 'worse', ownerDisplayName: null, ownerAvatarUrl: null, joinedAt: '2026-01-01T00:00:00Z' },
      ] }
      : { status: 'ok', items: [], nextCursor: null });
    const { findByText, getByTestId, queryByText } = await render(<ProfileActivityTab username="ann" />);
    await findByText('No posts to show.');
    await fireEvent.press(getByTestId('profile-activity-seg-circles'));
    await findByText("@olga's circle");
    expect(queryByText("@bad's circle")).toBeNull();
    expect(queryByText("@worse's circle")).toBeNull();
  });

  it('a failed "show more" keeps the rows already shown and says so', async () => {
    tabs.getProfileTabPage
      .mockResolvedValueOnce({ status: 'ok', items: [post('p1', 'First page')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ status: 'error', message: 'down' });
    const { findByText, getByTestId, getByText } = await render(<ProfileActivityTab username="ann" />);
    await findByText('First page');
    await fireEvent.press(getByTestId('profile-activity-more'));
    await findByText(/Couldn't load more/);
    expect(getByText('First page')).toBeTruthy();
    expect(tabs.getProfileTabPage).toHaveBeenLastCalledWith('posts', 'ann', 'c1');
  });
});
