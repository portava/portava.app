/**
 * census-layover L38 / L50 / L97 — the client half of the served
 * RecommendationStatus (lane LAYOVER, census drive 2026-10-23).
 *
 * With `layover_recommendation_status_enabled` ON (production since
 * 2026-10-23 10:02Z), `GET /:id/recommendations` KEEPS a card the server
 * certified as unavailable and serves it with `status` (BLOCKED, STALE,
 * EXPIRED, SUPERSEDED), `available: false` and the fixed `statusExplanation`
 * (artifacts/api-server/src/services/layover/LayoverRecommendationStatus.ts
 * `servedStatusOf`); `POST /:id/stops/from-recommendation` refuses such a card
 * with 409 RECOMMENDATION_UNAVAILABLE. Until this suite, the app read none of
 * those keys: an unavailable card looked like any other and offered
 * "Add to plan", and the traveller learned it was unavailable only from the
 * refusal. This pins what the list does now:
 *
 *   1. `available: false` → no "Add to plan", and the server's own sentence,
 *      "Unavailable — …", under the card;
 *   2. ELIGIBLE / TIGHT (`available: true`) and a card from a server with the
 *      flag OFF (no status keys at all) still offer "Add to plan" — nothing
 *      that was addable stops being addable;
 *   3. a card already added keeps its "added" mark even after it goes
 *      unavailable — the plan still holds it.
 *
 * Only `fetch` and the two auth modules beneath the service are replaced: the
 * cards reach the section through the real `getRecommendations`.
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

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

afterEach(() => { jest.restoreAllMocks(); });

const SNAP = `snap:${'a'.repeat(32)}`;

/** An airside card rated safe — addable by every rule the list had before the served status. */
function card(id: string, title: string, served: Record<string, unknown> = {}) {
  return {
    id, title, recType: 'inside_airport', insideAirport: true,
    safetyRating: 'safe', safetyLabel: 'Safe', travelTimeMin: 0, activityTimeMin: 30,
    description: null, warningReason: null, ...served,
  };
}

const ELIGIBLE = { status: 'ELIGIBLE', available: true, statusReason: null, statusExplanation: null };
const TIGHT = { status: 'TIGHT', available: true, statusReason: 'tight_return', statusExplanation: 'This fits, but your return margin is tight.' };
const BLOCKED = { status: 'BLOCKED', available: false, statusReason: 'unsafe_return_risk', statusExplanation: 'This does not fit your safe return to the airport.' };
const STALE = { status: 'STALE', available: false, statusReason: 'snapshot_not_active', statusExplanation: 'This idea was checked against an earlier version of your layover.' };
const EXPIRED = { status: 'EXPIRED', available: false, statusReason: 'card_window_closed', statusExplanation: 'The time to start this has passed.' };

async function served(cards: any[]) {
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(200, { recommendations: cards, featureEnabled: true, snapshotId: SNAP, landsideSuppression: null }));
  const r = await getRecommendations('sess-1');
  if (!r.ok) throw new Error('positive control: the read succeeded');
  return r.recommendations;
}

async function mount(recs: any[], added: string[] = []) {
  return await render(
    <LayoverRecsSection
      recs={recs} loading={false} error={null} onRetry={jest.fn()} canPlan
      addedRecIds={new Set(added)} addingRecId={null} onAddToPlan={jest.fn()}
    />,
  );
}

describe('the served RecommendationStatus reaches the list', () => {
  it('an unavailable card offers no "Add to plan" and says why, in the server\'s own words', async () => {
    await mount(await served([card('r-blocked', 'Night market', BLOCKED), card('r-stale', 'Garden walk', STALE), card('r-expired', 'Museum', EXPIRED)]));
    for (const title of ['Night market', 'Garden walk', 'Museum']) {
      expect(screen.queryByLabelText(`Add ${title} to plan`)).toBeNull();
    }
    expect(screen.getByText(`Unavailable — ${BLOCKED.statusExplanation}`)).toBeTruthy();
    expect(screen.getByText(`Unavailable — ${STALE.statusExplanation}`)).toBeTruthy();
    expect(screen.getByText(`Unavailable — ${EXPIRED.statusExplanation}`)).toBeTruthy();
  });

  it('an available card (ELIGIBLE, TIGHT) is still addable', async () => {
    await mount(await served([card('r-ok', 'Lounge', ELIGIBLE), card('r-tight', 'Spa', TIGHT)]));
    expect(screen.getByLabelText('Add Lounge to plan')).toBeTruthy();
    expect(screen.getByLabelText('Add Spa to plan')).toBeTruthy();
    expect(screen.queryByText(/^Unavailable — /)).toBeNull();
  });

  it('a card from a server with the status flag OFF (no status keys) is exactly as addable as before', async () => {
    await mount(await served([card('r-legacy', 'Rest area')]));
    expect(screen.getByLabelText('Add Rest area to plan')).toBeTruthy();
    expect(screen.queryByText(/^Unavailable — /)).toBeNull();
  });

  it('an unavailable card with no sentence still says it is unavailable, and invents no reason', async () => {
    await mount(await served([card('r-x', 'Rooftop', { status: 'SUPERSEDED', available: false, statusReason: null, statusExplanation: null })]));
    expect(screen.queryByLabelText('Add Rooftop to plan')).toBeNull();
    expect(screen.getByText('Unavailable — This idea is not available right now.')).toBeTruthy();
  });

  it('a card already in the plan keeps its "added" mark when it goes unavailable', async () => {
    const view = await mount(await served([card('r-added', 'Cafe', STALE)]), ['r-added']);
    expect(screen.queryByLabelText('Add Cafe to plan')).toBeNull();
    expect(view.toJSON()).toBeTruthy();
    expect(screen.getByTestId('layover-rec-added-0')).toBeTruthy();
  });
});
