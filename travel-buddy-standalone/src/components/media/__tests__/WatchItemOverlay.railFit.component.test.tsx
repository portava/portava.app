/**
 * WatchItemOverlay — the action rail clears the Media tab FAB and fits under
 * the header (census-media §40.11). Render-only cases; the one case driven by a
 * layout event lives in WatchItemOverlay.railFitLayout.component.test.tsx
 * (one event-derived commit per file: .agents/memory/rntl-react19-renderer-budget.md).
 *
 * ## What the renders showed (lane R's probe, web export, 390×844 and 375×667)
 *
 * The rail sat on the overlay's bottom row, 120 px above the screen's bottom
 * edge. The Media tab's FAB floats 16 above useLayoverAwareBottomInset() and is
 * 52 tall, over the same right edge (y 680–732 at 390×844), so a tap at the
 * centre of "More options" landed on the FAB ("Create a post"), with the
 * context overlay (census-media §34) off and on.
 *
 * ## What this pins
 *
 *   1. The rail's bottom edge (the row's bottomPad plus the rail's
 *      marginBottom) is at least 4 px above the FAB's top edge, for insets 0,
 *      34 and 48, with and without a layover pill, flag off and on.
 *   2. The left column is not moved: the row's paddingBottom is still
 *      max(insets.bottom + 100, 120).
 *   3. watchRailGap: space.xl when the rail fits its budget, a smaller gap when
 *      it does not, never under space.xs — at the budgets the probe measured.
 *   4. media.tsx still draws the FAB with the geometry (1) assumes.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — only router.push is needed.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

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

jest.mock('expo-linear-gradient', () => {
  const { View: V } = require('react-native');
  return { LinearGradient: ({ children, ...rest }: any) => <V {...rest}>{children}</V> };
});

// NOTE: intentional stub — follow network/auth is not under test.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({ isFollowing: false, loading: false, toggling: false, followsYou: false, followersCount: 0, followingCount: 0, toggle: jest.fn() }),
}));

// NOTE: exhaustive stub intentional — each case sets the flags it is about.
let mockFlags: Record<string, boolean> = {};
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mockFlags[key] ?? false, loading: false }),
}));

import { WatchItemOverlay, watchRailGap } from '../WatchItemOverlay.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';
import { NAV_BAR_FILLER_HEIGHT } from '../../../hooks/useNavBarCollapse.ts';
import { LAYOVER_PILL_BOTTOM_OFFSET, LAYOVER_PILL_HEIGHT } from '../../layover/layoverPillGeometry.ts';
import { avatar, space } from '../../../theme/tokens.ts';

function makeItem(): MediaFeedItem {
  return {
    id: 'item-1', videoUrl: 'https://example.com/video.mp4', posterUrl: null, duration: null,
    creator: { id: 'creator-1', displayName: 'Jane Doe', username: 'janedoe', avatarUrl: null, isFollowing: false },
    caption: 'Sunset from the pier', hashtags: [],
    place: { id: 'place-abc', name: 'An Thuong', city: 'Da Nang', country: 'Vietnam' },
    linkedEntity: null, audioLabel: null, likeCount: 10, commentCount: 23, saveCount: 31,
    likedByMe: false, savedByMe: false, stampItCount: 44,
  } as MediaFeedItem;
}

async function renderOverlay() {
  await render(
    <WatchItemOverlay
      item={makeItem()} currentUserId="viewer-1" isSaved={false}
      onComment={jest.fn()} onSave={jest.fn()} onMore={jest.fn()}
      stampGroupRef={React.createRef<View>()} stampVisualIsStamped={false} stampVisualCount={5}
      stampButtonStyle={{}} onStampPress={jest.fn()}
    />,
  );
}

// The FAB as app/(tabs)/media.tsx draws it (the needle test below keeps this honest).
function fabTop(insetBottom: number, layover: boolean): number {
  const bottomInset = layover
    ? insetBottom + LAYOVER_PILL_BOTTOM_OFFSET + LAYOVER_PILL_HEIGHT + 16
    : NAV_BAR_FILLER_HEIGHT + insetBottom;
  return bottomInset + 16 + avatar.s52;
}

beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  mockLayoverSession = null;
  mockFlags = {};
});

describe('WatchItemOverlay — the rail clears the Media tab FAB', () => {
  const cases: Array<[string, number, boolean, boolean]> = [
    ['no inset, flag off', 0, false, false],
    ['no inset, flag on', 0, false, true],
    ['iOS home indicator (34), flag off', 34, false, false],
    ['iOS home indicator (34), flag on', 34, false, true],
    ['Android three-button bar (48), flag off', 48, false, false],
    ['no inset, layover pill, flag off', 0, true, false],
    ['iOS home indicator (34), layover pill, flag on', 34, true, true],
  ];
  it.each(cases)('%s: the rail bottom is above the FAB top; the left column is unmoved', async (_n, insetBottom, layover, on) => {
    mockInsets = { top: 0, bottom: insetBottom, left: 0, right: 0 };
    mockLayoverSession = layover ? { id: 'layover-1' } : null;
    mockFlags = { MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: on };
    await renderOverlay();
    const rail = screen.getByTestId('watch-action-rail');
    const rs = StyleSheet.flatten(rail.props.style);
    const row = StyleSheet.flatten((rail.parent as typeof rail).props.style);
    const bottomPad = Math.max(insetBottom + 100, 120);
    expect(row.paddingBottom).toBe(bottomPad); // (2) the left column's baseline is today's
    expect(typeof rs.marginBottom).toBe('number');
    expect(bottomPad + (rs.marginBottom as number)).toBeGreaterThanOrEqual(fabTop(insetBottom, layover) + 4);
    // Before any layout is measured the rail keeps today's gap.
    expect(rs.gap).toBe(space.xl);
    expect(screen.queryByLabelText('Ask Compass about this') !== null).toBe(on);
  });

  it('media.tsx still draws the FAB with the geometry this file assumes', () => {
    const src = readFileSync(join(__dirname, '../../../../app/(tabs)/media.tsx'), 'utf8');
    expect(src).toContain('const bottomInset = useLayoverAwareBottomInset();');
    expect(src).toContain('{ bottom: bottomInset + 16 },');
    expect(src).toMatch(/fab: \{\s*position: 'absolute',\s*right: 20,\s*width: avatar\.s52, height: avatar\.s52,/);
  });
});

describe('watchRailGap — the rail fits its budget', () => {
  // Budgets and natural heights (gaps excluded) the web probe measured:
  // 390×844 → budget 516; 375×667 → budget 339. Off: 301 across 5 gaps; on: 353 across 6.
  it('keeps space.xl where the rail fits (390×844, off and on)', () => {
    expect(watchRailGap(516, 301, 5)).toBe(space.xl);
    expect(watchRailGap(516, 353, 6)).toBe(space.xl);
  });
  it('shrinks the gap where it does not (375×667, off): the rail then fits', () => {
    const g = watchRailGap(339, 301, 5);
    expect(g).toBeLessThan(space.xl);
    expect(g).toBeGreaterThanOrEqual(space.xs);
    expect(301 + 5 * g).toBeLessThanOrEqual(339);
  });
  it('never goes under space.xs (375×667, on: the rail cannot fit even at space.xs)', () => {
    expect(watchRailGap(339, 353, 6)).toBe(space.xs);
  });
});
