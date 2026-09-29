/**
 * census-discovery §103 (DV-83, W11-X2 round 7): the verifier's §102.11 probe, kept as a failing-first test.
 * Real CompassPicksSection + real useCompassFeed + real fetchCompassSection/normalizer; fetch mocked.
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

describe('§102.11 CompassPicksSection — the section route\'s build-error arm', () => {
  it('V6-P1 GET /compass/feed/section answers its catch arm (build failed) → the section is not the "disabled" silence', async () => {
    // routes/compass.ts catch arm, verbatim shape: res.json({ section: null, nextCursor: null, fallback: true, safeItems: fallback.safeItems })
    body = { section: null, nextCursor: null, fallback: true, safeItems: [] };
    const r = await render(<CompassPicksSection city="Paris" enabled />);
    await act(async () => {});
    await act(async () => {});
    expect((global.fetch as jest.Mock).mock.calls.map((c) => String(c[0])).some((u) => u.includes('/api/compass/feed/section/compass_picks'))).toBe(true);
    expect({
      hidden: r.toJSON() === null,
      failedLine: r.queryByTestId('compass-picks-failed') !== null,
    }).toEqual({ hidden: false, failedLine: true });
  });

  it('V6-P1b the same arm WITH safe items → they are not dropped silently', async () => {
    body = { section: null, nextCursor: null, fallback: true, safeItems: [{ id: 'safe-1', type: 'place', category: 'food', title: 'Safe Bistro', data: { city: 'Paris' } }] };
    const r = await render(<CompassPicksSection city="Paris" enabled />);
    await act(async () => {});
    await act(async () => {});
    expect(r.toJSON()).not.toBeNull();
    // §103: the safe items are shown UNDER the failure, never as the section's picks
    expect(r.queryByText('Safe Bistro')).not.toBeNull();
    expect(r.queryByTestId('compass-picks-stale')).not.toBeNull();
  });

  it('V6-PC CONTROL: Compass disabled arm ({compassEnabled:false}) hides', async () => {
    body = { section: null, nextCursor: null, fallback: true, compassEnabled: false };
    const r = await render(<CompassPicksSection city="Paris" enabled />);
    await act(async () => {});
    await act(async () => {});
    expect(r.toJSON()).toBeNull();
  });

  it('P2 the marked build-error arm (fallbackReason + compassEnabled: true + refusal, as routes/compass.ts now sends it) → failed line', async () => {
    body = { section: null, nextCursor: null, fallback: true, compassEnabled: true, fallbackReason: 'section_build_error', safeItems: [], refusal: { class: 'transient_db', code: 'section_build_error', route: 'GET /compass/feed/section', coverage: 'nothing', failedSources: ['compass_section'] } };
    const r = await render(<CompassPicksSection city="Paris" enabled />);
    await act(async () => {});
    await act(async () => {});
    expect(r.queryByTestId('compass-picks-failed')).not.toBeNull();
  });

  it('P3 an unread flag table (compass_flags_unreadable, no compassEnabled) → failed line, not the disabled silence', async () => {
    body = { section: null, nextCursor: null, fallback: true, fallbackReason: 'compass_flags_unreadable', safeItems: [], refusal: { class: 'transient_db', code: 'compass_flags_unreadable', route: 'GET /compass/feed/section', coverage: 'nothing', failedSources: ['feature_flags'] } };
    const r = await render(<CompassPicksSection city="Paris" enabled />);
    await act(async () => {});
    await act(async () => {});
    expect(r.queryByTestId('compass-picks-failed')).not.toBeNull();
  });

  it('P4 picks on screen, then the refresh hits the build-error arm → the picks stay under the stale line (not replaced by the fallback)', async () => {
    body = { sections: [{ name: 'compass_picks', total: 1, items: [{ id: 'pick-1', type: 'place', category: 'food', title: 'Real Pick', data: { city: 'Paris' } }] }], nextCursor: null, fallback: false, compassEnabled: true };
    const r = await render(<CompassPicksSection city="Paris" enabled />);
    await act(async () => {});
    await act(async () => {});
    expect(r.queryByText('Real Pick')).not.toBeNull();
    body = { section: null, nextCursor: null, fallback: true, compassEnabled: true, fallbackReason: 'section_build_error', safeItems: [{ id: 'safe-1', type: 'place', category: 'food', title: 'Safe Bistro', data: { city: 'Paris' } }] };
    expect(r.queryByTestId('compass-picks-retry')).toBeNull();
    await act(async () => { r.rerender(<CompassPicksSection city="Paris" enabled={false} />); });
    await act(async () => { r.rerender(<CompassPicksSection city="Paris" enabled />); });
    await act(async () => {});
    await act(async () => {});
    expect(r.queryByText('Real Pick')).not.toBeNull();
    expect(r.queryByText('Safe Bistro')).toBeNull();
    expect(r.queryByTestId('compass-picks-stale')).not.toBeNull();
  });

  it('P5 a failed section is never written to the device feed cache (a healthy one is — control)', async () => {
    const compassService = require('../../../services/compass.ts') as typeof import('../../../services/compass.ts');
    const spy = jest.spyOn(compassService, 'setCachedFeed').mockResolvedValue(undefined as never);
    try {
      body = { section: null, nextCursor: null, fallback: true, compassEnabled: true, fallbackReason: 'section_build_error', safeItems: [{ id: 'safe-1', type: 'place', category: 'food', title: 'Safe Bistro', data: { city: 'Paris' } }] };
      await render(<CompassPicksSection city="Paris" enabled />);
      await act(async () => {});
      await act(async () => {});
      expect(spy).not.toHaveBeenCalled();
      body = { sections: [{ name: 'compass_picks', total: 1, items: [{ id: 'pick-1', type: 'place', category: 'food', title: 'Real Pick', data: { city: 'Rome' } }] }], nextCursor: null, fallback: false, compassEnabled: true };
      await render(<CompassPicksSection city="Rome" enabled />);
      await act(async () => {});
      await act(async () => {});
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});
