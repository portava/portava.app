/**
 * Component test: the Wall draws the image variant its frame needs, and warms
 * the one it draws (Wall spec §33 "Images: responsive variants + CDN/cache",
 * §31 prefetch; census-wall W151).
 *
 * Proves:
 *   • on a 390 dp, 3× device (a 1170 px full-width frame) `WallImage` draws the
 *     stored ≤1500 px FEED variant — not the ≤400 px thumbnail it used to draw
 *     whatever the frame's size, and not the original;
 *   • with no feed variant stored it draws the original, never an upscaled
 *     thumbnail;
 *   • for every object type that draws an image, at four device widths, the set
 *     `prefetchWallMedia` warms is EXACTLY the one object the renderer drew. The
 *     old code broke this: the renderer drew `thumbnailUrl ?? url`, the prefetch
 *     warmed `url ?? thumbnailUrl`, and a multi-media post warmed media it never
 *     drew.
 *
 * WATCHED IT FAIL: (b) with WallImage back on `thumbnailUrl ?? url`, the 3× test
 * and every image row of the agreement table go red; (c) with the prefetch back
 * on `url ?? thumbnailUrl`, the agreement table goes red.
 */

import React from 'react';
import { Dimensions } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite. wallItemShared
// imports it.
jest.mock('../../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
  revalidateCachedObjects: jest.fn(),
}));

// NOTE: exhaustive-by-design stub — the real CachedImage signs the ref through
// the network (useHydratedMedia). What this test pins is WHICH stored ref the
// Wall hands it, so the stub prints that ref and nothing else.
jest.mock('../../../../../components/CachedImage.tsx', () => {
  const ReactLocal = require('react');
  const { Text } = require('react-native');
  return {
    CachedImage: ({ source }: { source: { uri?: string } }) =>
      ReactLocal.createElement(Text, { testID: 'drawn-uri' }, source?.uri ?? ''),
  };
});

import { WallImage } from '../wallItemShared.tsx';
import { WallObjectRenderer } from '../../WallObjectRenderer.tsx';
import { prefetchWallMedia } from '../../../services/wallPrefetch.ts';
import type { DisplayMedia, WallProjection } from '../../../types/wallProjection.ts';

const THUMB = 'post-media/u1/p.thumb.jpg';
const FEED = 'post-media/u1/p.feed.jpg';
const ORIG = 'post-media/u1/p.jpg';

const IMAGE: DisplayMedia = { mediaId: 'm1', kind: 'image', url: ORIG, thumbnailUrl: THUMB, feedUrl: FEED };
// A second image the renderers never draw (they draw media[0]).
const SECOND: DisplayMedia = {
  mediaId: 'm2',
  kind: 'image',
  url: 'post-media/u1/q.jpg',
  thumbnailUrl: 'post-media/u1/q.thumb.jpg',
  feedUrl: 'post-media/u1/q.feed.jpg',
};
const VIDEO: DisplayMedia = {
  mediaId: 'mv',
  kind: 'video',
  url: 'post-media/u1/clip.mp4',
  thumbnailUrl: 'post-media/u1/clip.jpg',
};

let dimsSpy: jest.SpyInstance;
function device(width: number, scale: number) {
  dimsSpy.mockReturnValue({ width, height: 844, scale, fontScale: 1 });
}

beforeEach(() => {
  dimsSpy = jest.spyOn(Dimensions, 'get');
  device(390, 3);
});
afterEach(() => {
  dimsSpy.mockRestore();
});

const drawn = () => screen.getByTestId('drawn-uri').props.children as string;

describe('WallImage draws the variant its frame needs (§33)', () => {
  it('a full-width frame on a 390 dp 3× device (1170 px) draws the feed variant', async () => {
    await render(<WallImage media={IMAGE} />);
    expect(drawn()).toBe(FEED);
  });

  it('with no feed variant stored, the same frame draws the original, not the 400 px thumbnail', async () => {
    await render(<WallImage media={{ ...IMAGE, feedUrl: null }} />);
    expect(drawn()).toBe(ORIG);
  });

  it('a video frame draws its poster, never the payload', async () => {
    await render(<WallImage media={VIDEO} ratio={16 / 9} rounded={false} />);
    expect(drawn()).toBe('post-media/u1/clip.jpg');
  });
});

const NOW = new Date().toISOString();
const base = (id: string) => ({
  projectionId: id,
  canonicalObjectId: `c-${id}`,
  publishedAt: NOW,
  visibility: 'public' as const,
  actions: [],
});

const PROJECTIONS: Array<[string, WallProjection]> = [
  ['social_post', { ...base('p1'), objectType: 'social_post', text: 'post', media: [IMAGE, SECOND] }],
  ['postcard', { ...base('c1'), objectType: 'postcard', storyPresentation: true, media: [IMAGE, SECOND] }],
  ['shared_moment', { ...base('s1'), objectType: 'shared_moment', media: [IMAGE, SECOND] }],
  ['discovery', { ...base('d1'), objectType: 'discovery', discoveryReason: 'nearby', media: [IMAGE, SECOND] }],
  ['video', { ...base('v1'), objectType: 'video', inlinePlayback: true, media: [VIDEO] }],
];

const DEVICES: Array<[string, number, number, string]> = [
  ['180 dp 2× (360 px)', 180, 2, THUMB],
  ['390 dp 2× (780 px)', 390, 2, FEED],
  ['390 dp 3× (1170 px)', 390, 3, FEED],
  ['1024 dp 2× (2048 px)', 1024, 2, ORIG],
];

describe('the prefetch warms exactly what the renderer draws (§31 × §33)', () => {
  describe.each(DEVICES)('on a %s device', (_label, width, scale, expectedImage) => {
    it.each(PROJECTIONS)('%s', async (type, projection) => {
      device(width, scale);
      await render(<WallObjectRenderer projection={projection} />);
      const rendered = drawn();
      expect(rendered).toBe(type === 'video' ? 'post-media/u1/clip.jpg' : expectedImage);

      const hydrate = jest.fn(async (refs: string[]) =>
        Object.fromEntries(refs.map((r) => [r, `https://signed/${r}`])),
      );
      const prefetch = jest.fn(async () => true);
      await prefetchWallMedia([projection], { count: 4, hydrate, prefetch });

      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(hydrate.mock.calls[0][0]).toEqual([rendered]);
      expect(prefetch).toHaveBeenCalledWith([`https://signed/${rendered}`]);
    });
  });
});
