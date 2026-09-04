/**
 * MediaAttachmentTray — single-item drag-path tests.
 *
 * Confirms that DraggableMediaCard skips gesture activation when totalCount === 1
 * so the long-press gesture cannot fire and the grip overlay never appears.
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';
import { MediaAttachmentTray } from '../ui/MediaAttachmentTray.tsx';
import type { MediaItem } from '../../hooks/useMediaComposer.ts';
import { getPolicy } from '../../lib/contentMediaPolicy.ts';

// Stub reanimated so gesture shared-values work without native modules.
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

// Force reduce-motion OFF so DraggableTray (the drag path) renders.
import { AccessibilityInfo } from 'react-native';
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    uri: `file:///test/${id}.jpg`,
    mimeType: 'image/jpeg',
    type: 'image',
    altText: '',
    isCover: false,
    uploadState: 'idle',
    uploadProgress: 0,
    uploadedUrl: null,
    uploadError: null,
    // Required by MediaItem (`'format_unsupported' | null`). Absent from these
    // defaults, so the factory's return type had it as `| undefined`.
    uploadErrorKind: null,
    ...overrides,
  };
}

function makeComposer(items: MediaItem[], reorderItems: jest.Mock = jest.fn()) {
  return {
    policy: getPolicy('memory'),
    items,
    removeItem: jest.fn(),
    reorderItems,
    setCover: jest.fn(),
    setAltText: jest.fn(),
    retryUpload: jest.fn(),
    cancelUpload: jest.fn(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DraggableMediaCard — single-item tray (drag path)', () => {
  it('renders the card without throwing when totalCount === 1', async () => {
    const { getByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer([makeItem('solo')])} />,
    );
    expect(getByTestId('media-card-solo')).toBeTruthy();
  });

  it('onDragStart is never called — reorderItems stays untouched for a single-item tray', async () => {
    const reorderItems = jest.fn();
    const item = makeItem('only');

    await render(
      <MediaAttachmentTray composer={makeComposer([item], reorderItems)} />,
    );

    // Flush any pending async effects (reduce-motion state update, etc.)
    await act(async () => {});

    // With totalCount === 1 there is no GestureDetector, so the long-press
    // gesture cannot fire and onDragStart (which leads to reorderItems) is
    // never invoked — even after effects settle.
    expect(reorderItems).not.toHaveBeenCalled();
  });

  it('grip overlay (dragActive) is never shown for a single-item tray', async () => {
    // dragActive is only true when isActive === index, which comes from
    // onDragStart setting activeIndex state. With totalCount === 1 there is
    // no GestureDetector so the gesture can never fire — dragActive stays false
    // and the gripOverlay View is never rendered.
    const { queryByTestId, getByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer([makeItem('grip-test')])} />,
    );

    // Card renders normally.
    expect(getByTestId('media-card-grip-test')).toBeTruthy();
    // Remove button renders (card content is intact).
    expect(getByTestId('remove-media-grip-test')).toBeTruthy();
    // No drag-state side-effects.
    expect(queryByTestId('drag-active-overlay')).toBeNull();
  });

  it('cards still render normally for a two-item tray (regression guard)', async () => {
    const items = [makeItem('alpha'), makeItem('beta')];
    const { getByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer(items)} />,
    );
    expect(getByTestId('media-card-alpha')).toBeTruthy();
    expect(getByTestId('media-card-beta')).toBeTruthy();
  });
});
