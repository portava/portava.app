/**
 * TripReservationsSection — list display tests.
 *
 * Covers:
 *  - null return from listReservations → renders nothing
 *  - grouped list display (pending_confirm + confirmed)
 *  - deadline chip shown when cancellationDeadlineAt is within 48 h
 *  - deadline chip absent when cancellationDeadlineAt is null
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

// ── expo-router mock ──────────────────────────────────────────────────────────
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn() },
    useFocusEffect: jest.fn((cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, []);
    }),
  };
});

// ── tripIntel service mock ────────────────────────────────────────────────────
// NOTE: spreading requireActual so the mock never drifts behind new exports.
jest.mock('../../services/tripIntel.ts', () => ({
  ...jest.requireActual('../../services/tripIntel.ts'),
  listReservations:    jest.fn(),
  importReservations:  jest.fn(),
  confirmReservation:  jest.fn(),
  dismissReservation:  jest.fn(),
}));

// ── Modal proxy mock ──────────────────────────────────────────────────────────
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { TripReservationsSection } from '../trip/TripReservationsSection.tsx';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PENDING_RES = {
  id: 'res-pending-1',
  type: 'flight' as const,
  title: 'Flight AA123',
  startsAt: '2026-09-01T08:00:00Z',
  endsAt: '2026-09-01T11:00:00Z',
  locationName: 'JFK → LAX',
  confirmationRef: 'AA-XXXXXX',
  cancellationDeadlineAt: null,
  status: 'pending_confirm' as const,
  extractionConfidence: 0.95,
};

const CONFIRMED_RES = {
  id: 'res-confirmed-1',
  type: 'stay' as const,
  title: 'Hotel Grand',
  startsAt: '2026-09-01T15:00:00Z',
  endsAt: '2026-09-05T11:00:00Z',
  locationName: 'Los Angeles, CA',
  confirmationRef: 'HG-12345',
  cancellationDeadlineAt: null,
  status: 'confirmed' as const,
  extractionConfidence: 0.9,
};

const DEADLINE_RES = {
  ...PENDING_RES,
  id: 'res-deadline-1',
  title: 'Hotel with deadline',
  type: 'stay' as const,
  cancellationDeadlineAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
};

function getService() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require('../../services/tripIntel.ts');
  return svc.listReservations as jest.Mock;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripReservationsSection — list display', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('renders nothing when listReservations returns null', async () => {
    const listReservations = getService();
    listReservations.mockResolvedValue(null);

    const view = await render(<TripReservationsSection tripId="trip-abc" />);
    await waitFor(() => expect(listReservations).toHaveBeenCalledTimes(1));

    expect(view.queryByText('Reservations')).toBeNull();
    expect(view.queryByTestId('paste-confirmation-btn')).toBeNull();
  });

  it('shows pending and confirmed groups with reservation titles', async () => {
    const listReservations = getService();
    listReservations.mockResolvedValue([PENDING_RES, CONFIRMED_RES]);

    const view = await render(<TripReservationsSection tripId="trip-abc" />);

    await view.findByText('Reservations');
    await view.findByText('Awaiting confirmation');
    await view.findByText('Confirmed');
    await view.findByText('Flight AA123');
    await view.findByText('Hotel Grand');
  });

  it('shows a deadline chip when cancellationDeadlineAt is within 48 h', async () => {
    const listReservations = getService();
    listReservations.mockResolvedValue([DEADLINE_RES]);

    const view = await render(<TripReservationsSection tripId="trip-abc" />);

    const chip = await view.findByText(/Cancel by/);
    expect(chip).toBeTruthy();
  });

  it('does not show deadline chip when cancellationDeadlineAt is null', async () => {
    const listReservations = getService();
    listReservations.mockResolvedValue([PENDING_RES]);

    const view = await render(<TripReservationsSection tripId="trip-abc" />);
    await view.findByText('Flight AA123');

    expect(view.queryByText(/Cancel by/)).toBeNull();
  });
});
