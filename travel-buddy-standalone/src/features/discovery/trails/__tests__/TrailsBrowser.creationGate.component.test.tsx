/**
 * Trails browser — "Start a Trail" is offered only while a Trail can be started.
 *
 * POST /api/v1/discovery/trails refuses every proposal with feature_disabled while `trail_creation_enabled` is OFF
 * (lead ruling D-66; OFF in production 2026-10-22). The browser still offered "Start a Trail" and an empty list
 * still said "You can start one." — both led to a form whose submit could only be refused.
 *   B1  flag off → no "Start a Trail", and an empty list does not invite the traveller to start one;
 *   B2  flag on → both are offered, and the button carries the city.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { TrailsBrowser } from '../TrailsBrowser.tsx';

const mockFlagsOn = new Set<string>();
// NOTE: intentionally exhaustive — the browser reads one flag through the context; the provider fetches over HTTP.
jest.mock('../../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlagsOn.has(k), loading: false }),
}));

const empty = () => jest.fn().mockResolvedValue({ state: 'ok', data: [] });

beforeEach(() => { mockFlagsOn.clear(); });

describe('TrailsBrowser — trail_creation_enabled gate', () => {
  it('B1: flag off → no "Start a Trail", and an empty list does not offer to start one', async () => {
    await render(<TrailsBrowser initialDestination="Kyoto" onOpen={jest.fn()} onCreate={jest.fn()} load={empty()} loadMine={empty()} />);
    await waitFor(() => screen.getByTestId('trails-empty'));
    expect(screen.queryByTestId('trails-create')).toBeNull();
    expect(screen.queryByText('Start a Trail')).toBeNull();
    expect(screen.getByText('No Trails match.')).toBeTruthy();
  });

  it('B2: flag on → "Start a Trail" is offered with the city, and the empty list invites one', async () => {
    mockFlagsOn.add('trail_creation_enabled');
    const onCreate = jest.fn();
    await render(<TrailsBrowser initialDestination="Kyoto" onOpen={jest.fn()} onCreate={onCreate} load={empty()} loadMine={empty()} />);
    await waitFor(() => screen.getByTestId('trails-empty'));
    expect(screen.getByText('No Trails match. You can start one.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('trails-create'));
    expect(onCreate).toHaveBeenCalledWith('Kyoto');
  });
});
