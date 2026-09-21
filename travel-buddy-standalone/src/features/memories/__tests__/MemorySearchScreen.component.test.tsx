/**
 * MemorySearchScreen — §15 retrieval, from a person's side.
 *
 * Highlights/Memories Development Architecture Spec v1 §15, §18, §28.11.
 * Census H110–H114.
 *
 * The load-bearing assertions are the three answers that are NOT "nothing
 * matched": a revoked index, a refusal, and an outage. §28.11 exists because a
 * failure served as an empty page is byte-identical to the truth, and on a
 * person's own history that is the worst available lie.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

import { MemorySearchScreen } from '../MemorySearchScreen.tsx';
import type { MemorySearchResult, MemorySearchPage } from '../memorySearchApi.ts';

const M1 = 'dddddddd-dddd-dddd-dddd-dddddddddd01';

function page(over: Partial<MemorySearchPage> = {}): MemorySearchPage {
  return {
    hits: [{
      memoryId: M1,
      score: 0.8,
      dimensions: {
        semantic_relevance: 0.1, temporal_relevance: 0.5, spatial_relevance: 0.2,
        person_relevance: 0, explicit_significance: 0, confidence: 0, privacy_eligibility: 1,
      },
      row: { memory_id: M1, title: 'Hanoi noodle stall', location_city: 'Hanoi', location_country: 'VN' },
    }],
    deterministicMatchCount: 4,
    semanticRerankApplied: true,
    namespace: 'PRIVATE_PERSONAL',
    projectionId: 'MemoryTimelineProjection',
    engineVersion: 'memory-retrieval@1',
    capabilities: {
      intents: ['mine', 'mine_place', 'public'],
      namespaces: ['PRIVATE_PERSONAL', 'PUBLIC'],
      unreachableNamespaces: { SHARED_CREW: 'per-owner derivatives' },
      rankingDimensions: ['semantic_relevance', 'temporal_relevance', 'spatial_relevance', 'person_relevance', 'explicit_significance', 'confidence', 'privacy_eligibility'],
      // The server's own weights. `privacy_eligibility` is 0 because it is a
      // GATE: it is 1 on every eligible row, so a client that ranked by raw
      // value would say "shareable" about every result ever returned.
      rankingWeights: {
        semantic_relevance: 0.25, temporal_relevance: 0.20, spatial_relevance: 0.20,
        person_relevance: 0.15, explicit_significance: 0.10, confidence: 0.10,
        privacy_eligibility: 0,
      },
      engineVersion: 'memory-retrieval@1',
      semanticIndex: 'none',
      projectionsByNamespace: {},
    },
    ...over,
  };
}

const searcher = (r: MemorySearchResult) => jest.fn(async () => r);

describe('MemorySearchScreen', () => {
  it('runs the search and lists the hits the server ranked', async () => {
    const search = searcher({ state: 'ok', page: page() });
    const { findByTestId, getByText } = await render(<MemorySearchScreen search={search} />);
    fireEvent.changeText(await findByTestId('memory-search-input'), 'noodle');
    fireEvent.press(await findByTestId('memory-search-submit'));

    await findByTestId(`memory-search-hit-${M1}`);
    expect(getByText('Hanoi noodle stall')).toBeTruthy();
    expect(getByText('Hanoi, VN')).toBeTruthy();
    expect(search).toHaveBeenCalledWith({ intent: { kind: 'mine' }, query: 'noodle', limit: 50 });
  });

  it('says WHY a hit ranked where it did, using the dimension that contributed most', async () => {
    // §15 asks for named ranking dimensions. A list with no derivation is a
    // list, not a ranking — and the fixture's top contributor is temporal.
    const { findByTestId, getByText } = await render(
      <MemorySearchScreen search={searcher({ state: 'ok', page: page() })} />,
    );
    fireEvent.press(await findByTestId('memory-search-submit'));
    await findByTestId(`memory-search-why-${M1}`);
    expect(getByText('close in time')).toBeTruthy();
  });

  it('never reports a ZERO-WEIGHT gate as the reason a hit ranked', async () => {
    // `privacy_eligibility` is 1 on every eligible row and weighted 0 — it is a
    // gate, not a contributor. Ranking by RAW value would tell every person,
    // about every result, that it is there because it is shareable. This is the
    // bug this assertion exists for; it was real and this suite caught it.
    const { findByTestId, queryByText } = await render(
      <MemorySearchScreen search={searcher({ state: 'ok', page: page() })} />,
    );
    fireEvent.press(await findByTestId('memory-search-submit'));
    await findByTestId(`memory-search-why-${M1}`);
    expect(queryByText('shareable')).toBeNull();
    expect(queryByText('privacy_eligibility')).toBeNull();
  });

  it('reports how many the DETERMINISTIC filters selected, not just how many are shown', async () => {
    // H111: a semantic query may only reorder what the filters selected.
    const { findByTestId, getByText } = await render(
      <MemorySearchScreen search={searcher({ state: 'ok', page: page() })} />,
    );
    fireEvent.press(await findByTestId('memory-search-submit'));
    await findByTestId('memory-search-meta');
    expect(getByText('4 matched · reordered by your words')).toBeTruthy();
  });

  it('does not imply an understanding the engine does not have', async () => {
    // H111: the scorer is token overlap and no model is called on this path.
    const { findByTestId } = await render(
      <MemorySearchScreen search={searcher({ state: 'ok', page: page() })} />,
    );
    fireEvent.press(await findByTestId('memory-search-submit'));
    expect(await findByTestId('memory-search-engine-note')).toBeTruthy();
  });

  it('an EMPTY result says nothing matched', async () => {
    const { findByTestId } = await render(
      <MemorySearchScreen search={searcher({ state: 'ok', page: page({ hits: [], deterministicMatchCount: 0, semanticRerankApplied: false }) })} />,
    );
    fireEvent.press(await findByTestId('memory-search-submit'));
    expect(await findByTestId('memory-search-empty')).toBeTruthy();
  });

  it('a REVOKED index is its own answer, with no retry offered', async () => {
    // §18 / H114. These were removed from search by a privacy decision or a
    // deletion and are not coming back; a retry button would be a lie, and
    // "nothing matched" would be a different lie.
    const { findByTestId, queryByTestId, getByText } = await render(
      <MemorySearchScreen search={searcher({ state: 'revoked', detail: 'Those memories are no longer searchable.' })} />,
    );
    fireEvent.press(await findByTestId('memory-search-submit'));
    await findByTestId('memory-search-revoked');
    expect(getByText('Those memories are no longer searchable.')).toBeTruthy();
    expect(queryByTestId('memory-search-empty')).toBeNull();
    expect(queryByTestId('memory-search-retry')).toBeNull();
  });

  it('an OUTAGE is not an empty page, and it does offer a retry', async () => {
    const search = jest.fn(async () => ({ state: 'unavailable' as const, detail: 'You appear to be offline.' }));
    const { findByTestId, queryByTestId } = await render(<MemorySearchScreen search={search} />);
    fireEvent.press(await findByTestId('memory-search-submit'));
    await findByTestId('memory-search-unavailable');
    expect(queryByTestId('memory-search-empty')).toBeNull();

    fireEvent.press(await findByTestId('memory-search-retry'));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });

  it('a REFUSAL is shown as a refusal', async () => {
    const { findByTestId, queryByTestId } = await render(
      <MemorySearchScreen search={searcher({ state: 'refused', detail: 'PublicMemoryProjection cannot answer: trip' })} />,
    );
    fireEvent.press(await findByTestId('memory-search-submit'));
    await findByTestId('memory-search-refused');
    expect(queryByTestId('memory-search-empty')).toBeNull();
  });

  it('passes the intent it was given straight through — it never names a namespace', async () => {
    const OWNER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const search = searcher({ state: 'ok', page: page() });
    const { findByTestId } = await render(
      <MemorySearchScreen intent={{ kind: 'public', ownerId: OWNER }} search={search} />,
    );
    fireEvent.press(await findByTestId('memory-search-submit'));
    await waitFor(() => expect(search).toHaveBeenCalled());
    const sent = (search as jest.Mock).mock.calls[0][0];
    expect(sent.intent).toEqual({ kind: 'public', ownerId: OWNER });
    // If a client could name these, the server's isolation check would be the
    // only thing standing between a stranger and a private timeline.
    expect(sent).not.toHaveProperty('namespace');
    expect(sent).not.toHaveProperty('authorizedProjection');
    expect(sent).not.toHaveProperty('ownerId');
  });
});
