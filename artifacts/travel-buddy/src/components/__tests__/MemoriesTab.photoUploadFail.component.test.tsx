/**
 * CreateMemoryModal — upload failure surface
 *
 * When uploadMedia returns { ok: false, message: 'Upload failed' }:
 *   • the inline upload-error message is visible
 *   • createPassportMemory is NOT called (no save without a photo URL)
 *
 * ## act() / screen discipline
 *
 * CreateMemoryModal wraps everything in react-native's <Modal>.  The Modal
 * animation/visibility lifecycle creates an async act() scope inside RNTL's
 * render() promise.  Any subsequent explicit act() call then collides with
 * that floating scope → "overlapping act() calls" → actScopeDepth corrupted
 * → state updates never flush.
 *
 * Fixes applied:
 *
 * A. react-native's Modal is replaced with a synchronous View via a Proxy
 *    mock (see below).  The Proxy intercepts only the 'Modal' key so every
 *    other export RNTL needs (AccessibilityInfo, Platform, …) falls through
 *    to the actual react-native module via Reflect.get.
 *
 * B. `await render()` is called OUTSIDE any explicit act() wrapper.
 *
 * C. Every state-producing press is wrapped in `await act(async () => { … })`.
 *
 * D. uploadMedia is mocked with a deferred promise (not mockResolvedValue).
 *    Fast-resolving mocks fire handleSave's continuation between waitFor polls,
 *    outside any act scope.  Deferreds let us call resolve() inside settleWith
 *    so every state-setter runs within a controlled act scope.
 *
 * E. This test lives in its own file.  The two upload-path tests share mocks
 *    and act() helpers but cannot coexist in the same file: test 1's act scopes
 *    corrupt the screen global in a way that prevents test 2's render from
 *    rebinding it.  Separate files → separate Jest workers → no shared state.
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { CreateMemoryModal } from '../MemoriesTab.tsx';
import { uploadMedia } from '../../services/media.ts';
import { createPassportMemory } from '../../services/passportStamps.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — Modal's animation lifecycle leaves a floating
// async act() scope after render(), which collides with subsequent explicit
// act() calls (overlapping act() → corrupted actScopeDepth → state never
// flushes).  The Proxy replaces only 'Modal' with a synchronous View; all
// other react-native exports fall through untouched via Reflect.get.
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

// NOTE: intentionally exhaustive — expo-image-picker requires native camera
// permission modules unavailable in the jest-expo runner.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///picked-photo.jpg', mimeType: 'image/jpeg' }],
  }),
  MediaTypeOptions: { Images: 'Images' },
}));

// NOTE: intentionally exhaustive — uploadMedia calls the API server and Supabase
// auth stack; pulling requireActual would cause live network requests.
jest.mock('../../services/media', () => ({
  uploadMedia: jest.fn(),
}));

// NOTE: intentionally exhaustive — createPassportMemory calls the API server and
// Supabase auth stack; pulling requireActual would cause live network requests.
jest.mock('../../services/passportStamps', () => ({
  createPassportMemory: jest.fn(),
  updatePassportMemory: jest.fn(),
}));

// NOTE: intentionally exhaustive — KeyboardSafeView wraps KeyboardAvoidingView
// with native keyboard metrics that crash the jest-expo runner.
jest.mock('../ui/KeyboardSafeView', () => {
  const ReactActual = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    KeyboardSafeView: ({ children }: { children: unknown }) =>
      ReactActual.createElement(View, null, children),
  };
});

// NOTE: intentionally exhaustive — SaveButton imports the saves service graph
// (Supabase + API token stack); pulling requireActual would cause OOM.
jest.mock('../SaveButton', () => ({ SaveButton: () => null }));

// ── Typed mocks ────────────────────────────────────────────────────────────────

const uploadMediaMock          = uploadMedia          as jest.Mock;
const createPassportMemoryMock = createPassportMemory as jest.Mock;

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  uploadMediaMock.mockReset();
  createPassportMemoryMock.mockReset();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function deferredUpload() {
  let resolve!: (v: { ok: boolean; url: string | null; mediaType: string | null; message?: string }) => void;
  const promise = new Promise<{ ok: boolean; url: string | null; mediaType: string | null; message?: string }>(
    (res) => { resolve = res; },
  );
  return { promise, resolve };
}

async function settleWith(setup: () => void): Promise<void> {
  await act(async () => {
    setup();
    await new Promise<void>((r) => setTimeout(r, 30));
  });
}

// ── Test ───────────────────────────────────────────────────────────────────────

describe('CreateMemoryModal — upload failure', () => {
  it('shows the upload error message when uploadMedia fails and does NOT call createPassportMemory', async () => {
    const d = deferredUpload();
    uploadMediaMock.mockReturnValue(d.promise);

    // await render() outside any act() — see rule B in file header.
    await render(<CreateMemoryModal visible onClose={jest.fn()} onCreated={jest.fn()} />);

    fireEvent.changeText(
      screen.getByPlaceholderText('A memorable moment\u2026'),
      'My test memory',
    );

    // Photo pick: press + 30 ms timeout within one act so both ImagePicker
    // awaits (requestPermissions + launchImageLibrary) resolve before act exits.
    await act(async () => {
      fireEvent.press(screen.getByText('Add photo'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });
    screen.getByText('Change'); // sync confirmation that setPhotoUri committed

    // Save press: handleSave suspends at await uploadMedia(d.promise).
    await act(async () => { fireEvent.press(screen.getByText('Save Memory')); });
    expect(uploadMediaMock).toHaveBeenCalledTimes(1);

    // Resolve inside settleWith: handleSave's continuation
    // (setUploading(false), setUploadError('Upload failed'), setSaving(false))
    // fires as a microtask before the 30 ms timer, inside the act scope.
    await settleWith(() =>
      d.resolve({ ok: false, url: null, mediaType: null, message: 'Upload failed' }),
    );

    await waitFor(() => expect(screen.getByText('Upload failed')).toBeTruthy());
    expect(createPassportMemoryMock).not.toHaveBeenCalled();
  });
});
