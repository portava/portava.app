/**
 * census-layover L269 — THE CONSUMER THE FLAG HAS TO HAVE SOMETHING TO TURN ON.
 *
 * `getLayoverGems` has existed in `services/hiddenGems.ts` and
 * `GET /api/hidden-gems/layover-safe` has existed in `routes/hiddenGems.ts` for
 * several census passes with NO CALLER ANYWHERE UNDER `app/layover/`. An
 * endpoint whose intended client flow is not connected is not a shipped
 * feature, and `layover_discovery_mode_enabled` (migration 2971) cannot be
 * enabled against nothing — the deployed consumer is exactly what has to be
 * verified before the gate moves.
 *
 * ── NOTHING HERE MOCKS THE SERVICE ───────────────────────────────────────────
 * The real `services/layover` module runs; only `fetch` and the two auth
 * modules under it are replaced. The URL, its query string and the request
 * count are asserted on the fetch spy, so a card wired to the wrong route, or
 * to no route, fails rather than passing against a stub.
 *
 * ── THE FOUR ANSWERS, AND WHY EACH IS ITS OWN CASE ───────────────────────────
 *   served, non-empty  the gems are rendered. The card states the server's
 *                      own per-gem floor and derives no feasibility of its
 *                      own — `LayoverReturnPanel.tsx` was deleted at a718beb5
 *                      for carrying thresholds that existed nowhere on the
 *                      server, and re-inventing one here would repeat it.
 *   served, empty      a MEASURED empty. Said plainly, and distinguishable
 *                      from the next case.
 *   gate OFF           `feature_disabled`. NO CARD AT ALL and no claim: not an
 *                      error, not "nothing nearby", not a spinner that never
 *                      resolves. The traveller is shown nothing because
 *                      nothing was offered.
 *   read failed        the SERVER's refusal sentence, and never an empty list.
 *                      Three sites that rendered a failed read as an empty
 *                      result were fixed on this tree earlier today; this is
 *                      the fourth not being introduced.
 *
 * `feature_disabled` answers 404 — THE SAME STATUS AS `not_found` — so the gate
 * has to be recognised by the envelope's `error` code and not by the status.
 * A card keyed on `res.status === 404` renders the gate-off case as a failed
 * read; case 3 is what catches that.
 *
 * ── NO FIXED DATES ───────────────────────────────────────────────────────────
 * Nothing here is time-sensitive: `availableMinutes` is the server's certified
 * figure passed in as a prop, never a local clock subtraction.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

import { LayoverDiscoveryCard } from '../LayoverDiscoveryCard.tsx';

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

/** Transcribed from `listGems` + `applyGemPrivacyBatch`'s serialised row. */
const GEM_ROW = {
  id: 'gem-1',
  name: 'Soi 38 night market',
  category: 'food',
  city: 'Bangkok',
  country: 'Thailand',
  neighborhood: 'Thonglor',
  description: 'Stalls under the skytrain.',
  lat: null,
  lng: null,
  coords_precision: 'hidden',
  vibe_tags: ['late night'],
  layover_safe: true,
  minimum_layover_minutes: 180,
  sensitivity_level: 'approximate',
  image_url: null,
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
}

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  (global as any).fetch = fetchSpy;
});

afterEach(() => {
  jest.clearAllMocks();
});

function gemCalls() {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes('/hidden-gems/layover-safe'));
}

test('1. the card reaches the layover-safe endpoint with the CERTIFIED minutes and the city', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { gems: [GEM_ROW], total: 1, availableMinutes: 240 }));
  await render(<LayoverDiscoveryCard availableMinutes={240} city="Bangkok" />);

  await waitFor(() => expect(gemCalls().length).toBe(1));
  const url = String(gemCalls()[0][0]);
  expect(url).toContain('/api/hidden-gems/layover-safe');
  // 240 is the server's `window.usableMinutes`, handed down as a prop. A card
  // that recomputed it from a clock would send a different number.
  expect(url).toContain('availableMinutes=240');
  expect(url).toContain('city=Bangkok');
});

