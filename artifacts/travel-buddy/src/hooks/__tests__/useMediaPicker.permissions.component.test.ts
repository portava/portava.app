/**
 * useMediaPicker.permissions.component.test.ts
 *
 * Confirms that the correct Alert fires for each permission-denial branch
 * in both requestCamera and requestLibrary.  The four cases:
 *
 *   camera  canAskAgain=false → "Camera access blocked"  + "Open Settings"
 *   camera  canAskAgain=true  → "Camera access required" + "Open Settings"
 *   library canAskAgain=false → "Photo access blocked"   + "Open Settings"
 *   library canAskAgain=true  → "Photo access required"  + "Open Settings"
 *
 * Strategy:
 *   renderHook gives us the pickMedia function.  On native (Platform.OS set to
 *   'android') pickMedia immediately fires Alert.alert with the
 *   "Take Photo / Choose from Library" chooser.  We press the relevant button
 *   **bare** (no act() wrapper — see TESTING.md rule 2) then waitFor the
 *   second Alert.alert call that carries the permission message.
 *
 * Run with: pnpm test:component
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useMediaPicker } from '../useMediaPicker.ts';

// NOTE: intentionally exhaustive — expo-image-picker requires native camera /
// media-library modules unavailable in jest-expo.
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync:       jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync:                   jest.fn(),
  launchImageLibraryAsync:             jest.fn(),
}));

const mockRequestCamera  = ImagePicker.requestCameraPermissionsAsync       as jest.Mock;
const mockRequestLibrary = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Press a button in the Nth Alert.alert call (0-indexed) by its text label.
 * Called bare (no act() wrapper) per TESTING.md rule 2.
 */
function pressAlertButton(
  alertSpy: jest.SpyInstance,
  callIndex: number,
  buttonText: string,
): void {
  const buttons: Array<{ text: string; onPress?: () => void }> =
    alertSpy.mock.calls[callIndex][2] ?? [];
  const btn = buttons.find((b) => b.text === buttonText);
  if (!btn) {
    throw new Error(
      `No button with text "${buttonText}" in Alert call #${callIndex}. ` +
        `Available: ${buttons.map((b) => b.text).join(', ')}`,
    );
  }
  btn.onPress?.();
}

// ── camera — canAskAgain=false ────────────────────────────────────────────────

describe('useMediaPicker — camera permanently blocked (canAskAgain=false)', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRequestCamera.mockResolvedValue({ granted: false, canAskAgain: false });
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('fires "Camera access blocked" alert with "Open Settings" button', async () => {
    const { result } = await renderHook(() => useMediaPicker());

    // pickMedia fires the chooser Alert synchronously; do not await yet.
    result.current.pickMedia();
    expect(alertSpy).toHaveBeenCalledTimes(1);

    // Press "Take Photo" bare — no act() per TESTING.md rule 2.
    pressAlertButton(alertSpy, 0, 'Take Photo');

    // requestCamera() is async; waitFor drains the microtask queue until the
    // permission Alert fires.
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));

    const [title, message, buttons] = alertSpy.mock.calls[1] as [
      string,
      string,
      Array<{ text: string }>,
    ];
    expect(title).toBe('Camera access blocked');
    expect(message).toBe('Open Settings to enable camera access.');
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Open Settings' }),
        expect.objectContaining({ text: 'Cancel' }),
      ]),
    );
  });
});

// ── camera — canAskAgain=true ─────────────────────────────────────────────────

describe('useMediaPicker — camera first-time denied (canAskAgain=true)', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRequestCamera.mockResolvedValue({ granted: false, canAskAgain: true });
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('fires "Camera access required" rationale alert with "Open Settings" button', async () => {
    const { result } = await renderHook(() => useMediaPicker());

    result.current.pickMedia();
    expect(alertSpy).toHaveBeenCalledTimes(1);

    pressAlertButton(alertSpy, 0, 'Take Photo');

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));

    const [title, message, buttons] = alertSpy.mock.calls[1] as [
      string,
      string,
      Array<{ text: string }>,
    ];
    expect(title).toBe('Camera access required');
    expect(message).toBe('Enable camera access in Settings to take photos.');
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Open Settings' }),
        expect.objectContaining({ text: 'Cancel' }),
      ]),
    );
  });
});

// ── library — canAskAgain=false ───────────────────────────────────────────────

describe('useMediaPicker — library permanently blocked (canAskAgain=false)', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRequestLibrary.mockResolvedValue({ granted: false, canAskAgain: false });
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('fires "Photo access blocked" alert with "Open Settings" button', async () => {
    const { result } = await renderHook(() => useMediaPicker());

    result.current.pickMedia();
    expect(alertSpy).toHaveBeenCalledTimes(1);

    pressAlertButton(alertSpy, 0, 'Choose from Library');

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));

    const [title, message, buttons] = alertSpy.mock.calls[1] as [
      string,
      string,
      Array<{ text: string }>,
    ];
    expect(title).toBe('Photo access blocked');
    expect(message).toBe('Open Settings to enable photo library access.');
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Open Settings' }),
        expect.objectContaining({ text: 'Cancel' }),
      ]),
    );
  });
});

// ── library — canAskAgain=true ────────────────────────────────────────────────

describe('useMediaPicker — library first-time denied (canAskAgain=true)', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRequestLibrary.mockResolvedValue({ granted: false, canAskAgain: true });
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('fires "Photo access required" rationale alert with "Open Settings" button', async () => {
    const { result } = await renderHook(() => useMediaPicker());

    result.current.pickMedia();
    expect(alertSpy).toHaveBeenCalledTimes(1);

    pressAlertButton(alertSpy, 0, 'Choose from Library');

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2));

    const [title, message, buttons] = alertSpy.mock.calls[1] as [
      string,
      string,
      Array<{ text: string }>,
    ];
    expect(title).toBe('Photo access required');
    expect(message).toBe('Enable photo library access in Settings to choose photos.');
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Open Settings' }),
        expect.objectContaining({ text: 'Cancel' }),
      ]),
    );
  });
});
