/**
 * Destination page — CityConfidenceBadge (local data depth honesty signal).
 *
 * The destination screen must surface the same GET /api/compass/city-confidence
 * honesty signal as the Discovery "For You" tab:
 *   - thin city  → "Still learning this city" pill + honest note
 *   - deep city  → "Deep local data" pill
 *   - fetch fail → badge self-hides, page still renders
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ slug: 'el-nido' })),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stubs — these services import Supabase; not under test.
jest.mock('../../../src/services/hiddenGems', () => ({
  listGems: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../src/services/events', () => ({
  listEvents: jest.fn().mockResolvedValue({ ok: true, data: { events: [] } }),
}));
// NOTE: intentional stub — pulse service imports Supabase; not under test.
jest.mock('../../../src/services/pulse', () => ({
  getPulseData: jest.fn().mockResolvedValue({ ok: true, data: { posts: [] } }),
}));

const mockFetchCityConfidence = jest.fn();
jest.mock('../../../src/services/compass', () => ({
  ...jest.requireActual('../../../src/services/compass'),
  fetchCityConfidence: (...args: unknown[]) => mockFetchCityConfidence(...args),
}));

import Destination from '../[slug].tsx';

describe('Destination page — CityConfidenceBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the thin-tier badge with the honest note for the viewed city', async () => {
    mockFetchCityConfidence.mockResolvedValue({
      ok: true,
      data: {
        city: 'El Nido',
        depthScore: 9,
        tier: 'thin',
        note: "We're still building local depth for El Nido — recommendations may lean on broader signals.",
        computedAt: null,
      },
    });

    await render(<Destination />);
    await waitFor(() => expect(screen.getByTestId('city-confidence-badge')).toBeTruthy());
    // Fetches confidence for the humanized slug, not the raw slug.
    expect(mockFetchCityConfidence).toHaveBeenCalledWith('El Nido');
    expect(screen.getByText('Still learning this city')).toBeTruthy();
    expect(screen.getByText(/still building local depth for El Nido/)).toBeTruthy();
  });

  it('shows the deep-tier badge without a note line', async () => {
    mockFetchCityConfidence.mockResolvedValue({
      ok: true,
      data: {
        city: 'El Nido',
        depthScore: 88,
        tier: 'deep',
        note: 'El Nido has deep local coverage.',
        computedAt: '2026-07-20T00:00:00Z',
      },
    });

    await render(<Destination />);
    await waitFor(() => expect(screen.getByText('Deep local data')).toBeTruthy());
    expect(screen.queryByText('El Nido has deep local coverage.')).toBeNull();
  });

  it('self-hides the badge when the confidence fetch fails — page still renders', async () => {
    mockFetchCityConfidence.mockResolvedValue({ ok: false, error: 'http_500' });

    await render(<Destination />);
    await waitFor(() => expect(mockFetchCityConfidence).toHaveBeenCalled());
    expect(screen.queryByTestId('city-confidence-badge')).toBeNull();
    // The rest of the page is unaffected.
    expect(screen.getByText('Traveler guide to El Nido')).toBeTruthy();
  });
});
