/**
 * useHighlightRingState — a read that FAILED is not a person with no Highlights.
 *
 * Highlights/Memories Development Architecture Spec v1 §28.11 ("never swallow
 * projection/schema failures into plausible-looking empty history without
 * structured error state").
 *
 * THE DEFECT THIS GUARDS. `GET /users/:id/highlights` answers `db_error` when
 * the read could not be performed, and the sibling feeds answer
 * `degraded_unavailable` when a scoping read failed — the API server refuses on
 * purpose rather than serving an empty list, because "this person has no
 * Highlights" is a claim about another person and it must be true. The hook
 * took `r.ok && r.data ? r.data : []` and turned every one of those refusals
 * back into the empty answer the server had just declined to give — and then
 * WROTE IT INTO A 60-SECOND CACHE, so one failed request fabricated that claim
 * on every profile card in the app until the TTL expired.
 *
 * The two assertions below are the two halves of that:
 *   1. a failed read reports itself (`unreadable`), it is not `hasActive:false`;
 *   2. a failed read is NOT cached, so the next mount actually asks again.
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

import {
  useHighlightRingState,
  invalidateHighlightCache,
  type HighlightRingState,
} from '../useHighlightRingState.ts';

const USER = 'user-under-test';

function makeHighlight(id: string) {
  return {
    id,
    ownerId: USER,
    mediaUrl: 'https://example.test/h.jpg',
    mediaType: 'image/jpeg',
    videoDurationSeconds: null,
    caption: null,
    locationName: null,
    locationCity: null,
    locationCountry: null,
    visibility: 'public' as const,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    deletedAt: null,
    author: null,
    viewCount: 0,
    likeCount: 0,
    viewedByMe: false,
    likedByMe: false,
    filterId: 'none',
    filterIntensity: 0,
  };
}

/** Probe that surfaces the hook's state to the test. */
function Probe({ onState }: { onState: (s: HighlightRingState | null) => void }) {
  const state = useHighlightRingState(USER);
  onState(state);
  return <Text>{state ? String(state.hasActive) : 'loading'}</Text>;
}

async function mountOnce(): Promise<HighlightRingState | null> {
  let last: HighlightRingState | null = null;
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(<Probe onState={(s) => { last = s; }} />);
  });
  // let the in-flight promise settle and the resulting setState flush
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  act(() => { tree?.unmount(); });
  return last;
}

describe('useHighlightRingState — a failed read is not an empty person', () => {
  beforeEach(() => {
    mockFetchUserHighlights.mockReset();
    invalidateHighlightCache(USER);
  });

  it('reports a failed read as unreadable instead of claiming no Highlights', async () => {
    mockFetchUserHighlights.mockResolvedValue({
      ok: false, data: null, errorKind: 'degraded_unavailable',
    });

    const state = await mountOnce();

    expect(state).not.toBeNull();
    // The whole point: the hook must not answer the question it could not read.
    expect(state?.unreadable).toBe(true);
  });

  it('does not cache a failed read as "no Highlights" — the next mount asks again', async () => {
    mockFetchUserHighlights.mockResolvedValueOnce({
      ok: false, data: null, errorKind: 'db_error',
    });
    mockFetchUserHighlights.mockResolvedValueOnce({
      ok: true, data: [makeHighlight('h-1')],
    });

    await mountOnce();
    const second = await mountOnce();

    // Before the fix the first (failed) read was written into the 60s cache,
    // so this second mount never called the service and reported hasActive:false.
    expect(mockFetchUserHighlights).toHaveBeenCalledTimes(2);
    expect(second).not.toBeNull();
    expect(second?.unreadable).toBe(false);
    expect(second?.hasActive).toBe(true);
  });
});
