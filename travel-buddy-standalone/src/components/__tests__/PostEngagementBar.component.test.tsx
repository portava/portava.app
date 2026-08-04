/**
 * Component-level tests for PostEngagementBar — lucide Proxy coverage.
 *
 * The primary goal is to confirm that the lucide-react-native Proxy mock
 * correctly handles icon names relevant to PostEngagementBar.  PostEngagementBar
 * now renders Smile, MessageCircle, and Bookmark (and uses StampButton, which has its own
 * internal icon rendering) — none of which appear in any other component test
 * assertion. Bookmark only renders when saveCount > 0 and is covered by its own test below.
 *
 * By intentionally NOT providing an inline jest.mock('lucide-react-native', …)
 * override, these tests rely on the file-level Proxy in
 * src/__mocks__/lucide-react-native.tsx.  If the Proxy's get trap were broken
 * for any icon name, getByTestId('icon-Smile') etc. would throw and make the
 * regression immediately visible.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { View } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { PostEngagementBar } from '../PostEngagementBar.tsx';

// ── Sub-component stubs ───────────────────────────────────────────────────────
// Return null so the test tree stays shallow and unrelated modals don't
// require their own deep mock chains.

// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../CommentsSheet', () => ({ CommentsSheet: () => null }));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../ShareSheet', () => ({ ShareSheet: () => null }));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../ReactionPicker', () => ({
  ReactionPicker: () => null,
  ReactionSummary: () => null,
}));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../EngagementUserListSheet', () => ({
  EngagementUserListSheet: () => null,
}));
// NOTE: PostSaversSheet calls useSafeAreaInsets(), which requires SafeAreaProvider.
// Stub the whole module so the test tree stays shallow and provider-free.
jest.mock('../PostSaversSheet', () => ({
  PostSaversSheet: () => null,
}));
// NOTE: intentionally an exhaustive stub — requiring the actual StampButton module
// would pull in useStamp, useStampAnimation, PortavaInkStamp, and the Reanimated
// worklet chain, all of which require native bridging unavailable under jest-expo.
jest.mock('../stamps/StampButton', () => ({
  StampButton: () => null,
}));
// ── Service mocks ─────────────────────────────────────────────────────────────

jest.mock('../../services/postEngagement', () => ({
  ...jest.requireActual('../../services/postEngagement'),
  getReactions:   jest.fn().mockResolvedValue({ reactions: [], myReaction: null }),
  reactToPost:    jest.fn().mockResolvedValue(null),
  removeReaction: jest.fn().mockResolvedValue(null),
  recordShare:    jest.fn().mockResolvedValue(null),
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
      stampCount={0}
      commentCount={0}
      isStampedByViewer={false}
      canStamp
      canComment
      canShare
      {...overrides}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PostEngagementBar — lucide Proxy mock coverage', () => {
  it('renders the lucide icons when all actions are enabled', async () => {
    // PostEngagementBar imports { Smile, MessageCircle } from
    // 'lucide-react-native'.  The share button uses TelegraphSendIcon (react-native-svg),
    // not a lucide icon.  This test confirms the Proxy's get trap resolves every
    // lucide named export to <View testID="icon-<Name>" /> — not just the first
    // one it sees.  A regression in the cache or get trap would cause one or
    // more of these to be missing.
    const { getByTestId } = await renderBar({
      canStamp: true,
      canComment: true,
      canShare: true,
    });
    await waitFor(() => {
      expect(getByTestId('icon-Smile')).toBeTruthy();
      expect(getByTestId('icon-MessageCircle')).toBeTruthy();
    });
  });

  it('does not render MessageCircle when canComment is false', async () => {
    // Confirms the testID assertion is sensitive to render conditions — the icon
    // genuinely being absent produces a null result, not a false positive.
    const { queryByTestId } = await renderBar({ canComment: false });
    await waitFor(() => expect(queryByTestId('icon-MessageCircle')).toBeNull());
  });

  it('renders icon-Bookmark when saveCount is positive', async () => {
    // Bookmark is a third lucide icon in PostEngagementBar, rendered conditionally
    // when saveCount > 0. A separate test is needed because the default renderBar
    // fixture uses saveCount=0 (no Bookmark). Confirms the Proxy's get-trap cache
    // resolves a third distinct icon name without a stale-entry or collision bug.
    const { getByTestId } = await renderBar({ saveCount: 1 });
    await waitFor(() => expect(getByTestId('icon-Bookmark')).toBeTruthy());
  });

  it('does not render icon-Bookmark when saveCount is zero', async () => {
    // Confirms the Bookmark assertion above is sensitive to render conditions.
    const { queryByTestId } = await renderBar({ saveCount: 0 });
    await waitFor(() => expect(queryByTestId('icon-Bookmark')).toBeNull());
  });
});

describe('PostEngagementBar — icon-spacing spec (counter formatting + row composition)', () => {
  it('renders a large comment count compactly, with the exact count preserved in the accessibility label', async () => {
    // 12345 must render abbreviated per the shared counter-abbreviation
    // helper, while the accessibility label carries the full, unabbreviated
    // figure.
    const { getByText, getByLabelText } = await renderBar({ commentCount: 12345 });
    await waitFor(() => {
      expect(getByText('12K')).toBeTruthy();
      expect(getByLabelText('Comment, 12,345')).toBeTruthy();
    });
  });

  it('renders a billion-scale save count compactly', async () => {
    const { getByText } = await renderBar({ saveCount: 1_234_000_000, isOwner: true });
    await waitFor(() => expect(getByText('1.2B')).toBeTruthy());
  });

  it('composes a caller-supplied right-cluster slot (e.g. Save/More) alongside the left actions', async () => {
    const { getByTestId } = await renderBar({
      right: [
        {
          key: 'more',
          node: <View key="more" testID="right-cluster-slot" />,
        },
      ],
    });
    // Confirms PostEngagementBar's `right` prop reaches PostActionRow's
    // right cluster from a real call site, not just the isolated
    // PostActionRow unit tests.
    await waitFor(() => {
      expect(getByTestId('right-cluster-slot')).toBeTruthy();
      expect(getByTestId('icon-Smile')).toBeTruthy();
    });
  });

  it('still renders a caller-supplied right cluster even when every left action is disabled', async () => {
    // Regression guard: PostEngagementBar's early `return null` guard must
    // only fire when there is truly nothing to show. A caller-supplied
    // `right` cluster (e.g. Save/More) has to keep rendering even when
    // canStamp/canComment/canShare are all false.
    const { getByTestId } = await renderBar({
      canStamp: false,
      canComment: false,
      canShare: false,
      right: [
        {
          key: 'more',
          node: <View key="more" testID="right-cluster-slot" />,
        },
      ],
    });
    await waitFor(() => expect(getByTestId('right-cluster-slot')).toBeTruthy());
  });
});
