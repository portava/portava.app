/**
 * feedAutoplay — which Pulse card plays its video by itself (2026-11-04: "videos should play on auto").
 *
 * Run: node --import tsx/esm --test src/lib/media/__tests__/feedAutoplay.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pulseCardVideoRef, firstAutoplayCardId, FEED_AUTOPLAY_VISIBLE_PERCENT } from '../feedAutoplay.ts';

const videoPost = (id: string) => ({ id, type: 'post', media: [{ url: `post-media/u-1/${id}.mov`, media_type: 'video' }] });
const photoPost = (id: string) => ({ id, type: 'post', media: [{ url: `post-media/u-1/${id}.jpg`, media_type: 'image' }] });
const token = (item: unknown, index: number, isViewable = true) => ({ item, index, isViewable });

describe('pulseCardVideoRef', () => {
  it('a post whose first media item is a video plays that item', () => {
    assert.equal(pulseCardVideoRef(videoPost('a')), 'post-media/u-1/a.mov');
  });
  it('a post whose first media item is a photo plays nothing, even with a video later in the carousel', () => {
    assert.equal(pulseCardVideoRef({ ...photoPost('a'), media: [...photoPost('a').media, ...videoPost('b').media] }), null);
  });
  it('a post with no media item plays its media URL when that names a video file (the #776 camera videos)', () => {
    assert.equal(pulseCardVideoRef({ id: 'a', type: 'post', mediaUrl: 'post-media/u-1/a.MOV' }), 'post-media/u-1/a.MOV');
    assert.equal(pulseCardVideoRef({ id: 'a', type: 'post', media: [], mediaUrl: 'post-media/u-1/a.mp4' }), 'post-media/u-1/a.mp4');
    assert.equal(pulseCardVideoRef({ id: 'a', type: 'post', mediaUrl: 'post-media/u-1/a.jpg' }), null);
  });
  it('a video item with no URL, a text post and every non-post card play nothing', () => {
    assert.equal(pulseCardVideoRef({ id: 'a', type: 'post', media: [{ url: null, media_type: 'video' }] }), null);
    assert.equal(pulseCardVideoRef({ id: 'a', type: 'post' }), null);
    for (const type of ['hidden_gem', 'itinerary', 'question', 'rent_a_buddy', 'place_card']) {
      assert.equal(pulseCardVideoRef({ ...videoPost('a'), type }), null, type);
    }
  });
});

describe('firstAutoplayCardId', () => {
  it('picks the first VIEWABLE video card in list order, skipping photos and text', () => {
    const picked = firstAutoplayCardId([token(photoPost('p'), 3), token(videoPost('v2'), 5), token(videoPost('v1'), 4), token({ id: 'q', type: 'question' }, 2)]);
    assert.equal(picked, 'v1');
  });
  it('a card that has left the screen is not picked', () => {
    assert.equal(firstAutoplayCardId([token(videoPost('gone'), 1, false), token(videoPost('here'), 2)]), 'here');
  });
  it('no video on screen, or nothing on screen, means nothing plays', () => {
    assert.equal(firstAutoplayCardId([token(photoPost('p'), 0)]), null);
    assert.equal(firstAutoplayCardId([]), null);
  });
  it('a card plays only once it is mostly on screen', () => {
    assert.ok(FEED_AUTOPLAY_VISIBLE_PERCENT >= 50 && FEED_AUTOPLAY_VISIBLE_PERCENT <= 100);
  });
});
