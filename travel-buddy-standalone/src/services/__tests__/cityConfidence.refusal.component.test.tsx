/**
 * census-discovery §107 (DV-83 round 10, D-W11X2-70) — a failed city-confidence read is never
 * cached and never drawn as "Limited local data".
 *
 * GET /compass/city-confidence answered a failed read with the bytes of a measured city with no
 * rows (`tier: "thin"`, "Limited local data for X"); `fetchCityConfidence` cached that answer in
 * memory AND in AsyncStorage (24 h), and CityConfidenceBadge on the destination screen drew the
 * thin pill and its note. The route now answers 503 `city_confidence_unreadable`; the reader must
 * cache neither that nor any 200 that carries a refusal, and the badge must not draw either.
 *
 *   CF1  503 city_confidence_unreadable → ok:false; nothing cached (the next call reads again; no AsyncStorage entry)
 *   CF2  a 200 carrying a refusal → ok:false; nothing cached
 *   CF3  the badge over a failed read draws nothing — no "Still learning this city", no note
 *   CFc  CONTROL: a healthy answer is cached (one network read for two calls) and drawn
 *
 * THE SERVICE AND THE BADGE ARE REAL (services/compass.ts imports react-native, so this runs under jest).
 */
// NOTE: a stand-in on purpose — the reader needs a configured client and nothing else from the module.
jest.mock('../../lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — the reader needs a configured client and nothing else from the module.
jest.mock('../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../apiToken', () => ({ freshToken: async () => 'tok-1' }));

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchCityConfidence, _clearCityConfidenceCache, CITY_CONFIDENCE_STORAGE_KEY } from '../compass.ts';
import { CityConfidenceBadge } from '../../components/compass/CityConfidenceBadge.tsx';

let answer: unknown = {};
let status = 200;
let reads = 0;
const realFetch = global.fetch;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(async () => {
  status = 200; reads = 0;
  _clearCityConfidenceCache();
  await AsyncStorage.clear();
  global.fetch = jest.fn(async () => { reads++; return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } }); }) as unknown as typeof fetch;
});

const UNREADABLE = { error: 'degraded_unavailable', message: 'city confidence could not be read just now', reason: 'city_confidence_unreadable' };
const THIN = { city: 'Lyon', depthScore: 0, tier: 'thin', note: 'Limited local data for Lyon — be upfront that suggestions there are less certain.', computedAt: null };
const stored = async () => { const raw = await AsyncStorage.getItem(CITY_CONFIDENCE_STORAGE_KEY); return raw ? Object.keys(JSON.parse(raw)) : []; };

describe('§107 a failed city-confidence read is never cached and never drawn', () => {
  it('CF1 503 city_confidence_unreadable → ok:false, and nothing is cached', async () => {
    status = 503; answer = UNREADABLE;
    expect((await fetchCityConfidence('Lyon')).ok).toBe(false);
    expect((await fetchCityConfidence('Lyon')).ok).toBe(false);
    expect(reads).toBe(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(await stored()).toEqual([]);
  });

  it('CF2 a 200 carrying a refusal → ok:false, and nothing is cached', async () => {
    answer = { ...THIN, refusal: { class: 'transient_db', code: 'city_confidence_unreadable', coverage: 'nothing' } };
    expect((await fetchCityConfidence('Lyon')).ok).toBe(false);
    expect((await fetchCityConfidence('Lyon')).ok).toBe(false);
    expect(reads).toBe(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(await stored()).toEqual([]);
  });

  it('CF3 the badge over a failed read draws nothing — never "Limited local data"', async () => {
    status = 503; answer = UNREADABLE;
    await render(<CityConfidenceBadge city="Lyon" />);
    await waitFor(() => expect(reads).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText('Still learning this city')).toBeNull();
    expect(screen.queryByText(/Limited local data/)).toBeNull();
  });

  it('CFc CONTROL: a healthy answer is cached and drawn', async () => {
    answer = THIN;
    expect((await fetchCityConfidence('Lyon')).ok).toBe(true);
    expect((await fetchCityConfidence('Lyon')).ok).toBe(true);
    expect(reads).toBe(1);
    await render(<CityConfidenceBadge city="Lyon" />);
    await waitFor(() => expect(screen.queryByText('Still learning this city')).not.toBeNull());
  });
});
