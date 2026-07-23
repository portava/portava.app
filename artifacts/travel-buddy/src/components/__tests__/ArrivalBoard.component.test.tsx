/**
 * ArrivalBoard — RNTL component tests
 *
 * Covers three scenarios:
 *  1. fetchArrivalBoard returns rows with arrival data → member name + time shown
 *  2. fetchArrivalBoard returns rows but no arrival data → service note shown
 *  3. fetchArrivalBoard returns null → component renders nothing
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

// ── Service mock ──────────────────────────────────────────────────────────────
// NOTE: exhaustive by design — ArrivalBoard only imports fetchArrivalBoard
// from tripIntel; no other exports are used by this component.
jest.mock('../../services/tripIntel.ts', () => ({
  fetchArrivalBoard: jest.fn(),
}));

import { ArrivalBoard } from '../tripCrew/ArrivalBoard.tsx';
import { fetchArrivalBoard } from '../../services/tripIntel.ts';

const mockFetch = fetchArrivalBoard as jest.Mock;

const TRIP_ID = 'trip-arrival-test';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// A future date so the label is "In N days" or "Today at Hpm" (not "Arrived")
const FUTURE_ISO = new Date(Date.now() + 2 * 86_400_000).toISOString();

const BOARD_WITH_ARRIVALS = {
  arrivals: [
    { userId: 'u-1', arrival: { time: FUTURE_ISO, label: 'Alice' } },
    { userId: 'u-2', arrival: { time: FUTURE_ISO, label: 'Bob' } },
  ],
  note: 'Arrival times shown are estimates.',
};

const BOARD_NO_ARRIVAL_DATA = {
  arrivals: [
    { userId: 'u-1', arrival: null },
    { userId: 'u-2', arrival: null },
  ],
  note: 'No arrival information has been shared yet.',
};

const BOARD_EMPTY = {
  arrivals: [],
  note: 'No arrival information available.',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ArrivalBoard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders member names and arrival times when board has arrival data', async () => {
    mockFetch.mockResolvedValue(BOARD_WITH_ARRIVALS);

    const { getByTestId, getByText } = await render(<ArrivalBoard tripId={TRIP_ID} />);

    await waitFor(() => {
      expect(getByTestId('arrival-board')).toBeTruthy();
    });

    expect(getByText('Alice')).toBeTruthy();
    expect(getByText('Bob')).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledWith(TRIP_ID);
  });

  it('shows the service note when rows have no arrival data', async () => {
    mockFetch.mockResolvedValue(BOARD_NO_ARRIVAL_DATA);

    const { getByTestId, getByText } = await render(<ArrivalBoard tripId={TRIP_ID} />);

    await waitFor(() => {
      expect(getByTestId('arrival-board-note')).toBeTruthy();
    });

    expect(getByText('No arrival information has been shared yet.')).toBeTruthy();
  });

  it('shows the service note when board is empty', async () => {
    mockFetch.mockResolvedValue(BOARD_EMPTY);

    const { getByTestId, getByText } = await render(<ArrivalBoard tripId={TRIP_ID} />);

    await waitFor(() => {
      expect(getByTestId('arrival-board-note')).toBeTruthy();
    });

    expect(getByText('No arrival information available.')).toBeTruthy();
  });

  it('renders nothing when fetchArrivalBoard returns null', async () => {
    mockFetch.mockResolvedValue(null);

    const { toJSON } = await render(<ArrivalBoard tripId={TRIP_ID} />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    // After the fetch resolves to null, the component returns null
    expect(toJSON()).toBeNull();
  });
});
