/**
 * GridTile — the verified-location stamp stops short of the stamp disc
 * (census-media §40.14). One layout event, so one file
 * (.agents/memory/rntl-react19-renderer-budget.md).
 *
 * Both sit on the band above the meta row (bottom 28): the stamp from the left
 * (left 6), the disc from the right (right 4). The stamp was up to ~158 px wide
 * (its name's maxWidth 130, 12 + 12 padding, a 2-px border), so on a ~190-px
 * tile a long place name ran under the disc; the web probe measured a -14 px
 * gap idle, -26 with a four-digit count and -39 with a six-digit one.
 *
 * Pinned here, for a verified tile with a long name:
 *   1. idle, the stamp's maxWidth leaves the disc's idle 36 px and an 8-px gap;
 *   2. once the disc reports a wider layout (a count), the stamp's maxWidth
 *      follows it, still leaving the 8-px gap;
 *   3. the stamp's eyebrow and name fill the stamp and truncate inside it
 *      (alignSelf stretch, one line): on web a text sized to itself overflowed
 *      a narrowed stamp's border and ran under the disc all the same.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent, act, within } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — no video plays in this tile.
jest.mock('expo-av', () => {
  const { View } = require('react-native');
  return { Video: (props: object) => <View {...props} />, ResizeMode: { COVER: 'cover' } };
});
// NOTE: intentional stub — autoplay lifecycle not under test.
jest.mock('../../../hooks/useInViewAutoplay.ts', () => ({ useInViewAutoplay: () => {} }));
// NOTE: intentional stub — resize-mode calculation not under test.
jest.mock('../../../hooks/useSmartVideoFit.ts', () => ({
  useSmartVideoFit: () => ({ resizeMode: 'cover' as const, needsLetterbox: false, onReadyForDisplay: () => {} }),
}));
// NOTE: intentional stub — letterbox backdrop not under test.
jest.mock('../../ui/VideoBlurBackdrop.tsx', () => ({ VideoBlurBackdrop: () => null }));
// NOTE: intentional stub — poster image rendering not under test.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({ DisplayMediaImage: () => null }));

import { GridTile } from '../GridTile.tsx';
import type { MediaGridItem } from '../../../types/media.ts';

const CELL_W = 190;
const LONG = 'Miradouro de Santa Luzia e Jardim Júlio de Castilho';

function stampWrap() {
  // The stamp's positioned wrapper: the eyebrow's grandparent (wrap > stamp > eyebrow).
  const eyebrow = screen.getByText('VERIFIED · HERE');
  return (eyebrow.parent as typeof eyebrow).parent as typeof eyebrow;
}

function gapToDisc(discWidth: number): number {
  const ws = StyleSheet.flatten(stampWrap().props.style);
  const ds = StyleSheet.flatten(screen.getByTestId('grid-tile-stamp-disc').props.style);
  expect(ws.position).toBe('absolute');
  expect(typeof ws.maxWidth).toBe('number');
  const stampRight = (ws.left as number) + (ws.maxWidth as number);
  const discLeft = CELL_W - (ds.right as number) - discWidth;
  return discLeft - stampRight;
}

it('a long verified name: the stamp leaves the disc an 8-px gap, idle and once the disc widens', async () => {
  await render(
    <GridTile
      item={{
        id: 'g-verified', mediaType: 'video', thumbnailUrl: 'https://example.com/a.jpg', posterUrl: 'https://example.com/a.jpg',
        width: 1080, height: 1440, durationMs: 42000, contentType: 'Viewpoint', creatorId: 'c-1',
        locationLabel: LONG, placeId: null, viewCount: 48200, qualifiedViewCount: 48200, processingStatus: null,
        videoUrl: null, locationVerified: true,
      } as MediaGridItem}
      index={0} cellWidth={CELL_W} cellHeight={256} onPress={() => {}}
    />,
  );

  // 3. The stamp's two lines fill it and truncate inside it.
  // (The long name is also the tile's top-right place badge; this is the stamp's copy.)
  for (const text of ['VERIFIED · HERE', LONG]) {
    const t = within(stampWrap()).getByText(text);
    expect(StyleSheet.flatten(t.props.style).alignSelf).toBe('stretch');
    expect(t.props.numberOfLines).toBe(1);
  }

  // 1. Idle: the disc is 36 wide.
  expect(gapToDisc(36)).toBeGreaterThanOrEqual(8);

  // 2. The disc reports a four-digit count's width (47.5 on the web render).
  await act(async () => {
    fireEvent(screen.getByTestId('grid-tile-stamp-disc'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 47.5, height: 44 } } });
  });
  expect(gapToDisc(47.5)).toBeGreaterThanOrEqual(8);
});
