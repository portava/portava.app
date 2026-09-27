/**
 * GemsItemOverlay — the bottom content ends above the floating tab bar
 * (census-media §40.12).
 *
 * The Gems page fills the screen and the tab bar's pill floats over its
 * bottom: 12 above insets.bottom, 64 tall (NAV_BAR_FILLER_HEIGHT = 64 + 12 +
 * 20 clearance). The bottom content's paddingBottom was BOTTOM_SAFE +
 * space.md (28 on web and Android), so the creator's handle, the Follow
 * button's lower half and the caption were drawn under the pill (the web
 * probe: handle y 755–770, caption y 781–814, pill from y 768 at 390×844).
 *
 * Pinned here: the paddingBottom is useLayoverAwareBottomInset() — the app's
 * own clearance for tab surfaces (hooks/useBottomInset.ts, Tier 1) — so the
 * content's bottom edge is at least 8 px above the pill's top (and above the
 * layover pill when a layover session shows it), for insets 0, 34 and 48.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — each case sets the insets it is about.
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentional exhaustive stub — the layover session is the other input
// of useLayoverAwareBottomInset; each case sets it.
let mockLayoverSession: object | null = null;
jest.mock('../../../context/LayoverSessionContext.tsx', () => ({
  useLayoverSessionContext: () => ({ session: mockLayoverSession }),
}));

// NOTE: intentional exhaustive stub — the scrim is decoration.
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: (props: object) => <View {...props} /> };
});

// NOTE: intentional exhaustive stub — the quick-action chips are content, not under test.
jest.mock('../../PlaceQuickActions.tsx', () => ({
  PlaceQuickActions: () => null,
}));

import { GemsItemOverlay } from '../GemsItemOverlay.tsx';
import type { GemsFeedItem } from '../../../hooks/useGemsFeed.ts';
import { LAYOVER_PILL_BOTTOM_OFFSET, LAYOVER_PILL_HEIGHT } from '../../layover/layoverPillGeometry.ts';

function makeGem(): GemsFeedItem {
  return {
    id: 'gem-1', sourceType: 'gem', gemId: 'gem-1-gem',
    caption: 'Ask at the desk for the back staircase: no queue.',
    tags: [], createdAt: '2026-09-15T09:00:00.000Z',
    creator: { id: 'c-1', username: 'maya.okafor', displayName: 'Maya Okafor', avatarUrl: null, isPrivate: false, isVerified: false, followersCount: null, followingCount: null, bio: null },
    media: [{ id: 'm-1', type: 'image', url: 'https://example.com/a.jpg', thumbnailUrl: null, provenanceLabel: null }],
    stats: { viewCount: 5400, likeCount: 212, saveCount: 64, commentCount: 18 },
    location: { name: 'Palácio da Luz — the back staircase', city: 'Lisbon', country: 'Portugal', canonicalPlaceId: 'place-1', placeType: 'culture', isVerified: true, lat: 38.7, lng: -9.1 },
    viewerState: { hasLiked: false, hasSaved: false, isFollowingCreator: false, hasFollowRequestPending: false },
  };
}

// The tab bar's pill: 12 above the inset and 64 tall (NAV_BAR_FILLER_HEIGHT's own
// breakdown in hooks/useNavBarCollapse.ts; the web probe measured y 768–832 at 390×844), and
// the layover pill that sits above it during a layover session.
const TAB_PILL_TOP = (insetBottom: number) => insetBottom + 12 + 64;
const LAYOVER_PILL_TOP = (insetBottom: number) => insetBottom + LAYOVER_PILL_BOTTOM_OFFSET + LAYOVER_PILL_HEIGHT;

beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  mockLayoverSession = null;
});

describe('GemsItemOverlay — the bottom content ends above the floating tab bar', () => {
  const cases: Array<[string, number, boolean]> = [
    ['no inset', 0, false],
    ['iOS home indicator (34)', 34, false],
    ['Android three-button bar (48)', 48, false],
    ['no inset, layover pill', 0, true],
    ['iOS home indicator (34), layover pill', 34, true],
  ];
  it.each(cases)('%s', async (_name, insetBottom, layover) => {
    mockInsets = { top: 0, bottom: insetBottom, left: 0, right: 0 };
    mockLayoverSession = layover ? { id: 'layover-1' } : null;
    await render(<GemsItemOverlay item={makeGem()} onSave={() => {}} onShare={() => {}} onMore={() => {}} />);
    const bottom = screen.getByTestId('gems-bottom-content');
    const bs = StyleSheet.flatten(bottom.props.style);
    expect(typeof bs.paddingBottom).toBe('number');
    // The bottom content is anchored to the screen's bottom edge (justifyContent
    // flex-end on the full-screen overlay), so its paddingBottom is how far its
    // lowest line sits above that edge.
    const overlay = StyleSheet.flatten((bottom.parent as typeof bottom).props.style);
    expect(overlay.justifyContent).toBe('flex-end');
    expect(bs.paddingBottom as number).toBeGreaterThanOrEqual(TAB_PILL_TOP(insetBottom) + 8);
    if (layover) expect(bs.paddingBottom as number).toBeGreaterThanOrEqual(LAYOVER_PILL_TOP(insetBottom) + 8);
    // The content is still inside the block, with its measured 0.81 backing.
    expect(bs.backgroundColor).toBe('rgba(0,0,0,0.81)');
    expect(screen.getByText('Ask at the desk for the back staircase: no queue.')).toBeTruthy();
  });
});
