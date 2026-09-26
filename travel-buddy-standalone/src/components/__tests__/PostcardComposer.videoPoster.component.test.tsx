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
// NOTE: intentionally exhaustive — uploadVideoPoster is the only export the composer uses.
jest.mock('../../services/media/uploadHttp.ts', () => ({
  uploadVideoPoster: (...args: unknown[]) => mockUploadVideoPoster(...args),
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

function asset(kind: 'video' | 'image'): ImagePickerNS.ImagePickerAsset {
  return {
    uri: kind === 'video' ? 'file:///clip.mp4' : 'file:///photo.jpg',
    type: kind,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    width: 1080,
    height: 1920,
    fileName: kind === 'video' ? 'clip.mp4' : 'photo.jpg',
    fileSize: 2_000_000,
    duration: kind === 'video' ? 12_000 : null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

async function pickAndPost(kind: 'video' | 'image') {
  const onSuccess = jest.fn();
  const view = await render(<PostcardComposer visible={true} onClose={jest.fn()} onSuccess={onSuccess} />);
  await act(async () => {
    fireEvent.press(view.getByText('Library'));
  });
  await waitFor(() => expect(resolvePick).not.toBeNull());
  await act(async () => {
    resolvePick!([asset(kind)]);
  });
  await waitFor(() => expect(view.getByText('Post')).toBeTruthy());
  await act(async () => {
    fireEvent.press(view.getByText('Post'));
  });
  await waitFor(() => expect(mockCompleteUpload).toHaveBeenCalledTimes(1));
  return { onSuccess };
}

describe('PostcardComposer — a video postcard gets a real poster (§37)', () => {
  beforeEach(() => {
    resolvePick = null;
    mockPickMedia.mockClear();
    mockCompleteUpload.mockClear();
    mockUploadVideoPoster.mockClear();
    mockDiscard.mockClear();
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
