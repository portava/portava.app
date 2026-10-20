import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { getRecommendations } from '../../../services/layover.ts';
import { LayoverRecsSection } from '../LayoverRecsSection.tsx';
// NOTE: intentionally exhaustive — the real auth module constructs a native SecureStore-backed client.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } }, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — requiring apiToken would construct that same native auth client.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: jest.fn(async () => 'test-token') }));
afterEach(() => { jest.restoreAllMocks(); });
const SNAP = `snap:${'a'.repeat(32)}`;
const route = { state: 'UNMEASURED', band: 'BLOCKED', absence: 'PROVIDER_REJECTED', reason: 'A return route could not be measured.', outboundMinutes: null, conservativeReturnMinutes: null, returnContract: null, expiresAt: null };
const rec = { id: 'r', title: 'Museum', recType: 'activity', insideAirport: false, travelTimeMin: 99, activityTimeMin: 30, safetyRating: 'safe', safetyLabel: 'Previously available', description: null, warningReason: null, routing: route };
test('the real recommendations client keeps the named envelope and route absence; blocked card remains visible without an add button', async () => {
  const envelope = { basis: 'routed_union', centre: { lat: 25, lng: 121 }, certifiedInward: true, certifiedOutward: false, polygonInteriorCertified: false,
    outerBound: null, windowStartsAt: '2026-10-19T09:00:00Z', hardReturnBy: '2026-10-19T12:00:00Z', usableMinutes: 180, dwellFloorMinutes: 30,
    confidence: 'MEDIUM', members: [], excluded: [{ key: 'r', point: { lat: 25.1, lng: 121.1 }, band: 'BLOCKED', reason: route.reason }], sectors: [], polygon: [], expiresAt: null };
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ snapshotId: SNAP, routedEnvelope: envelope, recommendations: [rec] }) } as Response);
  const response = await getRecommendations('s');
  expect(response.ok).toBe(true); if (!response.ok) return;
  expect(response.routedEnvelope?.excluded[0]?.band).toBe('BLOCKED');
  expect(response.snapshotId).toBe(SNAP);
  expect(response.recommendations[0]?.routing?.absence).toBe('PROVIDER_REJECTED');
  await render(<LayoverRecsSection recs={response.recommendations} loading={false} error={null} onRetry={jest.fn()} canPlan addedRecIds={new Set<string>()} addingRecId={null} onAddToPlan={jest.fn()} />);
  expect(screen.getByText('Museum')).toBeTruthy();
  expect(screen.getByText(/Unavailable — A return route/)).toBeTruthy();
  expect(screen.getByText(/could not be measured right now/)).toBeTruthy();
  expect(screen.queryByText('99m away')).toBeNull();
  expect(screen.queryByLabelText('Add Museum to plan')).toBeNull();
});
