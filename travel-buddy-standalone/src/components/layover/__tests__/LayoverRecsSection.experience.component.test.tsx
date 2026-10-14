/**
 * census-layover L75 — the spec §9 ExperiencePrimitive reaches the card a
 * traveller reads (`app/layover/[id].tsx` mounts `LayoverRecsSection`).
 *
 * `GET /:id/recommendations` attaches `experience` to every card: the TYPICAL
 * profile of the card's kind, from the Trips primitives, never a measurement
 * of the place. The card says it on its own line, "Typical for …", and the
 * facts it already showed are untouched: a landside card with no stated time
 * there shows none, and its unmeasured journey still says so.
 *
 * Only `fetch` and the two auth modules beneath it are replaced.
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

/** What the server attaches to a `food` card: Trips' EAT defaults. */
const EAT = {
  type: 'EAT', minDuration: 45, idealDuration: 90, compressibility: 0.5, interruptibility: 'low',
  reversibility: 'partially_reversible', costRange: 'medium', energyCost: 'low',
  weatherCompatibility: 'all_weather', reservationRequirement: 'unknown',
  source: 'category_default', typeBasis: 'rec_type', weatherBasis: 'category_default',
};

/** A landside discovery card as the server serves it: no measured journey, no stated time there. */
const NOODLES = {
  id: 'r-noodles', title: 'Riverside Noodles', recType: 'food', insideAirport: false,
  safetyRating: 'not_recommended', safetyLabel: 'Not recommended', travelTimeMin: null, activityTimeMin: null,
  description: null, warningReason: 'Travel time not measured — leave only when you know your way back.', experience: EAT,
} as any;

function props(over: Record<string, unknown> = {}) {
  return {
    recs: [NOODLES], loading: false, error: null, onRetry: () => {}, canPlan: false,
    addedRecIds: new Set<string>(), addingRecId: null, onAddToPlan: () => {}, ...over,
  } as any;
}

describe('getRecommendations — the descriptor travels with the card', () => {
  test('1. the server\'s experience reaches the client unchanged', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { recommendations: [NOODLES], featureEnabled: true, landsideSuppression: null }));
    const r = await getRecommendations('sess-1');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.recommendations[0]!.experience).toEqual(EAT);
  });
});

describe('LayoverRecsSection — the card says what its kind typically takes, and only that', () => {
  test('2. the typical line is on the card, labelled typical, with the caveat for a screen reader', async () => {
    await render(<LayoverRecsSection {...props()} />);
    const line = screen.getByTestId('layover-rec-typical-0');
    expect(line).toHaveTextContent('Typical for a meal: 45m–1h 30m · hard to leave partway');
    expect(line.props.accessibilityLabel).toMatch(/not measured for this one/);
  });

  test('3. the card\'s own facts are untouched: no "there" stamp from a typical number, the journey still unmeasured, the warning still shown', async () => {
    await render(<LayoverRecsSection {...props()} />);
    expect(screen.queryByText(/ there$/)).toBeNull();
    expect(screen.queryByText('45m there')).toBeNull();
    expect(screen.getByText('travel time not measured')).toBeTruthy();
    expect(screen.getByText('Travel time not measured — leave only when you know your way back.')).toBeTruthy();
  });

  test('4. a card with its own stated time keeps it, beside the typical line', async () => {
    const lounge = {
      ...NOODLES, id: 'r-lounge', title: 'Airport Lounge / Rest Area', recType: 'inside_airport', insideAirport: true,
      safetyRating: 'safe', safetyLabel: 'Safe', travelTimeMin: 0, activityTimeMin: 30,
      experience: { ...EAT, type: 'REST', minDuration: 30, interruptibility: 'medium', typeBasis: 'airside_card', weatherBasis: 'inside_airport' },
    };
    await render(<LayoverRecsSection {...props({ recs: [lounge] })} />);
    expect(screen.getByText('30m there')).toBeTruthy();
    expect(screen.getByTestId('layover-rec-typical-0')).toHaveTextContent('Typical for resting: 30m–1h 30m');
  });

  test('4b. a museum as the server now serves it (EXPLORE, weather unknown): the line, and no weather claim', async () => {
    const museum = {
      ...NOODLES, id: 'r-museum', title: 'National Museum', recType: 'activity',
      experience: { ...EAT, type: 'EXPLORE', minDuration: 30, interruptibility: 'high', energyCost: 'medium', weatherCompatibility: 'unknown', weatherBasis: 'venue_dependent' },
    };
    await render(<LayoverRecsSection {...props({ recs: [museum] })} />);
    const line = screen.getByTestId('layover-rec-typical-0');
    expect(line).toHaveTextContent('Typical for exploring: 30m–1h 30m');
    expect(screen.queryByText(/weather/)).toBeNull();
    expect(line.props.accessibilityLabel).not.toMatch(/weather/);
  });

  test('5. an older server (no descriptor) and an unmapped kind: no line at all', async () => {
    const older = { ...NOODLES, experience: undefined };
    const unmapped = { ...NOODLES, id: 'r-x', experience: { ...EAT, type: 'EXPLORE', typeBasis: 'unmapped' } };
    await render(<LayoverRecsSection {...props({ recs: [older, unmapped] })} />);
    expect(screen.queryByTestId('layover-rec-typical-0')).toBeNull();
    expect(screen.queryByTestId('layover-rec-typical-1')).toBeNull();
    expect(screen.queryByText(/^Typical for/)).toBeNull();
  });
});
