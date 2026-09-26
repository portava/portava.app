/**
 * §37 "Thumbnail generation" on the general upload path (census-media §22).
 * The device cuts the frame; the server decides where it lives. These tests pin
 * the client half: the derived route first, the pre-existing image upload only
 * as a fallback, and no poster at all only when the device could not cut one.
 *
 * Run: node --import tsx --test src/services/media/__tests__/generalVideoPoster.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachVideoPoster, type GeneralPosterDeps } from '../generalVideoPoster.ts';

const PATH = 'f0000000-0000-4000-a000-000000000001/1790000000000.mp4';

function deps(over: Partial<GeneralPosterDeps> & { calls?: string[] } = {}): GeneralPosterDeps & { calls: string[] } {
  const calls: string[] = over.calls ?? [];
  return {
    calls,
    extract: over.extract ?? (async () => { calls.push('extract'); return 'file:///frame.jpg'; }),
    postPoster: over.postPoster ?? (async (p) => {
      calls.push(`poster:${p}`);
      return { status: 201, body: { thumbnailUrl: `post-media/${p}.poster.jpg` } };
    }),
    uploadAsImage: over.uploadAsImage ?? (async () => { calls.push('legacy'); return 'post-media/u/legacy.jpg'; }),
  };
}

describe('attachVideoPoster', () => {
  it('sends the frame to the video\'s own poster route and uses the path the SERVER derived', async () => {
    const d = deps();
    const out = await attachVideoPoster(PATH, 'file:///v.mp4', d);
    assert.deepEqual(out, { thumbnailUrl: `post-media/${PATH}.poster.jpg`, route: 'derived' });
    assert.deepEqual(d.calls, ['extract', `poster:${PATH}`], 'no second, unlinked image upload');
  });

  it('409 means the video already has its poster (a retry after a lost answer) — use it, upload nothing', async () => {
    const d = deps({ postPoster: async () => ({ status: 409, body: { error: 'conflict' } }) });
    const out = await attachVideoPoster(PATH, 'file:///v.mp4', d);
    assert.deepEqual(out, { thumbnailUrl: `post-media/${PATH}.poster.jpg`, route: 'already_had_one' });
    assert.equal(d.calls.includes('legacy'), false);
  });

  it('an API without the route (404), any other refusal, or no answer → the pre-existing image upload', async () => {
    for (const postPoster of [
      async () => ({ status: 404, body: { error: 'not_found' } }),
      async () => ({ status: 500, body: null }),
      async () => { throw new Error('offline'); },
      async () => ({ status: 201, body: {} }),
    ]) {
      const d = deps({ postPoster });
      const out = await attachVideoPoster(PATH, 'file:///v.mp4', d);
      assert.deepEqual(out, { thumbnailUrl: 'post-media/u/legacy.jpg', route: 'legacy_image' });
    }
  });

  it('with no storage path (an older upload response) it goes straight to the image upload', async () => {
    const d = deps();
    const out = await attachVideoPoster(null, 'file:///v.mp4', d);
    assert.equal(out.route, 'legacy_image');
    assert.equal(d.calls.some((c) => c.startsWith('poster:')), false);
  });

  it('no frame → no poster and no request of any kind; a failing fallback → null, never a throw', async () => {
    const d = deps({ extract: async () => null });
    assert.deepEqual(await attachVideoPoster(PATH, 'file:///v.mp4', d), { thumbnailUrl: null, route: 'none' });
    assert.deepEqual(d.calls, []);
    const throwing = deps({ extract: async () => { throw new Error('codec'); } });
    assert.deepEqual(await attachVideoPoster(PATH, 'file:///v.mp4', throwing), { thumbnailUrl: null, route: 'none' });
    const bothFail = deps({
      postPoster: async () => ({ status: 503, body: null }),
      uploadAsImage: async () => { throw new Error('offline'); },
    });
    assert.deepEqual(await attachVideoPoster(PATH, 'file:///v.mp4', bothFail), { thumbnailUrl: null, route: 'none' });
  });
});
