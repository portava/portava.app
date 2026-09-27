/**
 * MediaViewer — the page dots have a slot of their own (census-media §40).
 *
 * ## What H8's renders showed
 *
 * §31.13 put the viewer's page dots on a 0.87 ink pill. The dots sat at
 * `bottom: max(insets.bottom + 80, 90)`, a fixed height that lands inside the
 * left column (author, caption, place chip, quick actions) whenever that
 * column is taller than ~70 px, which is always once a caption shows. Before
 * the pill the bare dots overlapped a caption line and the words showed
 * between them; the opaque pill hid them ("should", "honest version").
 *
 * ## What this pins
 *
 *   1. The dots and the overlay's bottom block (the two columns) are separate
 *      layers anchored to the screen's bottom edge.
 *   2. The dots' top edge — their `bottom` plus the pill's height, read from
 *      the pill's and the dots' own styles — is at or below the columns'
 *      bottom edge (the block's paddingBottom), with a gap, for a zero and an
 *      iOS home-indicator inset. The columns can then grow to any height
 *      without reaching the dots.
 *   3. With one item there are no dots and no slot is reserved.
 *   4. The pill keeps §31.13's backing (the fix is a slot, not a colour).
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, act, within } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — only the bottom inset matters here; the
// test sets it per case through mockInsets.
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'm-1' }),
}));

// NOTE: intentional exhaustive stub — the viewer only reads userId.
jest.mock('../../../src/context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1', isAuthed: true }),
}));

// NOTE: intentional exhaustive stub — every flag off (the World shell's
// action rail is not drawn, as in the H8 renders).
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));

// NOTE: intentional exhaustive stub — the post read resolves with one post so
// the left column carries a caption, as on a device.
jest.mock('../../../src/services/mediaFeed.ts', () => ({
  fetchMediaFeedItemById: async (id: string) => ({
    ok: true,
    data: {
      id, videoUrl: null, posterUrl: null, caption: 'The staircase everyone photographs, and the one everyone should.',
      creator: { id: 'creator-1', username: 'maya.okafor', displayName: 'Maya Okafor', avatarUrl: null },
      place: { name: 'Palácio da Luz', city: 'Lisbon' },
      likeCount: 214, commentCount: 17, saveCount: 58, likedByMe: false, savedByMe: false, stampItCount: 0,
    },
  }),
}));

// NOTE: intentional exhaustive stub — save state is not under test.
jest.mock('../../../src/hooks/useMediaSave.ts', () => ({
  useMediaSave: () => ({ seed: () => {}, toggleSave: () => {}, isSaved: () => false, savedSet: {} }),
}));

// NOTE: intentional exhaustive stub — share analytics not under test.
jest.mock('../../../src/services/mediaInteractions.ts', () => ({
  recordMediaShare: async () => {},
}));

// NOTE: intentional exhaustive stubs — the rail's stamp, the sheets, the
// images and the quick-action chips are content inside the columns; this
// test is about where the columns and the dots sit.
jest.mock('../../../src/components/stamps/StampButton.tsx', () => ({
  StampButton: () => null,
}));
jest.mock('../../../src/components/media/MediaCommentSheet.tsx', () => ({
  MediaCommentSheet: () => null,
}));
jest.mock('../../../src/features/media/components/MediaActionRail.tsx', () => ({
  MediaActionRail: () => null,
}));
jest.mock('../../../src/components/CachedImage', () => ({
  CachedImage: () => null,
}));
jest.mock('../../../src/components/PlaceQuickActions.tsx', () => ({
  PlaceQuickActions: () => null,
}));

// NOTE: intentional exhaustive stub — no video plays in this test.
jest.mock('expo-av', () => {
  const { View } = require('react-native');
  return { Video: (props: object) => <View {...props} />, ResizeMode: { COVER: 'cover' } };
});

// NOTE: intentional exhaustive stub — the scrim is decoration.
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: (props: object) => <View {...props} /> };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import MediaViewer from '../[id].tsx';
import { setViewerContext, clearViewerContext, type ViewerContextItem } from '../../../src/lib/viewerContext.ts';

function items(n: number): ViewerContextItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `m-${i + 1}`, posterUrl: null, thumbnailUrl: null, mediaType: 'image' as const }));
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

async function renderViewer(n: number) {
  setViewerContext(items(n), 'm-1');
  await render(<MediaViewer />);
  // Let the post read (a resolved promise) land, so the left column carries its caption.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(() => {
  clearViewerContext();
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
});

describe('MediaViewer — page dots sit in their own slot under the columns', () => {
  it.each([0, 34])('insets.bottom %i: the dots end below the columns, with a gap', async (insetBottom) => {
    mockInsets = { top: 0, bottom: insetBottom, left: 0, right: 0 };
    await renderViewer(8);
    expect(screen.getByText('The staircase everyone photographs, and the one everyone should.')).toBeTruthy();

    const dots = screen.getByTestId('viewer-page-dots');
    const block = screen.getByTestId('viewer-overlay-bottom');
    const ds = StyleSheet.flatten(dots.props.style);
    const bs = StyleSheet.flatten(block.props.style);

    // 1. Separate layers, both anchored to the screen's bottom edge.
    expect(ds.position).toBe('absolute');
    expect(bs.position).toBe('absolute');
    expect(bs.bottom).toBe(0);
    expect(within(block).queryByTestId('viewer-page-dots')).toBeNull();

    // The pill's height from its own styles: vertical padding plus its tallest dot.
    const pill = dots.children[0] as typeof dots;
    const ps = StyleSheet.flatten(pill.props.style);
    expect(ps.backgroundColor).toBe('rgba(17,17,15,0.87)'); // 4. §31.13's backing is kept
    const dotHeights = (pill.children as Array<typeof dots>).map((c) => num(StyleSheet.flatten(c.props.style).height));
    expect(dotHeights).toHaveLength(8);
    const pillHeight = num(ps.paddingTop ?? ps.paddingVertical ?? ps.padding) + Math.max(...dotHeights) + num(ps.paddingBottom ?? ps.paddingVertical ?? ps.padding);

    // 2. The dots' top edge is at least 4 px below the columns' bottom edge,
    //    and the dots stay clear of the home indicator.
    const dotsTop = num(ds.bottom) + pillHeight;
    expect(dotsTop + 4).toBeLessThanOrEqual(num(bs.paddingBottom));
    expect(num(ds.bottom)).toBeGreaterThanOrEqual(insetBottom);
  });

  it('one item: no dots, and no slot is reserved under the columns', async () => {
    await renderViewer(1);
    expect(screen.queryByTestId('viewer-page-dots')).toBeNull();
    const withOne = num(StyleSheet.flatten(screen.getByTestId('viewer-overlay-bottom').props.style).paddingBottom);
    clearViewerContext();
    await renderViewer(3);
    const withThree = num(StyleSheet.flatten(screen.getByTestId('viewer-overlay-bottom').props.style).paddingBottom);
    expect(withOne).toBeLessThan(withThree);
  });
});
