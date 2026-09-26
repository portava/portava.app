/**
 * wallImageVariant — the one choice of which stored image a Wall frame draws
 * (Wall spec §33 "Images: responsive variants + CDN/cache"; census-wall W151).
 *
 * ── THE CLAIMS ───────────────────────────────────────────────────────────────
 *   0. ASPECT-AWARE when the original's width and height are known. A variant
 *      capped at DIM on its longest edge is `w × min(1, DIM / max(w, h))` wide.
 *      The picker takes the narrowest stored variant whose WIDTH covers the
 *      target:
 *        - a 9:16 portrait's 844 px feed variant does not cover a 1170 px frame,
 *          so the original is drawn;
 *        - a landscape image's 1500 px feed variant does cover it.
 *   1. With either dimension unknown it keeps the longest-edge rule, where the
 *      cap stands in for the width: the smallest stored variant that covers the
 *      target is the thumbnail up to 400 px, the feed variant up to 1500 px,
 *      and the original above that.
 *   2. An absent variant falls to the next LARGER one that is present, and only
 *      when nothing at or above the target is present, to the largest smaller.
 *   3. A video yields its poster only, never the payload; processing media and
 *      no media yield nothing.
 *   4. The target is window width × scale, and a nonsense window yields 0.
 *   5. The client's two caps are the server's: THUMBNAIL_DIM and FEED_DIM in
 *      artifacts/api-server/src/lib/mediaProcessing.ts.
 *   6. The Wall draws media[0] of the five image-drawing object types and
 *      nothing of the other two (the component test pins this set against the
 *      real renderers).
 *
 * WATCHED IT FAIL (census-wall §16):
 *   (d) with the picker starting at the thumbnail whatever the target, the
 *       covering and fallback cases go red;
 *   (g) with the picker back on the longest-edge rule when dimensions ARE
 *       known, the aspect-aware cases go red.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WALL_FEED_DIM,
  WALL_THUMBNAIL_DIM,
  drawnWallMediaOf,
  pickWallImageRef,
  wallImageTargetPx,
  wallVariantWidth,
} from '../wallImageVariant.ts';
import type { DisplayMedia, WallObjectType, WallProjection } from '../../types/wallProjection.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

const THUMB = 'post-media/u1/p.thumb.jpg';
const FEED = 'post-media/u1/p.feed.jpg';
const ORIG = 'post-media/u1/p.jpg';

function image(over: Partial<DisplayMedia> = {}): DisplayMedia {
  return { mediaId: 'm1', kind: 'image', url: ORIG, thumbnailUrl: THUMB, feedUrl: FEED, ...over };
}

describe('pickWallImageRef — aspect-aware when the original\'s dimensions are known', () => {
  const FRAME = wallImageTargetPx({ width: 390, scale: 3 }); // 1170 px

  test('a variant capped on its longest edge is w × min(1, DIM / max(w, h)) wide', () => {
    assert.equal(wallVariantWidth(WALL_FEED_DIM, 1152, 2048), 843.75); // 9:16 portrait
    assert.equal(wallVariantWidth(WALL_FEED_DIM, 1536, 2048), 1125); // 3:4 portrait
    assert.equal(wallVariantWidth(WALL_FEED_DIM, 2048, 1365), 1500); // 3:2 landscape
    assert.equal(wallVariantWidth(WALL_THUMBNAIL_DIM, 2048, 1365), 400);
    assert.equal(wallVariantWidth(WALL_FEED_DIM, 800, 600), 800, 'never wider than the original');
    assert.equal(wallVariantWidth(Number.POSITIVE_INFINITY, 1152, 2048), 1152, 'the original is its own width');
  });

  test('a 9:16 portrait on a 1170 px frame draws the original: its feed variant is only 844 px wide', () => {
    assert.equal(pickWallImageRef(image({ width: 1152, height: 2048 }), FRAME), ORIG);
  });

  test('a 3:4 portrait draws the original at 1170 px (feed is 1125 wide) and the feed variant at 1100 px', () => {
    assert.equal(pickWallImageRef(image({ width: 1536, height: 2048 }), FRAME), ORIG);
    assert.equal(pickWallImageRef(image({ width: 1536, height: 2048 }), 1100), FEED);
  });

  test('a portrait whose original is absent takes the widest stored variant', () => {
    assert.equal(pickWallImageRef(image({ width: 1152, height: 2048, url: null }), FRAME), FEED);
  });

  test('a landscape image still draws the feed variant on a 1170 px frame', () => {
    assert.equal(pickWallImageRef(image({ width: 2048, height: 1365 }), FRAME), FEED);
  });

  test('a portrait thumbnail is narrower than 400 px, so a 350 px frame takes the feed variant', () => {
    // 9:16 thumbnail = 1152 × 400 / 2048 = 225 px wide.
    assert.equal(pickWallImageRef(image({ width: 1152, height: 2048 }), 350), FEED);
    assert.equal(pickWallImageRef(image({ width: 1152, height: 2048 }), 225), THUMB);
  });

  test('an original narrower than the frame: nothing covers, so the widest; on a tie the smaller variant', () => {
    // 800 × 600: the feed variant is 800 wide, the same as the original.
    assert.equal(pickWallImageRef(image({ width: 800, height: 600 }), FRAME), FEED);
    assert.equal(pickWallImageRef(image({ width: 800, height: 600, feedUrl: null }), FRAME), ORIG);
  });

  test('unknown dimensions keep the longest-edge rule', () => {
    for (const dims of [{}, { width: null, height: null }, { width: 1152 }, { height: 2048 }, { width: 0, height: 2048 }]) {
      assert.equal(pickWallImageRef(image(dims as Partial<DisplayMedia>), FRAME), FEED, JSON.stringify(dims));
      assert.equal(pickWallImageRef(image(dims as Partial<DisplayMedia>), 300), THUMB, JSON.stringify(dims));
      assert.equal(pickWallImageRef(image(dims as Partial<DisplayMedia>), 2000), ORIG, JSON.stringify(dims));
    }
  });
});

describe('pickWallImageRef — the smallest stored variant that covers the target (dimensions unknown)', () => {
  test('up to 400 px it draws the thumbnail', () => {
    assert.equal(pickWallImageRef(image(), 1), THUMB);
    assert.equal(pickWallImageRef(image(), 400), THUMB);
  });

  test('from 401 to 1500 px it draws the feed variant', () => {
    assert.equal(pickWallImageRef(image(), 401), FEED);
    assert.equal(pickWallImageRef(image(), 1500), FEED);
  });

  test('a full-width 3× frame (390 dp × 3 = 1170 px) draws the feed variant', () => {
    assert.equal(pickWallImageRef(image(), wallImageTargetPx({ width: 390, scale: 3 })), FEED);
  });

  test('above FEED_DIM it draws the original', () => {
    assert.equal(pickWallImageRef(image(), 1501), ORIG);
    assert.equal(pickWallImageRef(image(), wallImageTargetPx({ width: 1024, scale: 2 })), ORIG);
  });
});

describe('pickWallImageRef — fallbacks when a variant is absent', () => {
  test('no feed variant (most production rows): a large frame takes the original, not the thumbnail', () => {
    for (const feedUrl of [null, undefined, '', '   ']) {
      assert.equal(pickWallImageRef(image({ feedUrl }), 1170), ORIG, `feedUrl=${JSON.stringify(feedUrl)}`);
    }
  });

  test('no thumbnail: a small frame takes the next larger stored variant, the feed', () => {
    assert.equal(pickWallImageRef(image({ thumbnailUrl: null }), 300), FEED);
    assert.equal(pickWallImageRef(image({ thumbnailUrl: null, feedUrl: null }), 300), ORIG);
  });

  test('nothing at or above the target: the largest smaller variant', () => {
    assert.equal(pickWallImageRef(image({ url: null }), 2000), FEED);
    assert.equal(pickWallImageRef(image({ url: null, feedUrl: null }), 2000), THUMB);
    assert.equal(pickWallImageRef(image({ url: null, feedUrl: null }), 1170), THUMB);
  });

  test('only the original: every target draws it', () => {
    const only = image({ thumbnailUrl: null, feedUrl: null });
    for (const t of [0, 200, 400, 1170, 1500, 4000]) assert.equal(pickWallImageRef(only, t), ORIG, `target ${t}`);
  });

  test('nothing stored: null', () => {
    assert.equal(pickWallImageRef(image({ url: null, thumbnailUrl: null, feedUrl: null }), 1170), null);
  });

  test('a non-finite or negative target is treated as 0 (the smallest present)', () => {
    assert.equal(pickWallImageRef(image(), Number.NaN), THUMB);
    assert.equal(pickWallImageRef(image(), -5), THUMB);
  });
});

describe('pickWallImageRef — video, processing, absent', () => {
  test('a video yields its poster only, never the payload, at any target', () => {
    const video: DisplayMedia = { mediaId: 'v', kind: 'video', url: 'post-media/u1/clip.mp4', thumbnailUrl: 'post-media/u1/clip.jpg', feedUrl: FEED };
    for (const t of [100, 1170, 4000]) assert.equal(pickWallImageRef(video, t), 'post-media/u1/clip.jpg');
    assert.equal(pickWallImageRef({ ...video, thumbnailUrl: null }, 1170), null, 'no poster: nothing, not the .mp4');
  });

  test('processing media and no media yield null', () => {
    assert.equal(pickWallImageRef(image({ processing: true }), 1170), null);
    assert.equal(pickWallImageRef(undefined, 1170), null);
    assert.equal(pickWallImageRef(null, 1170), null);
  });
});

describe('drawnWallMediaOf — the one media item the Wall draws', () => {
  const second: DisplayMedia = { mediaId: 'm2', kind: 'image', url: 'post-media/u1/q.jpg' };
  const proj = (objectType: WallObjectType, media?: DisplayMedia[]) =>
    ({ projectionId: 'p', canonicalObjectId: 'c', objectType, publishedAt: '2026-09-26T00:00:00Z', visibility: 'public', actions: [], media }) as WallProjection;

  test('media[0] of the five image-drawing types, never media[1]', () => {
    for (const t of ['social_post', 'video', 'postcard', 'shared_moment', 'discovery'] as WallObjectType[]) {
      assert.equal(drawnWallMediaOf(proj(t, [image(), second]))?.mediaId, 'm1', t);
    }
  });

  test('nothing for a social update or a contextual opportunity, even when they carry media', () => {
    assert.equal(drawnWallMediaOf(proj('social_update', [image()])), undefined);
    assert.equal(drawnWallMediaOf(proj('contextual_opportunity', [image()])), undefined);
  });

  test('nothing when there is no media', () => {
    assert.equal(drawnWallMediaOf(proj('social_post')), undefined);
    assert.equal(drawnWallMediaOf(proj('social_post', [])), undefined);
  });
});

describe('wallImageTargetPx', () => {
  test('window width × scale, rounded up to a whole pixel', () => {
    assert.equal(wallImageTargetPx({ width: 390, scale: 3 }), 1170);
    assert.equal(wallImageTargetPx({ width: 411.4, scale: 2.625 }), 1080);
  });

  test('a nonsense window yields 0', () => {
    assert.equal(wallImageTargetPx({ width: 0, scale: 3 }), 0);
    assert.equal(wallImageTargetPx({ width: 390, scale: Number.NaN }), 0);
  });
});

describe('the client caps are the server caps', () => {
  const server = readFileSync(join(REPO, 'artifacts/api-server/src/lib/mediaProcessing.ts'), 'utf8');

  test('WALL_THUMBNAIL_DIM equals the server THUMBNAIL_DIM', () => {
    const m = server.match(/export const THUMBNAIL_DIM = (\d+);/);
    assert.ok(m, 'THUMBNAIL_DIM found in lib/mediaProcessing.ts');
    assert.equal(WALL_THUMBNAIL_DIM, Number(m[1]));
  });

  test('WALL_FEED_DIM equals the server FEED_DIM', () => {
    const m = server.match(/export const FEED_DIM = (\d+);/);
    assert.ok(m, 'FEED_DIM found in lib/mediaProcessing.ts');
    assert.equal(WALL_FEED_DIM, Number(m[1]));
  });
});
