/**
 * MediaAttachmentTray — add/remove/cover/alt-text/reorder interaction tests.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { MediaAttachmentTray } from '../ui/MediaAttachmentTray.tsx';
import type { MediaItem } from '../../hooks/useMediaComposer.ts';
import { getPolicy } from '../../lib/contentMediaPolicy.ts';

// NOTE: exhaustive mock intentional — expo-av uses native video modules unavailable
// in the Jest environment; MediaAttachmentTray renders Video only for video-type items,
// and none of the test cases below use video items.
jest.mock('expo-av', () => ({
  Video: () => null,
  ResizeMode: { COVER: 'cover' },
}));

// Stub reanimated so gesture shared-values work without native modules.
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

// Force reduce-motion ON so the tray renders tap-based reorder buttons (the
// drag path requires gesture-handler native events that RNTL cannot fire).
import { AccessibilityInfo } from 'react-native';
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);

// ── Helpers ─────────────────────────────────────────────────────────────────

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
    ...overrides,
  };
}

function makeComposer(
  items: MediaItem[],
  callbacks: {
    removeItem?: jest.Mock;
    reorderItems?: jest.Mock;
    setCover?: jest.Mock;
    setAltText?: jest.Mock;
    retryUpload?: jest.Mock;
    cancelUpload?: jest.Mock;
  } = {},
) {
  return {
    policy: getPolicy('memory'),
    items,
    removeItem: callbacks.removeItem ?? jest.fn(),
    reorderItems: callbacks.reorderItems ?? jest.fn(),
    setCover: callbacks.setCover ?? jest.fn(),
    setAltText: callbacks.setAltText ?? jest.fn(),
    retryUpload: callbacks.retryUpload ?? jest.fn(),
    cancelUpload: callbacks.cancelUpload ?? jest.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MediaAttachmentTray — rendering', () => {
  it('renders nothing when items is empty', async () => {
    const { toJSON } = await render(
      <MediaAttachmentTray composer={makeComposer([])} />,
    );
    expect(toJSON()).toBeNull();
  });

  it('renders a card for each item', async () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    const { getAllByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer(items)} />,
    );
    expect(getAllByTestId(/^media-card-/).length).toBe(3);
  });
});

describe('MediaAttachmentTray — remove', () => {
  it('calls removeItem with the correct id', async () => {
    const removeItem = jest.fn();
    const item = makeItem('abc');
    const { getByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer([item], { removeItem })} />,
    );
    fireEvent.press(getByTestId('remove-media-abc'));
    expect(removeItem).toHaveBeenCalledWith('abc');
    expect(removeItem).toHaveBeenCalledTimes(1);
  });
});

describe('MediaAttachmentTray — cover star', () => {
  it('calls setCover with the correct id when star is pressed', async () => {
    const setCover = jest.fn();
    const item = makeItem('xyz', { isCover: false });
    const { getByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer([item], { setCover })} />,
    );
    fireEvent.press(getByTestId('cover-media-xyz'));
    expect(setCover).toHaveBeenCalledWith('xyz');
  });

  it('already-cover item still calls setCover on re-press', async () => {
    const setCover = jest.fn();
    const item = makeItem('star1', { isCover: true });
    const { getByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer([item], { setCover })} />,
    );
    fireEvent.press(getByTestId('cover-media-star1'));
    expect(setCover).toHaveBeenCalledWith('star1');
  });
});

describe('MediaAttachmentTray — alt-text', () => {
  it('calls setAltText with the id and new text', async () => {
    const setAltText = jest.fn();
    const item = makeItem('q', { altText: '' });
    const { getByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer([item], { setAltText })} />,
    );
    fireEvent.changeText(getByTestId('alt-text-q'), 'A sunny beach');
    expect(setAltText).toHaveBeenCalledWith('q', 'A sunny beach');
  });

  it('does NOT render alt-text field for a policy without supportsAltText', async () => {
    const item = makeItem('noalt');
    const composer = {
      policy: getPolicy('highlight'), // supportsAltText=false
      items: [item],
      removeItem: jest.fn(),
      reorderItems: jest.fn(),
      setCover: jest.fn(),
      setAltText: jest.fn(),
      retryUpload: jest.fn(),
      cancelUpload: jest.fn(),
    };
    const { queryByTestId } = await render(
      <MediaAttachmentTray composer={composer} />,
    );
    expect(queryByTestId('alt-text-noalt')).toBeNull();
  });
});

describe('MediaAttachmentTray — reorder', () => {
  it('pressing "Move later" calls reorderItems(0, 1) on the first item', async () => {
    const reorderItems = jest.fn();
    const items = [makeItem('first'), makeItem('second')];
    const { getAllByLabelText } = await render(
      <MediaAttachmentTray composer={makeComposer(items, { reorderItems })} />,
    );
    const moveLaterBtns = getAllByLabelText('Move later');
    fireEvent.press(moveLaterBtns[0]);
    expect(reorderItems).toHaveBeenCalledWith(0, 1);
  });
});

describe('MediaAttachmentTray — error state', () => {
  it('renders the uploadError message text when an item is in error state', async () => {
    const HEIC_MSG = "This photo format isn't supported — please re-upload as JPEG or PNG";
    const item = makeItem('err1', {
      uploadState: 'error',
      uploadError: HEIC_MSG,
    });
    const { getByText } = await render(
      <MediaAttachmentTray composer={makeComposer([item])} />,
    );
    // The error message must be visible on-screen, not silently stuck in state
    expect(getByText(HEIC_MSG)).toBeTruthy();
  });

  it('does not render an error message when uploadError is null', async () => {
    const item = makeItem('ok1', { uploadState: 'idle', uploadError: null });
    const { queryByText } = await render(
      <MediaAttachmentTray composer={makeComposer([item])} />,
    );
    expect(queryByText(/re-upload|not supported/i)).toBeNull();
  });

  it('pressing the Retry button calls retryUpload with the correct item id', async () => {
    const retryUpload = jest.fn();
    const item = makeItem('retry1', {
      uploadState: 'error',
      uploadError: 'Network error',
    });
    const { getByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer([item], { retryUpload })} />,
    );
    fireEvent.press(getByTestId('retry-media-retry1'));
    expect(retryUpload).toHaveBeenCalledWith('retry1');
    expect(retryUpload).toHaveBeenCalledTimes(1);
  });

  it('does NOT render a Retry button when uploadState is uploading', async () => {
    const item = makeItem('uploading1', {
      uploadState: 'uploading',
      uploadProgress: 0.5,
    });
    const { queryByTestId } = await render(
      <MediaAttachmentTray composer={makeComposer([item])} />,
    );
    expect(queryByTestId('retry-media-uploading1')).toBeNull();
  });
});
