/**
 * Post detail — the owner can delete their post here.
 *
 * The owner's menu had Edit but no Delete, while the edit screen tells them to
 * "delete this post and create a new one" to change its media. Delete now sits
 * in the owner's overflow menu: it asks first, says so when the delete fails
 * (and stays put), and goes back once the server has deleted the post.
 *
 * TWO PRESSES in this file (renderer press budget, see
 * .agents/memory/rntl-react19-renderer-budget.md): open the menu, tap Delete.
 * The confirm dialog's buttons are driven through the Alert spy.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mock expo-router so useLocalSearchParams returns a predictable id.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'post-abc' }),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
}));

// Mock SessionContext — the screen only needs userId.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-1', isAuthed: true }),
}));

// Mock the posts service — tests control the resolved PostRow.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/posts', () => ({
  getPostById: jest.fn(),
}));

// Mock nav-bar collapse — NavBarFiller and the scroll handler aren't relevant
// to media-rendering behaviour.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => undefined,
}));

// Mock CommentsSection — not under test.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CommentsSheet', () => ({
  CommentsSection: () => null,
}));

// Mock ReportPostSheet — not under test.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReportPostSheet', () => ({
  ReportPostSheet: () => null,
}));

// Mock ScreenHeader — not under test.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ScreenHeader', () => ({
  ScreenHeader: () => null,
}));

// Mock KeyboardSafeScrollView — not under test.
jest.mock('../../../src/components/ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => (
      <View>{children}</View>
    ),
  };
});

// Mock commentCountStore — no side-effects needed.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/commentCountStore', () => ({
  emitCommentCount: jest.fn(),
}));

// Mock expo-av so Video doesn't try to load native modules.
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef(({ testID, ...rest }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      playAsync: jest.fn(),
      pauseAsync: jest.fn(),
      setStatusAsync: jest.fn(),
    }));
    return <View testID={testID ?? 'mock-video'} {...rest} />;
  });
  Video.displayName = 'Video';
  return {
    Video,
    ResizeMode: { COVER: 'cover', CONTAIN: 'contain' },
  };
});

// Mock SharedVideoPlayer with a stable testID so we can assert its presence /
// absence without relying on expo-av internals.
jest.mock('../../../src/components/ui/SharedVideoPlayer', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SharedVideoPlayer: (props: any) => (
      <View testID="shared-video-player" accessibilityLabel="Play video" />
    ),
  };
});

// Mock MediaStampOverlay with a stable testID for absence assertions.
jest.mock('../../../src/components/StampOverlayBadge', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    MediaStampOverlay: () => <View testID="stamp-overlay" />,
  };
});

// NOTE: intentional stub — the delete call is the seam under test.
jest.mock('../../../src/services/postEngagement', () => ({
  deletePost: jest.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { router } from 'expo-router';
import { getPostById } from '../../../src/services/posts';
import { deletePost } from '../../../src/services/postEngagement';
import PostDetail from '../[id]';

const mockGetPostById = getPostById as jest.Mock;
const mockDeletePost = deletePost as jest.Mock;

const OWN_POST = {
  id: 'post-abc', authorId: 'user-1', tripId: null, content: 'A great trip!',
  mediaUrls: [], media: [], visibility: 'public', status: 'published',
  createdAt: '2025-01-01T12:00:00.000Z', updatedAt: '2025-01-01T12:00:00.000Z',
  locationName: null, locationCity: null, locationCountry: null,
  author: { id: 'user-1', name: 'Alice', handle: 'alice', avatarUrl: null },
  likeCount: 0, commentCount: 0, shareCount: 0, likedByMe: false, savedByMe: false, saveCount: 0,
  canLike: true, canComment: true, canShare: true, filterId: 'none', filterIntensity: 0,
  tags: [], hashtagUsages: [],
};

jest.setTimeout(20000);

it('owner: Delete asks first, reports a failed delete, and goes back after a delete', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockGetPostById.mockResolvedValue({ ok: true, data: OWN_POST });

  await render(<PostDetail />);
  await waitFor(() => expect(screen.getByLabelText('More options')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('More options'));
  await fireEvent.press(await screen.findByTestId('overflow-delete-post'));

  // The confirm waits out the sheet's dismissal.
  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Delete post?', 'This cannot be undone.', expect.any(Array)), { timeout: 2000 });
  expect(mockDeletePost).not.toHaveBeenCalled();
  const buttons = alertSpy.mock.calls[0]![2] as Array<{ text: string; onPress?: () => Promise<void> }>;
  const confirm = buttons.find((b) => b.text === 'Delete')!;

  mockDeletePost.mockResolvedValueOnce(false);
  await act(async () => { await confirm.onPress!(); });
  expect(mockDeletePost).toHaveBeenCalledWith('post-abc');
  expect(alertSpy).toHaveBeenLastCalledWith('Error', 'Could not delete post. Please try again.');
  expect(router.back).not.toHaveBeenCalled();

  mockDeletePost.mockResolvedValueOnce(true);
  await act(async () => { await confirm.onPress!(); });
  expect(router.back).toHaveBeenCalledTimes(1);
  alertSpy.mockRestore();
});
