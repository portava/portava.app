/**
 * WatchFeed — "Following" is offered only while the server serves it, and the toggle clears the overlay header.
 *
 * Two defects on the owner's iPhone (2026-10-22):
 *   - the For You / Following toggle offered Following while MEDIA_FOLLOWING_ENABLED is OFF in production; the
 *     server refused with feature_disabled and the feed's error screen (Retry only) had no way back to For You;
 *   - the toggle bar sat at `top: 0` + 12pt padding (y 12–44pt): behind the Dynamic Island and under the media
 *     tab's overlay header (app/(tabs)/media.tsx tints 0 to getOverlayHeaderTotalHeight(insets.top)).
 *   F1  flag off → no toggle, no "Following" anywhere;
 *   F2  flag off with the selection on Following → moved back to For You;
 *   F3  flag on → both offered, and the bar's top clears the overlay header AND the mode selector under it
 *       (GemsFeed's filter-bar clearance) with a 62pt top inset;
 *   F4  flag on, a feed that failed → the error screen still offers the toggle (a way back).
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';

import { WatchFeed } from '../WatchFeed.tsx';
import { getOverlayHeaderTotalHeight } from '../../ui/AppHeader.tsx';

const INSET_TOP = 62; // an iPhone with a Dynamic Island
const MODE_SELECTOR_BOTTOM = getOverlayHeaderTotalHeight(INSET_TOP) + 4 + 44; // media.tsx: the pill sits 4pt under the header, 44pt tall

const mockFlagsOn = new Set<string>();
// NOTE: intentionally exhaustive — the feed reads one flag through the context; the provider fetches over HTTP.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlagsOn.has(k), loading: false }),
}));

// NOTE: intentionally exhaustive — the inset is the input under test (a Dynamic Island's 62pt).
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));

const mockFeed = {
  feedType: 'for_you' as 'for_you' | 'following',
  setFeedType: jest.fn(),
  items: [] as Array<{ id: string }>,
  loading: false,
  error: null as string | null,
  activeIndex: 0,
  setActiveIndex: jest.fn(),
  loadFeed: jest.fn(),
  loadMore: jest.fn(),
  setItemCommentCount: jest.fn(),
};
// NOTE: intentionally exhaustive — the feed's state is the input here; the real hook fetches over HTTP.
jest.mock('../../../hooks/useWatchFeed.ts', () => ({ useWatchFeed: () => mockFeed }));
// NOTE: intentionally exhaustive — saves are not under test.
jest.mock('../../../hooks/useMediaSave.ts', () => ({
  useMediaSave: () => ({ savedSet: new Set<string>(), seed: jest.fn(), toggleSave: jest.fn() }),
}));
// NOTE: intentionally exhaustive — the viewer is not under test.
jest.mock('../../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: 'u-1' }) }));
// NOTE: intentionally exhaustive — the video list (native players) is not under test.
jest.mock('../WatchFeedList.tsx', () => ({ WatchFeedList: () => null }));
// NOTE: intentionally exhaustive — the sheets are closed.
jest.mock('../MediaCommentSheet.tsx', () => ({ MediaCommentSheet: () => null }));
// NOTE: intentionally exhaustive — the sheets are closed.
jest.mock('../MediaMoreMenu.tsx', () => ({ MediaMoreMenu: () => null }));
// NOTE: intentionally exhaustive — the sheets are closed.
jest.mock('../WhyThisSheet.tsx', () => ({ WhyThisSheet: () => null }));

/** The absolutely positioned host the toggle floats in — found from its label, so no testID is assumed. */
function toggleBarTop(): unknown {
  let node: any = screen.getByText('For You');
  while (node && StyleSheet.flatten(node.props?.style)?.position !== 'absolute') node = node.parent;
  return node ? StyleSheet.flatten(node.props.style).top : undefined;
}

beforeEach(() => {
  mockFlagsOn.clear();
  jest.clearAllMocks();
  Object.assign(mockFeed, { feedType: 'for_you', items: [{ id: 'v1' }], loading: false, error: null });
});

describe('WatchFeed — MEDIA_FOLLOWING_ENABLED gate', () => {
  it('F1: flag off → no toggle and no "Following"', async () => {
    await render(<WatchFeed />);
    expect(screen.queryByText('Following')).toBeNull();
    expect(screen.queryByTestId('watch-feed-toggle-bar')).toBeNull();
  });

  it('F2: flag off with the selection on Following → moved back to For You', async () => {
    mockFeed.feedType = 'following';
    mockFeed.items = [];
    mockFeed.error = 'feature_disabled';
    await render(<WatchFeed />);
    expect(mockFeed.setFeedType).toHaveBeenCalledWith('for_you');
    expect(screen.queryByText('Following')).toBeNull();
  });

  it('F3: flag on → both offered, and the bar clears the overlay header and the mode selector', async () => {
    mockFlagsOn.add('MEDIA_FOLLOWING_ENABLED');
    await render(<WatchFeed />);
    expect(screen.getByText('For You')).toBeTruthy();
    await fireEvent.press(screen.getByText('Following'));
    expect(mockFeed.setFeedType).toHaveBeenCalledWith('following');
    const top = toggleBarTop();
    expect(typeof top).toBe('number');
    expect(top as number).toBeGreaterThanOrEqual(MODE_SELECTOR_BOTTOM);
  });

  it('F3b: the empty feed draws its toggle at the same cleared position', async () => {
    mockFlagsOn.add('MEDIA_FOLLOWING_ENABLED');
    mockFeed.items = [];
    await render(<WatchFeed />);
    const top = toggleBarTop();
    expect(typeof top).toBe('number');
    expect(top as number).toBeGreaterThanOrEqual(MODE_SELECTOR_BOTTOM);
  });

  it('F4: flag on, the Following feed failed → the error screen still offers a way back to For You', async () => {
    mockFlagsOn.add('MEDIA_FOLLOWING_ENABLED');
    Object.assign(mockFeed, { feedType: 'following', items: [], error: 'HTTP 500' });
    await render(<WatchFeed />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    await fireEvent.press(screen.getByText('For You'));
    expect(mockFeed.setFeedType).toHaveBeenCalledWith('for_you');
  });
});
