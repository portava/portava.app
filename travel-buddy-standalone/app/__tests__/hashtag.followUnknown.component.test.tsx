/**
 * census-discovery §113 (DV-83 round 16 sweep, D-W11X2-137): the hashtag page never shows a failed follow read as
 * "Follow" (not following). GET /hashtags/:slug now answers `isFollowing: null` over a failed read; the page said
 * "Follow" for a viewer who follows the tag.
 *
 *   HF1  isFollowing null → "Can't check follow", never "Follow" or "Following"
 *   HF2  tapping it follows (idempotent server-side) and then says "Following"
 *   HF3  after a toggle the follow state is known: follow, then unfollow → "Follow"
 *   HFc  CONTROL: false → "Follow"; true → "Following"
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import HashtagFeedScreen from '../hashtag/[slug].tsx';

// NOTE: intentionally exhaustive — the real expo-router pulls in native navigation bindings.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => ({ slug: 'romejazz' }),
  usePathname: () => '/hashtag/romejazz',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
  Stack: { Screen: () => null },
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentionally exhaustive — the screen reads only the current city.
jest.mock('../../src/context/LocationContext', () => ({
  useLocationContext: () => ({ locationState: { place: { city: null } } }),
}));
// NOTE: intentionally exhaustive — the collapse handler needs Reanimated.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => undefined,
  NavBarFiller: () => null,
}));
// NOTE: intentionally exhaustive — the save button reads the saves context, which is not under test.
jest.mock('../../src/components/SaveButton', () => ({ SaveButton: () => null }));

const mockGetHashtag = jest.fn();
const mockGetFeed = jest.fn();
const mockFollow = jest.fn(); const mockUnfollow = jest.fn();
jest.mock('../../src/services/hashtag', () => ({
  ...jest.requireActual('../../src/services/hashtag'),
  getHashtag: (...a: unknown[]) => mockGetHashtag(...(a as [])),
  getHashtagFeed: (...a: unknown[]) => mockGetFeed(...(a as [])),
  followHashtag: (...a: unknown[]) => mockFollow(...(a as [])),
  unfollowHashtag: (...a: unknown[]) => mockUnfollow(...(a as [])),
}));

const META = { id: 'ht-1', slug: 'romejazz', name: 'romejazz', usageCount: 3, isFollowing: false, topCity: null, createdAt: '2026-09-01T00:00:00Z' };
const page = (tab: string) => ({ ok: true, data: { items: [], posts: [], hasMore: false, nextCursor: null, tab, scope: 'global' } });

beforeEach(() => { jest.clearAllMocks(); mockGetFeed.mockImplementation(async (_s: string, tab: string) => page(tab)); mockFollow.mockResolvedValue({ ok: true }); mockUnfollow.mockResolvedValue({ ok: true }); });

describe('hashtag page — the follow state over a failed read (§113, D-W11X2-137)', () => {
  it("HF1 isFollowing null → \"Can't check follow\", never Follow or Following", async () => {
    mockGetHashtag.mockResolvedValue({ ok: true, data: { ...META, isFollowing: null } });
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText("Can't check follow")).not.toBeNull());
    expect(view.queryByText('Follow')).toBeNull();
    expect(view.queryByText('Following')).toBeNull();
  });
  it('HF2 tapping it follows and then says Following', async () => {
    mockGetHashtag.mockResolvedValue({ ok: true, data: { ...META, isFollowing: null } });
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText("Can't check follow")).not.toBeNull());
    await act(async () => { fireEvent.press(view.getByText("Can't check follow")); });
    expect(mockFollow).toHaveBeenCalledWith('romejazz');
    await waitFor(() => expect(view.queryByText('Following')).not.toBeNull());
  });
  it('HF3 follow, then unfollow → "Follow" (the state is known after a toggle)', async () => {
    mockGetHashtag.mockResolvedValue({ ok: true, data: { ...META, isFollowing: null } });
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText("Can't check follow")).not.toBeNull());
    await act(async () => { fireEvent.press(view.getByText("Can't check follow")); });
    await waitFor(() => expect(view.queryByText('Following')).not.toBeNull());
    await act(async () => { fireEvent.press(view.getByText('Following')); });
    await waitFor(() => expect(view.queryByText('Follow')).not.toBeNull());
  });
  it('HFc CONTROL: false → Follow; true → Following', async () => {
    mockGetHashtag.mockResolvedValue({ ok: true, data: META });
    const a = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(a.queryByText('Follow')).not.toBeNull());
    a.unmount();
    mockGetHashtag.mockResolvedValue({ ok: true, data: { ...META, isFollowing: true } });
    const b = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(b.queryByText('Following')).not.toBeNull());
  });
});
