/**
 * census-layover L43 — after the traveller reports being back at the airport,
 * `GET /:id/recommendations` serves airport-side ideas only and says why
 * (`landsideSuppression`). The FILTERING is the server's; the client parses
 * the reason and says it, so a shorter list does not read as "nothing out
 * there fits".
 *
 * Only `fetch` and the two auth modules beneath it are replaced.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverRecsSection } from '../LayoverRecsSection.tsx';
import { getRecommendations, landsideSuppressionOf } from '../../../services/layover.ts';

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

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

afterEach(() => { jest.restoreAllMocks(); });

const AIRSIDE = { id: 'r-air', title: 'Lounge', recType: 'inside_airport', insideAirport: true, safetyRating: 'safe' } as any;

function props(over: Record<string, unknown> = {}) {
  return {
    recs: [AIRSIDE], loading: false, error: null, onRetry: () => {}, canPlan: false,
    addedRecIds: new Set<string>(), addingRecId: null, onAddToPlan: () => {}, ...over,
  } as any;
}

describe('getRecommendations — the server\'s reason travels with the list', () => {
  test('1. airport_reentered is parsed with its instant', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {
      recommendations: [AIRSIDE], featureEnabled: true,
      landsideSuppression: { reason: 'airport_reentered', reportedAt: '2026-10-05T10:00:00.000Z' },
    }));
    const r = await getRecommendations('sess-1');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.landsideSuppression).toEqual({ reason: 'airport_reentered', reportedAt: '2026-10-05T10:00:00.000Z' });
  });

  test('2. none sent, null sent, or an unknown reason: null — never a guess', async () => {
    expect(landsideSuppressionOf(undefined)).toBeNull();
    expect(landsideSuppressionOf(null)).toBeNull();
    expect(landsideSuppressionOf({ reason: 'something_new' })).toBeNull();
    expect(landsideSuppressionOf({ reason: 'airport_reentered' })).toBeNull();
    expect(landsideSuppressionOf({ reason: 'checkpoints_unreadable', reportedAt: null })).toEqual({ reason: 'checkpoints_unreadable', reportedAt: null });
  });
});

describe('LayoverRecsSection — says why the list is airport-side', () => {
  test('3. re-entry: the card says city ideas are hidden because the traveller is back', async () => {
    await render(<LayoverRecsSection {...props({ landsideSuppression: { reason: 'airport_reentered', reportedAt: '2026-10-05T10:00:00.000Z' } })} />);
    expect(screen.getByTestId('layover-recs-landside-suppressed')).toBeTruthy();
    expect(screen.queryByTestId('layover-recs-landside-unknown')).toBeNull();
  });

  test('4. an unreadable check: the card says it could not check, and hides nothing', async () => {
    await render(<LayoverRecsSection {...props({ landsideSuppression: { reason: 'checkpoints_unreadable', reportedAt: null } })} />);
    expect(screen.getByTestId('layover-recs-landside-unknown')).toBeTruthy();
    expect(screen.queryByTestId('layover-recs-landside-suppressed')).toBeNull();
  });

  test('5. nothing withheld: no note at all', async () => {
    await render(<LayoverRecsSection {...props()} />);
    expect(screen.queryByTestId('layover-recs-landside-suppressed')).toBeNull();
    expect(screen.queryByTestId('layover-recs-landside-unknown')).toBeNull();
  });

  test('6. a refusal outranks the note: the server\'s sentence, not a re-entry line', async () => {
    await render(<LayoverRecsSection {...props({ error: 'Layover ideas could not be loaded. Please try again.', landsideSuppression: { reason: 'airport_reentered', reportedAt: 'x' } })} />);
    expect(screen.getByTestId('layover-recs-error')).toBeTruthy();
    expect(screen.queryByTestId('layover-recs-landside-suppressed')).toBeNull();
  });
});
