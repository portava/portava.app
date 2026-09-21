/**
 * SearchSuggestionsPanel — a refused suggest read is not "no quick matches".
 *
 * OWNER RULING, 2026-09-14: "Do not cache rate limits or outages as 'this
 * location does not exist.'" and "A distinguishable response body alone is
 * insufficient if consumers still treat it as successful empty data."
 *
 * Every layer below this one now carries the distinction. `discovery.ts` parses
 * the refusal off the body; `useSearchSuggestions` stopped caching a
 * `coverage: 'nothing'` read and stopped flashing the panel empty over groups
 * already on screen, and exposes `refused`. `useGlobalSearchSuggestions`
 * forwards it.
 *
 * And then nothing rendered it. On the FIRST query of a session a refusal
 * arrives with no earlier groups to hold, `hasAny` is false, and this panel
 * printed "No quick matches yet — keep typing, or search everything." That
 * sentence is a claim about the corpus, made on the server's behalf, when the
 * server did not look. It is the same defect the ruling names, one layer up
 * from where it was fixed: a refusal that reaches the screen as empty data.
 *
 * `refused` is `coverage: 'nothing'` only. A `partial` refusal carries real
 * groups and is rendered as the result it is.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SearchSuggestionsPanel } from '../SearchSuggestionsPanel.tsx';
import type { SuggestGroup, UnifiedSearchResult } from '../../../services/discovery.ts';

// NOTE: exhaustive on purpose — spreading requireActual pulls supabase and
// apiToken native deps in at module load. This panel reaches exactly these
// three bindings, and none of the fixtures below carry a media URL, so the
// hydration path is inert here rather than merely stubbed.
jest.mock('../../../services/mediaUrl.ts', () => ({
  PRIVATE_BUCKETS: ['post-media', 'profile-media'],
  hydrateMediaUrls: async () => ({}),
  useHydratedMedia: () => ({ resolved: {}, loading: false }),
}));

jest.mock('expo-image', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return { Image: (p: any) => ReactLib.createElement(View, { testID: 'mock-expo-image', ...p }) };
});

// NOTE: intentionally exhaustive — only `useSafeAreaInsets` is reached, via
// PlainBottomFiller; a minimal stub avoids wrapping every render in a provider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const NO_MATCHES = 'No quick matches yet';
const REFUSED_LINE = 'Suggestions are unavailable';

function create(el: React.ReactElement) {
  let tr!: TestRenderer.ReactTestRenderer;
  act(() => { tr = TestRenderer.create(el); });
  return tr;
}

/** Whole rendered tree as text — the panel's copy is what the user reads. */
function textOf(tr: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

function resultFixture(id: string, title: string): UnifiedSearchResult {
  return {
    id, type: 'person', title, subtitle: null,
    avatarUrl: null, imageUrl: null, fallbackInitials: 'XX',
    locationPreview: null, matchedReason: null, actionState: null,
    privacyState: null, accessState: null, destinationRoute: null,
    metadata: null, createdAt: null, startsAt: null,
  } as UnifiedSearchResult;
}

const STALE_GROUPS: SuggestGroup[] = [
  { type: 'person', label: 'People', items: [resultFixture('u1', 'Traveler One')] } as SuggestGroup,
];

function panel(props: Partial<React.ComponentProps<typeof SearchSuggestionsPanel>> = {}) {
  return (
    <SearchSuggestionsPanel
      query="kopi"
      groups={[]}
      loading={false}
      recentSearches={[]}
      onSubmit={jest.fn()}
      onPickRecent={jest.fn()}
      onPickResult={jest.fn()}
      {...props}
    />
  );
}

describe('SearchSuggestionsPanel — a refusal is not an empty corpus', () => {
  it('OUTAGE, first query: does not print "No quick matches yet" when the server did not look', () => {
    const text = textOf(create(panel({ refused: true })));

    expect(text).not.toContain(NO_MATCHES);
    expect(text).toContain(REFUSED_LINE);
  });

  it('CONTROL: a genuinely empty answer still says there are no quick matches', () => {
    const text = textOf(create(panel({ refused: false })));

    expect(text).toContain(NO_MATCHES);
    expect(text).not.toContain(REFUSED_LINE);
  });

  it('CONTROL: refused prop absent behaves exactly as before', () => {
    const text = textOf(create(panel()));

    expect(text).toContain(NO_MATCHES);
    expect(text).not.toContain(REFUSED_LINE);
  });

  it('OUTAGE over groups already on screen: the held groups stay, and are not passed off as fresh', () => {
    const text = textOf(create(panel({ refused: true, groups: STALE_GROUPS })));

    // The hook holds the previous groups rather than flashing empty. They are
    // still the last real answer, so they stay — but the panel says the read
    // behind them failed, instead of letting them read as current.
    expect(text).toContain('Traveler One');
    expect(text).toContain(REFUSED_LINE);
    expect(text).not.toContain(NO_MATCHES);
  });

  it('CONTROL: while still loading, neither sentence is stated', () => {
    const text = textOf(create(panel({ refused: true, loading: true })));

    expect(text).not.toContain(NO_MATCHES);
    expect(text).not.toContain(REFUSED_LINE);
  });
});
