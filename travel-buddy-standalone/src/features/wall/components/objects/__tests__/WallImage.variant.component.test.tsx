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
 *   • the choice is aspect-aware: a 9:16 portrait's feed variant is only 844 px
 *     wide, so the same 1170 px frame draws its original;
 *   • for every object type the renderer dispatches, at four device widths, the
 *     set `prefetchWallMedia` warms is EXACTLY the set the renderer drew: one
 *     object for the five image-drawing types, none for a social update or a
 *     contextual opportunity. The old code broke this three ways: the renderer
 *     drew `thumbnailUrl ?? url` while the prefetch warmed `url ?? thumbnailUrl`;
 *     a multi-media post warmed media no renderer draws; and a Buddy
 *     opportunity's cover photo was warmed though its renderer draws no media.
 *
 * WATCHED IT FAIL: census-wall §16.8 lists, for each mutation, which of these
 * cases go red. The mutations are:
 *   (b) WallImage ignores `feedUrl`;
 *   (c) the prefetch goes back to `url ?? thumbnailUrl`;
 *   (d) the picker starts at the thumbnail whatever the target;
 *   (e) the prefetch warms every media item of every type again;
 *   (g) the picker goes back to the longest-edge rule when dimensions are
 *       known.
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
// A 9:16 portrait with known dimensions: its feed variant is 1152 × 1500 / 2048
// = 844 px wide, so a 1170 px frame needs the original.
const PORTRAIT: DisplayMedia = {
  mediaId: 'mp',
  kind: 'image',
  url: 'post-media/u1/tall.jpg',
  thumbnailUrl: 'post-media/u1/tall.thumb.jpg',
  feedUrl: 'post-media/u1/tall.feed.jpg',
  width: 1152,
  height: 2048,
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

  it('a 9:16 portrait on the same 1170 px frame draws the original: its feed variant is only 844 px wide', async () => {
    await render(<WallImage media={PORTRAIT} />);
    expect(drawn()).toBe('post-media/u1/tall.jpg');
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

// Every object type the renderer dispatches. The last two draw no media even
// when the projection carries some — a Buddy opportunity carries the Buddy's
// cover photo — so the prefetch must warm nothing for them.
const PROJECTIONS: Array<[string, WallProjection]> = [
  ['social_post', { ...base('p1'), objectType: 'social_post', text: 'post', media: [IMAGE, SECOND] }],
  ['social_post (9:16 portrait)', { ...base('p2'), objectType: 'social_post', text: 'tall', media: [PORTRAIT, SECOND] }],
  ['postcard', { ...base('c1'), objectType: 'postcard', storyPresentation: true, media: [IMAGE, SECOND] }],
  ['shared_moment', { ...base('s1'), objectType: 'shared_moment', media: [IMAGE, SECOND] }],
  ['discovery', { ...base('d1'), objectType: 'discovery', discoveryReason: 'nearby', media: [IMAGE, SECOND] }],
  ['video', { ...base('v1'), objectType: 'video', inlinePlayback: true, media: [VIDEO] }],
  ['social_update', { ...base('u1'), objectType: 'social_update', text: 'update', media: [IMAGE] }],
  [
    'contextual_opportunity',
    { ...base('o1'), objectType: 'contextual_opportunity', opportunityKind: 'buddy_around', text: 'Buddy', media: [IMAGE] },
  ],
];

// [label, dp, scale, what an image of unknown shape draws, what the 9:16 portrait draws]
const DEVICES: Array<[string, number, number, string, string]> = [
  ['180 dp 2× (360 px)', 180, 2, THUMB, 'post-media/u1/tall.feed.jpg'], // portrait thumbnail is 225 px wide
  ['390 dp 2× (780 px)', 390, 2, FEED, 'post-media/u1/tall.feed.jpg'],
  ['390 dp 3× (1170 px)', 390, 3, FEED, 'post-media/u1/tall.jpg'],
  ['1024 dp 2× (2048 px)', 1024, 2, ORIG, 'post-media/u1/tall.jpg'],
];

function expectedDraw(type: string, expectedImage: string, expectedPortrait: string): string | null {
  if (type === 'video') return 'post-media/u1/clip.jpg';
  if (type === 'social_update' || type === 'contextual_opportunity') return null;
  if (type.includes('portrait')) return expectedPortrait;
  return expectedImage;
}

describe('the prefetch warms exactly what the renderer draws (§31 × §33)', () => {
  describe.each(DEVICES)('on a %s device', (_label, width, scale, expectedImage, expectedPortrait) => {
    it.each(PROJECTIONS)('%s', async (type, projection) => {
      device(width, scale);
      await render(<WallObjectRenderer projection={projection} />);
      const frames = screen.queryAllByTestId('drawn-uri').map((n) => n.props.children as string);
      const want = expectedDraw(type, expectedImage, expectedPortrait);
      expect(frames).toEqual(want ? [want] : []);

      const hydrate = jest.fn(async (refs: string[]) =>
        Object.fromEntries(refs.map((r) => [r, `https://signed/${r}`])),
      );
      const prefetch = jest.fn(async () => true);
      await prefetchWallMedia([projection], { count: 4, hydrate, prefetch });

      // The warmed set IS the drawn set — the same object, and nothing else.
      const warmed = hydrate.mock.calls.flatMap((c) => c[0] as string[]);
      expect(warmed).toEqual(frames);
      if (frames.length > 0) expect(prefetch).toHaveBeenCalledWith(frames.map((f) => `https://signed/${f}`));
      else expect(prefetch).not.toHaveBeenCalled();
    });
  });
});
