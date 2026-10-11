/**
 * PostcardComposer with a `layover` — census-layover L275, the postcard half.
 *
 * The composer is the ordinary one; told which COMPLETED layover it is of, it
 * shows the layover as the place (no picker), starts as "Only me", and sends the
 * layover id INSTEAD of any location — the server takes city/country from the
 * layover and refuses a location sent alongside it (layoverPostcard.test.ts in
 * the api-server). Without a layover, nothing changes.
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

// NOTE: intentionally exhaustive — a SENTINEL place, so a layover postcard that
// leaked the picker's mapping into its body is visible.
jest.mock('../../lib/location/locationPayload.ts', () => ({
  placeToLocationFields: jest.fn(() => ({ locationCity: 'PICKED', locationLat: 1, placeId: 'picked:1' })),
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

async function pickAndPost(layover: { sessionId: string; city: string | null } | undefined) {
  const view = await render(<PostcardComposer visible onClose={jest.fn()} onSuccess={jest.fn()} layover={layover} />);
  await act(async () => { fireEvent.press(view.getByText('Library')); });
  await waitFor(() => expect(resolvePick).not.toBeNull());
  await act(async () => { resolvePick!([photo()]); });
  await waitFor(() => expect(view.getByText('Post')).toBeTruthy());
  return view;
}

beforeEach(() => {
  resolvePick = null;
  postcards.createPostcard.mockClear();
  mockCompleteUpload.mockClear();
});

test('a layover postcard shows the layover as its place, and the place cannot be re-picked', async () => {
  const view = await pickAndPost({ sessionId: 'sess-1', city: 'Taipei' });
  expect(view.getByTestId('postcard-layover-place')).toBeTruthy();
  expect(view.getByText('Layover in Taipei')).toBeTruthy();
  expect(view.queryByText('Search for a city')).toBeNull();
});

test('it is created through the EXISTING route with only the layover id — no picked place — and starts private', async () => {
  const view = await pickAndPost({ sessionId: 'sess-1', city: 'Taipei' });
  await act(async () => { fireEvent.press(view.getByText('Post')); });
  await waitFor(() => expect(postcards.createPostcard).toHaveBeenCalledTimes(1));
  const body = postcards.createPostcard.mock.calls[0][0];
  expect(body.layoverSessionId).toBe('sess-1');
  expect(body.visibility).toBe('private');
  for (const k of ['locationCity', 'locationCountry', 'locationLat', 'locationLng', 'placeId', 'canonicalLocationId', 'locationName']) {
    expect(body).not.toHaveProperty(k);
  }
  await waitFor(() => expect(mockCompleteUpload).toHaveBeenCalledTimes(1));
});

test('without a layover the composer is unchanged: the picked place is sent, public by default, no layover id', async () => {
  const view = await pickAndPost(undefined);
  expect(view.queryByTestId('postcard-layover-place')).toBeNull();
  await act(async () => { fireEvent.press(view.getByText('Post')); });
  await waitFor(() => expect(postcards.createPostcard).toHaveBeenCalledTimes(1));
  const body = postcards.createPostcard.mock.calls[0][0];
  expect(body).not.toHaveProperty('layoverSessionId');
  expect(body.locationCity).toBe('PICKED');
  expect(body.visibility).toBe('public');
});
