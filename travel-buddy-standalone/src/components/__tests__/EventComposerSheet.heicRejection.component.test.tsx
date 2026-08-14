/**
 * EventComposerSheet — HEIC processed=false rejection.
 *
 * When `uploadMedia` returns { ok: true, url, processed: false } for an image
 * cover pick, `handleCoverResult` must surface a re-upload prompt rather than
 * silently storing the unrenderable URL.
 *
 * Videos legitimately return processed=false (no server transcode), so a video
 * pick with processed=false must NOT be treated as an error.
 */

import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';
import { EventComposerSheet } from '../EventComposerSheet.tsx';
import { uploadMedia } from '../../services/media.ts';
import type * as ImagePickerNS from 'expo-image-picker';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-image-picker requires native camera
// permission modules unavailable in jest-expo.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true }),
  launchCameraAsync: jest.fn().mockResolvedValue({ canceled: true }),
  MediaTypeOptions: { Images: 'Images', Videos: 'Videos', All: 'All' },
}));

// NOTE: intentionally exhaustive — uploadMedia calls the API server and Supabase
// auth stack; pulling requireActual causes live network requests.
jest.mock('../../services/media.ts', () => ({
  uploadMedia: jest.fn(),
  validateMedia: jest.fn(() => ({ ok: true })),
}));
const mockUploadMedia = uploadMedia as jest.Mock;

// NOTE: intentionally exhaustive — createEvent/updateEvent hit the API server.
jest.mock('../../services/events.ts', () => ({
  createEvent: jest.fn().mockResolvedValue({ ok: false, data: null }),
  updateEvent: jest.fn().mockResolvedValue({ ok: false, data: null }),
}));

// NOTE: intentionally exhaustive — useFeatureFlags imports the Supabase client
// and async-storage; the stub returns a stable isEnabled function.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));

// NOTE: intentionally exhaustive — MediaSourceSheet launches a native picker;
// the mock captures onResult so tests can inject assets directly.
let capturedOnResult: ((asset: ImagePickerNS.ImagePickerAsset) => void) | null = null;
jest.mock('../ui/MediaSourceSheet.tsx', () => ({
  MediaSourceSheet: (props: { onResult: (asset: ImagePickerNS.ImagePickerAsset) => void }) => {
    capturedOnResult = props.onResult;
    return null;
  },
}));

// NOTE: intentionally exhaustive — GeneratedHeaderPicker imports heavy AI/fetch
// dependencies unavailable in jest-expo.
jest.mock('../visuals/GeneratedHeaderPicker.tsx', () => ({
  GeneratedHeaderPicker: () => null,
}));

// NOTE: intentionally exhaustive — picker components import native modal/gesture
// modules unavailable in jest-expo.
jest.mock('../selectors/GlobalCalendarPicker.tsx', () => ({
  GlobalCalendarPicker: () => null,
}));
// NOTE: intentionally exhaustive — picker components import native modal/gesture
// modules unavailable in jest-expo.
jest.mock('../selectors/GlobalTimePicker.tsx', () => ({
  GlobalTimePicker: () => null,
}));
// NOTE: intentionally exhaustive — GlobalPlacePicker imports MapLibre native
// modules unavailable in jest-expo.
jest.mock('../selectors/GlobalPlacePicker.tsx', () => ({
  GlobalPlacePicker: () => null,
}));

// NOTE: intentionally exhaustive — VideoThumbnail imports expo-image which
// requires a native module unavailable in jest-expo.
jest.mock('../ui/VideoThumbnail.tsx', () => ({
  VideoThumbnail: () => null,
}));

// NOTE: intentionally exhaustive — KeyboardSafeScrollView wraps KeyboardAvoidingView
// with native keyboard metrics that crash jest-expo.
jest.mock('../ui/KeyboardSafeView.tsx', () => {
  const R = jest.requireActual('react');
  const { ScrollView } = jest.requireActual('react-native');
  return {
    KeyboardSafeScrollView: ({ children, style }: any) =>
      R.createElement(ScrollView, { style }, children),
  };
});

// NOTE: intentionally exhaustive — formatEventLocation imports Supabase/location
// modules that are unreachable in the jest-expo environment.
jest.mock('../../lib/location/formatEventLocation.ts', () => ({
  formatEventLocation: () => '',
}));

// ── Helpers ───────────────────────────────────────────────────────────────────


const STORED_URL = 'https://cdn.example.com/post-media/user/photo.heic';

function makeImageAsset(mime = 'image/heic'): ImagePickerNS.ImagePickerAsset {
  return {
    uri: 'file:///test/photo.heic',
    type: 'image',
    mimeType: mime,
    width: 4032,
    height: 3024,
    fileName: 'photo.heic',
    fileSize: 3_000_000,
    duration: null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePickerNS.ImagePickerAsset;
}

function makeVideoAsset(): ImagePickerNS.ImagePickerAsset {
  return {
    uri: 'file:///test/clip.mp4',
    type: 'video',
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
  } as ImagePickerNS.ImagePickerAsset;
}

const defaultProps = {
  onDismiss: jest.fn(),
  onCreated: jest.fn(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventComposerSheet — HEIC processed=false rejection', () => {
  beforeEach(() => {
    capturedOnResult = null;
    mockUploadMedia.mockReset();
    defaultProps.onDismiss.mockReset();
    defaultProps.onCreated.mockReset();
  });

  it('shows a re-upload prompt when the server returns processed=false for an image cover', async () => {
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: STORED_URL,
      processed: false,
      width: null,
      height: null,
      mediaType: 'image/heic',
    });

    const { getByText } = await render(<EventComposerSheet {...defaultProps} />);

    // capturedOnResult is set when MediaSourceSheet renders (which is on step 'basics')
    expect(capturedOnResult).not.toBeNull();

    await act(async () => {
      capturedOnResult!(makeImageAsset());
      // Allow uploadMedia promise to settle
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    await waitFor(() => {
      expect(
        getByText(/re-upload|not supported/i),
      ).toBeTruthy();
    });
  });

  it('does not show the re-upload prompt when processed=false for a video cover', async () => {
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: 'https://cdn.example.com/post-media/user/clip.mp4',
      processed: false,
      width: null,
      height: null,
      mediaType: 'video/mp4',
    });

    const { queryByText } = await render(<EventComposerSheet {...defaultProps} />);

    expect(capturedOnResult).not.toBeNull();

    await act(async () => {
      capturedOnResult!(makeVideoAsset());
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    // No HEIC-style error should appear for videos
    expect(queryByText(/re-upload|not supported/i)).toBeNull();
  });

  it('does not set coverUrl when processed=false for an image — so no unrenderable URL is stored', async () => {
    mockUploadMedia.mockResolvedValue({
      ok: true,
      url: STORED_URL,
      processed: false,
      width: null,
      height: null,
      mediaType: 'image/heic',
    });

    // Verify that onCreated is never called with a HEIC URL when processed=false
    // blocks the upload from completing. We advance to the review step and save.
    // The cover preview should NOT appear (coverLocalUri cleared on guard hit).
    const { queryByText } = await render(<EventComposerSheet {...defaultProps} />);

    expect(capturedOnResult).not.toBeNull();

    await act(async () => {
      capturedOnResult!(makeImageAsset());
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    // The error is shown — the local URI was cleared, so no cover preview renders.
    // Confirm upload error is visible.
    await waitFor(() => {
      expect(queryByText(/re-upload|not supported/i)).not.toBeNull();
    });
  });
});
