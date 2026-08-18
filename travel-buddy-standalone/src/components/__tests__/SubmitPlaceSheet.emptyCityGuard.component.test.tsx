/**
 * SubmitPlaceSheet — an empty city must not be submitted.
 *
 * ## Why this guard exists, and why it belongs to us
 *
 * `city` is not an input on this sheet. It arrives as a prop:
 * `app/(tabs)/discovery.tsx` renders `<SubmitPlaceSheet city={destination} …/>`.
 *
 * While Discovery fell back to a hardcoded 'Paris', `destination` could never be
 * empty, so `handleSubmit` never needed to check it — it validated `name` and
 * nothing else. Removing that fallback (so the screen honestly reports "no city
 * known") made an empty `destination` reachable, and with it a community place
 * submitted with `city: ''`. The server keys community places by city, so an
 * empty one is unroutable.
 *
 * That is a behaviour change the fallback removal caused, which is why the guard
 * ships with it rather than being left for whoever finds the orphaned rows.
 * "Empty is more honest than Paris" is true and is not a reason to persist it.
 *
 * The submit button is in the Discover header and does not depend on destination
 * state, so an unlocated user really can reach this.
 */
import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react-native';
import { SubmitPlaceSheet } from '../discovery/SubmitPlaceSheet.tsx';
import { submitCommunityPlace } from '../../services/discovery.ts';

// ── Modal Proxy ────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — Modal's animation lifecycle posts a macrotask
// after render() that corrupts actScopeDepth and IsSomeRendererActing (see
// TESTING.md Rule 6). Proxy replaces only 'Modal' with a synchronous View.
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
// server and Supabase auth stack; requireActual causes live network or OOM.
jest.mock('../../services/media.ts', () => ({
  validateMedia: jest.fn(() => ({ ok: true })),
  uploadMedia: jest.fn().mockResolvedValue({ ok: true, url: null, mediaType: null }),
}));

// NOTE: intentionally exhaustive — submitCommunityPlace calls the API server
// and the Supabase auth token stack.
jest.mock('../../services/discovery.ts', () => ({
  submitCommunityPlace: jest.fn(),
}));

// NOTE: intentionally exhaustive — KeyboardSafeView measures native keyboard
// events unavailable under jest.
jest.mock('../ui/KeyboardSafeView.tsx', () => {
  const RN = jest.requireActual('react-native');
  return {
    KeyboardSafeView: ({ children }: { children: React.ReactNode }) => <RN.View>{children}</RN.View>,
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => <RN.View>{children}</RN.View>,
  };
});

// NOTE: intentionally exhaustive — GpsLocationCapture pulls expo-location.
jest.mock('../location/GpsLocationCapture.tsx', () => ({ GpsLocationCapture: () => null }));

// NOTE: intentionally exhaustive — safe-area context needs a native provider.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — media chrome is not under test here.
jest.mock('../ui/MediaSourceSheet.tsx', () => ({ MediaSourceSheet: () => null }));
jest.mock('../ui/MediaAttachmentTray.tsx', () => ({ MediaAttachmentTray: () => null }));
jest.mock('../ui/MediaPickerButton.tsx', () => ({ MediaPickerButton: () => null }));

const mockSubmit = submitCommunityPlace as jest.Mock;

beforeEach(() => {
  mockSubmit.mockReset();
  mockSubmit.mockResolvedValue({
    ok: true,
    place: { id: 'p-1', name: 'X', city: 'Rome', place_type: 'hidden_gem', status: 'pending', created_at: '2026-01-01T00:00:00Z' },
  });
});

describe('SubmitPlaceSheet — empty city guard', () => {
  // ONE test only. This tree's renderer (React 19 + RNTL v14) commits a single
  // press-derived state update per file, so a second submit attempt never
  // re-renders and fails on a stale tree. The rule's full table lives in
  // src/lib/discovery/__tests__/communityPlaceSubmission.test.ts; this proves
  // the sheet is actually wired to it.
  it('does not submit when the destination is empty', async () => {
    await render(<SubmitPlaceSheet visible city="" onClose={jest.fn()} />);

    // Name IS filled, so a blocked submit here is attributable to the city and
    // not to the pre-existing name check. Its sibling file
    // SubmitPlaceSheet.cityAccepted.component.test.tsx renders the identical
    // sequence with city="Rome" and asserts the call DOES happen, which is what
    // pins that attribution.
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Secret rooftop bar'), 'Orphan Place');
    await act(async () => {});
    fireEvent.press(screen.getByText('Submit Place'));
    await act(async () => {});

    expect(mockSubmit).not.toHaveBeenCalled();
    // The error TEXT is not asserted here: changeText has already consumed this
    // file's one available commit, so the press-derived setError never renders.
    // The message and the name-before-city ordering are covered exhaustively in
    // src/lib/discovery/__tests__/communityPlaceSubmission.test.ts.
  });
});
