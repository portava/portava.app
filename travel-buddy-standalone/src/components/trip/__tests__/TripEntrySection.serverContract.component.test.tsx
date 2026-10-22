/**
 * Entry requirements are shown as the server says them, and fetched once.
 *
 * THE DEFECTS.
 *   1. GET /trips/:tripId/entry-requirements answers the corridor `status` from
 *      the server's own enum (artifacts/api-server/src/routes/entryRequirements.ts:
 *      visa_free, visa_on_arrival, evisa, visa_required, special_authorization,
 *      entry_restricted). Both chips — TripEntrySection and the passport's
 *      PassportTravelInfoSection — matched `additional_approval` / `restricted`
 *      instead, so a traveller who needs special authorisation, or who is BARRED
 *      from entry, saw a grey UNKNOWN.
 *   2. `requirement` is the raw `entry_requirements` row (snake_case). The card
 *      read `allowedStayDays` / `sourceUrl`, which the server never sends, so the
 *      allowed stay and the official-source link never appeared.
 *   3. `load` listed the `onLoad` prop in its deps and BeforeYouGoSection passes
 *      `onLoad` inline, so every re-render of the trip screen re-fetched the
 *      entry requirements.
 *
 * RED on the tree before this change: 2 failed / 0 passed.
 *
 * Two renders only (RNTL v14 + React 19 render-count limit).
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// NOTE: intentional stub — Modal's native animation lifecycle corrupts
// actScopeDepth under jest-expo; the Proxy replaces only 'Modal', every other
// react-native export falls through untouched.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react') as typeof import('react');
        return ({ children, visible }: { children: React.ReactNode; visible?: boolean }) =>
          visible ? R.createElement(target.View as React.ComponentType, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: intentional stub — entryRequirements reaches the network (Supabase +
// custom API). Mocking the whole module keeps the tests offline.
jest.mock('../../../services/entryRequirements', () => ({
  fetchTripEntryRequirements: jest.fn(),
  listMyPassports:            jest.fn(async () => []),
  setTripPassport:            jest.fn(),
  addPassport:                jest.fn(),
  updatePassport:             jest.fn(),
  deletePassport:             jest.fn(),
}));

// NOTE: intentional stub — countryEssentials reaches the network; the passport
// section reads only getTripEssentials.
jest.mock('../../../services/countryEssentials', () => ({
  getTripEssentials: jest.fn(async () => null),
}));

import { fetchTripEntryRequirements } from '../../../services/entryRequirements.ts';
import { TripEntrySection } from '../TripEntrySection.tsx';
import { PassportTravelInfoSection } from '../../passport/PassportTravelInfoSection.tsx';
import type { TripRow } from '../../../services/trips.ts';

const mockFetchEntry = fetchTripEntryRequirements as jest.Mock;

/** The route's response shape, with the server's own enum values. */
const PAYLOAD = {
  destinationCountry: 'CN',
  disclaimer: 'Always confirm with the official source.',
  travelers: [
    {
      userId: 'me', self: true, passportSelected: true, passportCountry: 'US',
      status: 'special_authorization',
      requirement: {
        id: 'c1', passport_country: 'US', destination_country: 'CN', status: 'special_authorization',
        allowed_stay_days: 30, official_source_url: 'https://gov.example/visa',
        fee_text: null, processing_time_text: null, passport_validity_rule: null, notes: null,
        confidence: 'high', last_verified_at: '2030-01-02T00:00:00.000Z',
      },
      unknownReason: null, lastVerifiedAt: '2030-01-02T00:00:00.000Z',
    },
    { userId: 'friend', self: false, passportSelected: true, status: 'entry_restricted' },
  ],
};

afterEach(async () => { await act(async () => {}); jest.clearAllMocks(); });

describe('TripEntrySection — the server contract', () => {
  it('names special_authorization / entry_restricted, shows the stay and the source, and a re-render does not refetch', async () => {
    mockFetchEntry.mockResolvedValue(PAYLOAD);
    const view = await render(<TripEntrySection tripId="t1" onLoad={() => {}} />);
    await waitFor(() => expect(screen.getByText('ADDITIONAL APPROVAL')).toBeTruthy());
    expect(screen.getByText('RESTRICTED')).toBeTruthy();
    expect(screen.queryByText('UNKNOWN')).toBeNull();
    expect(screen.getByText('30 days')).toBeTruthy();
    expect(screen.getByText('Official source')).toBeTruthy();
    expect(mockFetchEntry).toHaveBeenCalledTimes(1);

    // The trip screen re-renders; BeforeYouGoSection hands a NEW inline onLoad each time.
    await view.rerender(<TripEntrySection tripId="t1" onLoad={() => {}} />);
    await view.rerender(<TripEntrySection tripId="t1" onLoad={() => {}} />);
    await act(async () => {});
    expect(mockFetchEntry).toHaveBeenCalledTimes(1);
  });
});

describe('PassportTravelInfoSection — the same enum', () => {
  it('a traveller barred from entry sees RESTRICTED, not UNKNOWN', async () => {
    mockFetchEntry.mockResolvedValue({ ...PAYLOAD, travelers: [{ ...PAYLOAD.travelers[0], status: 'entry_restricted' }] });
    const trip = { id: 't1', title: 'Spring in Shanghai', destinationCity: 'Shanghai', status: 'planning', startDate: null } as unknown as TripRow;
    await render(<PassportTravelInfoSection trips={[trip]} />);
    await waitFor(() => expect(screen.getByText('Spring in Shanghai')).toBeTruthy());
    expect(screen.getByText('RESTRICTED')).toBeTruthy();
    expect(screen.queryByText('UNKNOWN')).toBeNull();
  });
});
