/**
 * MediaSourceSheet — what leaves the sheet is uploadable, without distortion (lib/media/normalizeUpload).
 *
 * The owner's iPhone (2026-10-22) could upload nothing: the library handed over HEIC photos and HEVC `.MOV` videos,
 * the camera recorded `.mov`, and the client accepted only JPEG/PNG/WebP and MP4 — "Unsupported media type" for all of
 * it. Through the real sheet (only the native modules are doubles):
 *   S1  the library is asked for iOS's compatible copy (JPEG, H.264 MP4);
 *   S2  a 48 MP HEIC photo reaches onResult as a JPEG whose longest edge is 4096 — ONE dimension resized, ratio kept;
 *   S3  a camera `.mov` reaches onResult labelled video/quicktime, never re-encoded (validateMedia accepting it:
 *       services/__tests__/media.acceptsCameraMov.test.ts).
 */
import React from 'react';
import { Platform } from 'react-native';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { MediaSourceSheet } from '../MediaSourceSheet.tsx';

// NOTE: intentionally exhaustive — the native picker is replaced; the enums are deliberately absent, as in the other
// MediaSourceSheet test, so the defensive read in normalizeUpload.ts is exercised too.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

// The native image encoder's double resizes like the real one (one dimension in, the other scaled proportionally), so
// the test sees the ratio the device would.
const mockManipulate = jest.fn(async (_uri: string, actions: Array<{ resize?: { width?: number; height?: number } }>, options: { format: string }) => {
  let width = 8064; let height = 6048;
  const r = actions[0]?.resize;
  if (r?.width) { height = Math.round((height * r.width) / width); width = r.width; }
  return { uri: `file:///normalized.${options.format}`, width, height };
});
// NOTE: intentionally exhaustive — the native encoder is replaced by the proportional double above.
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...a: unknown[]) => (mockManipulate as unknown as (...x: unknown[]) => unknown)(...a),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));

// NOTE: intentionally exhaustive — only the size read of the re-encoded file is used.
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 3_100_000 })),
}));

const mockLaunchLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock;
const mockLaunchCamera = ImagePicker.launchCameraAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, status: 'granted' });
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, status: 'granted' });
  Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
});

async function sheet(onResult: jest.Mock) {
  return render(<MediaSourceSheet visible onClose={jest.fn()} onResult={onResult} allowsVideo videoMaxDuration={60} title="Add media" />);
}

describe('MediaSourceSheet — picks are normalized before they leave', () => {
  it('S1 + S2: the library is asked for compatible formats, and a 48 MP HEIC arrives as a 4096-px JPEG, ratio kept', async () => {
    mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: [{
      uri: 'file:///IMG_0001.HEIC', mimeType: 'image/heic', fileName: 'IMG_0001.HEIC', width: 8064, height: 6048, type: 'image', fileSize: 4_200_000,
    }] });
    const onResult = jest.fn();
    const view = await sheet(onResult);
    await act(async () => { await fireEvent.press(view.getByLabelText(/^Choose .* from library$/)); });

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(mockLaunchLibrary).toHaveBeenCalledWith(expect.objectContaining({ preferredAssetRepresentationMode: 'compatible', videoExportPreset: 7 }));
    expect(mockManipulate).toHaveBeenCalledWith('file:///IMG_0001.HEIC', [{ resize: { width: 4096 } }], expect.objectContaining({ format: 'jpeg' }));
    const out = onResult.mock.calls[0][0];
    expect(out).toEqual(expect.objectContaining({ uri: 'file:///normalized.jpeg', mimeType: 'image/jpeg', fileName: 'IMG_0001.jpg', width: 4096, height: 3072, fileSize: 3_100_000 }));
    expect(out.width / out.height).toBeCloseTo(8064 / 6048, 3);
  });

  it('S3: a camera .mov arrives as video/quicktime, untouched', async () => {
    mockLaunchCamera.mockResolvedValue({ canceled: false, assets: [{
      uri: 'file:///rec.mov', mimeType: null, fileName: 'rec.mov', width: 1920, height: 1080, type: 'video', duration: 12_000, fileSize: 18_000_000,
    }] });
    const onResult = jest.fn();
    const view = await sheet(onResult);
    await act(async () => { await fireEvent.press(view.getByLabelText(/^Take .* with camera$/)); });

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(mockManipulate).not.toHaveBeenCalled();
    const out = onResult.mock.calls[0][0];
    expect(out).toEqual(expect.objectContaining({ uri: 'file:///rec.mov', mimeType: 'video/quicktime' }));
    // That validateMedia accepts it: services/__tests__/media.acceptsCameraMov.test.ts (node — importing the service
    // here would start its Supabase client's timers inside jest).
  });
});
