/**
 * Story and memory videos get their poster too (§37 "Thumbnail generation",
 * census-media §22). services/stories.ts and services/memories.ts post straight
 * to /api/media/upload without uploadMedia, so before this a story or memory
 * video was stored with no frame at all. After a VIDEO upload each now attaches
 * the poster in the background — derived route only, no extra image upload —
 * and a photo never asks for one.
 *
 * Runs under jest because both services import the token module at scope.
 */
const mockGetThumbnail = jest.fn(async (_uri: string, _opts: unknown) => ({ uri: 'file:///frame.jpg' }));
// NOTE: intentionally exhaustive — freshToken is the only export the services use.
jest.mock('../../apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { uploadStoryMedia } from '../../stories.ts';
import { uploadMemoryMedia } from '../../memories.ts';
// The frame is cut through mediaProcessing's own test seam (its native module is
// loaded lazily, which jest's VM cannot do).
import { _setTestMediaNatives } from '../mediaProcessing.ts';

const PATH = 'f0000000-0000-4000-a000-000000000001/1790000000000.mp4';

function installFetch(posterStatus = 201): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, blob: async () => ({ size: 1 }) });
  (globalThis as any).fetch = jest.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).startsWith('file://')) return res(200, null);
    if (String(url).includes('/api/media/upload/poster')) {
      return posterStatus === 201 ? res(201, { thumbnailUrl: `post-media/${PATH}.poster.jpg` }) : res(posterStatus, { error: 'not_found' });
    }
    if (String(url).endsWith('/api/media/upload')) return res(201, { url: `post-media/${PATH}`, path: PATH });
    return res(404, null);
  });
  return calls;
}

async function settle(until?: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  do {
    await new Promise((r) => setTimeout(r, 10));
  } while (until && !until() && Date.now() < deadline);
}

describe('story and memory videos get the poster the server derives', () => {
  const saved = (globalThis as any).fetch;
  beforeAll(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    _setTestMediaNatives({ thumbnail: (uri, opts) => mockGetThumbnail(uri, opts) });
  });
  afterAll(() => {
    (globalThis as any).fetch = saved;
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    _setTestMediaNatives({ thumbnail: null });
  });

  for (const [name, upload] of [['story', uploadStoryMedia], ['memory', uploadMemoryMedia]] as const) {
    it(`${name}: a video upload is followed by its poster on the derived route, and nothing else`, async () => {
      const calls = installFetch();
      const url = await upload('file:///clip.mp4', 'video/mp4');
      expect(url).toBe(`post-media/${PATH}`);
      await settle(() => calls.some((c) => c.url.includes('/api/media/upload/poster')));
      const poster = calls.filter((c) => c.url.includes('/api/media/upload/poster'));
      expect(poster).toHaveLength(1);
      expect(poster[0]!.url).toBe(`https://api.test/api/media/upload/poster?path=${encodeURIComponent(PATH)}`);
      expect(calls.filter((c) => c.url.endsWith('/api/media/upload'))).toHaveLength(1);
    });

    it(`${name}: an API without the poster route gets NO extra image upload (these paths never had one)`, async () => {
      const calls = installFetch(404);
      await upload('file:///clip.mp4', 'video/mp4');
      await settle(() => calls.some((c) => c.url.includes('/api/media/upload/poster')));
      await settle(() => false, 100);
      expect(calls.filter((c) => c.url.endsWith('/api/media/upload'))).toHaveLength(1);
    });

    it(`${name}: a photo never asks for a poster`, async () => {
      const calls = installFetch();
      mockGetThumbnail.mockClear();
      await upload('file:///p.jpg', 'image/jpeg');
      await settle(() => false, 200);
      expect(mockGetThumbnail).not.toHaveBeenCalled();
      expect(calls.some((c) => c.url.includes('/poster'))).toBe(false);
    });
  }
});
