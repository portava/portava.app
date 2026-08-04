/**
 * PortavaShareIcon — component tests
 *
 * Covers:
 *  1. Renders at every size used in-product (compact, feed, toolbar,
 *     share-sheet, large-control, hero) without throwing — a smoke test for
 *     the hand-authored SVG path.
 *  2. PORTAVA_SHARE_PATH is a single compound path with exactly two
 *     subpaths (ring + arrow) — guards against accidentally splitting or
 *     blanking the path during future geometry edits.
 *
 * NOTE: react-native-svg renders to a native host view that the jest-expo
 * renderer reports as an empty tree, so prop/accessibility assertions on the
 * rendered output are not meaningful here. Accessibility wiring
 * (onPress/accessibilityLabel/disabled) is covered end-to-end on the
 * Pressable-based PortavaShareButton wrapper instead — see
 * PortavaShareButton.component.test.tsx.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { PortavaShareIcon, PORTAVA_SHARE_PATH } from '../PortavaShareIcon.tsx';

describe('PortavaShareIcon', () => {
  it('renders at compact, feed, toolbar, share-sheet, large-control, and hero sizes without throwing', async () => {
    const sizes = [14, 20, 22, 24, 32, 160];
    for (const size of sizes) {
      const { unmount } = await render(<PortavaShareIcon size={size} color="#11110F" />);
      unmount();
    }
  });

  it('renders with an explicit accessibilityLabel without throwing (standalone usage)', async () => {
    const { unmount } = await render(<PortavaShareIcon size={20} accessibilityLabel="Share this post" />);
    unmount();
  });

  it('defines a single non-empty compound path with both a ring and an arrow subpath', () => {
    expect(PORTAVA_SHARE_PATH.length).toBeGreaterThan(0);
    // Two subpaths: the ring (starts with M, closed with Z) and the arrow
    // (starts with a second M, closed with Z) — i.e. exactly two "M...Z" segments.
    const moveCommands = PORTAVA_SHARE_PATH.match(/M/g) ?? [];
    const closeCommands = PORTAVA_SHARE_PATH.match(/Z/g) ?? [];
    expect(moveCommands.length).toBe(2);
    expect(closeCommands.length).toBe(2);
  });
});
