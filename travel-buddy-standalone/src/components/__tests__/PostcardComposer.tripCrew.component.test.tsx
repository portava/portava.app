import './composerDraftTestRuntime.ts';
/**
 * PostcardComposer — "Trip crew only" is offered only with a trip.
 *
 * The composer offered "Trip crew only" but never sent a trip, so the server
 * stored the postcard trip_only with trip_id null — visible to nobody but its
 * author. Without a tripId the option is gone; with one it is offered and the
 * postcard is created with that tripId.
 *
 * Drives the real composer through pick → Post on the shipped transport (off).
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

// NOTE: intentionally exhaustive — every postcards export the composer calls
// is stubbed so the upload path runs with no network.
jest.mock('../../services/postcards.ts', () => ({
  validatePostcardMedia: jest.fn(() => ({ ok: true })),
  createPostcard: jest.fn(async () => ({ ok: true, data: { id: 'post-1' } })),
  discardPostcardShell: jest.fn(async () => undefined),
  getUploadUrl: jest.fn(async () => ({ ok: true, data: { mediaId: 'media-1', uploadUrl: 'https://storage.test/u', path: 'u/post-1/media-1.jpg' } })),
  uploadToSignedUrl: jest.fn(async () => ({ ok: true })),
  completeUpload: jest.fn(async () => ({ ok: true, data: { ok: true, mediaCount: 1, hasVideo: false } })),
}));

// NOTE: intentionally exhaustive — the two uploadHttp exports the composer uses.
jest.mock('../../services/media/uploadHttp.ts', () => ({
  uploadVideoPoster: jest.fn(async () => null),
  readFileBlob: async () => ({ size: 2_000_000 }),
}));

jest.mock('../../services/media/mediaProcessing.ts', () => ({
  ...jest.requireActual('../../services/media/mediaProcessing.ts'),
  prepareImageForUpload: async (a: Record<string, unknown>) => ({ ok: true, resized: false, asset: a }),
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

// NOTE: intentionally exhaustive — SVG overlay is not under test.
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

import { PostcardComposer } from '../PostcardComposer.tsx';

const postcards = require('../../services/postcards.ts');

function photo(): ImagePickerNS.ImagePickerAsset {
  return {
    uri: 'file:///photo.jpg', type: 'image', mimeType: 'image/jpeg', width: 1080, height: 1440,
    fileName: 'photo.jpg', fileSize: 2_000_000, duration: null, assetId: null, base64: null, exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

async function pickAndOpenVisibility(tripId?: string) {
  const view = await render(<PostcardComposer visible onClose={jest.fn()} onSuccess={jest.fn()} tripId={tripId} />);
  await act(async () => { fireEvent.press(view.getByText('Library')); });
  await waitFor(() => expect(resolvePick).not.toBeNull());
  await act(async () => { resolvePick!([photo()]); });
  await waitFor(() => expect(view.getByText('Post')).toBeTruthy());
  await act(async () => { fireEvent.press(view.getByText('Public')); });
  await waitFor(() => expect(view.getByText('Only me')).toBeTruthy());
  return view;
}

beforeEach(() => {
  resolvePick = null;
  postcards.createPostcard.mockClear();
});

test('without a trip, "Trip crew only" is not offered (it was stored trip_only with no trip — seen by nobody)', async () => {
  const view = await pickAndOpenVisibility(undefined);
  expect(view.queryByText('Trip crew only')).toBeNull();
  await act(async () => { fireEvent.press(view.getByText('Post')); });
  await waitFor(() => expect(postcards.createPostcard).toHaveBeenCalledTimes(1));
  expect(postcards.createPostcard.mock.calls[0][0]).not.toHaveProperty('tripId');
});

test('with a trip, "Trip crew only" is offered and the postcard is created with that trip', async () => {
  const view = await pickAndOpenVisibility('trip-1');
  await act(async () => { fireEvent.press(view.getByText('Trip crew only')); });
  await act(async () => { fireEvent.press(view.getByText('Post')); });
  await waitFor(() => expect(postcards.createPostcard).toHaveBeenCalledTimes(1));
  expect(postcards.createPostcard.mock.calls[0][0]).toMatchObject({ tripId: 'trip-1', visibility: 'trip_only' });
});
