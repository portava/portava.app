/**
 * census-layover L154 — "**Crew** — cache meeting point", on the screen a
 * traveller sees when the network has gone (census-layover §48).
 *
 * `LayoverOfflinePlanCard` renders the last certified plan from the device
 * cache. Its header said "no crew meeting point (the bundle still answers
 * `no_crew_storage`)", and that was the whole of the offline crew story: the
 * only place the meeting point was shown was `LayoverSafeReturnCard`, which
 * reads the LIVE overview — i.e. exactly when it is least needed.
 *
 * The card now says the cached point, or why there is none, in the same words
 * `describeCrewMeetingPoint` uses online. An older cached record with no crew
 * field says nothing is saved — it does not invent a point or a reason.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverOfflinePlanCard } from '../LayoverOfflinePlanCard.tsx';
import type { CachedLayoverPlan } from '../../../lib/layoverPlanCache.ts';

const NOW = Date.parse('2026-09-22T09:05:00.000Z');

function plan(over: Partial<CachedLayoverPlan> = {}): CachedLayoverPlan {
  return {
    sessionId: 'sess-1',
    bundleVersion: '2026.09.08-1',
    certifiedAt: '2026-09-22T09:00:00.000Z',
    staleAfter: '2026-09-22T09:15:00.000Z',
    airport: { iataCode: 'TPE', name: 'Taoyuan', city: 'Taoyuan', timezone: 'Asia/Taipei', lat: 25.08, lng: 121.23 },
    stops: [],
    envelope: null,
    schedule: null,
    crewMeetingPoint: null,
    cachedAt: '2026-09-22T09:00:01.000Z',
    ...over,
  };
}

describe('LayoverOfflinePlanCard — the crew meeting point, offline', () => {
  it('1. a cached point is shown verbatim', async () => {
    await render(<LayoverOfflinePlanCard nowMs={NOW} plan={plan({
      crewMeetingPoint: { available: true, value: 'Terminal 2 food court', reason: null },
    })} />);
    expect(screen.getByTestId('layover-cached-plan-crew-point').props.children)
      .toBe('Meet your crew at Terminal 2 food court.');
  });

  it('2. a crew that could not be read is said as that, not as "no crew"', async () => {
    await render(<LayoverOfflinePlanCard nowMs={NOW} plan={plan({
      crewMeetingPoint: { available: false, value: null, reason: 'crew_unreadable' },
    })} />);
    const text = screen.getByTestId('layover-cached-plan-crew-point').props.children as string;
    expect(text).toMatch(/could not be read/i);
    expect(text).not.toMatch(/not in a crew/i);
  });

  it('3. not in a crew is said as that', async () => {
    await render(<LayoverOfflinePlanCard nowMs={NOW} plan={plan({
      crewMeetingPoint: { available: false, value: null, reason: 'not_in_crew' },
    })} />);
    expect(screen.getByTestId('layover-cached-plan-crew-point').props.children).toMatch(/not in a crew/i);
  });

  it('4. an older record with no crew field claims nothing about the crew', async () => {
    await render(<LayoverOfflinePlanCard nowMs={NOW} plan={plan({ crewMeetingPoint: null })} />);
    expect(screen.getByTestId('layover-cached-plan-crew-point').props.children)
      .toBe('No crew meeting point is saved on this device.');
  });
});
