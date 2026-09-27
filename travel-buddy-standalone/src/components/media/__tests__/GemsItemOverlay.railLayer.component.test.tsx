/**
 * GemsItemOverlay — the action rail's layer and position (census-media §40).
 *
 * ## What H8's renders showed
 *
 * Lane S rendered the Gems feed on the web export. Two defects sat under the
 * rail, both reproduced by a hit-test probe (elementFromPoint at each rail
 * control's centre):
 *
 *   1. The bottom content (place block, creator row, caption) is a LATER
 *      sibling of the absolutely positioned rail and carries a full-width
 *      0.81 backing (§31.12). Siblings paint in tree order on web and on
 *      native, so the block was drawn over the rail's lower half: Stamp,
 *      Save, Share and ⋯ read dark grey on black and a tap on them landed on
 *      the block. The tap half predates the backing; the dimming did not.
 *   2. The Media tab's FAB (app/(tabs)/media.tsx `fab`) floats over the same
 *      right edge. The rail's bottom sat at BOTTOM_SAFE + 120, inside the
 *      FAB's box, so a tap on ⋯ landed on the FAB.
 *
 * ## What this pins
 *
 *   1. The rail is drawn above the bottom content: both are children of the
 *      overlay root, the rail is absolutely positioned with a zIndex above
 *      the bottom content's, and every rail control is inside the rail.
 *   2. The rail's bottom edge clears the FAB's top edge, computed from the
 *      FAB's own geometry (read from media.tsx below), for a zero and an iOS
 *      home-indicator inset, with and without an active layover session
 *      (the layover pill lifts the FAB, and the rail must follow it).
 *   3. The FAB geometry (2) assumes is still media.tsx's: a source needle, so
 *      moving the FAB turns this file red instead of silently re-covering ⋯.
 *
 * Contrast is measured elsewhere (src/features/media/__tests__/
 * mediaContrast.test.ts); this file is about layers and boxes only.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — only the bottom inset matters here; the
// test sets it per case through mockInsets.
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentional exhaustive stub — the layover session is the one input of
// useLayoverAwareBottomInset besides the inset; the test switches it per case.
let mockLayoverSession: object | null = null;
jest.mock('../../../context/LayoverSessionContext.tsx', () => ({
  useLayoverSessionContext: () => ({ session: mockLayoverSession }),
}));

// NOTE: intentional exhaustive stub — the scrim is decoration, not a layer
// this test measures.
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: (props: object) => <View {...props} /> };
});

// NOTE: intentional exhaustive stub — the quick-action chips' own behaviour
// (trip picker, calendar, maps) is not under test; they are content inside
// the bottom block, which is all that matters here.
jest.mock('../../PlaceQuickActions.tsx', () => ({
  PlaceQuickActions: () => null,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { GemsItemOverlay } from '../GemsItemOverlay.tsx';
import type { GemsFeedItem } from '../../../hooks/useGemsFeed.ts';
import { NAV_BAR_FILLER_HEIGHT } from '../../../hooks/useNavBarCollapse.ts';
import {
  LAYOVER_PILL_BOTTOM_OFFSET,
  LAYOVER_PILL_HEIGHT,
} from '../../layover/layoverPillGeometry.ts';
import { avatar } from '../../../theme/tokens.ts';

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeGem(): GemsFeedItem {
  return {
    id: 'gem-1',
    sourceType: 'gem',
    gemId: 'gem-1-gem',
    caption: 'The staircase everyone photographs, and the one everyone should.',
    tags: [],
    createdAt: '2026-09-15T09:00:00.000Z',
    creator: {
      id: 'creator-1', username: 'maya.okafor', displayName: 'Maya Okafor', avatarUrl: null,
      isPrivate: false, isVerified: false, followersCount: null, followingCount: null, bio: null,
    },
    media: [{ id: 'm-1', type: 'image', url: 'https://example.com/a.jpg', thumbnailUrl: null, provenanceLabel: null }],
    stats: { viewCount: 5400, likeCount: 212, saveCount: 64, commentCount: 18 },
    location: {
      name: 'Palácio da Luz — the back staircase', city: 'Lisbon', country: 'Portugal',
      canonicalPlaceId: 'place-1', placeType: 'culture', isVerified: true, lat: 38.7, lng: -9.1,
    },
    viewerState: { hasLiked: false, hasSaved: false, isFollowingCreator: false, hasFollowRequestPending: false },
  };
}

async function renderOverlay() {
  return await render(
    <GemsItemOverlay item={makeGem()} onSave={() => {}} onShare={() => {}} onMore={() => {}} onComment={() => {}} />,
  );
}

// The FAB, as app/(tabs)/media.tsx draws it (needles below keep this honest).
const FAB_OFFSET = 16;
const FAB_SIZE = avatar.s52;
function fabTop(insetBottom: number, layover: boolean): number {
  const bottomInset = layover
    ? insetBottom + LAYOVER_PILL_BOTTOM_OFFSET + LAYOVER_PILL_HEIGHT + 16
    : NAV_BAR_FILLER_HEIGHT + insetBottom;
  return bottomInset + FAB_OFFSET + FAB_SIZE;
}

beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  mockLayoverSession = null;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GemsItemOverlay — the rail is drawn above the place block', () => {
  it('rail and bottom content are siblings, and the rail is the upper layer', async () => {
    await renderOverlay();
    const rail = screen.getByTestId('gems-action-rail');
    const bottom = screen.getByTestId('gems-bottom-content');
    // Same parent, so zIndex decides their order (and tree order breaks a tie).
    expect(rail.parent).toBe(bottom.parent);
    const rs = StyleSheet.flatten(rail.props.style);
    const bs = StyleSheet.flatten(bottom.props.style);
    expect(rs.position).toBe('absolute');
    expect(typeof rs.zIndex).toBe('number');
    expect(rs.zIndex as number).toBeGreaterThan((bs.zIndex as number | undefined) ?? 0);
    // The bottom content keeps its measured backing (the fix is a layer, not a colour).
    expect(bs.backgroundColor).toBe('rgba(0,0,0,0.81)');
    expect(rs.backgroundColor).toBe('rgba(0,0,0,0.89)');
  });

  it('every rail control is inside the rail, none inside the bottom content', async () => {
    await renderOverlay();
    const rail = screen.getByTestId('gems-action-rail');
    const bottom = screen.getByTestId('gems-bottom-content');
    for (const label of ['Stamp', 'Comment', 'Save', 'Share', 'More options']) {
      expect(within(rail).getByLabelText(label)).toBeTruthy();
      expect(within(bottom).queryByLabelText(label)).toBeNull();
    }
  });
});

describe('GemsItemOverlay — the rail clears the Media tab FAB', () => {
  const cases: Array<[string, number, boolean]> = [
    ['no inset, no layover', 0, false],
    ['iOS home indicator (34), no layover', 34, false],
    ['Android three-button bar (48), no layover', 48, false],
    ['no inset, layover pill active', 0, true],
    ['iOS home indicator (34), layover pill active', 34, true],
  ];
  it.each(cases)('%s: the rail bottom is above the FAB top', async (_name, insetBottom, layover) => {
    mockInsets = { top: 0, bottom: insetBottom, left: 0, right: 0 };
    mockLayoverSession = layover ? { id: 'layover-1' } : null;
    await renderOverlay();
    const rs = StyleSheet.flatten(screen.getByTestId('gems-action-rail').props.style);
    expect(typeof rs.bottom).toBe('number');
    // Both are measured from the screen's bottom edge (the overlay fills the
    // gem page, which fills the screen; the FAB is positioned in the screen).
    expect(rs.bottom as number).toBeGreaterThanOrEqual(fabTop(insetBottom, layover) + 4);
  });

  it("media.tsx still draws the FAB with the geometry this file assumes", () => {
    const src = readFileSync(join(__dirname, '../../../../app/(tabs)/media.tsx'), 'utf8');
    expect(src).toContain('const bottomInset = useLayoverAwareBottomInset();');
    expect(src).toContain('{ bottom: bottomInset + 16 },');
    expect(src).toMatch(/fab: \{\s*position: 'absolute',\s*right: 20,\s*width: avatar\.s52, height: avatar\.s52,/);
  });
});
