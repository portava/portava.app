/**
 * census-layover L296 — Appendix C5, the client half: *"Never certify a
 * recommendation against a snapshot other than the one returned with it."*
 *
 * `GET /:id/recommendations` names the snapshot its cards were certified under,
 * and `POST /:id/stops/from-recommendation` refuses any other with 409
 * `RECOMMENDATION_EXPIRED` ("Recommendation certified under stale snapshot",
 * artifacts/api-server/src/test/layoverRecommendationSnapshotPairing.test.ts).
 * This suite pins what the client does with both halves:
 *
 *   1. every card carries the snapshot it was RETURNED with;
 *   2. "Add to plan" sends the PRESSED card's snapshot — not the one a later
 *      response happened to bring;
 *   3. a 409 RECOMMENDATION_EXPIRED puts the list in its "refreshed — reload"
 *      state: the Add controls go, the ideas are reloaded once, and the add is
 *      NOT retried; the reloaded list says it was refreshed;
 *   4. nothing else (another 409, a 400, a 200) enters that state.
 *
 * Only `fetch` and the two auth modules beneath the service are replaced: the
 * real `services/layover` runs, and the add goes through the same
 * `addStopFromRecommendation(sessionId, recId)` call `app/layover/[id].tsx` makes.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { LayoverRecsSection } from '../LayoverRecsSection.tsx';
import {
  addStopFromRecommendation,
  addStopFromRecommendationOutcome,
  getRecommendations,
} from '../../../services/layover.ts';

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

const snap = (c: string) => `snap:${c.repeat(32)}`;
const EXPIRED_BODY = { error: 'conflict', message: 'Recommendation certified under stale snapshot', reason: 'RECOMMENDATION_EXPIRED' };

/** An airside card as the server serves it with stable ids: addable. */
function lounge(id = 'rec-lounge') {
  return {
    id, title: 'Airport Lounge / Rest Area', recType: 'inside_airport', insideAirport: true,
    safetyRating: 'safe', safetyLabel: 'Safe', travelTimeMin: 0, activityTimeMin: 30,
    description: null, warningReason: null,
  };
}

/** The cards exactly as `getRecommendations` hands them to the screen. */
async function served(snapshotId: string, cards = [lounge()]) {
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(200, { recommendations: cards, featureEnabled: true, snapshotId, landsideSuppression: null }));
  const r = await getRecommendations('sess-1');
  if (!r.ok) throw new Error('positive control: the read succeeded');
  return r;
}

/** The section wired the way app/layover/[id].tsx wires it. */
function mount(recs: any[], onRetry = jest.fn()) {
  const props = {
    recs, loading: false, error: null, onRetry, canPlan: true,
    addedRecIds: new Set<string>(), addingRecId: null,
    onAddToPlan: (recId: string) => { void addStopFromRecommendation('sess-1', recId); },
  };
  return { props, onRetry };
}

function addBodies(spy: jest.SpyInstance): any[] {
  return spy.mock.calls
    .filter(([url]) => String(url).endsWith('/from-recommendation'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe('1. every card carries the snapshot it was returned with', () => {
  test('1a. getRecommendations returns the snapshot and stamps it on each card', async () => {
    const r = await served(snap('a'), [lounge('r1'), lounge('r2')]);
    expect(r.snapshotId).toBe(snap('a'));
    expect(r.recommendations.map((c) => c.snapshotId)).toEqual([snap('a'), snap('a')]);
  });

  test('1b. a response with no readable snapshot is null on the result and on every card — never a made-up one', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(200, { recommendations: [lounge()], featureEnabled: true, snapshotId: 'not-a-snapshot' }));
    const r = await getRecommendations('sess-1');
    if (!r.ok) throw new Error('unreachable');
    expect(r.snapshotId).toBeNull();
    expect(r.recommendations[0]!.snapshotId).toBeNull();
  });
});

describe('2. "Add to plan" sends the snapshot of the card that was pressed', () => {
  test('2a. a newer response landing first does not change what the pressed card is added under', async () => {
    const shown = await served(snap('b'));
    await served(snap('c'));                                   // a later read the list on screen never showed
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true, stops: [], planFit: null }));
    const { props } = mount(shown.recommendations);
    await render(<LayoverRecsSection {...props} />);
    await fireEvent.press(screen.getByLabelText('Add Airport Lounge / Rest Area to plan'));
    await screen.findByLabelText('Add Airport Lounge / Rest Area to plan');
    expect(addBodies(fetchSpy)).toEqual([{ recommendationId: 'rec-lounge', snapshotId: snap('b') }]);
  });
});

