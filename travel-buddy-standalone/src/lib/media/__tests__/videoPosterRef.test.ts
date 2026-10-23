/**
 * videoPosterRef — a video FILE is recognised by its extension, and its poster lives at its own path + `.poster.jpg`.
 *
 * Run: node --import tsx/esm --test src/lib/media/__tests__/videoPosterRef.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isVideoRef, derivedVideoPosterRef, VIDEO_POSTER_SUFFIX } from '../videoPosterRef.ts';

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
