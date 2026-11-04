/**
 * videoPosterRef — a video FILE is recognised by its extension, and its poster lives at its own path + `.poster.jpg`.
 *
 * Run: node --import tsx/esm --test src/lib/media/__tests__/videoPosterRef.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isVideoRef, derivedVideoPosterRef, VIDEO_POSTER_SUFFIX, postTileStill } from '../videoPosterRef.ts';

describe('isVideoRef', () => {
  it('recognises the video files the app uploads, in any case, with or without a query', () => {
    for (const ref of [
      'post-media/u-1/1792727980484.mov', 'post-media/u-1/a.MOV', 'post-media/u-1/a.mp4', 'post-media/u-1/a.m4v',
      'post-media/u-1/a.webm', 'https://x.supabase.co/storage/v1/object/sign/post-media/u-1/a.mov?token=t#frag',
    ]) assert.equal(isVideoRef(ref), true, ref);
  });
  it('a photo, a poster, an empty ref and nothing are not videos', () => {
    for (const ref of ['post-media/u-1/a.jpg', 'post-media/u-1/a.mov.poster.jpg', 'post-media/u-1/movie.jpg', '', null, undefined]) {
      assert.equal(isVideoRef(ref as string | null | undefined), false, String(ref));
    }
  });
});

describe('derivedVideoPosterRef', () => {
  it('is the video path plus .poster.jpg — the name production stores (1792727980484.mov.poster.jpg)', () => {
    assert.equal(VIDEO_POSTER_SUFFIX, '.poster.jpg');
    assert.equal(derivedVideoPosterRef('post-media/u-1/1792727980484.mov'), 'post-media/u-1/1792727980484.mov.poster.jpg');
  });
  it('drops a signed URL token, so the poster is signed on its own', () => {
    assert.equal(derivedVideoPosterRef('https://x/sign/post-media/u-1/a.mp4?token=t'), 'https://x/sign/post-media/u-1/a.mp4.poster.jpg');
  });
  it('is null for anything that is not a video', () => {
    assert.equal(derivedVideoPosterRef('post-media/u-1/a.jpg'), null);
    assert.equal(derivedVideoPosterRef(null), null);
  });
});

describe('postTileStill', () => {
  it('a photo post draws its media item (thumbnail first), else its first media_urls entry', () => {
    assert.deepEqual(postTileStill({ media: [{ url: 'post-media/u/a.jpg', media_type: 'image', thumbnail_url: 'post-media/u/a.t.jpg' }] }), { uri: 'post-media/u/a.t.jpg', isVideo: false });
    assert.deepEqual(postTileStill({ media: [], mediaUrls: ['post-media/u/b.jpg'] }), { uri: 'post-media/u/b.jpg', isVideo: false });
  });
  it('a video post draws a poster, never the video file', () => {
    assert.deepEqual(postTileStill({ media: [{ url: 'post-media/u/v.mov', media_type: 'video', thumbnail_url: 'post-media/u/v.jpg' }] }), { uri: 'post-media/u/v.jpg', isVideo: true });
    assert.deepEqual(postTileStill({ mediaUrls: ['post-media/u/v.mov'], mediaThumbnailUrl: 'post-media/u/p.jpg' }), { uri: 'post-media/u/p.jpg', isVideo: true });
    assert.deepEqual(postTileStill({ mediaUrls: ['post-media/u/v.mov'] }), { uri: 'post-media/u/v.mov.poster.jpg', isVideo: true });
  });
  it('a text-only post has no still', () => {
    assert.deepEqual(postTileStill({ media: [], mediaUrls: [] }), { uri: null, isVideo: false });
  });
});
