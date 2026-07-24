/**
 * ReportSheet — safety evidence photo cleared on close.
 *
 * Covers:
 *   1. Picking a photo while safety_concern is selected causes MediaAttachmentTray
 *      to appear (items.length > 0) on step 2.
 *   2. Closing the sheet (X button) clears the photo — on next open MediaAttachmentTray
 *      is absent (items.length === 0 → returns null).
 *
 * ## Mock strategy
 * - useMediaComposer: mocked with a stateful implementation backed by React.useState
 *   so the component re-renders correctly when items change.  clearAll() is wrapped
 *   in a module-level jest.fn so we can assert it was called.  onPickResult() injects
 *   a fake MediaItem so the tray becomes visible.
 * - MediaAttachmentTray: minimal stub — renders a View with the forwarded testID when
 *   composer.items is non-empty, returns null otherwise.  Mirrors real tray behaviour
 *   without pulling in animation / reanimated bindings.
 * - MediaPickerButton: replaced by a minimal Pressable that calls
 *   composer.onPickResult directly, bypassing native sheet UI.
 * - KeyboardSafeScrollView / BlockedIdsContext / moderation: mocked as in the
 *   sibling block-CTA test.
 * - expo-image-picker / media.ts: not needed (useMediaComposer is fully mocked).
 *
 * ## Act strategy
 * Bare fireEvent + waitFor — avoids React 19 overlapping-act() warnings.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { ReportSheet } from '../ReportSheet.tsx';
import { submitModerationReport } from '../../services/moderation.ts';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';

// ── Module-level mock tracking refs ───────────────────────────────────────────
// Declared before jest.mock so the closure captures the correct binding.

const mockClearAll = jest.fn();

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real module imports native Supabase
// bindings and SessionContext that are unsafe under jest-expo.
jest.mock('../../context/BlockedIdsContext.tsx', () => ({
  useBlockedIds: jest.fn(),
}));

jest.mock('../../services/moderation.ts', () => ({
  ...jest.requireActual('../../services/moderation.ts'),
  submitModerationReport: jest.fn(),
}));

jest.mock('../../services/blocks.ts', () => ({
  ...jest.requireActual('../../services/blocks.ts'),
  blockUser:   jest.fn(),
  unblockUser: jest.fn(),
}));

// NOTE: intentionally exhaustive — KeyboardAvoidingView internals are not
// needed under jest; a transparent passthrough wrapper is sufficient.
jest.mock('../ui/KeyboardSafeView.tsx', () => ({
  KeyboardSafeScrollView: ({ children, style }: any) => {
    const { View } = require('react-native');
    return <View style={style}>{children}</View>;
  },
}));

// NOTE: intentionally exhaustive — useMediaComposer imports expo-image-picker and
// Supabase bindings that crash jest-expo.  The stub reimplements just enough state
// (items via React.useState) so the component re-renders correctly.  clearAll() is
// wrapped in the module-level mockClearAll jest.fn so tests can assert it was
// called.  onPickResult() injects a fake MediaItem so the tray becomes visible.
jest.mock('../../hooks/useMediaComposer.ts', () => {
  const React = require('react');
  return {
    useMediaComposer: jest.fn(() => {
      const [items, setItems] = React.useState<any[]>([]);
      const fakePolicy = {
        maxItems: 1,
        supportsCover: false,
        supportsAltText: false,
        allowsEditing: false,
        editAspect: undefined,
        videoMaxDuration: null,
        requireStoryVideoCrop: false,
      };
      return {
        policy:        fakePolicy,
        items,
        sheetVisible:  false,
        openSheet:     jest.fn(),
        closeSheet:    jest.fn(),
        onPickResult:  (asset: any) => setItems([{
          id:             'mock-item-1',
          uri:            asset.uri ?? 'file:///test/evidence.jpg',
          mimeType:       'image/jpeg',
          fileName:       asset.fileName ?? 'evidence.jpg',
          fileSize:       512000,
          width:          1200,
          height:         900,
          type:           'image',
          duration:       null,
          altText:        '',
          isCover:        true,
          uploadState:    'idle',
          uploadProgress: 0,
          uploadedUrl:    null,
          uploadError:    null,
        }]),
        removeItem:      jest.fn(),
        reorderItems:    jest.fn(),
        setCover:        jest.fn(),
        setAltText:      jest.fn(),
        uploadItem:      jest.fn(),
        uploadAll:       jest.fn(() => Promise.resolve(new Map())),
        retryUpload:     jest.fn(),
        cancelUpload:    jest.fn(),
        clearAll:        () => { mockClearAll(); setItems([]); },
        preSeedFromUrls: jest.fn(),
        canAddMore:      items.length < 1,
        primaryItem:     items[0] ?? null,
      };
    }),
  };
});

// NOTE: intentionally exhaustive — MediaAttachmentTray uses react-native-reanimated
// and animation bindings that are unreliable under jest-expo.  The stub mirrors the
// real component's key contract: renders a View with the forwarded testID when
// composer.items is non-empty, returns null when empty (same as the real tray).
jest.mock('../ui/MediaAttachmentTray.tsx', () => ({
  MediaAttachmentTray: ({ composer, testID }: any) => {
    const { View } = require('react-native');
    if (!composer.items || composer.items.length === 0) return null;
    return <View testID={testID ?? 'media-attachment-tray'} />;
  },
}));

// NOTE: intentionally exhaustive — MediaPickerButton opens a native source
// sheet (camera / library picker) that crashes jest.  The stub exposes a
// single Pressable that feeds a fake asset directly into composer.onPickResult
// so items state is exercised without native I/O.
jest.mock('../ui/MediaPickerButton.tsx', () => ({
  MediaPickerButton: ({ composer }: any) => {
    const { Pressable } = require('react-native');
    return (
      <Pressable
        testID="test-media-picker-button"
        onPress={() =>
          composer.onPickResult({
            uri:      'file:///test/evidence.jpg',
            type:     'image',
            mimeType: 'image/jpeg',
            fileName: 'evidence.jpg',
            fileSize: 512000,
            width:    1200,
            height:   900,
            duration: null,
            assetId:  null,
            base64:   null,
            exif:     null,
          })
        }
      />
    );
  },
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockUseBlockedIds = useBlockedIds          as jest.Mock;
const mockSubmitReport  = submitModerationReport as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeBlockedCtx() {
  return {
    blockedIds:  new Set<string>(),
    blockerIds:  new Set<string>(),
    isLoading:   false,
    addBlock:    jest.fn(),
    removeBlock: jest.fn(),
    refresh:     jest.fn() as () => Promise<void>,
  };
}

/** Resolves on the next macrotask so async continuations fire outside act(). */
const deferred = <T>(value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), 0));

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ReportSheet — safety evidence photo cleared on close', () => {
  beforeEach(() => {
    mockUseBlockedIds.mockReturnValue(makeBlockedCtx());
    mockSubmitReport.mockImplementation(() => deferred({ ok: true }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('tray appears after picking — then absent after close + reopen', async () => {
    const onClose = jest.fn();

    const utils = await render(
      <ReportSheet
        visible
        onClose={onClose}
        subjectType="user"
        subjectId="obj-1"
      />,
    );

    // ── First open: step 1 → select safety_concern → step 2 → pick photo ─

    await waitFor(() => utils.getByTestId('report-cat-safety_concern'));
    fireEvent.press(utils.getByTestId('report-cat-safety_concern'));

    // Wait for Next to enable, then advance to step 2
    await waitFor(() =>
      expect(utils.getByTestId('report-sheet-next').props.disabled).toBeFalsy(),
    );
    fireEvent.press(utils.getByTestId('report-sheet-next'));
    await utils.findByTestId('test-media-picker-button');

    // Pick a photo via the stubbed MediaPickerButton
    fireEvent.press(utils.getByTestId('test-media-picker-button'));

    // MediaAttachmentTray must appear (items.length > 0)
    await utils.findByTestId('safety-photo-tray');

    // ── Close — triggers reset() → safetyPhotoComposer.clearAll() ──────────

    fireEvent.press(utils.getByTestId('report-sheet-close-2'));

    // clearAll must have been invoked exactly once
    await waitFor(() => expect(mockClearAll).toHaveBeenCalledTimes(1));

    // ── Second open: toggle visible off/on then navigate to step 2 again ───

    await utils.rerender(
      <ReportSheet
        visible={false}
        onClose={onClose}
        subjectType="user"
        subjectId="obj-1"
      />,
    );

    await utils.rerender(
      <ReportSheet
        visible
        onClose={onClose}
        subjectType="user"
        subjectId="obj-1"
      />,
    );

    // Step 1 — wait for category list and select safety_concern
    await waitFor(() => utils.getByTestId('report-cat-safety_concern'));
    fireEvent.press(utils.getByTestId('report-cat-safety_concern'));

    await waitFor(() =>
      expect(utils.getByTestId('report-sheet-next').props.disabled).toBeFalsy(),
    );
    fireEvent.press(utils.getByTestId('report-sheet-next'));
    await utils.findByTestId('test-media-picker-button');

    // The tray must NOT appear — clearAll() wiped items on close (items.length === 0)
    expect(utils.queryByTestId('safety-photo-tray')).toBeNull();
  });
});
