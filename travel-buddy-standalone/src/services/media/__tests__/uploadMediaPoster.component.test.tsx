/**
 * services/media.ts `uploadMedia` — §37 "Thumbnail generation" on the general
 * upload path, through the REAL module (census-media §22).
 *
 * Before: the frame was uploaded as an unrelated image through /api/media/upload
 * and the video's canonical row never learned it had a poster. Now the frame is
 * sent to /api/media/upload/poster for THE STORAGE PATH THE VIDEO UPLOAD
 * RETURNED, and the pre-existing image upload is only the fallback for an API
 * without that route.
 *
 * Runs under jest (not node:test) because services/media.ts imports
 * expo-video-thumbnails and lib/supabase at module scope.
 */
const mockGetThumbnail = jest.fn(async (_uri: string, _opts: unknown) => ({ uri: 'file:///frame.jpg' }));
// NOTE: intentionally exhaustive — getThumbnailAsync is the only export media.ts uses.
jest.mock('expo-video-thumbnails', () => ({
  getThumbnailAsync: (uri: string, opts: unknown) => mockGetThumbnail(uri, opts),
}));

import { uploadMedia, _setTestTokenProvider, _setTestConfiguredOverride } from '../../media.ts';

const VIDEO_PATH = 'f0000000-0000-4000-a000-000000000001/1790000000000.mp4';
const VIDEO = { uri: 'file:///clip.mp4', type: 'video' as const, mimeType: 'video/mp4', fileSize: 1000, duration: 4 };

type Call = { url: string; method: string };

function installFetch(posterStatus: number): Call[] {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => ({ size: 10 }),
  });
  (globalThis as any).fetch = jest.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).startsWith('file://')) return json(200, null);
    if (String(url).includes('/api/media/upload/poster')) {
      return posterStatus === 201
        ? json(201, { thumbnailUrl: `post-media/${VIDEO_PATH}.poster.jpg`, thumbnailPath: `${VIDEO_PATH}.poster.jpg` })
        : json(posterStatus, { error: 'not_found' });
    }
    if (String(url).endsWith('/api/media/upload')) {
      // First call is the video; a second one is the legacy frame upload.
      const n = calls.filter((c) => c.url.endsWith('/api/media/upload')).length;
      return n === 1
        ? json(201, { url: `post-media/${VIDEO_PATH}`, path: VIDEO_PATH, thumbnailUrl: null, durationSeconds: 4 })
        : json(201, { url: 'post-media/u/legacy-frame.jpg', path: 'u/legacy-frame.jpg' });
    }
    return json(404, null);
  });
  return calls;
}

describe('uploadMedia — a video gets ITS poster, not an unrelated image', () => {
  const savedFetch = (globalThis as any).fetch;
  beforeAll(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    _setTestConfiguredOverride(true);
    _setTestTokenProvider(async () => 'tok');
  });
  afterAll(() => {
    (globalThis as any).fetch = savedFetch;
    _setTestConfiguredOverride(null);
    _setTestTokenProvider(null);
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  });

  it('sends the frame to /api/media/upload/poster for the path the video upload returned', async () => {
    const calls = installFetch(201);
    const r = await uploadMedia(VIDEO, { maxVideoDurationSeconds: 60 });
    expect(r.ok).toBe(true);
    expect(r.thumbnailUrl).toBe(`post-media/${VIDEO_PATH}.poster.jpg`);
    const poster = calls.find((c) => c.url.includes('/api/media/upload/poster'));
    expect(poster?.url).toBe(`https://api.test/api/media/upload/poster?path=${encodeURIComponent(VIDEO_PATH)}`);
    expect(poster?.method).toBe('POST');
    expect(calls.filter((c) => c.url.endsWith('/api/media/upload'))).toHaveLength(1);
  });

  it('against an API without the poster route it falls back to the pre-existing frame upload', async () => {
    const calls = installFetch(404);
    const r = await uploadMedia(VIDEO, { maxVideoDurationSeconds: 60 });
    expect(r.ok).toBe(true);
    expect(r.thumbnailUrl).toBe('post-media/u/legacy-frame.jpg');
    expect(calls.filter((c) => c.url.endsWith('/api/media/upload'))).toHaveLength(2);
  });

  it('a photo never asks for a poster', async () => {
    const calls = installFetch(201);
    mockGetThumbnail.mockClear();
    await uploadMedia({ uri: 'file:///p.jpg', type: 'image', mimeType: 'image/jpeg', fileSize: 10 });
    expect(mockGetThumbnail).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('/poster'))).toBe(false);
  });
});

// ── census-media §37, MD282: uploadMedia reads its file through the compression
// seam. The native module is a TEST DOUBLE; what is proved is which file is read.
import { _setTestVideoCompressionFlag, _setTestVideoCompressorLookup } from '../videoCompression.ts';

describe('uploadMedia — MD282: the original file unless a compressor is present and switched on', () => {
  const savedFetch = (globalThis as any).fetch;
  const smaller = () => ({ compressAsync: async () => ({ uri: 'file:///clip.small.mp4', sizeBytes: 400, width: 720, height: 1280 }) });
  beforeAll(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    _setTestConfiguredOverride(true);
    _setTestTokenProvider(async () => 'tok');
  });
  afterAll(() => {
    (globalThis as any).fetch = savedFetch;
    _setTestConfiguredOverride(null);
    _setTestTokenProvider(null);
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  });
  afterEach(() => { _setTestVideoCompressionFlag(null); _setTestVideoCompressorLookup(null); });

  it('shipped (switch off): the picked file is read, even with a module present', async () => {
    _setTestVideoCompressorLookup(smaller);
    const calls = installFetch(201);
    await uploadMedia(VIDEO, { maxVideoDurationSeconds: 60 });
    expect(calls[0]!.url).toBe('file:///clip.mp4');
  });

  it('switch on, module present, copy smaller than the picker size: the COMPRESSED copy is read', async () => {
    _setTestVideoCompressionFlag(true);
    _setTestVideoCompressorLookup(smaller);
    const calls = installFetch(201);
    await uploadMedia(VIDEO, { maxVideoDurationSeconds: 60 });
    expect(calls[0]!.url).toBe('file:///clip.small.mp4');
  });
});
