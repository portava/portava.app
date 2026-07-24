/**
 * VideoStoryTrimSheet + MediaSourceSheet — story video post-pick crop gate.
 *
 * Verifies the end-to-end story video flow:
 *   1. When storyVideoTrim=true and a video is picked, VideoStoryTrimSheet is
 *      shown and onResult is NOT called yet.
 *   2. Confirming in VideoStoryTrimSheet calls onResult with the original asset
 *      and closes the source sheet (onClose called).
 *   3. Rejecting in VideoStoryTrimSheet dismisses the trim sheet but keeps the
 *      source sheet open — the user can re-pick.
 *   4. Image picks are NOT intercepted — onResult fires immediately even when
 *      storyVideoTrim=true.
 *   5. storyVideoTrim=false leaves the existing direct-to-onResult path intact.
 */
import React from 'react';
import { Platform } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { MediaSourceSheet } from '../MediaSourceSheet.tsx';

// ── Mocks ──────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — every ImagePicker API the sheet might call
// is stubbed here. These are the only four APIs MediaSourceSheet calls;
// spreading requireActual would pull in native modules unavailable in Jest.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

// expo-av Video is a native component; stub it to a plain View for tests.
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Video: React.forwardRef((_props: any, _ref: any) => React.createElement(View, { testID: 'video-player' })),
    ResizeMode: { COVER: 'cover' },
  };
});

const mockRequestLibrary = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const mockLaunchLibrary  = ImagePicker.launchImageLibraryAsync as jest.Mock;

const VIDEO_ASSET: ImagePicker.ImagePickerAsset = {
  uri: 'file:///story-clip.mp4',
  type: 'video',
  mimeType: 'video/mp4',
  fileName: 'story-clip.mp4',
  fileSize: 5_000_000,
  width: 1080,
  height: 1920,
  duration: 15,
  assetId: null,
  base64: null,
  exif: null,
  pairedVideoAsset: undefined,
} as unknown as ImagePicker.ImagePickerAsset;

const IMAGE_ASSET: ImagePicker.ImagePickerAsset = {
  uri: 'file:///photo.jpg',
  type: 'image',
  mimeType: 'image/jpeg',
  fileName: 'photo.jpg',
  fileSize: 800_000,
  width: 1080,
  height: 1920,
  duration: null,
  assetId: null,
  base64: null,
  exif: null,
  pairedVideoAsset: undefined,
} as unknown as ImagePicker.ImagePickerAsset;

beforeEach(() => {
  mockRequestLibrary.mockResolvedValue({ granted: true, status: 'granted' });
  mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: [VIDEO_ASSET] });
  // Force iOS path so web file-input fallback is not taken.
  Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
});

afterEach(() => {
  jest.clearAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function pickLibrary(getByLabelText: (l: string) => any) {
  await act(async () => {
    fireEvent.press(getByLabelText('Choose photo or video from library'));
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MediaSourceSheet — storyVideoTrim interception', () => {
  it('shows VideoStoryTrimSheet after a video pick and does NOT call onResult yet', async () => {
    const onResult = jest.fn();
    const onClose  = jest.fn();

    const { getByLabelText } = await render(
      <MediaSourceSheet
        visible
        onClose={onClose}
        onResult={onResult}
        allowsVideo
        storyVideoTrim
        title="New Story"
      />,
    );

    await pickLibrary(getByLabelText);

    await waitFor(() => {
      // The trim sheet's confirm button should be visible.
      expect(getByLabelText('Use this video')).toBeTruthy();
    });

    // onResult must NOT have fired yet.
    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onResult + onClose when the user confirms in VideoStoryTrimSheet', async () => {
    const onResult = jest.fn();
    const onClose  = jest.fn();

    const { getByLabelText } = await render(
      <MediaSourceSheet
        visible
        onClose={onClose}
        onResult={onResult}
        allowsVideo
        storyVideoTrim
        title="New Story"
      />,
    );

    await pickLibrary(getByLabelText);

    await waitFor(() => getByLabelText('Use this video'));

    await act(async () => {
      fireEvent.press(getByLabelText('Use this video'));
    });

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(VIDEO_ASSET);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses VideoStoryTrimSheet without calling onResult when user rejects', async () => {
    const onResult = jest.fn();
    const onClose  = jest.fn();

    const { getByLabelText, queryByLabelText } = await render(
      <MediaSourceSheet
        visible
        onClose={onClose}
        onResult={onResult}
        allowsVideo
        storyVideoTrim
        title="New Story"
      />,
    );

    await pickLibrary(getByLabelText);

    await waitFor(() => getByLabelText('Re-pick video'));

    await act(async () => {
      fireEvent.press(getByLabelText('Re-pick video'));
    });

    // Trim sheet dismissed — its confirm button should be gone.
    await waitFor(() => {
      expect(queryByLabelText('Use this video')).toBeNull();
    });

    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT intercept image picks — onResult fires immediately', async () => {
    mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: [IMAGE_ASSET] });

    const onResult = jest.fn();
    const onClose  = jest.fn();

    const { getByLabelText, queryByLabelText } = await render(
      <MediaSourceSheet
        visible
        onClose={onClose}
        onResult={onResult}
        allowsVideo
        storyVideoTrim
        title="New Story"
      />,
    );

    await pickLibrary(getByLabelText);

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith(IMAGE_ASSET);
    expect(queryByLabelText('Use this video')).toBeNull();
  });

  it('skips interception entirely when storyVideoTrim=false', async () => {
    const onResult = jest.fn();
    const onClose  = jest.fn();

    const { getByLabelText, queryByLabelText } = await render(
      <MediaSourceSheet
        visible
        onClose={onClose}
        onResult={onResult}
        allowsVideo
        storyVideoTrim={false}
        title="New Story"
      />,
    );

    await pickLibrary(getByLabelText);

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith(VIDEO_ASSET);
    expect(queryByLabelText('Use this video')).toBeNull();
  });
});