describe('3. 409 RECOMMENDATION_EXPIRED is a "refreshed — reload" state, never a blind retry', () => {
  test('3a. the Add controls go, the ideas are reloaded exactly once, and the add is sent exactly once', async () => {
    const shown = await served(snap('d'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(409, EXPIRED_BODY));
    const { props, onRetry } = mount(shown.recommendations);
    const view = await render(<LayoverRecsSection {...props} />);
    await fireEvent.press(screen.getByLabelText('Add Airport Lounge / Rest Area to plan'));

    expect(await screen.findByTestId('layover-recs-expired')).toBeTruthy();
    expect(screen.queryByLabelText('Add Airport Lounge / Rest Area to plan')).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(addBodies(fetchSpy)).toHaveLength(1);

    // A re-render of the same expired list does not reload again.
    await view.rerender(<LayoverRecsSection {...props} />);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(addBodies(fetchSpy)).toHaveLength(1);
  });

  test('3b. the reloaded list (a new snapshot) is addable again and says it was refreshed — once', async () => {
    const shown = await served(snap('e'));
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(409, EXPIRED_BODY));
    const { props } = mount(shown.recommendations);
    const view = await render(<LayoverRecsSection {...props} />);
    await fireEvent.press(screen.getByLabelText('Add Airport Lounge / Rest Area to plan'));
    await screen.findByTestId('layover-recs-expired');

    const reloaded = await served(snap('f'));
    await view.rerender(<LayoverRecsSection {...props} recs={reloaded.recommendations} />);
    expect(await screen.findByTestId('layover-recs-refreshed')).toBeTruthy();
    expect(screen.queryByTestId('layover-recs-expired')).toBeNull();
    expect(screen.getByLabelText('Add Airport Lounge / Rest Area to plan')).toBeTruthy();

    const later = await served(snap('g'));
    await view.rerender(<LayoverRecsSection {...props} recs={later.recommendations} />);
    expect(screen.queryByTestId('layover-recs-refreshed')).toBeNull();
  });

  test('3c. the outcome names the refusal: expired, in the server\'s own sentence', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(409, EXPIRED_BODY));
    const out = await addStopFromRecommendationOutcome('sess-1', 'rec-lounge', snap('h'));
    expect(out).toEqual({ ok: false, reason: 'expired', message: 'Recommendation certified under stale snapshot' });
  });
});

describe('4. nothing else enters the expired state', () => {
  test.each([
    ['a 409 that is not RECOMMENDATION_EXPIRED', 409, { error: 'conflict', message: 'This recommendation is already in your plan' }, 'refused'],
    ['a 400', 400, { error: 'invalid_payload', message: 'This idea has no travel time yet, so it cannot be timed into a plan.' }, 'refused'],
    ['a 503', 503, { error: 'degraded_unavailable', message: 'We could not confirm this idea is still current. Please try again.', retryable: true }, 'unavailable'],
  ])('4. %s', async (_label, status, body, reason) => {
    const shown = await served(snap(String(status % 10)));
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status as number, body));
    const { props, onRetry } = mount(shown.recommendations);
    await render(<LayoverRecsSection {...props} />);
    await fireEvent.press(screen.getByLabelText('Add Airport Lounge / Rest Area to plan'));
    await screen.findByLabelText('Add Airport Lounge / Rest Area to plan');
    expect(screen.queryByTestId('layover-recs-expired')).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
    const out = await addStopFromRecommendationOutcome('sess-1', 'rec-lounge', shown.snapshotId);
    expect(out).toEqual({ ok: false, reason, message: (body as { message: string }).message });
  });

  test('4d. an unreachable server is unavailable, not an exception', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    const out = await addStopFromRecommendationOutcome('sess-1', 'rec-lounge', snap('i'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('unavailable');
  });
});
