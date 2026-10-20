/**
 * LAYOVER 165, lane B2-LIVE — the live-signal codes REACH A TRAVELLER.
 *
 * The server's live-signal producer (artifacts/api-server/src/services/airport/
 * layoverLiveSignals.ts) now puts SECURITY_WAIT_HIGH, DATA_STALE,
 * SOURCE_CONFLICT and TRAFFIC_DEGRADED on `advice.reasonCodes` and a LIVE
 * `airportIntelligence` on GET /overview — the payload the dashboard hands this
 * card (app/layover/[id].tsx). The real-schema suite
 * (src/test/db/layoverLiveSignals.db.test.ts, E1–E6) proves the server emits
 * them on the real routes; this pins that the card a traveller looks at draws
 * them as WORDS, and says live conditions are folded in, rather than the
 * "not measured" line every session showed before the producer existed.
 *
 * Run: npx jest --testPathPatterns='CanILeaveCard.liveSignals'
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react-native';
import { CanILeaveCard } from '../CanILeaveCard.tsx';
import type { LayoverAirportIntelligence, LayoverWindow, LeaveAdvice, PublicAirport } from '../../../services/layover.ts';

const AIRPORT = {
  id: 'airport-sin', iataCode: 'SIN', name: 'Singapore Changi Airport', city: 'Singapore', country: 'Singapore',
  countryCode: 'SG', timezone: 'Asia/Singapore', lat: 1.3644, lng: 103.9915, verified: false,
} as unknown as PublicAirport;

const WINDOW = {
  totalMinutes: 600, exitDelayMin: 45, usableMinutes: 285,
  earliestOutTime: '2026-10-18T10:00:00.000Z', hardReturnTime: '2026-10-18T15:15:00.000Z',
  returnState: 'NORMAL', tier: 'half_day', tierLabel: 'Half day',
  breakdown: { baseBuffer: 120, immigrationExtra: 30, bagsExtra: 0, trafficExtra: 20, timeOfDayExtra: 0, liveExtra: 40, totalBuffer: 210 },
  freedomWindow: null, shortfallMinutes: null,
} as unknown as LayoverWindow;

/** The shape GET /overview served in the real-schema run (E1/E5), live codes included. */
function advice(reasonCodes: string[]): LeaveAdvice {
  return {
    verdict: 'entry_unverified',
    reasons: ['About 4h 45m of usable time after exit and return buffers.'],
    unknowns: ['Visa or transit-permit requirements for your nationality'],
    reasonCodes,
    disclaimer: 'Guidance only — check with your airline.',
  } as unknown as LeaveAdvice;
}

const LIVE_INTEL: LayoverAirportIntelligence = {
  tier: 'LIVE', airportAddressable: true, airportVerified: false, liveObserved: true,
  bufferSourceClass: 'AIRPORT_PROFILE', bufferFallbackLevel: 2, confidence: 'LOW',
  sourceRefs: ['airport_profiles.international_buffer_min'],
};

afterEach(cleanup);

describe('the live-signal codes are drawn as sentences, and the card says live conditions are in the minutes', () => {
  test('SECURITY_WAIT_HIGH, SOURCE_CONFLICT, DATA_STALE and TRAFFIC_DEGRADED each reach the screen as words', async () => {
    await render(
      <CanILeaveCard
        advice={advice(['ENTRY_NOT_CONFIRMED', 'SECURITY_WAIT_HIGH', 'SOURCE_CONFLICT', 'DATA_STALE', 'TRAFFIC_DEGRADED', 'AIRPORT_MATURITY_LIMITED'])}
        window={WINDOW}
        airport={AIRPORT}
        airportIntelligence={LIVE_INTEL}
      />,
    );
    for (const code of ['SECURITY_WAIT_HIGH', 'SOURCE_CONFLICT', 'DATA_STALE', 'TRAFFIC_DEGRADED']) {
      expect(screen.getByTestId(`layover-reason-code-${code}`)).toBeTruthy();
      expect(screen.queryByText(code)).toBeNull(); // the WORDS, never the enum token
    }
    expect(screen.getByText(/Security queue running long/)).toBeTruthy();
    expect(screen.getByText(/Sources disagree/)).toBeTruthy();
    expect(screen.getByText(/past its freshness/)).toBeTruthy();
    expect(screen.getByText(/Ground transport is degraded/)).toBeTruthy();
    expect(screen.getByTestId('layover-airport-intelligence-live')).toBeTruthy();
    expect(screen.getByText(/A current airport observation is folded into these minutes/)).toBeTruthy();
    expect(screen.queryByText(/queues and traffic today are not measured/)).toBeNull();
  });

  test('the paired negative: with no live term the card says so, and draws none of the live codes', async () => {
    await render(
      <CanILeaveCard
        advice={advice(['ENTRY_NOT_CONFIRMED'])}
        window={WINDOW}
        airport={AIRPORT}
        airportIntelligence={{ ...LIVE_INTEL, tier: 'AIRPORT_RECORD', liveObserved: false }}
      />,
    );
    expect(screen.queryByTestId('layover-reason-code-SECURITY_WAIT_HIGH')).toBeNull();
    expect(screen.getByText(/queues and traffic today are not measured/)).toBeTruthy();
  });
});
