/**
 * census-layover L43 — §5 RETURNING → AIRPORT_REENTERED, "refresh gate/security"
 * (App B.1 step 9: "gate context replaces exploration"), the CLIENT half.
 *
 * The overview publishes `reentry` after a re-entry check-in
 * (LayoverDepartureFlight.reentryContextFor). This card draws it: the onward
 * flight's gate as Trips last recorded it, who recorded it and when, a stale line
 * once the server's `staleAfter` has passed, and the certified answer's security
 * term. Every "we don't know" is said; nothing is computed here.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverReentryCard } from '../LayoverReentryCard.tsx';
import type { LayoverReentryContext } from '../../../services/layover.ts';

const OBSERVED = '2026-10-20T10:00:00.000Z';
const flight = {
  segmentId: 'seg-dep', designator: 'BR61', departureAirport: 'TPE',
  scheduledDepartureAt: '2026-10-20T12:00:00.000Z', estimatedDepartureAt: '2026-10-20T12:35:00.000Z',
  terminal: 'T2', gate: 'D7', status: 'delayed', source: 'traveller', observedAt: OBSERVED, staleAfter: '2026-10-20T10:15:00.000Z',
};
const reentered = (over: Partial<Extract<LayoverReentryContext, { state: 'reentered' }>> = {}): LayoverReentryContext => ({
  state: 'reentered', reportedAt: '2026-10-20T10:05:00.000Z', refreshedAt: '2026-10-20T10:06:00.000Z',
  flight: { state: 'observed', flight }, security: { state: 'no_live_reading' }, ...over,
});
const at = (iso: string) => Date.parse(iso);
const text = (id: string) => String(screen.getByTestId(id).props.children);

describe('L43 — back at the airport: the gate context', () => {
  it('nothing published (not back, or the store is off): no card', async () => {
    await render(<LayoverReentryCard reentry={undefined} timezone="UTC" nowMs={at('2026-10-20T10:06:00.000Z')} />);
    expect(screen.queryByTestId('layover-reentry-card')).toBeNull();
    expect(screen.queryByTestId('layover-reentry-unknown')).toBeNull();
  });

  it('re-entered with a recorded flight: gate, terminal, status and who recorded it — fresh, no stale line', async () => {
    await render(<LayoverReentryCard reentry={reentered()} timezone="UTC" nowMs={at('2026-10-20T10:06:00.000Z')} />);
    expect(text('layover-reentry-flight-0')).toBe('BR61: gate D7, terminal T2.');
    expect(text('layover-reentry-flight-1')).toMatch(/^Status: delayed — departs (12:35|12:35\s?PM)\.$/);
    expect(text('layover-reentry-flight-2')).toMatch(/^Recorded by you at/);
    expect(screen.queryByTestId('layover-reentry-flight-stale')).toBeNull();
    expect(text('layover-reentry-security')).toBe("Security: no live reading. Your return time already allows the airport's usual security time.");
  });

  it('a recorded gate past the server\'s bound says how old it is', async () => {
    await render(<LayoverReentryCard reentry={reentered()} timezone="UTC" nowMs={at('2026-10-20T10:45:00.000Z')} />);
    expect(text('layover-reentry-flight-stale')).toBe('Recorded 45 min ago — gates and times change; check the departure board.');
  });

  it('no observation, no link, an unreadable flight, or the feature off: each said, none invents a gate', async () => {
    const cases: Array<[LayoverReentryContext, RegExp]> = [
      [reentered({ flight: { state: 'not_observed', segmentId: 'seg-dep' } }), /No gate or status has been recorded/],
      [reentered({ flight: { state: 'not_linked' } }), /not linked to a flight on your trip/],
      [reentered({ flight: { state: 'unreadable', reason: 'flight_unreadable' } }), /could not read your flight/],
      [reentered({ flight: { state: 'off' } }), /does not have your gate/],
    ];
    for (const [r, words] of cases) {
      await render(<LayoverReentryCard reentry={r} timezone="UTC" nowMs={at('2026-10-20T10:06:00.000Z')} />);
      expect(text('layover-reentry-flight-0')).toMatch(words);
      expect(text('layover-reentry-flight-0')).not.toMatch(/gate D7/);
    }
  });

  it('a live security reading: the extra minutes and when, said as already allowed for', async () => {
    await render(<LayoverReentryCard reentry={reentered({ security: { state: 'live', extraMinutes: 25, observedAt: '2026-10-20T10:00:00.000Z', expiresAt: null } })} timezone="UTC" nowMs={at('2026-10-20T10:06:00.000Z')} />);
    expect(text('layover-reentry-security')).toMatch(/^Security: about 25 min longer than usual \(as of/);
  });

  it('a live reading of zero says no longer than usual', async () => {
    await render(<LayoverReentryCard reentry={reentered({ security: { state: 'live', extraMinutes: 0, observedAt: null, expiresAt: null } })} timezone="UTC" nowMs={at('2026-10-20T10:06:00.000Z')} />);
    expect(text('layover-reentry-security')).toBe('Security: no longer than usual.');
  });

  it('check-ins unreadable: said, not read as "not back yet"', async () => {
    await render(<LayoverReentryCard reentry={{ state: 'unknown', reason: 'checkpoints_unreadable' }} timezone="UTC" nowMs={at('2026-10-20T10:06:00.000Z')} />);
    expect(screen.getByTestId('layover-reentry-unknown')).toBeTruthy();
    expect(screen.queryByTestId('layover-reentry-card')).toBeNull();
  });
});
