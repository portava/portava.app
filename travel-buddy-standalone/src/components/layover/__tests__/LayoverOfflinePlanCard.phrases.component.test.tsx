/**
 * census-layover L155 — "Translation — cache context phrases required by the
 * active plan", on the screen a traveller sees when the network has gone
 * (census-layover §55).
 *
 * The server's offline bundle carries the return phrases in the airport
 * country's language (services/airport/layoverPhrases.ts); `layoverPlanCache`
 * keeps them; this card shows the local sentence with the English under it, or
 * one sentence saying why there are none. An older record with no field claims
 * nothing.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverOfflinePlanCard } from '../LayoverOfflinePlanCard.tsx';
import type { CachedLayoverPlan } from '../../../lib/layoverPlanCache.ts';

const NOW = Date.parse('2026-09-22T09:05:00.000Z');

const SET = {
  language: 'ja',
  languageName: 'Japanese',
  phrases: [
    { key: 'take_me_to_airport', english: 'Please take me to Narita International Airport (NRT).', local: 'Narita International Airport（NRT）までお願いします。' },
    { key: 'please_help', english: 'Please help me.', local: '助けてください。' },
  ],
};

function plan(over: Partial<CachedLayoverPlan> = {}): CachedLayoverPlan {
  return {
    sessionId: 'sess-1',
    bundleVersion: '2026.09.08-1',
    certifiedAt: '2026-09-22T09:00:00.000Z',
    staleAfter: '2026-09-22T09:15:00.000Z',
    airport: { iataCode: 'NRT', name: 'Narita International Airport', city: 'Narita', timezone: 'Asia/Tokyo', lat: 35.77, lng: 140.39 },
    stops: [],
    envelope: null,
    schedule: null,
    crewMeetingPoint: null,
    translationPhrases: null,
    cachedAt: '2026-09-22T09:00:01.000Z',
    ...over,
  };
}

const textOf = (id: string) => {
  const kids = screen.getByTestId(id).props.children;
  return Array.isArray(kids) ? kids.join('') : String(kids);
};

describe('LayoverOfflinePlanCard — the return phrases, offline (L155)', () => {
  it('1. cached phrases show the local sentence with the English under it', async () => {
    await render(<LayoverOfflinePlanCard nowMs={NOW} plan={plan({ translationPhrases: { available: true, value: SET, reason: null } })} />);
    expect(screen.getByTestId('layover-cached-plan-phrases')).toBeTruthy();
    expect(screen.getByText('Phrases in Japanese')).toBeTruthy();
    expect(screen.getByText('Narita International Airport（NRT）までお願いします。')).toBeTruthy();
    expect(screen.getByText('Please take me to Narita International Airport (NRT).')).toBeTruthy();
    expect(screen.getByTestId('layover-cached-plan-phrase-please_help')).toBeTruthy();
    expect(screen.queryByTestId('layover-cached-plan-phrases-none')).toBeNull();
  });

  it('2. a language outside the catalogue is said as that, not as an empty list', async () => {
    await render(<LayoverOfflinePlanCard nowMs={NOW} plan={plan({ translationPhrases: { available: false, value: null, reason: 'language_not_in_catalogue' } })} />);
    expect(screen.queryByTestId('layover-cached-plan-phrases')).toBeNull();
    expect(textOf('layover-cached-plan-phrases-none')).toMatch(/no phrases in the language spoken here/i);
  });

  it('3. an airside plan says none were needed', async () => {
    await render(<LayoverOfflinePlanCard nowMs={NOW} plan={plan({ translationPhrases: { available: false, value: null, reason: 'plan_stays_airside' } })} />);
    expect(textOf('layover-cached-plan-phrases-none')).toMatch(/stays inside the airport/i);
  });

  it('4. an older record with no phrases field claims nothing', async () => {
    await render(<LayoverOfflinePlanCard nowMs={NOW} plan={plan({ translationPhrases: null })} />);
    expect(textOf('layover-cached-plan-phrases-none')).toBe('No phrases are saved on this device for this layover.');
  });
});
