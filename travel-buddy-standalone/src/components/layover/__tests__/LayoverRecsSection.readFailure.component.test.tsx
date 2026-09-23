/**
 * census-layover L294 (C2) — "NO RECOMMENDATIONS" IS A CLAIM ABOUT A
 * CITY. THE SERVER REFUSES TO MAKE IT ON A FAILED READ; THE CLIENT MADE IT
 * ANYWAY.
 *
 * `GET /api/airport/sessions/:id/recommendations` does not serve an empty list
 * when it cannot read. It refuses, twice, with its reason written out
 * (`artifacts/api-server/src/routes/airport.ts:1012` and `:1019`):
 *
 *     if (!stored.ok) {
 *       sendError(res, "degraded_unavailable",
 *                 "Layover ideas could not be loaded. Please try again.");
 *
 * and the comment above it states the principle the route was built on:
 *     "Both reads now answer 'could not look' separately from 'nothing to
 *      show', and this route refuses on the former. 'There is nothing to do on
 *      your layover' is a claim about a city, not a description of a failed
 *      query."
 *
 * The client then undid it in one line — `if (!res.ok) return []` — and the
 * card rendered **"No recommendations yet for this layover."** So a 503 during
 * an outage, and a city with genuinely nothing in the window, produced the
 * same sentence. The refusal the server took two branches to preserve was
 * discarded at the last hop.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Nothing here mocks `services/layover`: the real module runs and only `fetch`
 * and the two auth modules beneath it are replaced, so the assertions are about
 * what the service does with a REAL server body (transcribed from `sendError`
 * in `artifacts/api-server/src/lib/http.ts:160`, including `retryable: true`),
 * not about what a spy was told to return.
 *
 * Case 3 is the control: a 200 carrying an empty list is a measured "nothing
 * fits", and the card must still say so. A fix that reports every empty list as
 * an error fails case 3; the old behaviour fails cases 1, 2 and 4.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { LayoverRecsSection } from '../LayoverRecsSection.tsx';
import { getRecommendations } from '../../../services/layover.ts';

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

const REFUSAL = 'Layover ideas could not be loaded. Please try again.';
const NOTHING_YET = /No recommendations yet for this layover/i;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getRecommendations — a refusal is not an empty list', () => {
  it('1. a 503 degraded_unavailable is reported as a failure, carrying the server\'s own sentence', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      // The real body sendError writes for this code, retryable flag included.
      jsonResponse(503, { error: 'degraded_unavailable', message: REFUSAL, retryable: true }),
    );

    const result = await getRecommendations('sess-1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — asserted above');
    // The server owns the words. This must be ITS sentence, not one invented here.
    expect(result.message).toBe(REFUSAL);
  });

  it('2. a fetch that rejects (offline) is a failure, not an empty city', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));

    const result = await getRecommendations('sess-1');

    expect(result.ok).toBe(false);
  });

  it('3. a 200 with an empty list is a MEASURED nothing and stays one', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { recommendations: [], featureEnabled: true }),
    );

    const result = await getRecommendations('sess-1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable — asserted above');
    expect(result.recommendations).toEqual([]);
  });
});

describe('LayoverRecsSection — what the traveller is told', () => {
  const common = {
    canPlan: true,
    addedRecIds: new Set<string>(),
    addingRecId: null,
    onAddToPlan: () => {},
    onRetry: () => {},
  };

  it('4. a failed read shows the server\'s refusal and a retry, NOT "no recommendations yet"', async () => {
    await render(
      <LayoverRecsSection {...common} recs={[]} loading={false} error={REFUSAL} />,
    );

    expect(screen.queryByText(NOTHING_YET)).toBeNull();
    expect(screen.getByTestId('layover-recs-error')).toBeTruthy();
    expect(screen.getByText(REFUSAL)).toBeTruthy();
    expect(screen.getByTestId('layover-recs-retry')).toBeTruthy();
  });

  it('5. a measured empty list still says "no recommendations yet"', async () => {
    await render(
      <LayoverRecsSection {...common} recs={[]} loading={false} error={null} />,
    );

    expect(screen.getByText(NOTHING_YET)).toBeTruthy();
    expect(screen.queryByTestId('layover-recs-error')).toBeNull();
  });
});
