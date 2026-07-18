/**
 * CreateMemoryModal — upload error clears on re-pick
 *
 * After an upload failure the upload-error banner is visible.  When the user
 * presses 'Change' to pick a new photo the banner must disappear — pickMedia()
 * calls setUploadError('') as its first statement so the stale message never
 * lingers into a subsequent attempt.
 *
 * ## act() / screen discipline — same constraints as photoUploadFail
 *
 * A. react-native's Modal replaced with a synchronous View (Proxy mock) to
 *    prevent the floating async act() scope that corrupts actScopeDepth.
 * B. `await render()` outside any explicit act().
 * C. settleWith (async act + 30 ms timeout) commits every setState batch.
 * D. uploadMedia uses a deferred promise so resolve() fires inside the act
 *    scope controlled by settleWith.
 * E. The initial error-visibility check uses a synchronous getByText rather
 *    than waitFor.  waitFor temporarily sets IS_REACT_ACT_ENVIRONMENT=false
 *    (via wrapAsync), which can interfere with how subsequent act() calls
 *    route scheduler work: stale microtasks from scheduleImmediateRootSchedule
 *    Task fire during the waitFor polling window and leave processRootSchedule
 *    InMicrotask in a "already ran" state, so the Dismiss/re-pick setState
 *    is never flushed by a later flushActQueue.  Skipping waitFor before the
 *    re-pick sidesteps this entirely — settleWith's own flushActQueue commits
 *    both setUploadError('') and setPhotoUri atomically.
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
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

// NOTE: intentionally exhaustive — expo-av (Video component) requires native
// AV modules unavailable in the jest-expo runner; SharedVideoPlayer wraps it.
jest.mock('expo-av', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = jest.requireActual('react') as typeof import('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    Video: (props: Record<string, unknown>) =>
      R.createElement(View as React.ComponentType, { testID: 'expo-av-video', ...props }),
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
const launchImageLibraryMock   = ImagePicker.launchImageLibraryAsync as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function deferredUpload() {
  let resolve!: (v: {
    ok: boolean;
    url: string | null;
    mediaType: string | null;
    message?: string;
  }) => void;
  const promise = new Promise<{
    ok: boolean;
    url: string | null;
    mediaType: string | null;
    message?: string;
  }>((res) => { resolve = res; });
  return { promise, resolve };
}

async function settleWith(setup: () => void): Promise<void> {
  await act(async () => {
    setup();
    await new Promise<void>((r) => setTimeout(r, 30));
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  uploadMediaMock.mockReset();
  createPassportMemoryMock.mockReset();
  launchImageLibraryMock.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///picked-photo.jpg', mimeType: 'image/jpeg' }],
  });
});

// ── Test ───────────────────────────────────────────────────────────────────────

describe('CreateMemoryModal — upload error clears on re-pick', () => {
  it('clears the upload error when the user picks a new photo after a failure', async () => {
    const d = deferredUpload();
    uploadMediaMock.mockReturnValue(d.promise);

    // Rule B: await render() outside any act().
    await render(<CreateMemoryModal visible onClose={jest.fn()} onCreated={jest.fn()} />);

    fireEvent.changeText(
      screen.getByPlaceholderText('A memorable moment\u2026'),
      'My test memory',
    );

    // ── First photo pick ──────────────────────────────────────────────────────
    // 30 ms window lets both ImagePicker awaits (requestPermissions + launch)
    // resolve inside the act scope so setPhotoUri is committed by flushActQueue.
    await act(async () => {
      fireEvent.press(screen.getByText('Add photo or video'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });
    screen.getByText('Change'); // sync: setPhotoUri committed

    // ── Save → suspended at uploadMedia ──────────────────────────────────────
    await act(async () => { fireEvent.press(screen.getByText('Save Memory')); });
    expect(uploadMediaMock).toHaveBeenCalledTimes(1);

    // ── Settle upload failure ─────────────────────────────────────────────────
    // handleSave's continuation fires as a microtask before the 30 ms timer,
    // committing setUploading(false) + setUploadError('Upload failed') +
    // setSaving(false) inside the act scope via flushActQueue.
    await settleWith(() =>
      d.resolve({ ok: false, url: null, mediaType: null, message: 'Upload failed' }),
    );

    // Synchronous check — no waitFor, which avoids the IS_REACT_ACT_ENVIRONMENT
    // disruption described in the file header (rule E).
    expect(screen.getByText('Upload failed')).toBeTruthy();
    expect(createPassportMemoryMock).not.toHaveBeenCalled();

    // ── Re-pick ───────────────────────────────────────────────────────────────
    // Use a fresh URI so setPhotoUri emits a genuine change alongside
    // setUploadError('') — prevents React from eliding the render.
    launchImageLibraryMock.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///picked-photo-2.jpg', mimeType: 'image/jpeg' }],
    });

    // settleWith commits pickMedia's state batch atomically:
    //   1. setUploadError('')  — sync, before first await
    //   2. (requestPermissions resolves during 30 ms window)
    //   3. (launchImageLibrary resolves during 30 ms window)
    //   4. setPhotoUri('file:///picked-photo-2.jpg') — committed together with (1)
    await settleWith(() => {
      fireEvent.press(screen.getByText('Change'));
    });

    // Confirms pickMedia ran fully (two launchImageLibrary calls total).
    // Since setUploadError('') is pickMedia's FIRST statement, and pickMedia ran,
    // the setter was definitely called.
    expect(launchImageLibraryMock).toHaveBeenCalledTimes(2);

    // Upload error must be gone — settleWith committed the batch that includes
    // setUploadError('').  waitFor here is just a safety poll with a short
    // timeout; the state should already be committed.
    await waitFor(
      () => expect(screen.queryByText('Upload failed')).toBeNull(),
      { timeout: 2000 },
    );

    expect(createPassportMemoryMock).not.toHaveBeenCalled();
  });
});
