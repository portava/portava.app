/**
 * CreateMemoryScreen — picker re-enables after remove.
 *
 * Regression guard for the state-sync bug where local `assets[]` and
 * `mediaComposer.items` diverged: removals updated assets[] but not the
 * composer, so `canAddMore` never reset and the picker stayed disabled.
 *
 * Fix: mediaComposer.items IS the asset list; removes call removeItem()
 * which decrements items.length and re-enables canAddMore immediately.
 *
 * Tests:
 *   1. After picking up to maxItems (10), the Add button is disabled.
 *   2. After removing one item the Add button is enabled again.
 *   3. A subsequent pick succeeds — canAddMore was truly re-enabled.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import type * as ImagePickerTypes from 'expo-image-picker';
import CreateMemoryScreen from '../create';

// ── Navigation ───────────────────────────────────────────────────────────────

// NOTE: expo-router router is used only in handlePublish (router.back/replace).
// It is not invoked in these tests.
jest.mock('expo-router', () => ({ router: { back: jest.fn(), replace: jest.fn() } }));

// ── SafeArea ─────────────────────────────────────────────────────────────────

// NOTE: useSafeAreaInsets is called unconditionally — return a zero inset.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── Services ──────────────────────────────────────────────────────────────────

// NOTE: createMemory / addMemoryItem are not called in these tests (no publish).
jest.mock('../../../src/services/memories', () => ({
  createMemory: jest.fn(),
  addMemoryItem: jest.fn(),
}));

// NOTE: services/media.ts — validateMedia is called inside useMediaComposer.onPickResult.
// The .ts extension must match exactly what useMediaComposer.ts imports.
jest.mock('../../../src/services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: jest.fn(),
}));

// ── UI primitives ─────────────────────────────────────────────────────────────

// NOTE: Heavy scroll/navigation wrapper — pass children through.
jest.mock('../../../src/components/ui/KeyboardSafeView', () => ({
  KeyboardSafeScrollView: ({ children }: any) => children,
}));

// NOTE: navBar hook returns a no-op scroll handler.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
}));

// NOTE: bottom inset filler is decorative.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
}));

// NOTE: GlobalPlacePicker is a sheet — not invoked in these tests.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: () => null,
}));

// NOTE: location payload helper — not needed for picker tests.
jest.mock('../../../src/lib/location/locationPayload', () => ({
  placeToLocationFields: () => ({}),
}));

// NOTE: expo-image-picker — MediaSourceSheet calls permission APIs; grant all.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true, status: 'granted' })),
  requestCameraPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true, status: 'granted' })),
  launchImageLibraryAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: [] })),
  launchCameraAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: [] })),
}));

// ── MediaSourceSheet mock ─────────────────────────────────────────────────────
// Captures the `onResult` callback so tests can simulate picks without
// going through the actual image picker UI.

let mockOnResult: ((asset: ImagePickerTypes.ImagePickerAsset) => void) | null = null;

// NOTE: MediaSourceSheet is the shared picker sheet rendered by MediaPickerButton.
// We capture onResult each render so we always have the latest reference.
jest.mock('../../../src/components/ui/MediaSourceSheet', () => ({
  MediaSourceSheet: ({ onResult }: any) => {
    if (onResult) mockOnResult = onResult;
    return null;
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

let _assetCounter = 0;
function makeAsset(uri?: string): ImagePickerTypes.ImagePickerAsset {
  return {
    uri: uri ?? `file:///photo-${++_assetCounter}.jpg`,
    mimeType: 'image/jpeg',
    fileName: 'photo.jpg',
    fileSize: 100_000,
    type: 'image',
    width: 1200,
    height: 900,
    assetId: null,
    base64: null,
    exif: null,
    duration: null,
    pairedVideoAsset: undefined,
  } as unknown as ImagePickerTypes.ImagePickerAsset;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockOnResult = null;
  _assetCounter = 0;
});

describe('CreateMemoryScreen — picker re-enables after remove', () => {
  it('disables the Add button at the 10-item limit, then re-enables after a remove', async () => {
    const { getByTestId, getAllByLabelText, queryAllByLabelText } = await render(
      <CreateMemoryScreen />,
    );

    // onResult is registered on the first MediaSourceSheet mount.
    await waitFor(() => expect(mockOnResult).not.toBeNull());

    // ── Phase 1: pick 10 items ──────────────────────────────────────────────
    for (let i = 0; i < 10; i++) {
      await act(async () => { mockOnResult!(makeAsset()); });
    }

    // Confirm the grid now has 10 remove buttons — items landed in composer state.
    await waitFor(() =>
      expect(getAllByLabelText('Remove photo')).toHaveLength(10),
    );

    // After 10 items, canAddMore = false → Pressable renders with
    // accessibilityState.disabled = true (checked via toBeDisabled()).
    await waitFor(() => {
      expect(getByTestId('media-picker-button')).toBeDisabled();
    });

    // ── Phase 2: remove one item ────────────────────────────────────────────
    await act(async () => {
      fireEvent.press(getAllByLabelText('Remove photo')[0]);
    });

    // Grid should now have 9 items.
    await waitFor(() =>
      expect(queryAllByLabelText('Remove photo')).toHaveLength(9),
    );

    // canAddMore = true → button re-enables.
    await waitFor(() => {
      expect(getByTestId('media-picker-button')).not.toBeDisabled();
    });

    // ── Phase 3: pick one more — succeeds ──────────────────────────────────
    await act(async () => { mockOnResult!(makeAsset()); });

    // Back to 10 → button disabled again (confirming the pick actually worked).
    await waitFor(() =>
      expect(getAllByLabelText('Remove photo')).toHaveLength(10),
    );
    await waitFor(() => {
      expect(getByTestId('media-picker-button')).toBeDisabled();
    });
  });
});
