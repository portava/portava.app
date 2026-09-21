/**
 * Telegraph §21 — the search surface, against the real screen.
 *
 * §21's mockup prints a count per bucket before it prints any result, and the
 * screen follows it: the counts ARE the answer for most searches.
 *
 * THREE EMPTY STATES, AND THE THIRD IS THE POINT
 * ==============================================
 * "type more", "nothing matched" and "we could not search everywhere" are
 * different facts. The third is the dangerous one to collapse: a degraded
 * search rendered as "no results" tells a person their own message does not
 * exist. The server sends `degraded`; this screen renders it; this suite
 * proves the two never merge.
 *
 * WHAT TURNS THIS RED
 *   • render `degraded` as the no-results state → the degraded test fails.
 *   • drop the bucket counts → four assertions fail at once.
 *   • search on one character → the short-query test fails, and a one-character
 *     search over every conversation a person is in is a scan, not a search.
 *   • let a stale response overwrite a newer one → the out-of-order test fails.
 */

import React from 'react';
import { render, act, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub. The real service module imports the supabase +
// apiToken chain at load time, which has no native module under jest; the
// screen's whole contract with it is one function, so the factory lists one.
jest.mock('../../services/telegraphSearch.ts', () => ({
  searchTelegraph: jest.fn(),
  askConversation: jest.fn(),
  emptyResult: (q: string) => ({
    query: q,
    counts: { MESSAGES: 0, PLACES: 0, MEDIA: 0, PLANS: 0, MEMORIES: 0 },
    hits: [],
    conversationsSearched: 0,
    conversationsBounded: 0,
    degraded: false,
  }),
}));

import { TelegraphSearchScreen } from '../TelegraphSearchScreen.tsx';
import { searchTelegraph } from '../../services/telegraphSearch.ts';
import type { SearchResult } from '../../types/index.ts';

const mockSearch = searchTelegraph as jest.MockedFunction<typeof searchTelegraph>;

function result(over: Partial<SearchResult> = {}): SearchResult {
  return {
    query: 'sky36',
    counts: { MESSAGES: 3, PLACES: 1, MEDIA: 2, PLANS: 1, MEMORIES: 1 },
    hits: [
      {
        messageId: 'm1', conversationId: 'c1', bucket: 'PLANS', senderId: 'u2',
        createdAt: '2026-05-01T00:00:00.000Z', snippet: 'Sky36 meetup · Friday',
        objectTitle: 'Sky36 meetup', subtype: 'meetup', msgType: 'text', hasMedia: false,
      },
    ],
    conversationsSearched: 4,
    conversationsBounded: 0,
    degraded: false,
    ...over,
  };
}

beforeEach(() => { mockSearch.mockReset(); });

describe('TelegraphSearchScreen — §21 counts first, then results', () => {
  it('shows the short-query hint and does not search on one character', async () => {
    const v = await render(<TelegraphSearchScreen />);
    await act(async () => {
      fireEvent.changeText(v.getByTestId('telegraph-search-input'), 's');
    });
    expect(v.getByTestId('telegraph-search-hint')).toBeTruthy();
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('renders a count for every one of §21\'s five buckets', async () => {
    mockSearch.mockResolvedValue({ ok: true, result: result() });
    const v = await render(<TelegraphSearchScreen initialQuery="sky36" />);
    await waitFor(() => expect(v.getByTestId('telegraph-search-counts')).toBeTruthy());
    for (const b of ['MESSAGES', 'PLACES', 'MEDIA', 'PLANS', 'MEMORIES']) {
      expect(v.getByTestId(`telegraph-search-count-${b}`)).toBeTruthy();
    }
  });

  it('renders a hit with its bucket and its object title', async () => {
    mockSearch.mockResolvedValue({ ok: true, result: result() });
    const v = await render(<TelegraphSearchScreen initialQuery="sky36" />);
    await waitFor(() => expect(v.getByTestId('telegraph-search-hit-m1')).toBeTruthy());
    expect(v.getByText('Sky36 meetup')).toBeTruthy();
    // The bucket label appears on the count chip too, so this asserts the one
    // inside the hit row rather than any 'PLANS' on the screen.
    expect(v.getAllByText('PLANS').length).toBeGreaterThanOrEqual(2);
  });

  it('hands a tapped hit back with its conversation, so the caller can navigate', async () => {
    mockSearch.mockResolvedValue({ ok: true, result: result() });
    const onOpen = jest.fn();
    const v = await render(<TelegraphSearchScreen initialQuery="sky36" onOpenMessage={onOpen} />);
    await waitFor(() => expect(v.getByTestId('telegraph-search-hit-m1')).toBeTruthy());
    await act(async () => { fireEvent.press(v.getByTestId('telegraph-search-hit-m1')); });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1' }));
  });

  it('a bucket chip narrows the search rather than filtering what is already shown', async () => {
    mockSearch.mockResolvedValue({ ok: true, result: result() });
    const v = await render(<TelegraphSearchScreen initialQuery="sky36" />);
    await waitFor(() => expect(v.getByTestId('telegraph-search-count-PLACES')).toBeTruthy());
    mockSearch.mockClear();
    await act(async () => { fireEvent.press(v.getByTestId('telegraph-search-count-PLACES')); });
    expect(mockSearch).toHaveBeenCalledWith('sky36', expect.objectContaining({ buckets: ['PLACES'] }));
  });
});

describe('TelegraphSearchScreen — the three empty states stay distinct', () => {
  it('DEGRADED is not the same as no results', async () => {
    mockSearch.mockResolvedValue({ ok: true, result: result({ hits: [], degraded: true }) });
    const v = await render(<TelegraphSearchScreen initialQuery="sky36" />);
    await waitFor(() => expect(v.getByTestId('telegraph-search-degraded')).toBeTruthy());
    expect(v.queryByTestId('telegraph-search-no-results')).toBeNull();
  });

  it('an honest empty says nothing matched', async () => {
    mockSearch.mockResolvedValue({ ok: true, result: result({ hits: [], degraded: false }) });
    const v = await render(<TelegraphSearchScreen initialQuery="sky36" />);
    await waitFor(() => expect(v.getByTestId('telegraph-search-no-results')).toBeTruthy());
    expect(v.queryByTestId('telegraph-search-degraded')).toBeNull();
  });

  it('being offline says so instead of saying nothing matched', async () => {
    mockSearch.mockResolvedValue({ ok: false, result: null, error: 'network_unreachable' });
    const v = await render(<TelegraphSearchScreen initialQuery="sky36" />);
    await waitFor(() => expect(v.getByTestId('telegraph-search-error')).toBeTruthy());
    expect(v.getByText(/offline/i)).toBeTruthy();
  });

  it('explains a §14.3 window rather than letting it look like a broken search', async () => {
    mockSearch.mockResolvedValue({ ok: true, result: result({ conversationsBounded: 2 }) });
    const v = await render(<TelegraphSearchScreen initialQuery="sky36" />);
    await waitFor(() => expect(v.getByTestId('telegraph-search-bounded-note')).toBeTruthy());
    expect(v.getByText(/only show messages from after you joined/)).toBeTruthy();
  });
});

describe('TelegraphSearchScreen — scoping', () => {
  it('passes the conversation id through when scoped to one thread', async () => {
    mockSearch.mockResolvedValue({ ok: true, result: result() });
    await render(<TelegraphSearchScreen conversationId="c9" initialQuery="sky36" />);
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith('sky36', expect.objectContaining({ conversationId: 'c9' })));
  });

  it('a stale response never overwrites a newer one', async () => {
    let resolveFirst: (v: any) => void = () => {};
    mockSearch
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({
        ok: true,
        result: result({
          query: 'sky36',
          hits: [{
            messageId: 'new', conversationId: 'c1', bucket: 'MESSAGES', senderId: 'u2',
            createdAt: '2026-05-02T00:00:00.000Z', snippet: 'newer', objectTitle: null,
            subtype: null, msgType: 'text', hasMedia: false,
          }],
        }),
      });

    const v = await render(<TelegraphSearchScreen initialQuery="sky" />);
    await act(async () => {
      fireEvent(v.getByTestId('telegraph-search-input'), 'submitEditing');
    });
    await waitFor(() => expect(v.getByTestId('telegraph-search-hit-new')).toBeTruthy());

    // The first, slower request now resolves with a DIFFERENT result. It must
    // be discarded: rendering it would show old results under a new query.
    await act(async () => {
      resolveFirst({
        ok: true,
        result: result({
          hits: [{
            messageId: 'stale', conversationId: 'c1', bucket: 'MESSAGES', senderId: 'u2',
            createdAt: '2026-04-01T00:00:00.000Z', snippet: 'older', objectTitle: null,
            subtype: null, msgType: 'text', hasMedia: false,
          }],
        }),
      });
    });
    expect(v.queryByTestId('telegraph-search-hit-stale')).toBeNull();
    expect(v.getByTestId('telegraph-search-hit-new')).toBeTruthy();
  });
});
