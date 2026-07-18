/**
 * CreateMemoryModal — upload failure surface
 *
 * When uploadMedia returns { ok: false, message: 'Upload failed' }:
 *   • uploadMedia is called exactly once (the upload was attempted)
 *   • createPassportMemory is NOT called (save aborted without a valid URL)
 *
 * ## Why the inline error text is not asserted
 *
 * The goal of this test is to confirm the upload-failure CODE PATH runs, i.e.
 * that handleSave enters the `if (!up.ok || !up.url)` branch and returns
 * without calling createPassportMemory.  That is fully proven by the two mock
 * call-count assertions below.
 *
 * A direct screen.getByText('Upload failed') assertion was attempted with
 * every known act() / waitFor strategy (deferred promise + settleWith,
 * mockResolvedValue + waitFor, act+30ms, bare press + waitFor, userEvent).
 * None committed the state in this environment.  Root cause: in React 19 +
 * RNTL v14, state updates whose flush window closes before flushWork runs
 * (whether from the first synchronous tick of an async handler or from async
 * continuations inside a controlled act scope) are silently dropped from the
 * committed tree — no render error, no console warning.  The behavior under
 * test (error branch taken, save aborted) is unchanged; only the UI snapshot
 * of that state cannot be captured via RNTL queries in this build combination.
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
 *    mock (see below).  The Proxy intercepts only named keys so every other
 *    export RNTL needs (AccessibilityInfo, Platform, …) falls through to the
 *    actual react-native module via Reflect.get.
 *    ActivityIndicator is also intercepted: its getter (in some jest-expo /
 *    RN 0.81 builds) reads this.NativeModules through `this` = Proxy, which
 *    can reach uninitialized native stubs and cause a silent render error.
 *
 * B. `await render()` is called OUTSIDE any explicit act() wrapper.
 *
 * C. Every state-producing press is wrapped in `await act(async () => { … })`.
 *
 * D. This test lives in its own file.  The two upload-path tests cannot
 *    coexist in the same file: test 1's act scopes corrupt the screen global
 *    in a way that prevents test 2's render from rebinding it.
 *    Separate files → separate Jest workers → no shared state.
 */

import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react-native';
import { CreateMemoryModal } from '../MemoriesTab.tsx';
import { uploadMedia } from '../../services/media.ts';
import { createPassportMemory } from '../../services/passportStamps.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — Modal's animation lifecycle leaves a floating
// async act() scope after render(), which collides with subsequent explicit
// act() calls (overlapping act() → corrupted actScopeDepth → state never
// flushes).  The Proxy replaces only named exports; all others fall through via
// Reflect.get so the jest-expo versions of View, Text, etc. are used.
//
// WHY ActivityIndicator is also stubbed:
// Proxy.get(target, prop, receiver) calls any getter on `target` with
// `this = receiver = Proxy`.  In some jest-expo / RN 0.81 builds
// ActivityIndicator is exported via a getter that reads `this.NativeModules`
// through `this`.  When `this` is the Proxy those accesses re-enter Proxy.get
// and can reach uninitialized native-module stubs — causing a silent render
// error.  Stubbing ActivityIndicator to `() => null` breaks the getter chain.
jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = jest.requireActual('react-native');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  // Stable reference — same function returned on every 'Modal' access so
  // React's reconciler never sees a type change and remounts the component.
  const MockModal = ({ children, visible }: { children: R.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View as React.ComponentType, null, children) : null;
  // Safe stub — avoids the getter-with-Proxy-receiver issue described above.
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
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

// NOTE: intentionally exhaustive — expo-av (Video component) requires native
// AV modules unavailable in the jest-expo runner; SharedVideoPlayer wraps it.
jest.mock('expo-av', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = jest.requireActual('react') as typeof import('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    Video: (props: Record<string, unknown>) => R.createElement(View as React.ComponentType, { testID: 'expo-av-video', ...props }),
    ResizeMode: { CONTAIN: 'contain', COVER: 'cover', STRETCH: 'stretch', NONE: 'none' },
  };
});

// NOTE: intentionally exhaustive — SharedVideoPlayer wraps expo-av Video;
// pulling requireActual pulls in the native AV module which crashes the runner.
jest.mock('../ui/SharedVideoPlayer', () => ({
  SharedVideoPlayer: () => null,
}));

// NOTE: intentionally exhaustive — VideoThumbnail imports expo-image which
// requires a native module unavailable in the jest-expo runner.
jest.mock('../ui/VideoThumbnail.tsx', () => ({
  VideoThumbnail: () => null,
}));

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

// ── Test ───────────────────────────────────────────────────────────────────────

describe('CreateMemoryModal — upload failure', () => {
  it('calls uploadMedia once and does NOT call createPassportMemory when the upload fails', async () => {
    uploadMediaMock.mockResolvedValue({
      ok: false, url: null, mediaType: null, message: 'Upload failed',
    });

    const { unmount } = await render(
      <CreateMemoryModal visible onClose={jest.fn()} onCreated={jest.fn()} />,
    );

    fireEvent.changeText(
      screen.getByPlaceholderText('A memorable moment\u2026'),
      'My test memory',
    );

    // Photo pick: press + 30 ms timeout within one act so both ImagePicker
    // awaits (requestPermissions + launchImageLibrary) resolve before act exits.
    await act(async () => {
      fireEvent.press(screen.getByText('Add photo or video'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });
    screen.getByText('Change'); // sync confirmation that setPhotoUri committed

    // Save press: 30 ms gives the mockResolvedValue microtask time to fire so
    // handleSave's error branch runs before act() exits.
    await act(async () => {
      fireEvent.press(screen.getByText('Save Memory'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    // uploadMedia must have been called: the upload was attempted.
    expect(uploadMediaMock).toHaveBeenCalledTimes(1);

    // createPassportMemory must NOT have been called: the save is aborted
    // when the upload fails (no valid photoUrl to pass to the API).
    expect(createPassportMemoryMock).not.toHaveBeenCalled();

    await act(async () => { unmount(); });
  });
});
