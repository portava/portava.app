/**
 * EmergencyHelpSheet — the number it dials, and the options it offers.
 *
 * ## The defects
 *
 * 1. "Call local emergency number" dialled `tel:112` in every country. 112 is
 *    not the number in Japan (110 police / 119 ambulance and fire), the US
 *    (911), the UK (999) or China (110 / 120 / 119), and the app already
 *    holds per-country numbers (`/api/countries/:code/essentials`,
 *    `/api/trips/:tripId/essentials`).
 * 2. "Message Trusted Circle", "Contact trip host" and "Contact trip crew"
 *    rendered and did NOTHING when no callback was passed — which was every
 *    mount (ActiveSafeReturnCard twice, MissedCheckinPrompt once).
 * 3. "Share your location" and "Open Maps / Rideshare — Find a safe route
 *    home" both opened the bare maps.google.com: no location was shared, no
 *    route and no rideshare existed.
 *
 * ## The contract pinned here
 *
 * - The numbers come from the country essentials: an explicit `countryCode`
 *   (a layover's airport country) wins; otherwise the trip's destination
 *   countries. Every number is labelled with what it reaches, and the
 *   confirm-on-arrival disclaimer is shown beside them.
 * - Unknown (feature off, country not covered, no trip, read failed): NO dial
 *   button. A wrong emergency number is worse than none, so the sheet says it
 *   does not know and what to do instead.
 * - An option renders only when it has a handler that does what it says.
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports so the
// sheet's Modal renders synchronously in the test renderer.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    (visible ? R.createElement(actual.View, null, children) : null);
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import { Linking } from 'react-native';
import { render, act, waitFor, fireEvent, cleanup, screen } from '@testing-library/react-native';
import { EmergencyHelpSheet } from '../safeReturn/EmergencyHelpSheet.tsx';
import { getCountryEssentials, getTripEssentials, type CountryEssentials } from '../../services/countryEssentials.ts';

jest.mock('../../services/countryEssentials', () => ({
  ...jest.requireActual('../../services/countryEssentials'),
  getCountryEssentials: jest.fn(),
  getTripEssentials: jest.fn(),
}));

const mockCountry = getCountryEssentials as jest.Mock;
const mockTrip = getTripEssentials as jest.Mock;
const DISCLAIMER = 'Confirm emergency numbers locally on arrival — they vary by region and can change.';

function essentials(code: string, emergency: CountryEssentials['emergency']): CountryEssentials {
  return {
    code, plugTypes: [], voltage: null, frequency: null, driveSide: null, emergency,
    confidence: 'curated', source: 'test', lastVerifiedAt: '2026-07-24', disclaimer: DISCLAIMER,
  };
}

let openSpy: jest.SpyInstance;
beforeEach(() => {
  openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});
afterEach(() => {
  openSpy.mockRestore();
  cleanup();
  jest.clearAllMocks();
});

async function open(props: Partial<React.ComponentProps<typeof EmergencyHelpSheet>> = {}) {
  await act(async () => {
    render(<EmergencyHelpSheet visible onClose={() => {}} {...props} />);
  });
}
async function press(text: string | RegExp) {
  await act(async () => { await fireEvent.press(screen.getByText(text)); });
}
const dialled = () => openSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('tel:'));

describe('EmergencyHelpSheet — the number comes from the country, never a constant', () => {
  it('a trip in Japan offers 110 (police) and 119 (ambulance, fire), never 112', async () => {
    mockTrip.mockResolvedValue([{ country: 'JP', essentials: essentials('JP', { police: '110', fire: '119', ambulance: '119' }) }]);
    await open({ tripId: 'trip-jp' });
    await waitFor(() => expect(screen.getByText(/Call 110/)).toBeTruthy());
    expect(mockTrip).toHaveBeenCalledWith('trip-jp');
    expect(screen.getByText('Call 110 — police')).toBeTruthy();
    expect(screen.getByText('Call 119 — ambulance, fire')).toBeTruthy();
    expect(screen.getByText(DISCLAIMER)).toBeTruthy();
    await press('Call 119 — ambulance, fire');
    expect(dialled()).toEqual(['tel:119']);
    expect(screen.queryByText(/112/)).toBeNull();
  });

  it('a trip in the US offers 911', async () => {
    mockTrip.mockResolvedValue([{ country: 'US', essentials: essentials('US', { all: '911' }) }]);
    await open({ tripId: 'trip-us' });
    await waitFor(() => expect(screen.getByText('Call 911 — emergency')).toBeTruthy());
    await press('Call 911 — emergency');
    expect(dialled()).toEqual(['tel:911']);
  });

  it("an explicit country (a layover's airport) wins over the trip", async () => {
    mockCountry.mockResolvedValue(essentials('GB', { all: '999', police: '999', ambulance: '999', fire: '999' }));
    await open({ countryCode: 'GB', tripId: 'trip-jp' });
    await waitFor(() => expect(screen.getByText('Call 999 — emergency, police, ambulance, fire')).toBeTruthy());
    expect(mockCountry).toHaveBeenCalledWith('GB');
    expect(mockTrip).not.toHaveBeenCalled();
  });

  it('a trip through two countries names each country beside its numbers', async () => {
    mockTrip.mockResolvedValue([
      { country: 'JP', essentials: essentials('JP', { police: '110', ambulance: '119', fire: '119' }) },
      { country: 'US', essentials: essentials('US', { all: '911' }) },
    ]);
    await open({ tripId: 'trip-2' });
    await waitFor(() => expect(screen.getByText('JP')).toBeTruthy());
    expect(screen.getByText('US')).toBeTruthy();
    expect(screen.getByText('Call 110 — police')).toBeTruthy();
    expect(screen.getByText('Call 911 — emergency')).toBeTruthy();
  });

  for (const [label, setup] of [
    ['the feature is off or the read failed (null)', () => mockTrip.mockResolvedValue(null)],
    ['the country is not covered', () => mockTrip.mockResolvedValue([{ country: 'ZZ', essentials: null }])],
    ['the trip has no destination country', () => mockTrip.mockResolvedValue([])],
  ] as const) {
    it(`unknown — ${label}: no dial button, and the sheet says it does not know`, async () => {
      setup();
      await open({ tripId: 'trip-x' });
      await waitFor(() => expect(screen.getByTestId('emergency-number-unknown')).toBeTruthy());
      expect(screen.queryByText(/^Call /)).toBeNull();
      expect(screen.queryByText('Call local emergency number')).toBeNull();
      expect(dialled()).toEqual([]);
    });
  }

  it('no trip and no country: nothing is looked up and nothing is dialled', async () => {
    await open({});
    await waitFor(() => expect(screen.getByTestId('emergency-number-unknown')).toBeTruthy());
    expect(mockTrip).not.toHaveBeenCalled();
    expect(mockCountry).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Call /)).toBeNull();
  });

  it('while the number is being looked up, nothing is offered to dial', async () => {
    let resolve: (v: unknown) => void = () => {};
    mockTrip.mockReturnValue(new Promise((r) => { resolve = r; }));
    await open({ tripId: 'trip-jp' });
    expect(screen.getByTestId('emergency-number-loading')).toBeTruthy();
    expect(screen.queryByText(/^Call /)).toBeNull();
    await act(async () => { resolve([{ country: 'JP', essentials: essentials('JP', { police: '110' }) }]); });
    await waitFor(() => expect(screen.getByText('Call 110 — police')).toBeTruthy());
    expect(screen.queryByTestId('emergency-number-loading')).toBeNull();
  });

  it('a malformed number from the data is never dialled', async () => {
    mockTrip.mockResolvedValue([{ country: 'XX', essentials: essentials('XX', { all: '11 2; rm' }) }]);
    await open({ tripId: 'trip-bad' });
    await waitFor(() => expect(screen.getByTestId('emergency-number-unknown')).toBeTruthy());
    expect(screen.queryByText(/^Call /)).toBeNull();
  });
});

describe('EmergencyHelpSheet — an option renders only when it does what it says', () => {
  beforeEach(() => mockTrip.mockResolvedValue([{ country: 'US', essentials: essentials('US', { all: '911' }) }]));

  it('with no handlers: no Trusted Circle, host, crew or share-location option', async () => {
    await open({ tripId: 'trip-us' });
    await waitFor(() => expect(screen.getByText('Call 911 — emergency')).toBeTruthy());
    for (const t of ['Message Trusted Circle', 'Contact trip host', 'Contact trip crew', 'Share your location']) {
      expect(screen.queryByText(t)).toBeNull();
    }
    expect(screen.queryByText(/Rideshare/)).toBeNull();
    expect(screen.queryByText(/safe route home/)).toBeNull();
  });

  it('with handlers: each option renders and calls its own handler', async () => {
    const onMessageTrustedCircle = jest.fn(), onShareLocation = jest.fn(), onContactHost = jest.fn(), onContactTripCrew = jest.fn();
    await open({ tripId: 'trip-us', onMessageTrustedCircle, onShareLocation, onContactHost, onContactTripCrew });
    await waitFor(() => expect(screen.getByText('Call 911 — emergency')).toBeTruthy());
    await press('Message Trusted Circle');
    await press('Share your location');
    await press('Contact trip host');
    await press('Contact trip crew');
    expect(onMessageTrustedCircle).toHaveBeenCalledTimes(1);
    expect(onShareLocation).toHaveBeenCalledTimes(1);
    expect(onContactHost).toHaveBeenCalledTimes(1);
    expect(onContactTripCrew).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('"Open Maps" opens maps and claims nothing more', async () => {
    await open({ tripId: 'trip-us' });
    await waitFor(() => expect(screen.getByText('Open Maps')).toBeTruthy());
    await press('Open Maps');
    expect(openSpy.mock.calls.map((c) => String(c[0]))).toEqual(['https://maps.google.com']);
  });
});
