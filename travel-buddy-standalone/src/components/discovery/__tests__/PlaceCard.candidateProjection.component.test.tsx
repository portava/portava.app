/**
 * PlaceCard — the DiscoveryCandidate projection, rendered.
 * census-discovery DSV2-04 (the client leg split off A03) and DC-22 (reason labels).
 *
 * THE REQUIREMENTS, QUOTED
 * ========================
 * DSV2-04 (`docs/specs/upgrades-v2/02-DISCOVERY-v2.md`, via census §11.4):
 *   "Observed and predicted recommendations render distinctly; expired why-now
 *    claims disappear or become explicitly stale."
 * Sensing §5.1, which is where that rule comes from:
 *   "prediction must never be rendered indistinguishably from observation."
 * DC-22 (`11` §5) lists **reason labels** among the five Recommendation API
 * outputs. The server produces them — `lib/discoveryReasonCodes.ts#explainReasons`
 * puts `{ code, text }` pairs on `candidate.reasons` — and until now no client
 * read the field, so the labels stopped at the wire.
 *
 * WHAT THE SERVER SENDS
 * =====================
 * `artifacts/api-server/src/lib/discoveryCandidate.ts#withDiscoveryCandidates`
 * attaches a `candidate` object to each served place on `GET /api/discovery`
 * (`routes/discovery.ts:1850`, `:2100`, `:2192`, `:2282`). `toPublic` is the
 * identity function (`routes/discovery.ts:196`), so the field reaches the client
 * verbatim. It is ADDITIVE and flag-gated (`discovery_candidate_projection_enabled`,
 * migration 2361, seeded FALSE): with the flag off the field is simply ABSENT,
 * which is the first refusal arm below.
 *
 * Reachable from: Explore tab → `app/(tabs)/discovery.tsx` → `ForYouTab` →
 * `PlaceCard` (this component).
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────
// Same seam as PlaceCard.typePill.component.test.tsx.

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only the live-status function
// is needed and we control its return value entirely.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatusCached: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; only the stubs are needed here.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  saveItem:   jest.fn().mockResolvedValue(true),
  unsaveItem: jest.fn().mockResolvedValue(true),
}));

// NOTE: intentionally exhaustive — discoveryBookmarks imports AsyncStorage
// (already globally mocked) and Supabase; the Set return is all that matters.
jest.mock('../../../services/discoveryBookmarks', () => ({
  getSavedListIds: jest.fn().mockResolvedValue(new Set()),
}));

// NOTE: intentionally exhaustive — the real PlanPickerController renders the
// full picker UI tree with Reanimated/portal internals; only isAdded is needed.
jest.mock('../../PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker pulls in its own service
// chain and Modal; stubbing to null prevents a secondary dependency cascade.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// crash under jest-expo; the card only needs something that renders children.
jest.mock('../../ui/DisplayMediaImage.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    DisplayMediaImage: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(View, { testID: testID ?? 'display-media-image' }, children ?? null),
    MediaFallback: () => null,
  };
});

// NOTE: intentionally exhaustive — the FSQ photo hook performs network lookups;
// the projection under test has nothing to do with imagery.
jest.mock('../../../hooks/useFsqPhoto.ts', () => ({ useFsqPhoto: () => null }));

import { PlaceCard } from '../PlaceCard.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

const BASE_PLACE: DiscoveryPlace = {
  id: 'node/1',
  name: 'Sirao Flower Garden',
  category: 'nature',
  type: 'Garden',
  description: 'Terraced flower rows above the city.',
  distanceKm: 3.2,
  lat: 10.4,
  lng: 123.8,
  tags: [],
  address: 'Sirao',
  website: null,
  phone: null,
  openingHours: null,
  rating: null,
  isOpenNow: null,
};

/** A served projection, in the shape `lib/discoveryCandidate.ts` emits. */
function candidate(over: Record<string, unknown> = {}) {
  return {
    id: 'node/1',
    whyNow: null,
    whyForUser: [],
    rankedBy: 'none',
    confidence: 0.6,
    freshness: { state: 'fresh', ageMs: 1000, servedFrom: 'L1' },
    truthClass: 'observed',
    provenance: null,
    reasons: [],
    ...over,
  };
}

function placeWith(cand: unknown): DiscoveryPlace {
  const withCandidate = { ...BASE_PLACE, candidate: cand };
  return withCandidate as DiscoveryPlace;
}

const noop = () => {};

async function mount(place: DiscoveryPlace) {
  return render(<PlaceCard place={place} onPress={noop} onAddToPlan={noop} />);
}

