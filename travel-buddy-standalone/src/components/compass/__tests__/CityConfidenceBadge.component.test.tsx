/**
 * CityConfidenceBadge component tests.
 *
 * Covers:
 *   - thin city → "Still learning this city" pill plus the honest note
 *   - deep city → "Deep local data" pill, no note line
 *   - no city / failed fetch → renders nothing
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

const mockFetchCityConfidence = jest.fn();
jest.mock('../../../services/compass', () => ({
  ...jest.requireActual('../../../services/compass'),
  fetchCityConfidence: (...args: unknown[]) => mockFetchCityConfidence(...args),
}));

import { CityConfidenceBadge } from '../CityConfidenceBadge.tsx';

describe('CityConfidenceBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the thin-tier pill with the honest note', async () => {
    mockFetchCityConfidence.mockResolvedValue({
      ok: true,
      data: {
        city: 'Dumaguete',
        depthScore: 12,
        tier: 'thin',
        note: "We're still building local depth for Dumaguete — recommendations may lean on broader signals.",
        computedAt: null,
      },
    });

    await render(<CityConfidenceBadge city="Dumaguete" />);
    await waitFor(() => expect(screen.getByText('Still learning this city')).toBeTruthy());
    expect(mockFetchCityConfidence).toHaveBeenCalledWith('Dumaguete');
    expect(screen.getByText(/still building local depth for Dumaguete/)).toBeTruthy();
  });

  it('renders the deep-tier pill without a note line', async () => {
    mockFetchCityConfidence.mockResolvedValue({
      ok: true,
      data: {
        city: 'Cebu',
        depthScore: 91,
        tier: 'deep',
        note: 'Cebu has deep local coverage.',
        computedAt: '2026-07-20T00:00:00Z',
      },
    });

    await render(<CityConfidenceBadge city="Cebu" />);
    await waitFor(() => expect(screen.getByText('Deep local data')).toBeTruthy());
    // The note is only surfaced for thin cities.
    expect(screen.queryByText('Cebu has deep local coverage.')).toBeNull();
  });

  it('renders nothing when there is no city', async () => {
    await render(<CityConfidenceBadge city={null} />);
    expect(mockFetchCityConfidence).not.toHaveBeenCalled();
    expect(screen.queryByTestId('city-confidence-badge')).toBeNull();
  });

  it('renders nothing when the fetch fails', async () => {
    mockFetchCityConfidence.mockResolvedValue({ ok: false, error: 'http_500' });
    await render(<CityConfidenceBadge city="Cebu" />);
    await waitFor(() => expect(mockFetchCityConfidence).toHaveBeenCalled());
    expect(screen.queryByTestId('city-confidence-badge')).toBeNull();
  });
});
