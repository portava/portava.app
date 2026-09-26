/**
 * HiddenGemsMediaScreen — the §4 Hidden Gems Media screen and the HIDDEN GEMS
 * lens, rendered (census-media §19: MD21 · MD313 · MD15 · MD33 · MD415 · MD416).
 *
 * Rendered against the lens's real transport contract (`fetchGems` is stubbed
 * with the server's `MediaGemStateProjection` shape) so what is asserted is what
 * a viewer would see:
 *   • OVERVIEW draws the §3 sections from derived STATE;
 *   • VISUAL draws the gems' own images as §46.1-contoured tiles;
 *   • MAP draws gems only through the one Media Map, as contoured zones;
 *   • an unreadable gem list says so — it never says "no gems here";
 *   • no card prints a number.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react-native';
import { HiddenGemsMediaScreen } from '../screens/HiddenGemsMediaScreen.tsx';

const mockFetchGems = jest.fn();
const mockFetchMapProjection = jest.fn();

jest.mock('../services/mediaProjection.ts', () => ({
  ...jest.requireActual('../services/mediaProjection.ts'),
  fetchGems: (...args: unknown[]) => mockFetchGems(...args),
}));
jest.mock('../../../services/mapProjection.ts', () => ({
  ...jest.requireActual('../../../services/mapProjection.ts'),
  fetchMapProjection: (...args: unknown[]) => mockFetchMapProjection(...args),
}));
// NOTE: intentionally exhaustive — the image layer is not under test; a plain
// View keeps the tile tree renderable without the expo-image native module.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return { CachedImage: (p: { source?: { uri?: string } }) => <View testID={`img-${p.source?.uri ?? ''}`} /> };
});

function gem(id: string, over: Record<string, unknown> = {}) {
  return {
    gemId: id,
    name: `Gem ${id}`,
    placeId: null,
    category: 'viewpoint',
    neighborhood: 'Son Tra',
    city: 'Da Nang',
    country: 'Vietnam',
    state: 'still_hidden',
    confidence: { score: 0.6, band: 'likely_current' },
    contributionCounts: {},
    verificationLevel: null,
    lastUpdatedAt: null,
    imageUrl: null,
    ...over,
  };
}

function lens(gems: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      generatedAt: '2026-09-26T00:00:00.000Z',
      city: 'Da Nang',
      gems: gems.map((g) => ({ ...(g as object) })),
      total: gems.length,
      determined: true,
      undetermined: [],
      ...extra,
    },
  };
}

beforeEach(() => {
  mockFetchGems.mockReset();
  mockFetchMapProjection.mockReset();
});

// The lens data flows through the REAL mapper, so feed it through mapGemLensProjection.
const { mapGemLensProjection } = jest.requireActual('../state/gemLens.ts');
function lensResult(gems: unknown[], extra: Record<string, unknown> = {}) {
  const raw = lens(gems, extra);
  return { ok: true, data: mapGemLensProjection(raw.data) };
}

describe('HiddenGemsMediaScreen', () => {
  it('OVERVIEW: the §3 sections from derived state, asked for by the coarse city label', async () => {
    mockFetchGems.mockResolvedValue(
      lensResult([
        gem('a', { state: 'recently_confirmed' }),
        gem('b', { contributionCounts: { still_worth_it: 2 } }),
        gem('c', { state: 'seasonal' }),
        gem('d', { state: 'overcrowding_risk' }),
      ]),
    );
    await render(<HiddenGemsMediaScreen mode="overview" city="Da Nang" />);
    await waitFor(() => expect(screen.getByTestId('gem-lens-overview')).toBeTruthy());
    expect(mockFetchGems).toHaveBeenCalledWith(expect.objectContaining({ city: 'Da Nang' }));
    expect(screen.getByTestId('gem-section-recently_confirmed')).toBeTruthy();
    expect(screen.getByTestId('gem-section-worth_the_detour')).toBeTruthy();
    expect(screen.getByTestId('gem-section-seasonal')).toBeTruthy();
    expect(screen.getByTestId('gem-section-visit_gently')).toBeTruthy();
    expect(screen.getByText('This small spot is getting busy — consider another time.')).toBeTruthy();
    // Every gem gets the §46.1 marker; no card prints a count.
    expect(screen.getAllByTestId('hidden-gem-marker')).toHaveLength(4);
    for (const id of ['a', 'b', 'c', 'd']) {
      const card = screen.getByTestId(`hidden-gem-card-${id}`);
      // §46.1 "avoid popularity-counter language": the card prints no number at all.
      expect(within(card).queryAllByText(/\d/)).toHaveLength(0);
    }
  });

  it('OVERVIEW: the card carries the §46.1 contour — a border and an outer glow — from the gem\'s state', async () => {
    mockFetchGems.mockResolvedValue(lensResult([gem('a', { state: 'recently_confirmed' }), gem('x', { state: 'temporarily_unavailable' })]));
    await render(<HiddenGemsMediaScreen mode="overview" city="Da Nang" />);
    await waitFor(() => expect(screen.getByTestId('hidden-gem-card-a')).toBeTruthy());
    const flat = (id: string) => {
      const s = screen.getByTestId(`hidden-gem-card-${id}`).props.style;
      return Object.assign({}, ...(Array.isArray(s) ? s.flat(3).filter(Boolean) : [s]));
    };
    const calm = flat('a');
    expect(calm.borderWidth).toBeGreaterThan(0);
    expect(calm.shadowOpacity).toBeGreaterThan(0);
    expect(calm.shadowColor).toBe('#10B981');
    const unavailable = flat('x');
    expect(unavailable.shadowOpacity).toBe(0);
  });

  it('VISUAL: a mosaic of the gems\' OWN images; a gem without one draws its marker, not someone else\'s photo', async () => {
    mockFetchGems.mockResolvedValue(
      lensResult([gem('a', { imageUrl: 'https://cdn.example.test/a.jpg' }), gem('b')]),
    );
    await render(<HiddenGemsMediaScreen mode="visual" city="Da Nang" />);
    await waitFor(() => expect(screen.getByTestId('gem-lens-visual')).toBeTruthy());
    expect(screen.getByTestId('img-https://cdn.example.test/a.jpg')).toBeTruthy();
    expect(screen.getAllByTestId('hidden-gem-marker')).toHaveLength(1);
    expect(screen.queryByTestId('gem-lens-overview')).toBeNull();
  });

  it('MAP: gems only, through the Media Map, as contoured zones restricted to the gems this lens disclosed', async () => {
    mockFetchGems.mockResolvedValue(lensResult([gem('a')]));
    mockFetchMapProjection.mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        objects: [
          { id: 'gem:a', kind: 'hidden_gem', title: 'Gem a', privacyClass: 'approximate', renderingPriority: 1, geometry: { type: 'Point', coordinates: [108.2, 16.1] } },
          { id: 'gem:z', kind: 'hidden_gem', title: 'Not disclosed by the lens', privacyClass: 'approximate', renderingPriority: 1, geometry: { type: 'Point', coordinates: [108.3, 16.2] } },
        ],
      },
    });
    await render(<HiddenGemsMediaScreen mode="map" city="Da Nang" center={{ lat: 16.05, lng: 108.22 }} />);
    await waitFor(() => expect(screen.getByTestId('media-map-screen')).toBeTruthy());
    expect(mockFetchMapProjection).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['place', 'hidden_gem'] }));
    expect(screen.getByTestId('media-map-gem-row-a')).toBeTruthy();
    expect(screen.getByText('Approximate area')).toBeTruthy();
    expect(screen.queryByTestId('media-map-gem-row-z')).toBeNull();
    expect(screen.queryByText('Not disclosed by the lens')).toBeNull();
  });

  it('an UNREADABLE gem list is an error that says it is not the same as "none here"', async () => {
    mockFetchGems.mockResolvedValue(lensResult([], { determined: false, undetermined: ['gems'] }));
    await render(<HiddenGemsMediaScreen mode="overview" city="Da Nang" />);
    await waitFor(() => expect(screen.getByText('Hidden gems could not be read')).toBeTruthy());
    expect(screen.queryByText('No hidden gems here yet')).toBeNull();
  });

  it('a partially-read lens renders the gems AND says the states may be incomplete', async () => {
    mockFetchGems.mockResolvedValue(lensResult([gem('a')], { determined: false, undetermined: ['gemState'] }));
    await render(<HiddenGemsMediaScreen mode="overview" city="Da Nang" />);
    await waitFor(() => expect(screen.getByTestId('gem-lens-partial')).toBeTruthy());
    expect(screen.getByTestId('hidden-gem-card-a')).toBeTruthy();
  });
});