describe('DSV2-04 — observed and predicted render distinctly', () => {
  it('an OBSERVED candidate renders an observation chip, not a prediction chip', async () => {
    await mount(placeWith(candidate({ truthClass: 'observed' })));

    await waitFor(() => expect(screen.getByTestId('candidate-truth-class')).toBeTruthy());
    expect(screen.getByTestId('candidate-truth-observation')).toBeTruthy();
    expect(screen.queryByTestId('candidate-truth-prediction')).toBeNull();
    expect(screen.getByText('Observed')).toBeTruthy();
  });

  it('a PREDICTED candidate renders a prediction chip, not an observation chip', async () => {
    await mount(placeWith(candidate({ truthClass: 'predicted' })));

    await waitFor(() => expect(screen.getByTestId('candidate-truth-class')).toBeTruthy());
    expect(screen.getByTestId('candidate-truth-prediction')).toBeTruthy();
    expect(screen.queryByTestId('candidate-truth-observation')).toBeNull();
    expect(screen.getByText('Predicted')).toBeTruthy();
  });

  /**
   * One mount per class — `it.each`, not a loop inside one test, so each case
   * gets its own RNTL cleanup. The expected label and family are written out
   * here rather than imported from the module under test: a test that reads the
   * table it is checking would pass whatever the table said.
   */
  it.each([
    ['corroborated', 'Corroborated',      'observation'],
    ['observed',     'Observed',          'observation'],
    ['stale',        'Last seen earlier', 'observation'],
    ['unknown',      'Unverified',        'unknown'],
    ['inferred',     'Inferred',          'prediction'],
    ['predicted',    'Predicted',         'prediction'],
    ['conflicting',  'Sources disagree',  'conflict'],
  ])('§5.1 class %s renders "%s" in the %s family', async (truthClass, label, family) => {
    await mount(placeWith(candidate({ truthClass })));

    await waitFor(() => expect(screen.getByTestId('candidate-truth-class')).toBeTruthy());
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByTestId(`candidate-truth-${family}`)).toBeTruthy();
    // A prediction must never be reachable through the observation marker, and
    // vice versa — that is the whole of "render distinctly".
    const other = family === 'prediction' ? 'observation' : 'prediction';
    expect(screen.queryByTestId(`candidate-truth-${other}`)).toBeNull();
  });

});

describe('DSV2-04 — expired why-now claims become explicitly stale', () => {
  it('a FRESH why-now renders the grounded claim plainly', async () => {
    await mount(placeWith(candidate({
      whyNow: ['crowd_busy'],
      freshness: { state: 'fresh', ageMs: 2000, servedFrom: 'L2_fresh' },
    })));

    await waitFor(() => expect(screen.getByTestId('candidate-why-now')).toBeTruthy());
    expect(screen.getByText(/crowd busy/i)).toBeTruthy();
    expect(screen.queryByTestId('candidate-why-now-stale')).toBeNull();
  });

  it('a why-now served past its window is marked explicitly stale, never as a live claim', async () => {
    await mount(placeWith(candidate({
      whyNow: ['crowd_busy'],
      truthClass: 'stale',
      freshness: { state: 'stale', ageMs: 900_000, servedFrom: 'L2_stale' },
    })));

    await waitFor(() => expect(screen.getByTestId('candidate-why-now')).toBeTruthy());
    expect(screen.getByTestId('candidate-why-now-stale')).toBeTruthy();
    expect(screen.getByText(/no longer current/i)).toBeTruthy();
  });

  it('a NULL why-now renders no claim at all — absence is never an empty endorsement', async () => {
    await mount(placeWith(candidate({ whyNow: null })));

    // Non-empty tree: the card itself rendered; only the claim line is absent.
    await waitFor(() => expect(screen.getByText('Sirao Flower Garden')).toBeTruthy());
    expect(screen.queryByTestId('candidate-why-now')).toBeNull();
  });
});

describe('DC-22 — reason labels reach the client', () => {
  it('renders the plain-language reason text the server produced', async () => {
    await mount(placeWith(candidate({
      reasons: [
        { code: 'nearby_now', text: 'Rising near your hotel.' },
        { code: 'saved_similar', text: 'Because you saved similar rooftop bars.' },
      ],
    })));

    await waitFor(() => expect(screen.getByTestId('candidate-reasons')).toBeTruthy());
    expect(screen.getByText('Rising near your hotel.')).toBeTruthy();
    expect(screen.getByText('Because you saved similar rooftop bars.')).toBeTruthy();
  });

  it('renders no reasons block when the server sent an empty list', async () => {
    await mount(placeWith(candidate({ reasons: [] })));

    await waitFor(() => expect(screen.getByText('Sirao Flower Garden')).toBeTruthy());
    expect(screen.queryByTestId('candidate-reasons')).toBeNull();
  });
});

describe('refusal arms — the projection is additive and flag-gated', () => {
  it('FLAG OFF (no candidate field): the card renders normally and shows no projection', async () => {
    await mount(BASE_PLACE);

    await waitFor(() => expect(screen.getByText('Sirao Flower Garden')).toBeTruthy());
    expect(screen.queryByTestId('candidate-truth-class')).toBeNull();
    expect(screen.queryByTestId('candidate-why-now')).toBeNull();
    expect(screen.queryByTestId('candidate-reasons')).toBeNull();
  });

  it('MALFORMED candidate: the card renders normally and shows no projection', async () => {
    await mount(placeWith({ truthClass: 42, freshness: 'nope', reasons: 'nope' }));

    await waitFor(() => expect(screen.getByText('Sirao Flower Garden')).toBeTruthy());
    expect(screen.queryByTestId('candidate-truth-class')).toBeNull();
    expect(screen.queryByTestId('candidate-reasons')).toBeNull();
  });

  it('UNRECOGNISED truth class: no chip is invented for a class this client cannot name', async () => {
    await mount(placeWith(candidate({ truthClass: 'speculative' })));

    await waitFor(() => expect(screen.getByText('Sirao Flower Garden')).toBeTruthy());
    expect(screen.queryByTestId('candidate-truth-class')).toBeNull();
  });
});
