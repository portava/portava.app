/**
 * The Explore highlights tray reads the WHOLE following feed, page by page.
 *
 * With `highlights_feed_bounded_enabled` on, the server answers one finite page
 * (§12) plus `nextCursor`. `useFollowingHighlights` read only the first page and
 * dropped the cursor, so every followed user whose highlights fell after it was
 * missing from the tray, and a user split across pages showed only part of
 * their highlights — a partial read presented as the complete tray. Each
 * request stays bounded; the hook now follows the cursor to its end, merges
 * the pages, and says so when a later page could not be read.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

const mockFetchFollowingHighlightsFeed = jest.fn();

jest.mock('../../services/highlights.ts', () => ({
  ...jest.requireActual('../../services/highlights.ts'),
  fetchFollowingHighlightsFeed: (...args: unknown[]) => mockFetchFollowingHighlightsFeed(...args),
}));

jest.mock('../useHighlightRingState.ts', () => ({
  ...jest.requireActual('../useHighlightRingState.ts'),
  viewedHighlightIds: new Set<string>(),
  markViewed: jest.fn(),
}));

import { useFollowingHighlights, mergeFollowingFeedPages } from '../useFollowingHighlights.ts';
import type { HighlightFeedUser } from '../../services/highlights.ts';

function h(id: string, ownerId: string) {
  return {
    id, ownerId, mediaUrl: `https://example.com/${id}.jpg`, mediaType: 'image/jpeg',
    videoDurationSeconds: null, caption: null, locationName: null, locationCity: null,
    locationCountry: null, visibility: 'public', expiresAt: null, createdAt: '2026-10-03T00:00:00Z',
    deletedAt: null, author: null,
  } as unknown as HighlightFeedUser['highlights'][number];
}
function u(userId: string, ids: string[]): HighlightFeedUser {
  return { userId, handle: userId, name: null, avatarUrl: null, highlights: ids.map((id) => h(id, userId)) };
}
const page = (users: HighlightFeedUser[], nextCursor: string | null) => ({ ok: true, data: users, nextCursor });
const shape = (users: HighlightFeedUser[]) => users.map((x) => `${x.userId}:${x.highlights.map((y) => y.id).join(',')}`);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function flush(times = 12) {
  await act(async () => { for (let i = 0; i < times; i++) await Promise.resolve(); });
}

function mount() {
  const ref: { current: ReturnType<typeof useFollowingHighlights> | null } = { current: null };
  function Probe() {
    ref.current = useFollowingHighlights();
    return <Text>{String(ref.current.users.length)}</Text>;
  }
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => { tree = TestRenderer.create(<Probe />); });
  return { ref, unmount: () => act(() => { tree?.unmount(); }) };
}

describe('useFollowingHighlights — the cursor walk', () => {
  beforeEach(() => mockFetchFollowingHighlightsFeed.mockReset());

  it('follows nextCursor to the end and merges a user split across pages', async () => {
    mockFetchFollowingHighlightsFeed
      .mockResolvedValueOnce(page([u('a', ['h1', 'h2'])], 'c1'))
      .mockResolvedValueOnce(page([u('a', ['h3']), u('b', ['h4'])], 'c2'))
      .mockResolvedValueOnce(page([u('c', ['h5'])], null));

    const { ref, unmount } = mount();
    await flush();

    expect(mockFetchFollowingHighlightsFeed.mock.calls.map((c) => c[0] ?? null)).toEqual([null, 'c1', 'c2']);
    expect(shape(ref.current!.users)).toEqual(['a:h1,h2,h3', 'b:h4', 'c:h5']);
    expect(ref.current!.unreadable).toBeNull();
    expect(ref.current!.loading).toBe(false);
    unmount();
  });

  it('reads one page and stops when the server sends no cursor (cap off)', async () => {
    mockFetchFollowingHighlightsFeed.mockResolvedValueOnce({ ok: true, data: [u('a', ['h1'])] });

    const { ref, unmount } = mount();
    await flush();

    expect(mockFetchFollowingHighlightsFeed).toHaveBeenCalledTimes(1);
    expect(shape(ref.current!.users)).toEqual(['a:h1']);
    expect(ref.current!.unreadable).toBeNull();
    unmount();
  });

  it('keeps what it read and reports the refusal when a LATER page fails', async () => {
    mockFetchFollowingHighlightsFeed
      .mockResolvedValueOnce(page([u('a', ['h1'])], 'c1'))
      .mockResolvedValueOnce({ ok: false, data: null, errorKind: 'degraded_unavailable', nextCursor: null });

    const { ref, unmount } = mount();
    await flush();

    expect(shape(ref.current!.users)).toEqual(['a:h1']);
    // Not complete, and not allowed to look complete.
    expect(ref.current!.unreadable).toBe('degraded_unavailable');
    unmount();
  });

  it('stops on a cursor that does not advance, and says the read is incomplete', async () => {
    mockFetchFollowingHighlightsFeed
      .mockResolvedValueOnce(page([u('a', ['h1'])], 'c1'))
      .mockResolvedValue(page([u('a', ['h1'])], 'c1'));

    const { ref, unmount } = mount();
    await flush(30);

    expect(mockFetchFollowingHighlightsFeed).toHaveBeenCalledTimes(2);
    expect(shape(ref.current!.users)).toEqual(['a:h1']);
    expect(ref.current!.unreadable).toBe('db_error');
    unmount();
  });

  it('drops a page that arrives after a refresh started a new walk', async () => {
    const stalePage2 = deferred<ReturnType<typeof page>>();
    mockFetchFollowingHighlightsFeed
      .mockResolvedValueOnce(page([u('a', ['h1'])], 'c1'))
      .mockReturnValueOnce(stalePage2.promise)
      .mockResolvedValueOnce(page([u('z', ['h9'])], null));

    const { ref, unmount } = mount();
    await flush();
    expect(mockFetchFollowingHighlightsFeed).toHaveBeenCalledTimes(2);

    act(() => { ref.current!.refresh(); });
    await flush();
    expect(shape(ref.current!.users)).toEqual(['z:h9']);

    stalePage2.resolve(page([u('a', ['h2']), u('b', ['h3'])], null));
    await flush();

    expect(shape(ref.current!.users)).toEqual(['z:h9']);
    expect(ref.current!.unreadable).toBeNull();
    unmount();
  });
});

describe('mergeFollowingFeedPages', () => {
  it('appends new users in page order and new highlights to known users, once each', () => {
    const merged = mergeFollowingFeedPages([u('a', ['h1'])], [u('a', ['h1', 'h2']), u('b', ['h3'])]);
    expect(shape(merged)).toEqual(['a:h1,h2', 'b:h3']);
  });

  it('does not mutate its inputs', () => {
    const first = [u('a', ['h1'])];
    mergeFollowingFeedPages(first, [u('a', ['h2'])]);
    expect(shape(first)).toEqual(['a:h1']);
  });
});
