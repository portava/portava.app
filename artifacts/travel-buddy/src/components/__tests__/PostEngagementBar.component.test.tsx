/**
 * Component-level tests for PostEngagementBar — lucide Proxy coverage.
 *
 * The primary goal is to confirm that the lucide-react-native Proxy mock
 * correctly handles icon names relevant to PostEngagementBar.  PostEngagementBar
 * now renders Smile, MessageCircle (and uses StampButton, which has its own
 * internal icon rendering) — none of which appear in any other component test
 * assertion.
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
});
