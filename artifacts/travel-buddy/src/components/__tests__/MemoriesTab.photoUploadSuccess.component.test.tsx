/**
 * CreateMemoryModal — upload success surface
 *
 * When uploadMedia returns { ok: true, url: '…' }:
 *   • createPassportMemory IS called with the returned URL in photoUrl
 *   • onCreated fires after the save completes
 *
 * See MemoriesTab.photoUploadFail.component.test.tsx for the full explanation
 * of the act() / screen discipline and mock strategy that applies to both files.
 *
 * This test lives in its own file because the two upload-path tests cannot
 * coexist in the same file: test 1's act scopes corrupt the screen global in
 * a way that prevents test 2's render from rebinding it.  Separate files →
 * separate Jest workers → no shared state.
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function deferredUpload() {
  let resolve!: (v: { ok: boolean; url: string | null; mediaType: string | null; message?: string }) => void;
  const promise = new Promise<{ ok: boolean; url: string | null; mediaType: string | null; message?: string }>(
    (res) => { resolve = res; },
  );
  return { promise, resolve };
}

function deferredCreate() {
  let resolve!: (v: { ok: boolean; data?: unknown; message?: string }) => void;
  const promise = new Promise<{ ok: boolean; data?: unknown; message?: string }>(
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

describe('CreateMemoryModal — upload success', () => {
  it('calls createPassportMemory with the returned photoUrl when uploadMedia succeeds', async () => {
    const PHOTO_URL = 'https://cdn.example.com/uploads/photo.jpg';
    const dUpload = deferredUpload();
    const dCreate = deferredCreate();
    uploadMediaMock.mockReturnValue(dUpload.promise);
    createPassportMemoryMock.mockReturnValue(dCreate.promise);

    const onCreated = jest.fn();

    await render(<CreateMemoryModal visible onClose={jest.fn()} onCreated={onCreated} />);

    fireEvent.changeText(
      screen.getByPlaceholderText('A memorable moment\u2026'),
      'My test memory',
    );

    await act(async () => {
      fireEvent.press(screen.getByText('Add photo or video'));
      await new Promise<void>((r) => setTimeout(r, 30));
    });
    screen.getByText('Change');

    await act(async () => { fireEvent.press(screen.getByText('Save Memory')); });
    expect(uploadMediaMock).toHaveBeenCalledTimes(1);

    // Settle upload: handleSave's continuation runs, sets photoUrl = PHOTO_URL,
    // calls createPassportMemory, then suspends at that await.
    await settleWith(() =>
      dUpload.resolve({ ok: true, url: PHOTO_URL, mediaType: 'image/jpeg' }),
    );

    expect(createPassportMemoryMock).toHaveBeenCalledTimes(1);
    expect(createPassportMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ photoUrl: PHOTO_URL }),
    );

    // Settle createPassportMemory: handleSave finishes → setSaving(false),
    // onCreated(res.data), resetForm(), onClose() — all within act scope.
    await settleWith(() =>
      dCreate.resolve({
        ok: true,
        data: {
          id: 'mem-new',
          status: 'active',
          title: 'My test memory',
          description: null,
          country: null,
          city: null,
          neighborhood: null,
          category: 'city',
          visibility: 'private',
          verificationLevel: 'unverified',
          sourceType: null,
          photoUrl: PHOTO_URL,
          planId: null,
          tripId: null,
          suggestionReason: null,
          earnedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      }),
    );

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });
});
