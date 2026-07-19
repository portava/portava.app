/**
 * EventCard — city-alias coord injection into the map push URL
 *
 * Confirms that when an event's `city` field contains a known alternate
 * spelling (e.g. "Cebu" instead of "Cebu City"), the "View on map" button
 * still produces a push URL with `lat` and `lng` coord params drawn from the
 * alias-resolved centroid — not the empty-string fallback that would open the
 * map over the ocean.
 *
 * ## Why this matters
 * Partner APIs frequently omit the "City" suffix (Cebu, Davao, Ho Chi Minh).
 * Before the alias table was added, getCityCentroid returned undefined for
 * these strings, `coordParams` was '' and the map opened at the user's GPS
 * position rather than the event city.  This test pins the alias path so a
 * future refactor cannot silently regress it.
 *
 * ## Mock strategy
 * fireRankOutcome, SaveButton, and ui.tsx are stubbed identically to the
 * sessionId test — see that file's header for rationale.
 * router.push is spied on (not replaced) so we can inspect the URL string.
 */

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

// NOTE: intentionally exhaustive — pulling requireActual would import freshToken
// and trigger EXPO_PUBLIC_API_BASE_URL resolution; this test only needs the spy.
jest.mock('../../hooks/useRankOutcome', () => ({
  fireRankOutcome: jest.fn(),
}));

// NOTE: intentionally exhaustive — SaveButton brings in collections service,
// savedPostsCache, and SessionContext with native module chains.  A minimal
// stub keeps this test focused on the city-alias coord-injection contract.
jest.mock('../SaveButton', () => {
  const React = require('react');
  return { SaveButton: jest.fn((_props: Record<string, unknown>) => null) };
});

// NOTE: intentionally exhaustive — ui.tsx imports expo-linear-gradient which
// requires native GL modules unavailable under the jest-expo runner.
jest.mock('../ui', () => ({
  Stamp:  () => null,
  Avatar: () => null,
}));

// ── Subject under test ───────────────────────────────────────────────────────

import { EventCard } from '../EventCard.tsx';
import type { CityEvent } from '../../types/models.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(city: string): CityEvent {
  return {
    id:            'ev-alias-test',
    kind:          'event',
    title:         'Test Event',
    city,
    citySlug:      city.toLowerCase().replace(/\s+/g, '-'),
    startAt:       '2026-08-01T18:00:00+08:00',
    block:         'evening',
    category:      'social',
    attendeeCount: null,
    capacity:      null,
    score:         null,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EventCard — city alias coord injection into map push URL', () => {
  let pushSpy: jest.SpyInstance;

  beforeEach(() => {
    pushSpy = jest.spyOn(router, 'push');
  });

  afterEach(() => {
    pushSpy.mockRestore();
  });

  test('"Cebu" (alias for Cebu City) produces lat/lng coords in the push URL', async () => {
    await render(<EventCard ev={makeEvent('Cebu')} />);

    fireEvent.press(screen.getByText('View on map'));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const url = String(pushSpy.mock.calls[0][0]);

    // Confirm the URL contains coord params — no fallback to empty string
    expect(url).toContain('lat=');
    expect(url).toContain('lng=');
    expect(url).toContain('zoom=12');

    // Cebu City centroid: [10.3157, 123.8854] — check the numbers are present
    expect(url).toContain('lat=10.3157');
    expect(url).toContain('lng=123.8854');
  });

  test('"Davao" (alias for Davao City) produces lat/lng coords in the push URL', async () => {
    await render(<EventCard ev={makeEvent('Davao')} />);

    fireEvent.press(screen.getByText('View on map'));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const url = String(pushSpy.mock.calls[0][0]);

    expect(url).toContain('lat=');
    expect(url).toContain('lng=');
    // Davao City centroid: [7.1907, 125.4553]
    expect(url).toContain('lat=7.1907');
    expect(url).toContain('lng=125.4553');
  });

  test('"HCMC" (alias for Ho Chi Minh City) produces lat/lng coords in the push URL', async () => {
    await render(<EventCard ev={makeEvent('HCMC')} />);

    fireEvent.press(screen.getByText('View on map'));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const url = String(pushSpy.mock.calls[0][0]);

    expect(url).toContain('lat=');
    expect(url).toContain('lng=');
    // Ho Chi Minh City centroid: [10.8231, 106.6297]
    expect(url).toContain('lat=10.8231');
    expect(url).toContain('lng=106.6297');
  });

  test('"Cebu City" (canonical name) still produces coords — alias table does not break direct lookups', async () => {
    await render(<EventCard ev={makeEvent('Cebu City')} />);

    fireEvent.press(screen.getByText('View on map'));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const url = String(pushSpy.mock.calls[0][0]);

    expect(url).toContain('lat=10.3157');
    expect(url).toContain('lng=123.8854');
  });

  test('a genuinely unknown city still omits coord params (no lat/lng in URL)', async () => {
    await render(<EventCard ev={makeEvent('Atlantis')} />);

    fireEvent.press(screen.getByText('View on map'));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const url = String(pushSpy.mock.calls[0][0]);

    // Unknown city → coordParams is '' → no lat/lng injected
    expect(url).not.toContain('lat=');
    expect(url).not.toContain('lng=');
  });
});
