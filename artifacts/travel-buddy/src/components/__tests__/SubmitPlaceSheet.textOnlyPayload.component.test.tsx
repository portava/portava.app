/**
 * SubmitPlaceSheet — text-only payload omits photos field
 *
 * Confirms that submitting without picking any photo results in
 * submitCommunityPlace being called with photos: undefined (not an empty
 * array).  An empty array would be a mis-wiring of the photos field; the API
 * contract requires the field to be absent when there are no photos.
 *
 * ## Act discipline
 * Uses the Modal Proxy (TESTING.md Rule 6) so the Modal renders synchronously.
 * Uses `await act(async () => {})` after fireEvent.changeText to commit the
 * controlled-input state update before pressing Submit — without this flush
 * React 19 batching leaves name === '' when handleSubmit reads it, triggering
 * the early-return validation guard and silently skipping the API call.
 * Lives in its own file (TESTING.md two-file rule).
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SubmitPlaceSheet } from '../discovery/SubmitPlaceSheet.tsx';
import { submitCommunityPlace } from '../../services/discovery.ts';

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
// modules unavailable in the jest-expo runner.
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
  uploadMedia: jest.fn().mockResolvedValue({ ok: true, url: null, mediaType: null }),
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

// NOTE: intentionally exhaustive — MediaSourceSheet and MediaAttachmentTray
// are not triggered in the text-only path; stubs avoid their native deps.
jest.mock('../ui/MediaSourceSheet.tsx', () => ({ MediaSourceSheet: () => null }));
jest.mock('../ui/MediaAttachmentTray.tsx', () => ({ MediaAttachmentTray: () => null }));

// NOTE: intentionally exhaustive — MediaPickerButton renders lucide icons and
// opens MediaSourceSheet; not needed in the text-only path.
jest.mock('../ui/MediaPickerButton.tsx', () => ({ MediaPickerButton: () => null }));

// ── Typed mock ─────────────────────────────────────────────────────────────────

const mockSubmitCommunityPlace = submitCommunityPlace as jest.Mock;

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSubmitCommunityPlace.mockReset();
  mockSubmitCommunityPlace.mockResolvedValue({
    ok: true,
    place: {
      id: 'p-2',
      name: 'Text Only Place',
      city: 'Rome',
      place_type: 'hidden_gem',
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
    },
  });
});

// ── Test ───────────────────────────────────────────────────────────────────────

describe('SubmitPlaceSheet — text-only payload', () => {
  it('passes photos: undefined (not an empty array) when no photo is picked', async () => {
    await render(
      <SubmitPlaceSheet visible city="Rome" onClose={jest.fn()} />,
    );

    // Set the required name field.
    fireEvent.changeText(
      screen.getByPlaceholderText('e.g. Secret rooftop bar'),
      'Text Only Place',
    );

    // Flush the controlled-input state update.  Without this flush, React 19
    // batching can leave name === '' when handleSubmit reads it, triggering
    // the early-return guard and silently skipping the API call.
    await act(async () => {});

    // Submit — handleSubmit runs uploadAll() on an empty items list (returns an
    // empty Map immediately), builds an empty photos array, and passes
    // photos: undefined because photos.length === 0.
    fireEvent.press(screen.getByText('Submit Place'));

    await waitFor(
      () => expect(mockSubmitCommunityPlace).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    // photos must be absent / undefined — not an empty array.
    const payload: Record<string, unknown> = mockSubmitCommunityPlace.mock.calls[0][0];
    expect(payload.photos).toBeUndefined();
  });
});
