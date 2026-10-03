/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's survivor V32, fixture LI1):
 * LayoverDiscoveryCard bumps its request sequence BEFORE the "no window" early return, so a read for a window that has
 * since closed (availableMinutes 0: "you cannot leave the airport") is never drawn. LayoverDiscoveryCard.staleAnswer
 * races only a city change (LD1).
 *
 *   LI0 CONTROL: 240 min, Bangkok's gems land → drawn
 *   LI1 (V32) the window drops to 0 while Bangkok's read is in flight, then it lands → never drawn under a closed window
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';

import { LayoverDiscoveryCard } from '../LayoverDiscoveryCard.tsx';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

const gem = (id: string, name: string, city: string) => ({
  id, name, category: 'food', city, country: null, neighborhood: null, description: null, lat: null, lng: null, coords_precision: 'hidden',
  vibe_tags: [], layover_safe: true, minimum_layover_minutes: 120, sensitivity_level: 'approximate', image_url: null,
});


afterEach(() => { jest.clearAllMocks(); delete (global as any).fetch; });
async function idle(drop: boolean) {
  const held: Array<() => void> = [];
  (global as any).fetch = jest.fn((url: string) => new Promise((res) => { const city = new URL(String(url), 'http://x').searchParams.get('city') ?? ''; held.push(() => res({ ok: true, status: 200, json: async () => ({ gems: [gem(`g-${city}`, `${city} street food`, city)], total: 1, availableMinutes: 240 }) })); }));
  const ui = await render(<LayoverDiscoveryCard availableMinutes={240} city="Bangkok" />);
  await waitFor(() => expect(held.length).toBe(1));
  if (drop) await act(async () => { ui.rerender(<LayoverDiscoveryCard availableMinutes={0} city="Bangkok" />); });
  await act(async () => { held[0]!(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { drawn: screen.queryAllByText('Bangkok street food').length > 0 };
}
test('LI0 CONTROL: the window stays open → drawn', async () => { expect(await idle(false)).toEqual({ drawn: true }); });
test('LI1 the window closes while the read is in flight → never drawn', async () => { const s = await idle(true); expect(s).toEqual({ drawn: false }); });
