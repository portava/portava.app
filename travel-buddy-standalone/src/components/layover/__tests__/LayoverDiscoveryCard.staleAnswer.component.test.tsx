/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; sweep SW23, B26's class): the layover discovery card draws only
 * the answer for the window and city it now shows.
 *
 * `run` is rebuilt when `availableMinutes` or `city` changes and re-run, and kept no request token, so a slow answer for
 * the previous city (or window) that landed after the new one's was drawn under the new props — gems for another
 * airport, said as this layover's. The card now applies an answer only if no later read has started. The harness is
 * LayoverDiscoveryCard.component.test's (only fetch and the auth modules under the real service are replaced).
 *
 *   LD0  CONTROL: Bangkok's answer lands, then the city changes to Doha and Doha's lands → Doha's gems
 *   LD1  the city changes to Doha and Bangkok's answer lands LAST → Bangkok's gems are never drawn for Doha
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

type Held = { city: string; release: () => void };
async function race(order: 'inOrder' | 'stale') {
  const held: Held[] = [];
  (global as any).fetch = jest.fn((url: string) => new Promise((res) => {
    const city = new URL(String(url), 'http://x').searchParams.get('city') ?? '';
    held.push({ city, release: () => res({ ok: true, status: 200, json: async () => ({ gems: [gem(`g-${city}`, `${city} street food`, city)], total: 1, availableMinutes: 240 }) }) });
  }));
  const ui = await render(<LayoverDiscoveryCard availableMinutes={240} city="Bangkok" />);
  await waitFor(() => expect(held.length).toBe(1));
  if (order === 'inOrder') await act(async () => { held[0]!.release(); });
  await act(async () => { ui.rerender(<LayoverDiscoveryCard availableMinutes={240} city="Doha" />); });
  await waitFor(() => expect(held.some((h) => h.city === 'Doha')).toBe(true));
  await act(async () => { held.find((h) => h.city === 'Doha')!.release(); });
  if (order === 'stale') await act(async () => { held.find((h) => h.city === 'Bangkok')!.release(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { doha: screen.queryAllByText('Doha street food').length > 0, bangkok: screen.queryAllByText('Bangkok street food').length > 0 };
}

afterEach(() => { jest.clearAllMocks(); delete (global as any).fetch; });

test('LD0 CONTROL: the answers land in order → Doha\'s gems', async () => {
  expect(await race('inOrder')).toEqual({ doha: true, bangkok: false });
});
test('LD1 Bangkok\'s answer lands after Doha\'s → Bangkok\'s gems are never drawn for Doha', async () => {
  expect(await race('stale')).toEqual({ doha: true, bangkok: false });
});
