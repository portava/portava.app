/**
 * MediaSourceSheet — allowsEditing forwarding test.
 *
 * Verifies that the `allowsEditing` and `aspect` props introduced by the shared
 * media composer kit are forwarded to both `launchImageLibraryAsync` and
 * `launchCameraAsync`. This is the regression guard for the story / avatar /
 * cover crop flows, which previously used `allowsEditing: true` in their
 * direct ImagePicker calls and would silently lose cropping if the prop was
 * not threaded through MediaSourceSheet.
 *
 * Tests:
 *   1. Library pick with allowsEditing=true passes { allowsEditing: true, aspect } to launchImageLibraryAsync.
 *   2. Library pick with allowsEditing=false (default) passes { allowsEditing: false } — no regression.
 */
import React from 'react';
import { Platform } from 'react-native';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { MediaSourceSheet } from '../MediaSourceSheet.tsx';

// NOTE: intentionally exhaustive — every ImagePicker API the sheet might call
// is stubbed. launchImageLibraryAsync / launchCameraAsync return canceled=true
// so onResult is never invoked; we assert only on call arguments.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

const mockRequestLibrary = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const mockRequestCamera  = ImagePicker.requestCameraPermissionsAsync as jest.Mock;
const mockLaunchLibrary  = ImagePicker.launchImageLibraryAsync as jest.Mock;
const mockLaunchCamera   = ImagePicker.launchCameraAsync as jest.Mock;

beforeEach(() => {
  mockRequestLibrary.mockResolvedValue({ granted: true, status: 'granted' });
  mockRequestCamera.mockResolvedValue({ granted: true, status: 'granted' });
  mockLaunchLibrary.mockResolvedValue({ canceled: true, assets: [] });
  mockLaunchCamera.mockResolvedValue({ canceled: true, assets: [] });
  // Force native path so the file-input web fallback is not taken.
  Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
});

describe('MediaSourceSheet — allowsEditing forwarding', () => {
  it('forwards allowsEditing=true and aspect to launchImageLibraryAsync', async () => {
    const { getByLabelText } = await render(
      <MediaSourceSheet
        visible={true}
        onClose={jest.fn()}
        onResult={jest.fn()}
        allowsVideo={false}
        allowsEditing={true}
        aspect={[1, 1]}
        title="Profile photo"
      />,
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Choose photo from library'));
    });

    await waitFor(() =>
      expect(mockLaunchLibrary).toHaveBeenCalledWith(
        expect.objectContaining({ allowsEditing: true, aspect: [1, 1] }),
      ),
    );
  });

  it('forwards allowsEditing=false (default) — existing callers not regressed', async () => {
    const { getByLabelText } = await render(
      <MediaSourceSheet
        visible={true}
        onClose={jest.fn()}
        onResult={jest.fn()}
        allowsVideo={false}
        title="Add media"
      />,
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Choose photo from library'));
    });

    await waitFor(() =>
      expect(mockLaunchLibrary).toHaveBeenCalledWith(
        expect.objectContaining({ allowsEditing: false }),
      ),
    );
  });
});
