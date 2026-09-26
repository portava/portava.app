/**
 * PostcardComposer — §37 "Thumbnail generation" on the production upload path.
 *
 * Before this, no video postcard had a thumbnail: the composer never sent
 * `thumbnailPath` to /complete (PostcardsTab.tsx says so in its own comment),
 * and the server has no decoder to make one. The composer now extracts a frame
 * on the device and uploads it for the reserved slot BEFORE completing, and
 * hands /complete the path the server derived.
 *
 * Drives the real composer through pick → Post with the transport flag at its
 * shipped default (off), i.e. the path production takes today.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import type * as ImagePickerNS from 'expo-image-picker';

let resolvePick: ((assets: ImagePickerNS.ImagePickerAsset[] | null) => void) | null = null;
const mockPickMedia = jest.fn(() =>
  new Promise<ImagePickerNS.ImagePickerAsset[] | null>((resolve) => {
    resolvePick = resolve;
  }),
);

// NOTE: intentionally exhaustive — useMediaPicker is the only export used.
jest.mock('../../hooks/useMediaPicker', () => ({
  useMediaPicker: () => ({ pickMedia: mockPickMedia }),
}));

// NOTE: intentionally exhaustive — useSafeAreaInsets is the only export used.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — a pass-through scroll wrapper.
jest.mock('../ui/KeyboardSafeView', () => ({
  KeyboardSafeView: ({ children }: any) => children,
}));

const mockCompleteUpload = jest.fn(async (..._args: unknown[]) => ({ ok: true, data: { ok: true, mediaCount: 1, hasVideo: true } }));
const mockDiscard = jest.fn(async (..._args: unknown[]) => undefined);
// NOTE: intentionally exhaustive — every postcards export the composer calls
// is stubbed so the upload path runs with no network.
jest.mock('../../services/postcards.ts', () => ({
  validatePostcardMedia: jest.fn(() => ({ ok: true })),
  createPostcard: jest.fn(async () => ({ ok: true, data: { id: 'post-1' } })),
  discardPostcardShell: (...args: unknown[]) => mockDiscard(...args),
  getUploadUrl: jest.fn(async () => ({ ok: true, data: { mediaId: 'media-1', uploadUrl: 'https://storage.test/u', path: 'u/post-1/media-1.mp4' } })),
  uploadToSignedUrl: jest.fn(async () => ({ ok: true })),
  completeUpload: (...args: unknown[]) => mockCompleteUpload(...args),
}));

const mockUploadVideoPoster = jest.fn(async (..._args: unknown[]) => 'u/post-1/media-1.mp4.poster.jpg');
// NOTE: intentionally exhaustive — the two uploadHttp exports the composer uses.
jest.mock('../../services/media/uploadHttp.ts', () => ({
  uploadVideoPoster: (...args: unknown[]) => mockUploadVideoPoster(...args),
  readFileBlob: async () => ({ size: 3_300_000 }),
}));

type Prepared = { ok: true; resized: boolean; asset: Record<string, unknown> } | { ok: false; message: string };
const mockPrepare = jest.fn(async (a: Record<string, unknown>): Promise<Prepared> => ({ ok: true, resized: false, asset: a }));
jest.mock('../../services/media/mediaProcessing.ts', () => ({
  ...jest.requireActual('../../services/media/mediaProcessing.ts'),
  prepareImageForUpload: (a: Record<string, unknown>) => mockPrepare(a),
}));

// NOTE: intentionally exhaustive — validateMedia gates video duration at pick time.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
}));

// NOTE: intentionally exhaustive — the place picker is a full modal.
jest.mock('../selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: () => null,
}));

// NOTE: intentionally exhaustive — the stamp sheet queries stamps.
jest.mock('../StampPickerSheet', () => ({
  StampPickerSheet: () => null,
}));

// NOTE: intentionally exhaustive — SVG overlay never shown for a video.
jest.mock('../StampOverlayBadge', () => ({
  StampOverlayBadge: () => null,
}));

// NOTE: intentionally exhaustive — layout math and constants only.
jest.mock('../../lib/stampOverlay.ts', () => ({
  clamp: jest.fn((v: number, min: number, max: number) => Math.min(Math.max(v, min), max)),
  clampOverlayPosition: jest.fn((x: number, y: number) => ({ x, y })),
  completePayloadFromDraft: jest.fn(() => ({})),
  draftFromOption: jest.fn((opt: any) => ({ ...opt, x: 0.5, y: 0.5, scale: 1, style: 'default' })),
  draftToRenderData: jest.fn(() => ({ label: '', x: 0.5, y: 0.5, scale: 1, style: 'default' })),
  overlayLayout: jest.fn(() => ({ left: 0, top: 0, size: 40 })),
  STAMP_OVERLAY_CORNERS: [],
  STAMP_OVERLAY_MAX_SCALE: 2,
  STAMP_OVERLAY_MIN_SCALE: 0.5,
  STAMP_OVERLAY_SCALE_STEP: 0.1,
  STAMP_OVERLAY_STYLES: [],
}));

// NOTE: intentionally exhaustive — no location is exercised here.
jest.mock('../../lib/location/locationPayload.ts', () => ({
  placeToLocationFields: jest.fn(() => ({})),
}));

import { PostcardComposer } from '../PostcardComposer.tsx';

function asset(kind: 'video' | 'image', size: { width: number; height: number } = { width: 1080, height: 1920 }): ImagePickerNS.ImagePickerAsset {
  return {
    uri: kind === 'video' ? 'file:///clip.mp4' : 'file:///photo.jpg',
    type: kind,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    width: size.width,
    height: size.height,
    fileName: kind === 'video' ? 'clip.mp4' : 'photo.jpg',
    fileSize: 2_000_000,
    duration: kind === 'video' ? 12_000 : null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

async function pickAndPost(kind: 'video' | 'image', size?: { width: number; height: number }, expectComplete = true) {
  const onSuccess = jest.fn();
  const view = await render(<PostcardComposer visible={true} onClose={jest.fn()} onSuccess={onSuccess} />);
  await act(async () => {
    fireEvent.press(view.getByText('Library'));
  });
  await waitFor(() => expect(resolvePick).not.toBeNull());
  await act(async () => {
    resolvePick!([asset(kind, size)]);
  });
  await waitFor(() => expect(view.getByText('Post')).toBeTruthy());
  await act(async () => {
    fireEvent.press(view.getByText('Post'));
  });
  if (expectComplete) await waitFor(() => expect(mockCompleteUpload).toHaveBeenCalledTimes(1));
  return { onSuccess, view };
}

describe('PostcardComposer — a video postcard gets a real poster (§37)', () => {
  beforeEach(() => {
    resolvePick = null;
    mockPickMedia.mockClear();
    mockCompleteUpload.mockClear();
    mockUploadVideoPoster.mockClear();
    mockDiscard.mockClear();
    mockPrepare.mockClear();
  });

  it('extracts and uploads a frame for the reserved slot, and hands /complete the server-derived path', async () => {
    const { onSuccess } = await pickAndPost('video');
    expect(mockUploadVideoPoster).toHaveBeenCalledWith('post-1', 'media-1', 'file:///clip.mp4');
    expect(mockCompleteUpload).toHaveBeenCalledWith(
      'post-1',
      'media-1',
      expect.objectContaining({ thumbnailPath: 'u/post-1/media-1.mp4.poster.jpg' }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(mockDiscard).not.toHaveBeenCalled();
  });

  it('a photo never asks for a poster', async () => {
    await pickAndPost('image');
    expect(mockUploadVideoPoster).not.toHaveBeenCalled();
    expect((mockCompleteUpload.mock.calls[0]![2] as { thumbnailPath?: string }).thumbnailPath).toBeUndefined();
  });

  it('a failed poster never blocks the post — the video completes without one', async () => {
    mockUploadVideoPoster.mockImplementationOnce(async () => null as unknown as string);
    const { onSuccess } = await pickAndPost('video');
    expect((mockCompleteUpload.mock.calls[0]![2] as { thumbnailPath?: string }).thumbnailPath).toBeUndefined();
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });
});

describe('PostcardComposer — the server envelope is enforced on the device (§40 mediaProcessing)', () => {
  beforeEach(() => {
    resolvePick = null;
    mockCompleteUpload.mockClear();
    mockPrepare.mockClear();
  });

  it('a photo larger than the server keeps is RESIZED before it travels — the resized file is what uploads', async () => {
    mockPrepare.mockImplementationOnce(async (a) => ({
      ok: true, resized: true,
      asset: { ...a, uri: 'file:///photo.resized.jpg', mimeType: 'image/jpeg', fileName: 'photo.jpg', width: 4096, height: 3072 },
    }));
    const { uploadToSignedUrl, getUploadUrl } = jest.requireMock('../../services/postcards.ts') as Record<string, jest.Mock>;
    uploadToSignedUrl.mockClear();
    getUploadUrl.mockClear();
    await pickAndPost('image', { width: 8000, height: 6000 });
    expect(mockPrepare).toHaveBeenCalledWith(expect.objectContaining({ width: 8000, height: 6000, isVideo: false }));
    expect(uploadToSignedUrl.mock.calls[0]![1]).toBe('file:///photo.resized.jpg');
    expect(getUploadUrl.mock.calls[0]![1]).toEqual({ mimeType: 'image/jpeg', fileSizeBytes: 3_300_000 });
  });

  it('a required resize that FAILS stops the post — the oversized original is never sent', async () => {
    mockPrepare.mockImplementationOnce(async () => ({ ok: false, message: 'This photo is too large and could not be resized on your device. Try a smaller photo.' }));
    const { createPostcard } = jest.requireMock('../../services/postcards.ts') as Record<string, jest.Mock>;
    createPostcard.mockClear();
    const { view } = await pickAndPost('image', { width: 8000, height: 6000 }, false);
    await waitFor(() => expect(view.getByText(/could not be resized/)).toBeTruthy());
    expect(createPostcard).not.toHaveBeenCalled();
  });

  it('a video is never passed through the image envelope', async () => {
    await pickAndPost('video');
    expect(mockPrepare).not.toHaveBeenCalled();
  });
});
