/**
 * GridTile — the stamp disc and the view count sit in separate slots
 * (census-media §40).
 *
 * ## What H8's renders showed
 *
 * §31.12 gave the tile's StampButton a dark disc (0.95, then 0.80 in §31.13)
 * at bottom: 4, right: 4. The bottom meta row is right-aligned too and is only
 * 27 px tall, so the 44 px disc, drawn at zIndex 6 over the row's zIndex 3,
 * covered the view count on every tile: "12.4K" read "…K". Before §31.12 the
 * wrapper was transparent and the count showed around the stamp glyph.
 *
 * ## What this pins
 *
 *   1. Both are anchored to the tile's bottom edge: the meta row at bottom 0,
 *      the disc at its own `bottom`.
 *   2. The meta row's height, from its own styles (paddingTop + the tallest
 *      line in it + paddingBottom), is at most the disc's `bottom`: the disc
 *      starts above the row, so the two boxes cannot intersect.
 *   3. The count is inside the row, and the disc is not inside the row.
 *   4. The disc keeps §31.13's backing (the fix is a slot, not a colour).
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, within } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — no video in this tile; the player is not
// under test.
jest.mock('expo-av', () => {
  const { View } = require('react-native');
  return { Video: (props: object) => <View {...props} />, ResizeMode: { COVER: 'cover' } };
});

// NOTE: intentional stub — autoplay lifecycle not under test.
jest.mock('../../../hooks/useInViewAutoplay.ts', () => ({
  useInViewAutoplay: () => {},
}));

// NOTE: intentional stub — resize-mode calculation not under test.
jest.mock('../../../hooks/useSmartVideoFit.ts', () => ({
  useSmartVideoFit: () => ({ resizeMode: 'cover' as const, needsLetterbox: false, onReadyForDisplay: () => {} }),
}));

// NOTE: intentional stub — letterbox backdrop not under test.
jest.mock('../../ui/VideoBlurBackdrop.tsx', () => ({
  VideoBlurBackdrop: () => null,
}));

// NOTE: intentional stub — poster image rendering not under test.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: () => null,
}));

import { GridTile } from '../GridTile.tsx';
import type { MediaGridItem } from '../../../types/media.ts';

function makeItem(overrides: Partial<MediaGridItem> = {}): MediaGridItem {
  return {
    id: 'tile-1',
    mediaType: 'image',
    thumbnailUrl: 'https://example.com/a.jpg',
    posterUrl: 'https://example.com/a.jpg',
    width: 1080,
    height: 1440,
    durationMs: null,
    contentType: 'Stay',
    creatorId: 'creator-1',
    locationLabel: 'Lisbon',
    placeId: null,
    viewCount: 12400,
    qualifiedViewCount: 12400,
    processingStatus: null,
    videoUrl: null,
    ...overrides,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/** The meta row's height from its own styles: vertical padding plus its tallest line. */
function metaRowHeight(row: ReturnType<typeof screen.getByTestId>): number {
  const rs = StyleSheet.flatten(row.props.style);
  const lines = within(row).getAllByText(/\S/).map((n) => {
    const ts = StyleSheet.flatten(n.props.style);
    expect(typeof ts.lineHeight).toBe('number'); // a fixed line box, or the height is not knowable from style
    return ts.lineHeight as number;
  });
  expect(lines.length).toBeGreaterThan(0);
  const padTop = num(rs.paddingTop ?? rs.paddingVertical ?? rs.padding);
  const padBottom = num(rs.paddingBottom ?? rs.paddingVertical ?? rs.padding);
  return padTop + Math.max(...lines) + padBottom;
}

const cases: Array<[string, Partial<MediaGridItem>]> = [
  ['photo with a view count', {}],
  ['video with a duration and a view count', { mediaType: 'video', durationMs: 42000, videoUrl: null }],
];

describe('GridTile — stamp disc and view count in separate slots', () => {
  it.each(cases)("%s: the disc starts above the meta row", async (_name, overrides) => {
    await render(<GridTile item={makeItem(overrides)} index={0} cellWidth={190} cellHeight={250} onPress={() => {}} />);
    const row = screen.getByTestId('grid-tile-meta-row');
    const disc = screen.getByTestId('grid-tile-stamp-disc');
    const rs = StyleSheet.flatten(row.props.style);
    const ds = StyleSheet.flatten(disc.props.style);

    // 1. Both anchored to the tile's bottom edge.
    expect(rs.position).toBe('absolute');
    expect(rs.bottom).toBe(0);
    expect(ds.position).toBe('absolute');
    expect(typeof ds.bottom).toBe('number');

    // 2. The disc's bottom edge is at or above the row's top edge.
    expect(ds.bottom as number).toBeGreaterThanOrEqual(metaRowHeight(row));

    // 3. The count is in the row; the disc is not in the row.
    expect(within(row).getByText('12.4K')).toBeTruthy();
    expect(within(row).queryByTestId('grid-tile-stamp-disc')).toBeNull();
    expect(within(disc).queryByText('12.4K')).toBeNull();

    // 4. §31.13's backing is kept.
    expect(ds.backgroundColor).toBe('rgba(17,17,15,0.80)');
  });
});
