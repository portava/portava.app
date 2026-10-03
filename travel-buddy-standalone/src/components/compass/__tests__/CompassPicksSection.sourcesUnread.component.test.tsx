/**
 * census-discovery §104 (DV-83, D-W11X2-54) — For You's Compass picks when a
 * candidate read FAILED on the server.
 *
 * GET /compass/feed/section now answers such a section as its failure arm
 * (`fallback: true`, `compassEnabled: true`, `fallbackReason: "compass_sources_unread"`,
 * the rows that were read, and the refusal). Before, the §103.11 verifier's V7-S1
 * showed it answered a complete, empty section, which this section hid as "no picks".
 * Real CompassPicksSection + real useCompassFeed + real fetchCompassSection; fetch mocked.
 *
 *   U1  rows read beside a failed source → the rows AND the incomplete line (not the stale line)
 *   U2  no rows read → the failed line with its retry, never hidden
 *   U3  such an answer is never written to the device feed cache
 *   U4  picks on screen, then a refresh answers sources-unread → the kept picks stay, under the stale line
 *   Uc  CONTROL a healthy section → its rows, no line
 */
// NOTE: a stand-in on purpose — the probe needs a signed-in, configured client and nothing else from the module.
jest.mock('../../../lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — the probe needs a signed-in, configured client and nothing else from the module.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — only freshToken is read, and the probe fixes its value.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — only freshToken is read, and the probe fixes its value.
jest.mock('../../../services/apiToken', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — the section only navigates, and the probe never taps.
jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() } }));
// NOTE: a stand-in on purpose — the sheet is never opened by the probe.
jest.mock('../CompassWhySheet.tsx', () => ({ CompassWhySheet: () => null }));
// NOTE: a stand-in on purpose — the menu is never opened by the probe.
jest.mock('../CompassFeedbackMenu.tsx', () => ({ CompassFeedbackMenu: () => null }));
// NOTE: a stand-in on purpose — the probe fixes the signed-in viewer.
jest.mock('../../../context/SessionContext.tsx', () => ({ useSession: () => ({ isAuthed: true, userId: 'user-1' }) }));

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { CompassPicksSection } from '../CompassPicksSection.tsx';

const realFetch = global.fetch;
let body: unknown;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => {
  global.fetch = jest.fn(async (u: string) => {
    if (String(u).includes('/api/compass/feed/section/')) return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

const ITEM = (id: string, title: string) => ({ item: { id, type: 'place', category: 'food', title, data: { city: 'Paris' } }, finalScore: 80, explanationKey: 'k' });
const unread = (items: unknown[]) => ({
  sections: [{ name: 'compass_picks', total: items.length, items }], nextCursor: null, fallback: true, compassEnabled: true,
  fallbackReason: 'compass_sources_unread', safeItems: [],
  refusal: { class: 'transient_db', code: 'compass_sources_unread', route: 'GET /compass/feed/section', coverage: items.length > 0 ? 'partial' : 'nothing', failedSources: ['posts'] },
});
async function mount(city = 'Paris') {
  const r = await render(<CompassPicksSection city={city} enabled />);
  await act(async () => {});
  await act(async () => {});
  return r;
}

describe('§104 CompassPicksSection — a section built while a candidate read failed', () => {
  it('U1 rows read beside a failed source → the rows AND the incomplete line', async () => {
    body = unread([ITEM('place:1', 'Read Pick')]);
    const r = await mount();
    expect(r.queryByText('Read Pick')).not.toBeNull();
    expect(r.queryByTestId('compass-picks-partial')).not.toBeNull();
    expect(r.queryByTestId('compass-picks-stale')).toBeNull();
  });

  it('U2 no rows read → the failed line with its retry, never hidden', async () => {
    body = unread([]);
    const r = await mount();
    expect(r.toJSON()).not.toBeNull();
    expect(r.queryByTestId('compass-picks-failed')).not.toBeNull();
    expect(r.queryByTestId('compass-picks-retry')).not.toBeNull();
  });

  it('U3 a sources-unread section is never written to the device feed cache', async () => {
    const compassService = require('../../../services/compass.ts') as typeof import('../../../services/compass.ts');
    const spy = jest.spyOn(compassService, 'setCachedFeed').mockResolvedValue(undefined as never);
    try {
      body = unread([ITEM('place:1', 'Read Pick')]);
      await mount('Lyon');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('U4 picks on screen, then a refresh answers sources-unread → the kept picks stay, under the stale line', async () => {
    body = { sections: [{ name: 'compass_picks', total: 1, items: [ITEM('pick-1', 'Real Pick')] }], nextCursor: null, fallback: false, compassEnabled: true };
    const r = await mount('Nice');
    expect(r.queryByText('Real Pick')).not.toBeNull();
    body = unread([ITEM('place:9', 'Partial Pick')]);
    await act(async () => { r.rerender(<CompassPicksSection city="Nice" enabled={false} />); });
    await act(async () => { r.rerender(<CompassPicksSection city="Nice" enabled />); });
    await act(async () => {});
    await act(async () => {});
    expect(r.queryByText('Real Pick')).not.toBeNull();
    expect(r.queryByText('Partial Pick')).toBeNull();
    expect(r.queryByTestId('compass-picks-stale')).not.toBeNull();
  });

  it('Uc CONTROL a healthy section → its rows, no line', async () => {
    body = { sections: [{ name: 'compass_picks', total: 1, items: [ITEM('pick-2', 'Healthy Pick')] }], nextCursor: null, fallback: false, compassEnabled: true };
    const r = await mount('Porto');
    expect(r.queryByText('Healthy Pick')).not.toBeNull();
    expect(r.queryByTestId('compass-picks-partial')).toBeNull();
    expect(r.queryByTestId('compass-picks-stale')).toBeNull();
  });
});
