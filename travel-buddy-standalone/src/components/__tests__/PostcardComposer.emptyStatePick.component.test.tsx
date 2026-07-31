/**
 * PostcardComposer — empty-state media pick test.
 *
 * Regression guard for the Camera / Library picker buttons in the empty state.
 * PostcardComposer now uses useMediaPicker (not a direct MediaSourceSheet render),
 * so these tests mock useMediaPicker and drive picks via the returned pickMedia promise.
 *
 * Tests:
 *   1. Camera and Library buttons are visible in the empty state.
 *   2. Pressing Camera calls pickMedia.
 *   3. Pressing Library calls pickMedia.
 *   4. Resolving pickMedia with an asset populates the preview and hides the picker.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import type * as ImagePickerNS from 'expo-image-picker';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Variables prefixed with "mock" so Jest's hoisting guard permits them inside the factory.
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

// NOTE: intentionally exhaustive — KeyboardSafeView is a scroll wrapper;
// we pass children through so layout assertions still work.
jest.mock('../ui/KeyboardSafeView', () => ({
  KeyboardSafeView: ({ children }: any) => children,
}));

// NOTE: intentionally exhaustive — postcards service is not called during the
// pick phase; stubs prevent Supabase network calls.
jest.mock('../../services/postcards.ts', () => ({
  validatePostcardMedia: jest.fn(() => ({ ok: true })),
  createPostcard: jest.fn(),
  getUploadUrl: jest.fn(),
  uploadToSignedUrl: jest.fn(),
  completeUpload: jest.fn(),
}));

// NOTE: intentionally exhaustive — validateMedia is called during pick to check
// video duration; stub always passes so the asset is accepted.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
}));

// NOTE: intentionally exhaustive — GlobalPlacePicker opens a full modal with
// map + network calls; stub prevents it from mounting native modules.
jest.mock('../selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: () => null,
}));

// NOTE: intentionally exhaustive — StampPickerSheet opens a modal with Supabase
// stamp queries; stub prevents network calls and native dependencies.
jest.mock('../StampPickerSheet', () => ({
  StampPickerSheet: () => null,
}));

// NOTE: intentionally exhaustive — StampOverlayBadge renders SVG paths that
// require native canvas; it is never shown during the empty-state pick flow.
jest.mock('../StampOverlayBadge', () => ({
  StampOverlayBadge: () => null,
}));

// NOTE: intentionally exhaustive — stampOverlay exports are used for layout math
// and constant arrays; stubs return safe defaults so the component renders.
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

// NOTE: intentionally exhaustive — locationPayload helper converts a Place to API
// fields; stub returns empty object (location not exercised in this test).
jest.mock('../../lib/location/locationPayload.ts', () => ({
  placeToLocationFields: jest.fn(() => ({})),
}));

// ── Import component under test ───────────────────────────────────────────────
import { PostcardComposer } from '../PostcardComposer.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAsset(): ImagePickerNS.ImagePickerAsset {
  return {
    uri: 'file:///test/postcard.jpg',
    type: 'image',
    mimeType: 'image/jpeg',
    width: 1200,
    height: 800,
    fileName: 'postcard.jpg',
    fileSize: 500_000,
    duration: null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PostcardComposer — empty-state pick flow', () => {
  beforeEach(() => {
    mockPickMedia.mockClear();
    resolvePick = null;
    // Provide a fresh pending promise for each test.
    mockPickMedia.mockImplementation(
      () =>
        new Promise<ImagePickerNS.ImagePickerAsset[] | null>((resolve) => {
          resolvePick = resolve;
        }),
    );
  });

  it('shows Camera and Library buttons in the empty state', async () => {
    const { getByText } = await render(
      <PostcardComposer visible={true} onClose={jest.fn()} onSuccess={jest.fn()} />,
    );
    expect(getByText('Camera')).toBeTruthy();
    expect(getByText('Library')).toBeTruthy();
  });

  it('pressing Camera calls pickMedia', async () => {
    const { getByText } = await render(
      <PostcardComposer visible={true} onClose={jest.fn()} onSuccess={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(getByText('Camera'));
    });

    await waitFor(() => expect(mockPickMedia).toHaveBeenCalledTimes(1));
    expect(mockPickMedia).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ['images', 'videos'], videoMaxDuration: 60 }),
    );
  });

  it('pressing Library calls pickMedia', async () => {
    const { getByText } = await render(
      <PostcardComposer visible={true} onClose={jest.fn()} onSuccess={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(getByText('Library'));
    });

    await waitFor(() => expect(mockPickMedia).toHaveBeenCalledTimes(1));
  });

  it('resolving pickMedia with an asset populates the preview and hides the picker', async () => {
    const { getByText, queryByText } = await render(
      <PostcardComposer visible={true} onClose={jest.fn()} onSuccess={jest.fn()} />,
    );

    // Trigger the picker.
    await act(async () => {
      fireEvent.press(getByText('Camera'));
    });

    await waitFor(() => expect(resolvePick).not.toBeNull());

    // Simulate selecting an asset.
    await act(async () => {
      resolvePick!([makeAsset()]);
    });

    // Empty-state picker buttons should be gone after asset is set.
    await waitFor(() => expect(queryByText('Camera')).toBeNull());

    // The "Change" button in the preview area should now be visible.
    expect(getByText('Change')).toBeTruthy();
  });
});
