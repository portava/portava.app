/**
 * Discovery tab — the Trending chip is offered only while Trending can answer.
 *
 * Every list GET /api/v1/discovery/trending/:action serves needs BOTH `discovery_trending_api_enabled` AND
 * `discovery_trend_lists_enabled` (routes/discoveryTrending.ts); both are OFF in production (2026-10-22), so the
 * chip opened a screen that could only say "Trending isn't available yet."
 *   T1  both flags off → no Trending chip; Trails is still offered;
 *   T2  only one of the two on → still no chip (the server needs both);
 *   T3  both on → the chip is offered and carries the city.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

import { DiscoveryExploreLinks } from '../DiscoveryExploreLinks.tsx';

const mockFlagsOn = new Set<string>();
// NOTE: intentionally exhaustive — the chips read two flags through the context; the provider fetches over HTTP.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlagsOn.has(k), loading: false }),
}));

beforeEach(() => { mockFlagsOn.clear(); });

describe('DiscoveryExploreLinks — Trending flag gate', () => {
  it('T1: both trending flags off → no Trending chip; Trails is still offered', async () => {
    await render(<DiscoveryExploreLinks city="Lisbon" onNavigate={jest.fn()} />);
    expect(screen.getByTestId('discovery-link-trails')).toBeTruthy();
    expect(screen.queryByTestId('discovery-link-trending')).toBeNull();
    expect(screen.queryByText('Trending')).toBeNull();
  });

  it.each(['discovery_trending_api_enabled', 'discovery_trend_lists_enabled'])('T2: only %s on → still no chip', async (flag) => {
    mockFlagsOn.add(flag);
    await render(<DiscoveryExploreLinks city="Lisbon" onNavigate={jest.fn()} />);
    expect(screen.queryByTestId('discovery-link-trending')).toBeNull();
  });

  it('T3: both on → the chip is offered and opens Trending on the city', async () => {
    mockFlagsOn.add('discovery_trending_api_enabled');
    mockFlagsOn.add('discovery_trend_lists_enabled');
    const onNavigate = jest.fn();
    await render(<DiscoveryExploreLinks city="Lisbon" onNavigate={onNavigate} />);
    await fireEvent.press(screen.getByTestId('discovery-link-trending'));
    expect(onNavigate).toHaveBeenCalledWith('/trending?destination=Lisbon');
  });
});
