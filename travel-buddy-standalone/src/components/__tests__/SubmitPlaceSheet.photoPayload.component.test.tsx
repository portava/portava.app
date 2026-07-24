/**
 * SubmitPlaceSheet — photo payload reaches submitCommunityPlace
 *
 * Confirms that after picking a photo and pressing Submit, the CDN URL
 * returned by uploadMedia appears in the photos array passed to
 * submitCommunityPlace.  A dropped URL (bug in the upload→payload handoff)
 * would produce photos: undefined or an empty array instead.
 *
 * ## Act discipline
 * Uses the Modal Proxy (TESTING.md Rule 6) so the Modal renders synchronously.
 * Uses a direct MediaPickerButton stub that calls composer.onPickResult()
 * synchronously on press — this avoids the async MediaSourceSheet →
 * expo-image-picker chain whose useEffect/promise timing is unreliable inside
 * a single act() window.  The stub mirrors exactly what MediaPickerButton
 * would eventually deliver to the hook.
 * Lives in its own file because the photo-picker act() path leaves overlapping
 * act() warnings that corrupt screen's cleanup for any subsequent test in the
 * same file (TESTING.md two-file rule).
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SubmitPlaceSheet } from '../discovery/SubmitPlaceSheet.tsx';
import { submitCommunityPlace } from '../../services/discovery.ts';
import { uploadMedia } from '../../services/media.ts';

const CDN_URL = 'https://cdn.example.com/uploads/place-photo.jpg';

// ── Modal Proxy ────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — Modal's animation lifecycle posts a macrotask
// after render() that corrupts actScopeDepth and IsSomeRendererActing (see
// TESTING.md Rule 6).  Proxy replaces only 'Modal' with a synchronous View.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const R = require('react') as typeof import('react');
        return ({ children, visible }: { children: R.ReactNode; visible?: boolean }) =>
          visible ? R.createElement(target.View as React.ComponentType, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: intentionally exhaustive — expo-image-picker requires native permission
// modules unavailable in the jest-expo runner; not needed since MediaPickerButton
// is stubbed to call onPickResult directly without going through the picker sheet.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true }),
  MediaTypeOptions: { Images: 'Images' },
}));

// NOTE: intentionally exhaustive — uploadMedia / validateMedia call the API
// server and Supabase auth stack; pulling requireActual causes live network
// requests or OOM in the jest-expo runner.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: jest.fn(),
}));

// NOTE: intentionally exhaustive — submitCommunityPlace calls the API server
// and the Supabase auth token stack; pulling requireActual causes live network
// requests.
jest.mock('../../services/discovery.ts', () => ({
  submitCommunityPlace: jest.fn(),
}));

// NOTE: intentionally exhaustive — KeyboardAvoidingView internals not needed
// and crash the jest-expo runner when native keyboard metrics are unavailable.
jest.mock('../ui/KeyboardSafeView.tsx', () => ({
  KeyboardSafeScrollView: ({ children }: { children: unknown }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const R = require('react') as typeof import('react');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { View } = require('react-native') as typeof import('react-native');
    return R.createElement(View, null, children);
  },
}));

// NOTE: intentionally exhaustive — GpsLocationCapture imports native geo APIs
// unavailable in the jest-expo runner.
jest.mock('../location/GpsLocationCapture.tsx', () => ({
  GpsLocationCapture: () => null,
}));

// NOTE: intentionally exhaustive — useSafeAreaInsets requires a native insets
// provider not present in the jest-expo runner.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — MediaPickerButton stub calls
// composer.onPickResult() directly and synchronously on press, bypassing the
// async MediaSourceSheet → expo-image-picker chain.  This mirrors what the
// real component ultimately delivers to useMediaComposer once the user picks
// a photo, without depending on useEffect/promise timing inside act().
jest.mock('../ui/MediaPickerButton.tsx', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable } = require('react-native') as typeof import('react-native');
  return {
    MediaPickerButton: ({
      composer,
      testID,
    }: {
      composer: { onPickResult: (asset: unknown) => void };
      testID?: string;
    }) =>
      React.createElement(Pressable, {
        testID: testID ?? 'media-picker-button',
        onPress: () =>
          composer.onPickResult({
            uri: 'file:///test/place-photo.jpg',
            type: 'image',
            mimeType: 'image/jpeg',
            width: 1200,
            height: 900,
            fileName: 'place-photo.jpg',
            fileSize: 512_000,
            duration: null,
            assetId: null,
            base64: null,
            exif: null,
            pairedVideoAsset: undefined,
          }),
      }),
  };
});

// NOTE: stub renders a sentinel testID containing the item count so the test
// can confirm the photo was registered in composer before pressing Submit.
jest.mock('../ui/MediaAttachmentTray.tsx', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native') as typeof import('react-native');
  return {
    MediaAttachmentTray: ({ composer }: { composer: { items: unknown[] } }) =>
      React.createElement(View, { testID: `media-tray-items-${composer.items.length}` }),
  };
});

// NOTE: intentionally exhaustive — not triggered by the MediaPickerButton stub.
jest.mock('../ui/MediaSourceSheet.tsx', () => ({ MediaSourceSheet: () => null }));

// ── Typed mocks ────────────────────────────────────────────────────────────────

const mockSubmitCommunityPlace = submitCommunityPlace as jest.Mock;
const mockUploadMedia          = uploadMedia          as jest.Mock;

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSubmitCommunityPlace.mockReset();
  mockUploadMedia.mockReset();
  mockUploadMedia.mockResolvedValue({ ok: true, url: CDN_URL, mediaType: 'image/jpeg' });
  mockSubmitCommunityPlace.mockResolvedValue({
    ok: true,
    place: {
      id: 'p-1',
      name: 'My Place',
      city: 'Paris',
      place_type: 'hidden_gem',
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
    },
  });
});

// ── Test ───────────────────────────────────────────────────────────────────────

describe('SubmitPlaceSheet — photo payload', () => {
  it('includes the CDN URL in the photos array passed to submitCommunityPlace', async () => {
    await render(
      <SubmitPlaceSheet visible city="Paris" onClose={jest.fn()} />,
    );

    // Press the picker stub — onPickResult() is called synchronously, adding
    // the asset to composer.items via setItems.  The act() wrapper commits the
    // state update so the component re-renders before we proceed.
    await act(async () => {
      fireEvent.press(screen.getByTestId('media-picker-button'));
    });

    // Confirm the photo is registered: SubmitPlaceSheet renders MediaAttachmentTray
    // only when composer.items.length > 0, so the sentinel testID appearing
    // confirms the item is in the hook's state and itemsRef.current is synced.
    await waitFor(() => screen.getByTestId('media-tray-items-1'), { timeout: 3_000 });

    // Fill in the required name field and flush the state update.
    fireEvent.changeText(
      screen.getByPlaceholderText('e.g. Secret rooftop bar'),
      'My Place',
    );
    await act(async () => {});

    // Submit — handleSubmit calls uploadAll() (which calls uploadMedia for the
    // one idle item) then passes the CDN URL to submitCommunityPlace.
    fireEvent.press(screen.getByText('Submit Place'));

    // Wait for the full upload → submit pipeline to complete.
    await waitFor(
      () => expect(mockSubmitCommunityPlace).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    // The CDN URL returned by uploadMedia must reach the photos field.
    expect(mockSubmitCommunityPlace).toHaveBeenCalledWith(
      expect.objectContaining({ photos: [CDN_URL] }),
    );
  });
});
