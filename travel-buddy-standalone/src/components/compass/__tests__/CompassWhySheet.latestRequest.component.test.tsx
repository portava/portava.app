/**
 * census-discovery §105 (DV-83 round 9, register D-W11X2-63): For You's "Why am I seeing
 * this?" sheet is ONE instance whose recommendationId changes per tapped card. Before §105
 * useCompassWhyExplanation had no latest-request guard, so card A's late answer overwrote
 * card B's FAILED read: B's sheet showed A's reason and no failed line. Only the latest
 * request now writes the sheet, as DiscoveryCategoryTab does (D-W11X2-38).
 *
 *   Y1 (V8-Y1, the independent round-8 verifier's probe) A pending, B fails, A answers →
 *      B's failed line stays and A's reason never shows
 *   Y2 closed while A is pending, then A answers → nothing is written
 *   Y3 A answered, then B pending → A's reason is not shown under B while B loads
 *   Y4 CONTROL: one card, one answer → its reason
 */
// NOTE: a stand-in on purpose — the sheet needs a configured client and nothing else from the module.
jest.mock('../../../lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — the sheet needs a configured client and nothing else from the module.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } }, isSupabaseConfigured: true }));
// NOTE: a stand-in on purpose — only freshToken is read, and the probe fixes its value.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));
// NOTE: a stand-in on purpose — only freshToken is read, and the probe fixes its value.
jest.mock('../../../services/apiToken', () => ({ freshToken: async () => 'tok-1' }));

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { CompassWhySheet } from '../CompassWhySheet.tsx';

const realFetch = global.fetch;
let releaseA: () => void = () => {};
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => {
  global.fetch = jest.fn((u: string) => {
    if (String(u).includes('rec-A')) {
      return new Promise<Response>((res) => { releaseA = () => res(new Response(JSON.stringify({ explanation: 'Because you loved Paris cafés.', factors: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
    }
    return Promise.resolve(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  }) as unknown as typeof fetch;
});

const REASON_A = 'Because you loved Paris cafés.';
const texts = (r: { toJSON: () => unknown }) => JSON.stringify(r.toJSON());

describe('CompassWhySheet — only the latest request writes the sheet (§105)', () => {
  it("Y1 (V8-Y1) card A pending, card B read FAILS, then A answers → B's sheet never shows A's reason", async () => {
    const r = await render(<CompassWhySheet visible recommendationId="rec-A" onClose={jest.fn()} />);
    await act(async () => {});
    await act(async () => { r.rerender(<CompassWhySheet visible recommendationId="rec-B" onClose={jest.fn()} />); });
    for (let i = 0; i < 5; i++) await act(async () => {});
    const bFailedShown = r.queryByText(/load why this was suggested/) !== null;
    await act(async () => { releaseA(); });
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect({
      bFailedShown,
      aReasonUnderB: r.queryByText(REASON_A) !== null,
      failedLineUnderB: r.queryByText(/load why this was suggested/) !== null,
    }).toEqual({ bFailedShown: true, aReasonUnderB: false, failedLineUnderB: true });
  });

  it('Y2 closed while A is pending, then A answers → nothing is written', async () => {
    const r = await render(<CompassWhySheet visible recommendationId="rec-A" onClose={jest.fn()} />);
    await act(async () => {});
    await act(async () => { r.rerender(<CompassWhySheet visible={false} recommendationId="rec-A" onClose={jest.fn()} />); });
    await act(async () => { releaseA(); });
    for (let i = 0; i < 5; i++) await act(async () => {});
    await act(async () => { r.rerender(<CompassWhySheet visible recommendationId={null as unknown as string} onClose={jest.fn()} />); });
    expect(texts(r)).not.toContain(REASON_A);
  });

  it("Y3 A answered, then B pending → A's reason is not shown under B while B loads", async () => {
    const r = await render(<CompassWhySheet visible recommendationId="rec-A" onClose={jest.fn()} />);
    await act(async () => {});
    await act(async () => { releaseA(); });
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(r.queryByText(REASON_A)).not.toBeNull();
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await act(async () => { r.rerender(<CompassWhySheet visible recommendationId="rec-C" onClose={jest.fn()} />); });
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(r.queryByText(REASON_A)).toBeNull();
  });

  it('Y4 CONTROL: one card, one answer → its reason', async () => {
    const r = await render(<CompassWhySheet visible recommendationId="rec-A" onClose={jest.fn()} />);
    await act(async () => {});
    await act(async () => { releaseA(); });
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(r.queryByText(REASON_A)).not.toBeNull();
  });
});
