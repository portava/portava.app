/**
 * MemoriesTab — BOTH city/country render paths reach the place picker.
 *
 * ## Why this file exists at all
 *
 * MemoriesTab.tsx renders the same city + country pair twice, in two separate
 * components over two separate pieces of state: EditMemoryModal and
 * CreateMemoryModal. Nothing links them, so a change applied to one looks
 * finished — the field you were looking at now has a picker — while the other
 * keeps persisting whatever was typed.
 *
 * That is the specific way this defect comes back, so the assertion is not
 * "the picker exists" but "the picker exists in both places". The wiring itself
 * lives in one `usePlacePicker` hook precisely so the two call sites cannot
 * drift; this proves both call sites are actually there.
 *
 * The rule the picker applies to typed text — fill blanks silently, never
 * overwrite what the user typed without asking — is covered exhaustively in
 * src/lib/location/__tests__/applyPickedPlace.test.ts. That rule is the one
 * EventComposerSheet.tsx:604 and app/events/create/index.tsx:927 both carry a
 * "QA round 2, bug 6" comment about, and it is why it is one function.
 *
 * ## One press
 *
 * This tree's renderer (React 19 + RNTL v14) commits a single press-derived
 * state update per file. The create path needs no press — CreateMemoryModal is
 * exported and renders directly — so the file's one press is spent opening the
 * edit modal.
 */
import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react-native';
import { CreateMemoryModal, MemoriesTab } from '../MemoriesTab.tsx';
import { uploadMedia } from '../../services/media.ts';
import { createPassportMemory } from '../../services/passportStamps.ts';

// ── Module-scope stub ref (write-only in factory — allowed by Jest's hoisting) ──
// Refreshed on every render of the stub; test calls it directly for the re-pick.
let triggerResult: (() => void) | null = null;

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — Modal's animation lifecycle leaves a floating
// async act() scope after render(), which collides with subsequent explicit
// act() calls (overlapping act() → corrupted actScopeDepth → state never
// flushes).  ActivityIndicator is also stubbed: its getter reads
// this.NativeModules through `this = Proxy`, which can reach uninitialized
// native stubs and cause a silent render error.
jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = jest.requireActual('react-native');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  const MockModal = ({ children, visible }: { children: R.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View as React.ComponentType, null, children) : null;
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
  launchImageLibraryAsync: jest.fn(),
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

// NOTE: intentionally exhaustive — SharedVideoPlayer wraps expo-av Video.
jest.mock('../ui/SharedVideoPlayer', () => ({
  SharedVideoPlayer: () => null,
}));

// NOTE: intentionally exhaustive — VideoThumbnail imports expo-image which
// requires a native module unavailable in the jest-expo runner.
jest.mock('../ui/VideoThumbnail.tsx', () => ({
  VideoThumbnail: () => null,
}));

// NOTE: intentionally exhaustive — SaveButton imports the saves service graph.
jest.mock('../SaveButton', () => ({ SaveButton: () => null }));

// NOTE: intentionally exhaustive — MediaSourceSheet renders a native ActionSheet
// bottom-sheet that cannot run in jest-expo.  Hybrid stub: a useEffect path for
// the first pick (keeps the scheduler healthy for subsequent settleWith()) and a
// triggerResult ref for the re-pick (bypasses setMediaSheetOpen when the
// concurrent scheduler won't flush it after a deferred-promise settlement).
//
// global.__testOnResultCount is used instead of a module-scope let because
// jest.mock factories may not read outer-scope let/const variables (hoisting
// restriction); global IS in Jest's allowed-reference list.
jest.mock('../ui/MediaSourceSheet', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    MediaSourceSheet: ({
      visible,
      onResult,
      onClose,
    }: {
      visible: boolean;
      onResult: (asset: unknown) => void;
      onClose: () => void;
    }) => {
      // Always refresh the direct-invoke ref so the test can call it without
      // needing setMediaSheetOpen(true) to commit.  The counter is on global
      // so it can be read/incremented inside the factory (outer-scope let is
      // forbidden by Jest's hoisting rules).
      triggerResult = () => {
        global.__testOnResultCount = (global.__testOnResultCount || 0) + 1;
        onResult({
          uri: `file:///pick-${global.__testOnResultCount}.jpg`,
          mimeType: 'image/jpeg',
        });
        onClose();
      };

      // Normal UX path used for the first pick; keeps updates in the
      // scheduler's task queue rather than committing synchronously.
      React.useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ImagePicker = require('expo-image-picker');
        ImagePicker.launchImageLibraryAsync({}).then(
          (result: { canceled: boolean; assets?: Array<{ uri: string; mimeType?: string }> }) => {
            if (cancelled) return;
            if (result.canceled || !result.assets?.length) { onClose(); return; }
            global.__testOnResultCount = (global.__testOnResultCount || 0) + 1;
            onResult(result.assets[0]);
            onClose();
          },
        );
        return () => { cancelled = true; };
      }, [visible]);

      return null;
    },
  };
});

// ── Typed mocks ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const launchImageLibraryMock = require('expo-image-picker').launchImageLibraryAsync as jest.Mock;
const uploadMediaMock          = uploadMedia          as jest.Mock;
const createPassportMemoryMock = createPassportMemory as jest.Mock;

// ── Helper ─────────────────────────────────────────────────────────────────────

type UploadResult = { ok: boolean; url: string | null; mediaType: string | null; message?: string };

function deferredUpload() {
  let resolve!: (v: UploadResult) => void;
  const promise = new Promise<UploadResult>((res) => { resolve = res; });
  return { promise, resolve };
}

/** One act() scope that runs setup() then waits 30 ms for microtasks + effects. */
async function settleWith(setup: () => void): Promise<void> {
  await act(async () => {
    setup();
    await new Promise<void>((r) => setTimeout(r, 30));
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  triggerResult = null;
  (global as Record<string, unknown>).__testOnResultCount = 0;
  launchImageLibraryMock.mockReset();
  uploadMediaMock.mockReset();
  createPassportMemoryMock.mockReset();
});

afterEach(() => {
  jest.clearAllMocks();
});

// ── Test ───────────────────────────────────────────────────────────────────────

const MEMORY = {
  id: 'm-1',
  title: 'A day in Ubud',
  description: null,
  city: 'Ubud',
  country: 'Indonesia',
  category: 'city',
  visibility: 'public' as const,
  photoUrl: null,
  mediaType: null,
  createdAt: '2026-01-01T00:00:00Z',
  verificationLevel: 'none',
};

describe('MemoriesTab — the create path can pick a place', () => {
  it('renders the picker entry point in CreateMemoryModal', async () => {
    await render(<CreateMemoryModal visible onClose={jest.fn()} onCreated={jest.fn()} />);

    expect(screen.getByTestId('memory-create-pick-place')).toBeTruthy();
  });
});

describe('MemoriesTab — the edit path can pick a place too', () => {
  it('renders the picker entry point in EditMemoryModal', async () => {
    // The path that would have been missed. EditMemoryModal is not exported, so
    // it is reached the way a user reaches it: through a memory card's edit
    // control. This file's single press is spent here.
    await render(
      <MemoriesTab memories={[MEMORY as never]} loading={false} onReload={jest.fn()} />,
    );

    fireEvent.press(screen.getByTestId('icon-Pencil'));
    await act(async () => {});

    expect(screen.getByTestId('memory-edit-pick-place')).toBeTruthy();
  });
});