test('2. a served gem is rendered, with the SERVER\'s own minimum and no derived verdict', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { gems: [GEM_ROW], total: 1, availableMinutes: 240 }));
  await render(<LayoverDiscoveryCard availableMinutes={240} city="Bangkok" />);

  await waitFor(() => expect(screen.getByTestId('layover-discovery-card')).toBeTruthy());
  expect(screen.getByText('Soi 38 night market')).toBeTruthy();
  expect(screen.getByText(/180 min/)).toBeTruthy();
  // The card must not restate the gem as "fits" / "doesn't fit": the server
  // already filtered on `minLayoverMinutes` and a second verdict here would be
  // a second feasibility answer.
  expect(screen.queryByText(/fits your layover/i)).toBeNull();
});

test('3. the gate being OFF renders NO CARD — not an error, and not "nothing nearby"', async () => {
  // `feature_disabled` is 404 with the code in the envelope. Keying on the
  // STATUS would put this case in with `not_found` and show a refusal.
  fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'feature_disabled', message: 'feature_disabled' }));
  await render(<LayoverDiscoveryCard availableMinutes={240} city="Bangkok" />);

  await waitFor(() => expect(gemCalls().length).toBe(1));
  expect(screen.queryByTestId('layover-discovery-card')).toBeNull();
  expect(screen.queryByTestId('layover-discovery-error')).toBeNull();
  expect(screen.queryByTestId('layover-discovery-empty')).toBeNull();
  expect(screen.queryByTestId('layover-discovery-loading')).toBeNull();
  // And the raw code is never shown to a traveller.
  expect(screen.queryByText(/feature_disabled/)).toBeNull();
});

test('4. a MEASURED empty says so, and is not the same rendering as the gate being off', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { gems: [], total: 0, availableMinutes: 240 }));
  await render(<LayoverDiscoveryCard availableMinutes={240} city="Bangkok" />);

  await waitFor(() => expect(screen.getByTestId('layover-discovery-empty')).toBeTruthy());
  expect(screen.queryByTestId('layover-discovery-error')).toBeNull();
});

test('5. a failed read shows the SERVER\'s sentence and NEVER an empty result', async () => {
  fetchSpy.mockResolvedValue(jsonResponse(500, {
    error: 'db_error',
    message: 'A database error occurred. Please try again.',
    retryable: true,
  }));
  await render(<LayoverDiscoveryCard availableMinutes={240} city="Bangkok" />);

  await waitFor(() => expect(screen.getByTestId('layover-discovery-error')).toBeTruthy());
  expect(screen.getByText('A database error occurred. Please try again.')).toBeTruthy();
  // The failure mode this case exists for: a read that fell over rendering as
  // "no hidden gems here".
  expect(screen.queryByTestId('layover-discovery-empty')).toBeNull();
});

test('6. an offline device is a failed read, not an empty city', async () => {
  // `authedFetch` REJECTS when there is no network. Before this consumer
  // existed the only layover gem reader was `useLayoverGems`, whose
  // `.catch(() => setGems([]))` turns exactly this into an empty list.
  fetchSpy.mockRejectedValue(new TypeError('Network request failed'));
  await render(<LayoverDiscoveryCard availableMinutes={240} city="Bangkok" />);

  await waitFor(() => expect(screen.getByTestId('layover-discovery-error')).toBeTruthy());
  expect(screen.queryByTestId('layover-discovery-empty')).toBeNull();
});

test('7. with no certified minutes the card asks nothing and claims nothing', async () => {
  // `availableMinutes` of 0 or less is what the server publishes for a window
  // that does not exist. The endpoint rejects it as `invalid_payload`; asking
  // anyway would turn a certified "you cannot leave" into a 400.
  await render(<LayoverDiscoveryCard availableMinutes={0} city="Bangkok" />);

  await waitFor(() => expect(screen.queryByTestId('layover-discovery-loading')).toBeNull());
  expect(gemCalls().length).toBe(0);
  expect(screen.queryByTestId('layover-discovery-card')).toBeNull();
  expect(screen.queryByTestId('layover-discovery-empty')).toBeNull();
});
