/**
 * Component-level tests for PostEngagementBar — lucide Proxy coverage.
 *
 * The primary goal is to confirm that the lucide-react-native Proxy mock
 * correctly handles icon names beyond the X close-button that ReportPostSheet
 * already exercises.  PostEngagementBar renders Heart, Smile, MessageCircle,
 * and Share2 — none of which appear in any other component test assertion.
 *
 * By intentionally NOT providing an inline jest.mock('lucide-react-native', …)
 * override, these tests rely on the file-level Proxy in
 * src/__mocks__/lucide-react-native.tsx.  If the Proxy's get trap were broken
 * for any icon name, getByTestId('icon-Heart') etc. would throw and make the
 * regression immediately visible.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { PostEngagementBar } from '../PostEngagementBar.tsx';

// ── Sub-component stubs ───────────────────────────────────────────────────────
// Return null so the test tree stays shallow and unrelated modals don't
// require their own deep mock chains.

jest.mock('../CommentsSheet', () => ({ CommentsSheet: () => null }));
jest.mock('../ShareSheet', () => ({ ShareSheet: () => null }));
jest.mock('../ReactionPicker', () => ({
  ReactionPicker: () => null,
  ReactionSummary: () => null,
}));
jest.mock('../EngagementUserListSheet', () => ({
  EngagementUserListSheet: () => null,
}));

// ── Service mocks ─────────────────────────────────────────────────────────────

jest.mock('../../services/postEngagement', () => ({
  ...jest.requireActual('../../services/postEngagement'),
  likePost:       jest.fn().mockResolvedValue(null),
  unlikePost:     jest.fn().mockResolvedValue(null),
  getReactions:   jest.fn().mockResolvedValue({ reactions: [], myReaction: null }),
  reactToPost:    jest.fn().mockResolvedValue(null),
  removeReaction: jest.fn().mockResolvedValue(null),
  recordShare:    jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/likedPostsCache', () => ({
  ...jest.requireActual('../../services/likedPostsCache'),
  getLiked: jest.fn().mockReturnValue(undefined),
  setLiked: jest.fn(),
}));

jest.mock('../../context/SessionContext', () => ({
  ...jest.requireActual('../../context/SessionContext'),
  useSession: () => ({ userId: 'user-test-1', isAuthed: true }),
}));

// ── Helper ────────────────────────────────────────────────────────────────────

async function renderBar(
  overrides: Partial<React.ComponentProps<typeof PostEngagementBar>> = {},
) {
  return render(
    <PostEngagementBar
      postId="post-icon-test"
      likeCount={0}
      commentCount={0}
      likedByMe={false}
      canLike
      canComment
      canShare
      {...overrides}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PostEngagementBar — lucide Proxy mock coverage', () => {
  it('renders all four lucide icons when all actions are enabled', async () => {
    // PostEngagementBar imports { Heart, Smile, MessageCircle, Share2 } from
    // 'lucide-react-native'.  This test confirms the Proxy's get trap resolves
    // every named export to <View testID="icon-<Name>" /> — not just the first
    // one it sees.  A regression in the cache or get trap would cause one or
    // more of these to be missing.
    const { getByTestId } = await renderBar({
      canLike: true,
      canComment: true,
      canShare: true,
    });
    await waitFor(() => {
      expect(getByTestId('icon-Heart')).toBeTruthy();
      expect(getByTestId('icon-Smile')).toBeTruthy();
      expect(getByTestId('icon-MessageCircle')).toBeTruthy();
      expect(getByTestId('icon-Share2')).toBeTruthy();
    });
  });

  it('does not render Heart when canLike is false', async () => {
    // Confirms the testID assertion is sensitive to render conditions — the icon
    // genuinely being absent produces a null result, not a false positive.
    const { queryByTestId } = await renderBar({ canLike: false });
    await waitFor(() => expect(queryByTestId('icon-Heart')).toBeNull());
  });

  it('does not render Share2 when canShare is false', async () => {
    // Parity check: Share2 is also conditionally rendered behind canShare.
    const { queryByTestId } = await renderBar({ canShare: false });
    await waitFor(() => expect(queryByTestId('icon-Share2')).toBeNull());
  });
});
