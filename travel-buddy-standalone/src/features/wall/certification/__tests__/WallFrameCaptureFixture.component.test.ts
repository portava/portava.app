/**
 * Guards the pinned 60-item feed behind the W149 frame-time capture.
 *
 * W149 cannot be closed here — it needs a device, and this container has none.
 * What this file protects is the part of W149 that is NOT a judgement call: the
 * subject of the measurement. A frame-time number is only comparable to another
 * frame-time number if both were taken over the same feed, and "the same feed"
 * is a property that rots silently — a fixture that drifts to 48 items, or
 * loses its videos, or fills with object types the renderer drops on the floor,
 * still produces a trace, still produces a percentage, and the percentage is
 * then not about the same thing the last one was about.
 *
 * Each assertion below is one way that has happened to somebody.
 */

import {
  FRAME_CAPTURE_ITEM_COUNT,
  buildFrameCaptureFeed,
  pageOf,
} from '../wallFrameCaptureFixture.ts';

const MEDIA = 'http://fixture.invalid/media';

describe('W149 frame-capture fixture', () => {
  it('refuses to build a media-free feed', () => {
    // A feed of empty media wells scrolls beautifully and measures nothing.
    // Failing loudly at build time is the only safe default; see the module
    // header. Mutation proof: give mediaBase a default and this goes red.
    expect(() => buildFrameCaptureFeed({ mediaBase: '' })).toThrow(/mediaBase is required/);
  });

  it('is exactly the 60 items the requirement names, and every one carries media', () => {
    const feed = buildFrameCaptureFeed({ mediaBase: MEDIA });
    expect(feed.items).toHaveLength(FRAME_CAPTURE_ITEM_COUNT);
    expect(FRAME_CAPTURE_ITEM_COUNT).toBe(60);
    const withoutMedia = feed.items.filter((i) => !i.media || i.media.length === 0);
    expect(withoutMedia.map((i) => i.projectionId)).toEqual([]);
  });

  it('carries real video, because "with video" is in the requirement', () => {
    const feed = buildFrameCaptureFeed({ mediaBase: MEDIA });
    const videos = feed.items.filter((i) => i.objectType === 'video');
    // Video mounts a player and a poster and subscribes to viewability; it is
    // the most expensive card the Wall draws. A capture over a feed that lost
    // its videos would understate frame cost and still look like a pass.
    expect(videos.length).toBeGreaterThanOrEqual(15);
    for (const v of videos) {
      expect(v.media?.[0]?.kind).toBe('video');
      expect(v.media?.[0]?.url).toContain('.mp4');
    }
  });

  it('contains only object types that actually render', () => {
    // WallObjectRenderer returns null for an unknown objectType rather than
    // crashing the feed (spec §40). That is correct behaviour and a trap for a
    // fixture: 60 unrenderable items scroll as 60 zero-height rows at a
    // flawless 60 fps. These five are the types with their own renderer file.
    const renderable = new Set(['social_post', 'video', 'postcard', 'shared_moment', 'discovery']);
    const feed = buildFrameCaptureFeed({ mediaBase: MEDIA });
    const strays = [...new Set(feed.items.map((i) => i.objectType))].filter((t) => !renderable.has(t));
    expect(strays).toEqual([]);
  });

  it('pages the way the real server does, so mid-scroll fetches are measured', () => {
    // routes/wall.ts DEFAULT_LIMIT is 20. Reaching item 60 therefore costs two
    // onEndReached fetches and two list-data replacements DURING the scroll —
    // the exact moments a feed drops frames. A one-slab fixture would skip them.
    const feed = buildFrameCaptureFeed({ mediaBase: MEDIA });
    const p1 = pageOf(feed, null, 20);
    expect({ n: p1.items.length, next: p1.nextCursor }).toEqual({ n: 20, next: '20' });
    const p2 = pageOf(feed, p1.nextCursor ?? null, 20);
    expect({ n: p2.items.length, next: p2.nextCursor }).toEqual({ n: 20, next: '40' });
    const p3 = pageOf(feed, p2.nextCursor ?? null, 20);
    expect({ n: p3.items.length, next: p3.nextCursor }).toEqual({ n: 20, next: undefined });
    const seen = [...p1.items, ...p2.items, ...p3.items].map((i) => i.projectionId);
    expect(new Set(seen).size).toBe(60);
  });

  it('is byte-reproducible, so two captures are of the same feed', () => {
    const a = JSON.stringify(buildFrameCaptureFeed({ mediaBase: MEDIA }));
    const b = JSON.stringify(buildFrameCaptureFeed({ mediaBase: MEDIA }));
    expect(a).toBe(b);
  });
});
