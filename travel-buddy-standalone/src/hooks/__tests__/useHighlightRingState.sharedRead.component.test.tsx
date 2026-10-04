/**
 * useHighlightRingState — every card asking about the same friend gets the
 * answer, not just the first one.
 *
 * WHAT WAS WRONG (lane highlights, 2026-10-03). The hook kept a `Set` of user
 * ids with a read in flight, and a second hook that found its user already in
 * it simply RETURNED. When two cards for one person mounted together — two
 * posts by the same friend in the feed, a profile header and a traveler row —
 * the second never received an answer and drew no Highlight ring until it
 * happened to remount. "See friends' Highlights" depends on that ring.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

const mockFetchUserHighlights = jest.fn();
jest.mock('../../services/highlights.ts', () => ({
  ...jest.requireActual('../../services/highlights.ts'),
  fetchUserHighlights: (...args: unknown[]) => mockFetchUserHighlights(...args),
}));
jest.mock('../../services/highlightViewedStorage.ts', () => ({
  ...jest.requireActual('../../services/highlightViewedStorage.ts'),
  initViewedIds: async () => {},
}));

import { useHighlightRingState, invalidateHighlightCache, type HighlightRingState } from '../useHighlightRingState.ts';

const FRIEND = 'friend-under-test';
const hl = (id: string) => ({
  id, ownerId: FRIEND, mediaUrl: 'https://example.test/h.jpg', mediaType: 'image/jpeg',
  videoDurationSeconds: null, caption: null, locationName: null, locationCity: null, locationCountry: null,
  visibility: 'public' as const, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: new Date().toISOString(), deletedAt: null, author: null, viewCount: 0, likeCount: 0,
  viewedByMe: false, likedByMe: false, filterId: 'none', filterIntensity: 0,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function Probe({ onState }: { onState: (s: HighlightRingState | null) => void }) {
  const state = useHighlightRingState(FRIEND);
  onState(state);
  return <Text>{state ? String(state.hasActive) : 'loading'}</Text>;
}

async function mountTwoTogether(answer: unknown) {
  const read = deferred<unknown>();
  mockFetchUserHighlights.mockImplementation(() => read.promise);
  let a: HighlightRingState | null = null;
  let b: HighlightRingState | null = null;
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(
      <>
        <Probe onState={(s) => { a = s; }} />
        <Probe onState={(s) => { b = s; }} />
      </>,
    );
  });
  await act(async () => { read.resolve(answer); await Promise.resolve(); await Promise.resolve(); });
  act(() => { tree?.unmount(); });
  return { a: a as HighlightRingState | null, b: b as HighlightRingState | null };
}

describe('useHighlightRingState — one shared read per friend', () => {
  beforeEach(() => { mockFetchUserHighlights.mockReset(); invalidateHighlightCache(FRIEND); });

  it('two cards mounted together BOTH get the ring, from ONE read', async () => {
    const { a, b } = await mountTwoTogether({ ok: true, data: [hl('h-1')] });
    expect(mockFetchUserHighlights).toHaveBeenCalledTimes(1);
    expect(a?.hasActive).toBe(true);
    expect(b).not.toBeNull();
    expect(b?.hasActive).toBe(true);
  });

  it('a failed shared read is unreadable for both — and still not cached', async () => {
    const { a, b } = await mountTwoTogether({ ok: false, data: null, errorKind: 'db_error' });
    expect(a?.unreadable).toBe(true);
    expect(b?.unreadable).toBe(true);
    mockFetchUserHighlights.mockReset();
    mockFetchUserHighlights.mockResolvedValue({ ok: true, data: [] });
    let c: HighlightRingState | null = null;
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => { tree = TestRenderer.create(<Probe onState={(s) => { c = s; }} />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { tree?.unmount(); });
    expect(mockFetchUserHighlights).toHaveBeenCalledTimes(1);
    expect((c as HighlightRingState | null)?.unreadable).toBe(false);
  });
});
