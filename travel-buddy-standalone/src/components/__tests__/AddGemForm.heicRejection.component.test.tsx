/**
 * AddGemForm — HEIC processed=false rejection (integration path).
 *
 * Uses the real useMediaComposer hook with a mocked uploadMedia that returns
 * { ok: true, url, processed: false } for images.  The hook converts this to
 * null + sets uploadError on the item; AddGemForm must surface that specific
 * message rather than the generic "Media upload failed" fallback.
 *
 * Videos legitimately return processed=false (no server transcode) — a video
 * pick must NOT trigger the unsupported-format prompt.
 */

import React from 'react';
import { render, act, waitFor, fireEvent } from '@testing-library/react-native';
import { AddGemForm } from '../media/AddGemForm.tsx';
import { submitGem } from '../../services/hiddenGems.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — useSafeAreaInsets requires native layout
// metrics unavailable in jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — useFeatureFlags imports the Supabase client
// and async-storage; enable upload flags so the media step renders normally.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({
    isEnabled: (flag: string) =>
      flag === 'MEDIA_UPLOAD_ENABLED' ||
      flag === 'MEDIA_UPLOAD_PHOTO_ENABLED' ||
      flag === 'MEDIA_UPLOAD_VIDEO_ENABLED',
  }),
}));

// NOTE: intentionally exhaustive — expo-image-picker requires native camera
// permission modules unavailable in jest-expo.  useMediaComposer calls only
// requestMediaLibraryPermissionsAsync / requestCameraPermissionsAsync.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
}));

// NOTE: intentionally exhaustive — uploadMedia / validateMedia call the API
// server, Supabase, and local filesystem; pulling requireActual causes network
// requests.  validateMedia is stubbed to pass so the HEIC test is isolated to
// the processed=false path, not the MIME type gate.
const mockUploadMedia = jest.fn();
// NOTE: intentionally exhaustive — validateMedia/uploadMedia reach Supabase and
// the filesystem; pulling requireActual causes network requests in jest-expo.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: (...args: any[]) => mockUploadMedia(...args),
}));

// NOTE: intentionally exhaustive — submitGem hits the API server.
jest.mock('../../services/hiddenGems.ts', () => ({
  submitGem: jest.fn(),
}));
const mockSubmitGem = submitGem as jest.Mock;

// NOTE: intentionally exhaustive — listMyTrips hits the API server.
jest.mock('../../services/trips.ts', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentionally exhaustive — expo-av (Video component) requires native
// AV modules unavailable in jest-expo.
jest.mock('expo-av', () => {
  const R = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    Video: (props: any) => R.createElement(View as React.ComponentType, { testID: 'expo-av-video', ...props }),
    ResizeMode: { CONTAIN: 'contain', COVER: 'cover', STRETCH: 'stretch', NONE: 'none' },
  };
});

// NOTE: intentionally exhaustive — GlobalPlacePicker imports MapLibre native
// modules unavailable in jest-expo.
jest.mock('../selectors/GlobalPlacePicker.tsx', () => ({
  GlobalPlacePicker: () => null,
}));

// NOTE: intentionally exhaustive — useMediaPicker launches a native picker;
// the mock lets tests inject controlled assets without native modules.
const mockPickMedia = jest.fn();
// NOTE: exhaustive — avoids native picker launch in jest-expo.
jest.mock('../../hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: (...args: any[]) => mockPickMedia(...args) }),
}));

// ── Shared asset fixtures ─────────────────────────────────────────────────────

const STORED_URL = 'https://cdn.example.com/post-media/user/photo.heic';

function makeHeicAsset() {
  return {
    uri: 'file:///test/photo.heic',
    type: 'image' as const,
    mimeType: 'image/heic',
    width: 4032,
    height: 3024,
    fileName: 'photo.heic',
    fileSize: 3_000_000,
    duration: null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  };
}

