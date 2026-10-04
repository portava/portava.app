/**
 * census-discovery §104 (DV-83, D-W11X2-58) — For You's "Why am I seeing this?"
 * sheet (opened from the Compass picks and the For You cards) says a failed read.
 * It used to fall back to "Based on your travel preferences and recent activity."
 * for a failed read too, presenting a stub as the reason.
 *
 *   Y1  GET /compass/why refused `nothing` (the lookup failed) → the failed line, not the stub
 *   Y2  a transport failure → the failed line
 *   Yc  CONTROL a real explanation → that explanation, no failed line
 */
// NOTE: a stand-in on purpose — the sheet needs a configured client and nothing else from the module.
jest.mock('../../../lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — the sheet needs a configured client and nothing else from the module.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — only freshToken is read, and the test fixes its value.
jest.mock('../../../services/apiToken', () => ({ freshToken: async () => 'tok-1' }));

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { CompassWhySheet } from '../CompassWhySheet.tsx';

const realFetch = global.fetch;
let why: { status: number; body: unknown };
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify(why.body), { status: why.status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
});

async function open() {
  const r = await render(<CompassWhySheet visible recommendationId="rec-1" onClose={jest.fn()} />);
  await act(async () => {});
  await act(async () => {});
  return r;
}

describe('§104 CompassWhySheet — a failed explanation read is said', () => {
  it('Y1 the lookup failed (refused `nothing`) → the failed line, not the stub', async () => {
    why = { status: 200, body: { explanation: 'Recommendation not found or not available for your account.', refusal: { class: 'transient_db', code: 'why_unavailable', coverage: 'nothing', failedSources: ['compass_served_recommendations'] } } };
    const r = await open();
    expect(r.queryByText(/load why this was suggested/)).not.toBeNull();
    expect(r.queryByText(/not found or not available/)).toBeNull();
  });

  it('Y2 a transport failure → the failed line, not the generic reason', async () => {
    why = { status: 503, body: { error: 'unavailable' } };
    const r = await open();
    expect(r.queryByText(/load why this was suggested/)).not.toBeNull();
    expect(r.queryByText(/Based on your travel preferences/)).toBeNull();
  });

  it('Yc CONTROL a real explanation → shown, no failed line', async () => {
    why = { status: 200, body: { explanation: 'Popular with travelers like you.', factors: [] } };
    const r = await open();
    expect(r.queryByText('Popular with travelers like you.')).not.toBeNull();
    expect(r.queryByText(/load why this was suggested/)).toBeNull();
  });
});
