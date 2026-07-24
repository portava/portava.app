/**
 * Component tests — TripCountryEssentialsSection
 *
 * Covers:
 *   1. Returns nothing when getTripEssentials returns null (flag off)
 *   2. Returns nothing when all items have null essentials (no coverage)
 *   3. Renders card with country name, plug hint, drive side, emergency numbers
 *   4. Always renders disclaimer alongside emergency numbers (safety requirement)
 *   5. Skips countries where essentials is null; renders covered ones
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { TripCountryEssentialsSection } from '../trip/TripCountryEssentialsSection.tsx';

jest.mock('../../services/countryEssentials', () => ({
  getTripEssentials: jest.fn(),
}));

import { getTripEssentials } from '../../services/countryEssentials.ts';

const mockGet = getTripEssentials as jest.MockedFunction<typeof getTripEssentials>;

const ESSENTIALS_PH = {
  code: 'PH',
  plugTypes: ['A', 'B', 'C'],
  voltage: 220,
  frequency: 60,
  driveSide: 'right' as const,
  emergency: { all: '911', police: '117', ambulance: '161', fire: '160' },
  confidence: 'high',
  source: 'seed',
  lastVerifiedAt: '2025-01-01',
  disclaimer: 'Confirm emergency numbers on arrival — numbers may vary by region.',
};

describe('TripCountryEssentialsSection', () => {
  const TRIP_ID = 'trip-essentials-test';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when flag off (null response)', async () => {
    mockGet.mockResolvedValue(null);
    await render(<TripCountryEssentialsSection tripId={TRIP_ID} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(TRIP_ID));
    expect(screen.toJSON()).toBeNull();
  });

  it('renders nothing when all items have null essentials (no coverage)', async () => {
    mockGet.mockResolvedValue([{ country: 'Antarctica', essentials: null }]);
    await render(<TripCountryEssentialsSection tripId={TRIP_ID} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.toJSON()).toBeNull();
  });

  it('renders a card for a covered country', async () => {
    mockGet.mockResolvedValue([{ country: 'Philippines', essentials: ESSENTIALS_PH }]);
    await render(<TripCountryEssentialsSection tripId={TRIP_ID} />);
    await waitFor(() => expect(screen.getByText('Philippines')).toBeTruthy());
    expect(screen.getByText('Good to know')).toBeTruthy();
  });

  it('always renders disclaimer alongside emergency numbers', async () => {
    mockGet.mockResolvedValue([{ country: 'Philippines', essentials: ESSENTIALS_PH }]);
    await render(<TripCountryEssentialsSection tripId={TRIP_ID} />);
    await waitFor(() =>
      expect(screen.getByText(ESSENTIALS_PH.disclaimer)).toBeTruthy()
    );
  });

  it('renders plug type hint', async () => {
    mockGet.mockResolvedValue([{ country: 'Philippines', essentials: ESSENTIALS_PH }]);
    await render(<TripCountryEssentialsSection tripId={TRIP_ID} />);
    await waitFor(() =>
      expect(screen.getByText(/Type A, B, C/)).toBeTruthy()
    );
  });

  it('skips uncovered countries but shows covered ones', async () => {
    mockGet.mockResolvedValue([
      { country: 'Antarctica', essentials: null },
      { country: 'Philippines', essentials: ESSENTIALS_PH },
    ]);
    await render(<TripCountryEssentialsSection tripId={TRIP_ID} />);
    await waitFor(() => expect(screen.getByText('Philippines')).toBeTruthy());
    expect(screen.queryByText('Antarctica')).toBeNull();
  });

  it('renders drive side', async () => {
    mockGet.mockResolvedValue([{ country: 'Philippines', essentials: ESSENTIALS_PH }]);
    await render(<TripCountryEssentialsSection tripId={TRIP_ID} />);
    await waitFor(() =>
      expect(screen.getByText('Drives on the right')).toBeTruthy()
    );
  });
});
