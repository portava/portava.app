/**
 * Telegraph §1.3 Act / §8.1 — census-telegraph T6: "messages/shared objects
 * become … navigation". A LOCATION message hands its place to the device's maps
 * app at the precision the SENDER chose, and posts nothing.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentional stub — kindsApi reaches lib/supabase, which builds a client
// at import time. The renderer and the envelope parser are the real ones.
jest.mock('../kinds/kindsApi.ts', () => {
  const actual = jest.requireActual('../kinds/kindsApi.ts');
  return { ...actual, sendTypedMessage: jest.fn(), fetchDrawer: jest.fn(), searchThread: jest.fn() };
});
// NOTE: intentional stub — AccessibilityInfo is not backed by the jest preset.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({ useReducedMotionSetting: jest.fn(() => false) }));
// NOTE: intentional stub — the handoff opens the OS maps app through Linking;
// the test asserts WHAT is handed off.
jest.mock('../../../lib/maps.ts', () => ({ openMapsNavigation: jest.fn() }));

import { TypedMessageRenderer, locationDestination } from '../kinds/TypedMessageRenderer.tsx';
import { sendTypedMessage } from '../kinds/kindsApi.ts';
import { openMapsNavigation } from '../../../lib/maps.ts';

const mockedMaps = openMapsNavigation as jest.MockedFunction<typeof openMapsNavigation>;
const env = (payload: unknown) => JSON.stringify({ kind: 'LOCATION', envelopeVersion: '1', payload });

beforeEach(() => jest.clearAllMocks());

describe('a LOCATION message becomes navigation', () => {
  it('an AREA share hands the label (and area) as a place search — no coordinate is invented', async () => {
    await render(<TypedMessageRenderer msgType="location" body={env({ label: 'An Thuong 2', approximateLabel: 'Da Nang', precision: 'area' })} mine={false} />);
    await fireEvent.press(screen.getByTestId('telegraph-kind-location-directions'));
    expect(mockedMaps).toHaveBeenCalledWith({ name: 'An Thuong 2', city: 'Da Nang' });
    expect(sendTypedMessage).not.toHaveBeenCalled();
  });

  it('an EXACT share hands the coordinates the sender chose to share', async () => {
    await render(<TypedMessageRenderer msgType="location" body={env({ label: 'Pier 2', precision: 'exact', lat: 16.06, lng: 108.24 })} mine />);
    await fireEvent.press(screen.getByTestId('telegraph-kind-location-directions'));
    expect(mockedMaps).toHaveBeenCalledWith({ name: 'Pier 2', lat: 16.06, lng: 108.24 });
  });

  it('coordinates on a NON-exact share are not used — the sender did not choose to share them', () => {
    expect(locationDestination({ label: 'Pier 2', precision: 'area', lat: 16.06, lng: 108.24 })).toEqual({ name: 'Pier 2', city: null });
  });

  it('T6 gap (verifier): an EXACT share that has ENDED hands on its label, not its coordinates', () => {
    const now = Date.parse('2026-10-05T20:00:00.000Z');
    expect(locationDestination({ label: 'Pier 2', precision: 'exact', lat: 16.06, lng: 108.24, expiresAt: '2026-10-05T19:00:00.000Z' }, now))
      .toEqual({ name: 'Pier 2', city: null });
    expect(locationDestination({ label: 'Pier 2', precision: 'exact', lat: 16.06, lng: 108.24, expiresAt: '2026-10-05T21:00:00.000Z' }, now))
      .toEqual({ name: 'Pier 2', lat: 16.06, lng: 108.24 });
  });

  it('F9: only EXACT is exact — a VENUE share with coordinates hands on its label', () => {
    expect(locationDestination({ label: 'Cafe', precision: 'venue', lat: 1, lng: 2 })).toEqual({ name: 'Cafe', city: null });
  });

  it('no usable label, no Directions', async () => {
    expect(locationDestination({ label: '  ' })).toBeNull();
    expect(locationDestination(null)).toBeNull();
    await render(<TypedMessageRenderer msgType="location" body={env({ label: 'x', precision: 'area' })} mine={false} />);
    expect(screen.getByTestId('telegraph-kind-location-directions')).toBeTruthy();
  });
});
