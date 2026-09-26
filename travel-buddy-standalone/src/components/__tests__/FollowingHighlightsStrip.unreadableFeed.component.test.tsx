/**
 * A highlights feed that could not be READ is not a feed that is EMPTY.
 *
 * Highlights/Memories Development Architecture Spec v1 §28.11 ("never swallow
 * projection/schema failures into plausible-looking empty history without
 * structured error state").
 *
 * THE DEFECT THIS GUARDS. `GET /api/highlights/following-feed` refuses with
 * 503 `degraded_unavailable` when the follow graph could not be read. Its
 * handler says why, in capitals: *"NOBODY YOU FOLLOW HAS AN ACTIVE HIGHLIGHT
 * IS A CLAIM ABOUT OTHER PEOPLE, AND IT MUST BE TRUE."* A sibling lane had
 * already had to fix exactly this shape in the Wall ("you're all caught up"
 * over an unreadable follow graph) and in the Passport ("zero stamps" for an
 * unreadable table).
 *
 * The client then undid it in two steps:
 *   1. `useFollowingHighlights` wrote `setUsers(r.ok && r.data ? r.data : [])`,
 *      so the refusal became the empty list;
 *   2. `FollowingHighlightsStrip` returns `null` for an empty list, so the
 *      tray vanished from the Explore tab and read as "nobody you follow has
 *      posted a Highlight" — the exact claim the server declined to make.
 *
 * Both halves are asserted below.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

const mockFetchFollowingHighlightsFeed = jest.fn();

jest.mock('../../services/highlights.ts', () => ({
  ...jest.requireActual('../../services/highlights.ts'),
  fetchFollowingHighlightsFeed: (...args: unknown[]) =>
    mockFetchFollowingHighlightsFeed(...args),
}));

jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  ...jest.requireActual('../../hooks/useHighlightRingState.ts'),
  viewedHighlightIds: new Set<string>(),
  markViewed: jest.fn(),
}));

// NOTE: intentionally exhaustive — SessionContext reaches supabase auth on
// import, and this suite only needs the viewer id the strip reads.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1' }),
}));

import { FollowingHighlightsStrip } from '../FollowingHighlightsStrip.tsx';
import { useFollowingHighlights } from '../../hooks/useFollowingHighlights.ts';

/** Every text string rendered anywhere in the tree, flattened. */
function allText(tree: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const children = (node as { children?: unknown[] }).children;
    if (Array.isArray(children)) children.forEach(walk);
  };
  walk(tree.toJSON() as unknown);
  return out.join(' ');
}

describe('the Explore highlights tray and a refused feed', () => {
  beforeEach(() => mockFetchFollowingHighlightsFeed.mockReset());

  it('useFollowingHighlights reports the refusal instead of an empty follow list', async () => {
    mockFetchFollowingHighlightsFeed.mockResolvedValue({
      ok: false, data: null, errorKind: 'degraded_unavailable',
    });

    let state: ReturnType<typeof useFollowingHighlights> | null = null;
    function Probe() {
      state = useFollowingHighlights();
      return <Text>{String(state.users.length)}</Text>;
    }

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => { tree = TestRenderer.create(<Probe />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(state).not.toBeNull();
    // The refusal survives as itself — not as "you follow nobody with a Highlight".
    expect(state!.unreadable).toBe('degraded_unavailable');

    act(() => { tree?.unmount(); });
  });

  it('useFollowingHighlights reports no refusal on a genuinely empty feed', async () => {
    mockFetchFollowingHighlightsFeed.mockResolvedValue({ ok: true, data: [] });

    let state: ReturnType<typeof useFollowingHighlights> | null = null;
    function Probe() {
      state = useFollowingHighlights();
      return <Text>{String(state.users.length)}</Text>;
    }

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => { tree = TestRenderer.create(<Probe />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(state!.unreadable).toBeNull();
    expect(state!.users).toEqual([]);

    act(() => { tree?.unmount(); });
  });

  it('the strip states the refusal rather than disappearing', () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        <FollowingHighlightsStrip
          users={[]}
          sessionViewedIds={new Set()}
          onMarkViewed={() => {}}
          unreadable="degraded_unavailable"
        />,
      );
    });

    // Before the fix this rendered null: an unreadable feed and a friendless
    // account were the same picture.
    expect(tree!.toJSON()).not.toBeNull();
    expect(allText(tree!)).toMatch(/could not load/i);

    act(() => { tree?.unmount(); });
  });

  it('the strip still renders nothing when the feed is genuinely empty', () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        <FollowingHighlightsStrip
          users={[]}
          sessionViewedIds={new Set()}
          onMarkViewed={() => {}}
          unreadable={null}
        />,
      );
    });

    expect(tree!.toJSON()).toBeNull();

    act(() => { tree?.unmount(); });
  });
});
