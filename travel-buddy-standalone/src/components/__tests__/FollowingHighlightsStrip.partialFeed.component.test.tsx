/**
 * A tray read only in part says so.
 *
 * `useFollowingHighlights` follows the server's §12 cursor page by page. When a
 * LATER page cannot be read, the hook keeps the users it already has and
 * reports the refusal. The strip rendered those users and nothing else — the
 * same picture as a complete tray — and showed the refusal only when there was
 * nobody to show. It now ends the tray with a notice (and a retry, where a
 * retry can work) whenever the read was refused, whatever it already holds.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

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
import type { HighlightFeedUser } from '../../services/highlights.ts';

const user: HighlightFeedUser = {
  userId: 'owner-1', handle: 'owner', name: 'Owner', avatarUrl: null,
  highlights: [{
    id: 'h1', ownerId: 'owner-1', mediaUrl: 'https://example.com/h1.jpg', mediaType: 'image/jpeg',
    videoDurationSeconds: null, caption: null, locationName: null, locationCity: null,
    locationCountry: null, visibility: 'public', expiresAt: null, createdAt: '2026-10-03T00:00:00Z',
    deletedAt: null, author: null,
  } as unknown as HighlightFeedUser['highlights'][number]],
};

function allText(tree: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const children = (node as { children?: unknown[] }).children;
    if (Array.isArray(children)) children.forEach(walk);
  };
  walk(tree.toJSON() as unknown);
  return out.join(' ');
}

function render(unreadable: 'degraded_unavailable' | 'feature_disabled' | null, onRetry?: () => void) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <FollowingHighlightsStrip
        users={[user]}
        sessionViewedIds={new Set()}
        onMarkViewed={() => {}}
        unreadable={unreadable}
        onRetry={onRetry}
      />,
    );
  });
  return tree!;
}

describe('the Explore highlights tray, read in part', () => {
  it('keeps the users it has and states that the rest could not be loaded', () => {
    const onRetry = jest.fn();
    const tree = render('degraded_unavailable', onRetry);

    expect(tree.root.findAllByProps({ accessibilityLabel: "View owner's highlights" }).length).toBeGreaterThan(0);
    expect(allText(tree)).toMatch(/could not load all/i);

    const retry = tree.root.findAll((n) => n.props.accessibilityLabel === 'Retry loading highlights' && typeof n.props.onPress === 'function');
    expect(retry.length).toBeGreaterThan(0);
    act(() => { retry[0].props.onPress(); });
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => { tree.unmount(); });
  });

  it('offers no retry that cannot work', () => {
    const tree = render('feature_disabled', jest.fn());
    expect(allText(tree)).toMatch(/could not load all/i);
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Retry loading highlights').length).toBe(0);
    act(() => { tree.unmount(); });
  });

  it('shows no notice when the read completed', () => {
    const tree = render(null, jest.fn());
    expect(allText(tree)).not.toMatch(/could not load/i);
    act(() => { tree.unmount(); });
  });
});
