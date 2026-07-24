/**
 * useMediaComposer / MediaSourceSheet — permission state tests.
 *
 * Covers the three permission outcomes surfaced through MediaSourceSheet:
 *   1. Library permission denied → "Library access denied" note shown; no pick.
 *   2. Camera permission denied  → "Camera access denied" note shown; no pick.
 *   3. iOS limited-library (granted but accessPrivileges='limited') →
 *      Alert.alert fires with 'Limited photo access' after the pick succeeds;
 *      the item is still added to the composer (limited ≠ denied).
 *
 * NOTE: intentionally exhaustive mocks — every ImagePicker API the sheet may
 * call is stubbed so native modules are never invoked.
 *
 * Modal proxy: MediaSourceSheet uses React Native's Modal for the bottom sheet.
 * The Proxy replaces only 'Modal' with a synchronous View so modal animation
 * doesn't leave a floating async act() scope.
 */

import React from 'react';
import { Platform, Alert } from 'react-native';
import { render, act, fireEvent, waitFor, screen } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { MediaSourceSheet } from '../ui/MediaSourceSheet.tsx';

// ── react-native Modal proxy ──────────────────────────────────────────────────
// NOTE: intentionally exhaustive — Modal's animation lifecycle leaves a floating
// async act() scope after render(), which collides with subsequent explicit
// act() calls (overlapping act() → corrupted actScopeDepth → state never
// flushes).
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react') as typeof import('react');
        return ({
          children,
          visible,
        }: {
          children: R.ReactNode;
          visible?: boolean;
        }) => (visible ? R.createElement(target.View as React.ComponentType, null, children) : null);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: intentionally exhaustive — expo-image-picker requires native camera
// permission modules unavailable in the jest-expo runner.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAsset(): ImagePicker.ImagePickerAsset {
  return {
    uri: 'file:///test/photo.jpg',
    type: 'image',
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    fileName: 'photo.jpg',
    fileSize: 102400,
    duration: null,
    assetId: null,
    base64: null,
    exif: null,
    pairedVideoAsset: undefined,
  } as ImagePicker.ImagePickerAsset;
}

function renderSheet(onResult = jest.fn(), onClose = jest.fn()) {
  return render(
    <MediaSourceSheet
      visible={true}
      onClose={onClose}
      onResult={onResult}
      allowsVideo={false}
      title="Add photo"
    />,
  );
}

// ── Library permission denied ─────────────────────────────────────────────────

describe('MediaSourceSheet — library permission denied', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
    mockRequestLibrary.mockResolvedValue({ granted: false, status: 'denied' });
    mockRequestCamera.mockResolvedValue({ granted: true, status: 'granted' });
    mockLaunchLibrary.mockResolvedValue({ canceled: true, assets: [] });
    mockLaunchCamera.mockResolvedValue({ canceled: true, assets: [] });
  });

  it('shows the "Library access denied" note after tapping the library row', async () => {
    const onResult = jest.fn();
    await renderSheet(onResult);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose photo from library'));
    });

    await waitFor(() => {
      expect(
        screen.getByText('Library access denied — tap to open Settings'),
      ).toBeTruthy();
    });
  });

  it('does NOT call onResult when library is denied', async () => {
    const onResult = jest.fn();
    await renderSheet(onResult);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose photo from library'));
    });

    await waitFor(() => {
      expect(
        screen.getByText('Library access denied — tap to open Settings'),
      ).toBeTruthy();
    });

    expect(onResult).not.toHaveBeenCalled();
  });

  it('does NOT launch the image library when permission is denied', async () => {
    await renderSheet();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose photo from library'));
    });

    await waitFor(() =>
      screen.getByText('Library access denied — tap to open Settings'),
    );

    expect(mockLaunchLibrary).not.toHaveBeenCalled();
  });
});

// ── Camera permission denied ──────────────────────────────────────────────────

describe('MediaSourceSheet — camera permission denied', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
    mockRequestCamera.mockResolvedValue({ granted: false, status: 'denied' });
    mockRequestLibrary.mockResolvedValue({ granted: true, status: 'granted' });
    mockLaunchLibrary.mockResolvedValue({ canceled: true, assets: [] });
    mockLaunchCamera.mockResolvedValue({ canceled: true, assets: [] });
  });

  it('shows the "Camera access denied" note after tapping the camera row', async () => {
    await renderSheet();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Take photo with camera'));
    });

    await waitFor(() => {
      expect(
        screen.getByText('Camera access denied — tap to open Settings'),
      ).toBeTruthy();
    });
  });

  it('does NOT call onResult when camera is denied', async () => {
    const onResult = jest.fn();
    await renderSheet(onResult);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Take photo with camera'));
    });

    await waitFor(() =>
      screen.getByText('Camera access denied — tap to open Settings'),
    );

    expect(onResult).not.toHaveBeenCalled();
  });
});

// ── iOS limited-library ───────────────────────────────────────────────────────

describe('MediaSourceSheet — iOS limited-library (accessPrivileges="limited")', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
    // Limited = granted:true but only a subset of photos selected.
    mockRequestLibrary.mockResolvedValue({
      granted: true,
      status: 'granted',
      accessPrivileges: 'limited',
    });
    mockRequestCamera.mockResolvedValue({ granted: true, status: 'granted' });
    mockLaunchLibrary.mockResolvedValue({
      canceled: false,
      assets: [makeAsset()],
    });
    mockLaunchCamera.mockResolvedValue({ canceled: true, assets: [] });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    alertSpy.mockRestore();
  });

  it('calls Alert.alert with "Limited photo access" after a successful limited pick', async () => {
    const onResult = jest.fn();
    await renderSheet(onResult);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose photo from library'));
    });

    // launchImageLibraryAsync resolves; onResult is called; the 500ms timer starts.
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    // Advance past the setTimeout(500) that triggers the limited-access Alert.
    await act(async () => {
      jest.advanceTimersByTime(600);
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Limited photo access',
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Select more photos' }),
        expect.objectContaining({ text: 'Allow full access' }),
        expect.objectContaining({ text: 'Continue' }),
      ]),
    );
  });

  it('still delivers the asset to onResult even when access is limited', async () => {
    const onResult = jest.fn();
    await renderSheet(onResult);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose photo from library'));
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));

    const asset = onResult.mock.calls[0][0] as ImagePicker.ImagePickerAsset;
    expect(asset.uri).toBe('file:///test/photo.jpg');
  });
});
