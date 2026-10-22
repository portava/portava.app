/**
 * validateMedia — the iPhone camera's `.mov` is an accepted video.
 *
 * expo-image-picker saves every camera recording as `.mov` (video/quicktime) and the server stores QuickTime
 * (lib/mediaPipeline.ts ALLOWED_MEDIA_MIME), but the client accepted only video/mp4: on the owner's iPhone
 * (2026-10-22) every recording was "Unsupported media type: video/quicktime". Size and duration still apply.
 *
 * Jest, not node:test: services/media.ts imports native Expo modules (see run-node-tests.mjs KNOWN_BROKEN).
 */
import { validateMedia } from '../media.ts';
import { VIDEO_MAX_SIZE_BYTES } from '../../constants/mediaLimits.ts';

// NOTE: intentionally exhaustive — validateMedia is pure; the real client would start Supabase's auth timers in jest.
jest.mock('../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: false }));
// NOTE: intentionally exhaustive — token minting is not reached by validateMedia.
jest.mock('../apiToken.ts', () => ({ freshToken: jest.fn() }));
// NOTE: intentionally exhaustive — the native thumbnailer is not reached by validateMedia.
jest.mock('expo-video-thumbnails', () => ({ getThumbnailAsync: jest.fn() }));

describe('validateMedia — camera .mov', () => {
  it('accepts video/quicktime within the surface limits', () => {
    expect(validateMedia({ uri: 'file:///rec.mov', type: 'video', mimeType: 'video/quicktime', duration: 12, fileSize: 18_000_000 }, { maxVideoDurationSeconds: 60 })).toEqual({ ok: true });
  });

  it('still refuses one that is too long or too large — with its real numbers, not "unsupported"', () => {
    const long = validateMedia({ uri: 'file:///rec.mov', type: 'video', mimeType: 'video/quicktime', duration: 75 }, { maxVideoDurationSeconds: 60 });
    expect(long).toEqual(expect.objectContaining({ ok: false, message: expect.stringMatching(/up to 60 seconds/) }));
    const big = validateMedia({ uri: 'file:///rec.mov', type: 'video', mimeType: 'video/quicktime', duration: 30, fileSize: VIDEO_MAX_SIZE_BYTES + 12_000_000 }, { maxVideoDurationSeconds: 60 });
    expect(big).toEqual(expect.objectContaining({ ok: false, message: expect.stringMatching(/^File too large \(59MB; max 48MB\)$/) }));
  });

  it('a HEIC that could not be converted is still refused by name', () => {
    expect(validateMedia({ uri: 'file:///IMG.HEIC', type: 'image', mimeType: 'image/heic' })).toEqual(expect.objectContaining({ ok: false, message: expect.stringMatching(/image\/heic/) }));
  });
});