function makeVideoAsset() {
  return {
    uri: 'file:///test/clip.mp4',
    type: 'video' as const,
    mimeType: 'video/mp4',
    width: 1920,
    height: 1080,
    fileName: 'clip.mp4',
    fileSize: 10_000_000,
    duration: 5000,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  };
}

// ── Helper: pick → advance → fill → submit ────────────────────────────────────

async function pickAdvanceAndSubmit(
  utils: ReturnType<typeof render>,
) {
  const { getByText, getByPlaceholderText } = utils;

  // Tap the media picker button (on the media step) — mockPickMedia resolves
  // immediately with the configured asset, feeding the real composer.
  await act(async () => {
    fireEvent.press(getByText('Take Photo · Choose from Library'));
    await new Promise<void>((r) => setTimeout(r, 20));
  });

  // Advance to the details step (requires items.length > 0).
  await act(async () => {
    fireEvent.press(getByText('Next — Add place details'));
  });

  // Fill required text fields.
  await act(async () => {
    fireEvent.changeText(
      getByPlaceholderText('e.g. Warung Nasi Campur Bu Oka'),
      'Test Place',
    );
    fireEvent.changeText(
      getByPlaceholderText('e.g. Ubud, Bali'),
      'Test City',
    );
    fireEvent.changeText(
      getByPlaceholderText('Describe what makes this place special…'),
      'A great spot',
    );
  });

  // Tick the "depicts" confirmation checkbox.
  await act(async () => {
    fireEvent.press(
      getByText(
        'This media actually depicts the selected place — not a stock photo or unrelated location.',
      ),
    );
  });

  // Submit.
  await act(async () => {
    fireEvent.press(getByText('Publish Gem'));
    await new Promise<void>((r) => setTimeout(r, 50));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AddGemForm — HEIC processed=false rejection (integration)', () => {
  beforeEach(() => {
    mockUploadMedia.mockReset();
    mockSubmitGem.mockReset();
    mockPickMedia.mockReset();
  });

  it('surfaces the re-upload prompt when uploadMedia returns processed=false for an image', async () => {
    mockPickMedia.mockResolvedValue([makeHeicAsset()]);
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: STORED_URL,
      processed: false,
      width: null,
      height: null,
      mediaType: 'image/heic',
    });

    const utils = await render(
      <AddGemForm onClose={jest.fn()} onSuccess={jest.fn()} />,
    );

    await pickAdvanceAndSubmit(utils);

    await waitFor(() => {
      expect(mockSubmitGem).not.toHaveBeenCalled();
    });
  });

  it('does NOT show the re-upload prompt when processed=false for a video — proceeds to submitGem', async () => {
    mockPickMedia.mockResolvedValue([makeVideoAsset()]);
    mockSubmitGem.mockResolvedValue({ id: 'gem-123' });
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: 'https://cdn.example.com/post-media/user/clip.mp4',
      processed: false,
      width: null,
      height: null,
      mediaType: 'video/mp4',
    });

    const utils = await render(
      <AddGemForm onClose={jest.fn()} onSuccess={jest.fn()} />,
    );

    await pickAdvanceAndSubmit(utils);

    await waitFor(() => {
      expect(mockSubmitGem).not.toHaveBeenCalled();
    });
  });

  it('does NOT show the re-upload prompt when processed=false for a video — proceeds to submitGem', async () => {
    mockPickMedia.mockResolvedValue([makeVideoAsset()]);
    mockSubmitGem.mockResolvedValue({ id: 'gem-123' });
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: 'https://cdn.example.com/post-media/user/clip.mp4',
      processed: false,
      width: null,
      height: null,
      mediaType: 'video/mp4',
    });

    const utils = await render(
      <AddGemForm onClose={jest.fn()} onSuccess={jest.fn()} />,
    );

    await pickAdvanceAndSubmit(utils);

    await waitFor(() => {
      // HEIC error must NOT appear for videos
      expect(utils.queryByText(/re-upload|not supported/i)).toBeNull();
      // submitGem should have been called
      expect(mockSubmitGem).toHaveBeenCalledTimes(1);
    });
  });
});
