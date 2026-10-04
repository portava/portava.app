/**
 * census-discovery §104 (DV-83, D-W11X2-55). The first describe is the §103.11 verifier's probe
 * (V7-T1, V7-T2 red at 67d900e55; V7-TC the control), copied in unchanged; the second pins the
 * refusal envelope the route now sends.
 *
 * v7 verifier probe (DV-83 clause c/d): CompassTravelerRow renders on Discovery's For You tab
 * (ForYouTab.tsx `<CompassTravelerRow city={destination} limit={6} />`). Its read is
 * GET /compass/recommendations?surface=traveler. A failed read must not be drawn as the
 * silence "no traveler matches" draws.
 */
// NOTE: a stand-in on purpose — the probe needs a configured client and nothing else from the module.
jest.mock('../../../lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — the probe needs a configured client and nothing else from the module.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — only freshToken is read, and the probe fixes its value.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — only freshToken is read, and the probe fixes its value.
jest.mock('../../../services/apiToken', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — the row only navigates, and the probe never taps.
jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() } }));

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { CompassTravelerRow } from '../CompassTravelerRow.tsx';

const realFetch = global.fetch;
let recs: { status: number; body: unknown };
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => {
  global.fetch = jest.fn(async (u: string) => {
    if (String(u).includes('/api/compass/recommendations')) return new Response(JSON.stringify(recs.body), { status: recs.status, headers: { 'Content-Type': 'application/json' } });
    if (String(u).includes('/api/compass/settings')) return new Response(JSON.stringify({ settings: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

async function mount() {
  const r = await render(<CompassTravelerRow city="Paris" limit={6} />);
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
  return r;
}

describe('§103.11 verifier probe: CompassTravelerRow — a failed traveler read on Discovery For You', () => {
  it('V7-T1 the read fails (HTTP 503) → the row must not be the "no matches" silence', async () => {
    recs = { status: 503, body: { error: 'unavailable' } };
    const r = await mount();
    expect((global.fetch as jest.Mock).mock.calls.map((c) => String(c[0])).some((u) => u.includes('surface=traveler'))).toBe(true);
    expect({ hidden: r.toJSON() === null }).toEqual({ hidden: false });
  });

  it('V7-T2 the route\'s own fail-closed arm (block list unreadable: 200 { recommendations: [], error: "block_check_failed" }) → must not be the silence', async () => {
    recs = { status: 200, body: { recommendations: [], surface: 'traveler', error: 'block_check_failed' } };
    const r = await mount();
    expect({ hidden: r.toJSON() === null }).toEqual({ hidden: false });
  });

  it('V7-TC CONTROL: a readable answer with one traveler renders the row', async () => {
    recs = { status: 200, body: { recommendations: [{ id: 'u-2', type: 'traveler', category: 'traveler', title: 'Ana', reason: 'Shares your interests', city: 'Paris', data: { userId: 'u-2', username: 'ana', displayName: 'Ana', avatarUrl: null, homeCity: 'Paris', isPrivate: false, verified: false, sharedInterests: [], reasonCode: 'shared_interests', followStatus: 'none' } }] } };
    const r = await mount();
    expect(r.toJSON()).not.toBeNull();
    expect(r.queryByText('Travelers You May Vibe With')).not.toBeNull();
  });
});

const TRAVELER = { id: 'u-2', type: 'traveler', category: 'traveler', title: 'Ana', reason: 'Shares your interests', city: 'Paris', data: { userId: 'u-2', username: 'ana', displayName: 'Ana', avatarUrl: null, homeCity: 'Paris', isPrivate: false, verified: false, sharedInterests: [], reasonCode: 'shared_interests', followStatus: 'none' } };

describe('§104 CompassTravelerRow — the route\'s refusal envelope', () => {
  it('T3 refused `nothing` (the candidate read failed) → the failed line', async () => {
    recs = { status: 200, body: { recommendations: [], surface: 'traveler', refusal: { class: 'transient_db', code: 'traveler_read_failed', coverage: 'nothing', failedSources: ['profiles'] } } };
    const r = await mount();
    expect(r.queryByTestId('compass-travelers-failed')).not.toBeNull();
  });

  it('T4 a partial answer (a person gate unread) → the travelers AND the incomplete line', async () => {
    recs = { status: 200, body: { recommendations: [TRAVELER], surface: 'traveler', refusal: { class: 'transient_db', code: 'compass_sources_unread', coverage: 'partial', failedSources: ['profile_privacy_settings'] } } };
    const r = await mount();
    expect(r.queryByText('Travelers You May Vibe With')).not.toBeNull();
    expect(r.queryByTestId('compass-travelers-partial')).not.toBeNull();
    expect(r.queryByTestId('compass-travelers-failed')).toBeNull();
  });

  it('T5 CONTROL an answered empty list → hidden, as before', async () => {
    recs = { status: 200, body: { recommendations: [], surface: 'traveler' } };
    const r = await mount();
    expect(r.toJSON()).toBeNull();
  });

  it('T6 CONTROL the viewer turned people recommendations off (`disabled`) → hidden, no failed line', async () => {
    recs = { status: 200, body: { recommendations: [], surface: 'traveler', disabled: true } };
    const r = await mount();
    expect(r.toJSON()).toBeNull();
  });

  it('T7 CONTROL a healthy list → the travelers, no line', async () => {
    recs = { status: 200, body: { recommendations: [TRAVELER], surface: 'traveler' } };
    const r = await mount();
    expect(r.queryByTestId('compass-travelers-partial')).toBeNull();
    expect(r.queryByTestId('compass-travelers-failed')).toBeNull();
  });
});
