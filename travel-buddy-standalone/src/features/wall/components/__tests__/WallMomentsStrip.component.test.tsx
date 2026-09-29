/**
 * TM-live (WP-11) WALL-F13 — Wall Moments reach the Wall, through the REAL
 * service (services/wallMoments.ts → features/live/liveApi.ts). Only `fetch`
 * is faked, answering in routes/wallMoments.ts's shape.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import { WallMomentsStrip } from '../WallMomentsStrip.tsx';
import { _setLiveTestToken } from '../../../live/liveApi.ts';

const { router } = require('expo-router');

process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';

const A = '88888888-bbbb-4bbb-8bbb-888888888888';
const B = '99999999-cccc-4ccc-8ccc-999999999999';
const LIVE = [{ subjectId: A, subject: { name: 'Han Market' } }, { subjectId: B, subject: { name: 'Dragon Bridge' } }];

let urls: string[] = [];
function serve(status: number, body: unknown) {
  (global as any).fetch = jest.fn(async (url: string) => {
    urls.push(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
}
const moment = (id: string, subject: string, route: string, over: Record<string, unknown> = {}) => ({
  id, subject: { kind: 'place', id: subject },
  transition: { kind: 'crowd_shift', claimType: 'crowd.level', from: 'busy', to: 'packed' },
  occurredAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  relevanceWindow: { from: '', until: '' }, reason: { code: 'crowd_shift', text: 'Crowd went from busy to packed' },
  truthClass: 'corroborated', confidence: 'high', freshness: 'fresh', coverage: 'several', expiresAt: '', claimRef: 's1',
  attention: { route, reasons: [], factors: {} }, ...over,
});

beforeEach(() => { urls = []; _setLiveTestToken(async () => 'tok'); jest.spyOn(router, 'push').mockImplementation(() => {}); });
afterEach(() => { _setLiveTestToken(null); jest.restoreAllMocks(); });

describe('WALL-F13 WallMomentsStrip', () => {
  it('asks about the Live strip places and shows the moments placed on the Wall, labelled with their truth', async () => {
    serve(200, {
      ok: true, liveIntelligenceReadable: true,
      moments: [moment('m1', A, 'WALL'), moment('m2', B, 'SILENT')],
      subjects: [{ subjectId: A, refusal: null, moments: 1 }, { subjectId: B, refusal: null, moments: 1 }],
    });
    const { findByTestId, getByText, getByTestId, queryByTestId } = await render(<WallMomentsStrip liveItems={LIVE} />);
    const row = await findByTestId('wall-moment-m1');
    expect(getByText('Han Market')).toBeTruthy();
    expect(getByText('Crowd went from busy to packed')).toBeTruthy();
    expect(getByText(/^corroborated · fresh/)).toBeTruthy();
    expect(queryByTestId('wall-moment-m2')).toBeNull();
    expect(getByTestId('wall-moments-held')).toBeTruthy();
    const u = new URL(urls[0]);
    expect(u.pathname).toBe('/api/wall/moments');
    expect(u.searchParams.get('subjectIds')?.split(',').sort()).toEqual([A, B].sort());
    expect(u.searchParams.get('relevance')).toBe('nearby');
    fireEvent.press(row);
    expect(router.push).toHaveBeenCalledWith(`/place/${A}`);
  });

  it('a place the server could not check is said to be unchecked — never counted as "nothing changed"', async () => {
    serve(200, {
      ok: true, liveIntelligenceReadable: true, moments: [],
      subjects: [{ subjectId: A, refusal: 'error', moments: 0 }, { subjectId: B, refusal: null, moments: 0 }],
    });
    const { findByTestId, getByTestId } = await render(<WallMomentsStrip liveItems={LIVE} />);
    expect(await findByTestId('wall-moments-refused')).toBeTruthy();
    expect(getByTestId('wall-moments-none').props.children.join('')).toMatch(/at the 1 live place near you/);
  });

  it('Live intelligence closed: says changes cannot be checked', async () => {
    serve(200, { ok: true, liveIntelligenceReadable: false, moments: [], subjects: [{ subjectId: A, refusal: 'live_intelligence_unavailable', moments: 0 }] });
    const { findByTestId, queryByTestId } = await render(<WallMomentsStrip liveItems={LIVE} />);
    expect(await findByTestId('wall-moments-live-closed')).toBeTruthy();
    expect(queryByTestId('wall-moments-none')).toBeNull();
  });

  it('a failed request is "couldn\'t check" with Try again, never an empty strip', async () => {
    serve(503, { error: 'degraded_unavailable' });
    const { findByTestId, queryByTestId, getByTestId } = await render(<WallMomentsStrip liveItems={LIVE} />);
    expect(await findByTestId('wall-moments-unavailable')).toBeTruthy();
    expect(queryByTestId('wall-moments-none')).toBeNull();
    serve(200, { ok: true, liveIntelligenceReadable: true, moments: [moment('m1', A, 'NOTIFY')], subjects: [{ subjectId: A, refusal: null, moments: 1 }] });
    fireEvent.press(getByTestId('wall-moments-retry'));
    expect(await findByTestId('wall-moment-m1')).toBeTruthy();
  });

  it('moments off in this build, or no live places to ask about: nothing is rendered', async () => {
    serve(404, { error: 'feature_disabled' });
    const off = await render(<WallMomentsStrip liveItems={LIVE} />);
    await waitFor(() => expect(off.queryByTestId('wall-moments-loading')).toBeNull());
    expect(off.toJSON()).toBeNull();
    urls = [];
    const none = await render(<WallMomentsStrip liveItems={[]} />);
    expect(none.toJSON()).toBeNull();
    expect(urls).toEqual([]);
  });
});
