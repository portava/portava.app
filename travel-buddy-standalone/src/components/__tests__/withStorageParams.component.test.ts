/**
 * withStorageParams — signed-URL preservation guard
 *
 * Regression test for the bug fixed in the task that introduced the /sign/ guard:
 * query params to Supabase signed URLs (/object/sign/). The object endpoint
 * rejects those params and returns an error, permanently blanking any tile
 * whose signed URL got the params appended.
 *
 * The fix skips any URL containing '/sign/'. This test locks that behaviour
 * so a future refactor can't silently re-introduce the corruption.
 *
 * Run with: pnpm test (Jest picks up src/**\/*.test.ts)
 */

import { withStorageParams } from '../CachedImage.tsx';

const PROJECT = 'https://abcdefghijkl.supabase.co';
const PARAMS = 'width=400&quality=80';

describe('withStorageParams', () => {
  describe('signed URLs — must be returned unchanged', () => {
    it('leaves /object/sign/ URLs untouched', () => {
      const url = `${PROJECT}/storage/v1/object/sign/post-media/user-1/photo.jpg?token=tok123`;
      expect(withStorageParams(url, PARAMS)).toBe(url);
    });

    it('leaves /render/image/sign/ URLs untouched', () => {
      const url = `${PROJECT}/storage/v1/render/image/sign/post-media/user-1/photo.jpg?token=tok456&width=800`;
      expect(withStorageParams(url, PARAMS)).toBe(url);
    });

    it('leaves a /object/sign/ URL with no existing query string untouched', () => {
      // Ensure the guard fires even without a trailing ?token=... fragment.
      const url = `${PROJECT}/storage/v1/object/sign/avatars/user-2/avatar.jpg`;
      expect(withStorageParams(url, PARAMS)).toBe(url);
    });
  });

  describe('public storage URLs — params should be appended', () => {
    it('appends params to a /object/public/ URL that has no existing query string', () => {
      const url = `${PROJECT}/storage/v1/object/public/avatars/user-1/avatar.jpg`;
      expect(withStorageParams(url, PARAMS)).toBe(`${url}?${PARAMS}`);
    });

    it('appends params with & when the public URL already has a query string', () => {
      const url = `${PROJECT}/storage/v1/object/public/avatars/user-1/avatar.jpg?v=2`;
      expect(withStorageParams(url, PARAMS)).toBe(`${url}&${PARAMS}`);
    });

    it('does not double-append when width= is already present', () => {
      const url = `${PROJECT}/storage/v1/object/public/avatars/user-1/avatar.jpg?width=200&quality=60`;
      expect(withStorageParams(url, PARAMS)).toBe(url);
    });

    // The render endpoint (/render/image/public/) accepts the same transform
    // query params as /object/public/ — callers that pass a render-endpoint
    // URL should get params appended, not silently stripped.
    it('appends params to a /render/image/public/ URL that has no existing query string', () => {
      const url = `${PROJECT}/storage/v1/render/image/public/avatars/user-1/avatar.jpg`;
      expect(withStorageParams(url, PARAMS)).toBe(`${url}?${PARAMS}`);
    });

    it('appends params with & to a /render/image/public/ URL that already has a query string', () => {
      const url = `${PROJECT}/storage/v1/render/image/public/avatars/user-1/avatar.jpg?quality=60`;
      expect(withStorageParams(url, PARAMS)).toBe(`${url}&${PARAMS}`);
    });

    it('does not double-append when width= is already present on a /render/image/public/ URL', () => {
      const url = `${PROJECT}/storage/v1/render/image/public/avatars/user-1/avatar.jpg?width=200&quality=60`;
      expect(withStorageParams(url, PARAMS)).toBe(url);
    });
  });

  describe('non-Supabase URLs — must be returned unchanged', () => {
    it('leaves CDN URLs untouched', () => {
      const url = 'https://images.unsplash.com/photo-123?auto=format&fit=crop&w=800';
      expect(withStorageParams(url, PARAMS)).toBe(url);
    });

    it('leaves arbitrary HTTPS URLs untouched', () => {
      const url = 'https://example.com/photo.jpg';
      expect(withStorageParams(url, PARAMS)).toBe(url);
    });
  });

  describe('null / undefined input', () => {
    it('returns undefined for undefined', () => {
      expect(withStorageParams(undefined, PARAMS)).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(withStorageParams(null, PARAMS)).toBeUndefined();
    });
  });
});
