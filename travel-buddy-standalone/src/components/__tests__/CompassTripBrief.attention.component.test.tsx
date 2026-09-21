/**
 * CompassTripBrief (src/components/TripPage.tsx) — Trips spec §17.2, the
 * priority switch as the brief reports it (census-trips TR319).
 *
 * The server's trip surface consults the trip's priority switch and, while
 * the trip needs attention, withholds commercial and entertainment items and
 * says so in `attention`. The brief shows that reading as it was read: a
 * one-line note when suppressed (even with nothing left to show), nothing
 * when not, and nothing invented when the switch was not consulted.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn() },
}));

// NOTE: intentional stub — the brief's one network call is replaced so the
// component is driven by the exact response shapes the server produces.
jest.mock('../../services/compass.ts', () => ({
  ...jest.requireActual('../../services/compass.ts'),
  fetchCompassTripBrief: jest.fn(),
  reportCompassViewed: jest.fn(),
}));

import { fetchCompassTripBrief } from '../../services/compass.ts';
import { CompassTripBrief } from '../TripPage.tsx';

const mockFetch = fetchCompassTripBrief as jest.MockedFunction<typeof fetchCompassTripBrief>;

const suppressed = (withheld: number) => ({
  consulted: true, tripId: 't1', mode: 'SAFETY_EVENT' as const, suppressed: true,
  reason: 'TRIP_DISRUPTION_SUPPRESSED' as const, withheld, detail: 'a safety event: … (§17.2)', info: null,
});
const calm = { consulted: true, tripId: 't1', mode: 'NORMAL' as const, suppressed: false, reason: null, withheld: 0, detail: null, info: null };
const notConsulted = { consulted: false, tripId: 't1', mode: null, suppressed: false, reason: null, withheld: 0, detail: null, info: 'the priority switch is not readable: trip_operational_projections_enabled is off' };
const item = { id: 'r1', type: 'hidden_gem', category: 'pharmacy', title: 'Colon Street pharmacy', reason: 'near you', city: 'Cebu', data: null } as any;

describe('CompassTripBrief — §17.2 the switch, shown as read', () => {
  beforeEach(() => mockFetch.mockReset());

  it('suppressed with items left: the note names how many were held back, and the items still render', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [item], surface: 'trip', attention: suppressed(2) } });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByTestId('compass-brief-attention');
    expect(screen.getByText(/held back while this trip needs your attention \(2 held back\)/)).toBeTruthy();
    expect(screen.getByText('Colon Street pharmacy')).toBeTruthy();
  });

  it('suppressed with NOTHING left: the card is not hidden — the note is the content', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [], surface: 'trip', attention: suppressed(3) } });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByTestId('compass-brief-attention');
    expect(screen.getByText('Compass Brief')).toBeTruthy();
  });

  it('not suppressed: no note; empty and not suppressed: the card hides as before', async () => {
    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [item], surface: 'trip', attention: calm } });
    const first = await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await screen.findByText('Colon Street pharmacy');
    expect(screen.queryByTestId('compass-brief-attention')).toBeNull();
    first.unmount();

    mockFetch.mockResolvedValue({ ok: true, data: { recommendations: [], surface: 'trip', attention: notConsulted } });
    await render(<CompassTripBrief tripId="t1" city="Cebu" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Compass Brief')).toBeNull());
    expect(screen.queryByTestId('compass-brief-attention')).toBeNull();
  });
});
