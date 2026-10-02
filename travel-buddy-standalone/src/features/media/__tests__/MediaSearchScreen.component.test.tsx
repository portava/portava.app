/**
 * MediaSearchScreen and "Search my world" — rendered (census-media §19: MD27 ·
 * MD228 · MD294 client half · MD331).
 *
 * The transport is stubbed at `fetch`, so each case asserts the EXACT request
 * the screen made — a search screen that renders the right lists from the wrong
 * query proves nothing — and then what the viewer sees:
 *   • nothing is asked until there is a criterion ("empty means empty");
 *   • a submitted term becomes `GET /api/media/search?q=…`;
 *   • My World's search is `scope=me` and cannot be widened from inside it;
 *   • all seven §38 result types render, events/trips found by NAME included;
 *   • an undetermined list is labelled, never shown as "nothing matched".
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaSearchScreen } from '../screens/MediaSearchScreen.tsx';
import { MyWorldMediaScreen } from '../screens/MyWorldMediaScreen.tsx';
import { _setTestFreshToken, _clearTestFreshToken } from '../services/mediaProjection.ts';

// NOTE: intentionally exhaustive — the image layer is not under test.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});

const U1 = '11111111-1111-1111-1111-111111111111';
let requests: string[] = [];
let respond: (url: string) => unknown = () => ({});
const realFetch = global.fetch;

beforeEach(() => {
  requests = [];
  _setTestFreshToken('tok');
  (global as { fetch: typeof fetch }).fetch = jest.fn(async (url: string) => {
    requests.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => respond(String(url)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => {
  (global as { fetch: typeof fetch }).fetch = realFetch;
  _clearTestFreshToken();
});

const FULL_RESULTS = {
  criteriaUsed: ['q'],
  media: [{ id: 'm1', mediaType: 'image', thumbnailUrl: 't1', observationClass: 'observed' }],
  places: [{ placeId: U1, label: 'Vertigo Rooftop', city: 'Bangkok', perspectiveCount: 3, freshPerspectiveCount: 1, freshness: 'fresh' }],
  people: [{ id: 'u1', username: 'maya', perspectiveCount: 2, verified: true }],
  hiddenGems: [],
  experiences: [],
  events: [{ id: 'e1', kind: 'event', title: 'Beach Festival', placeIds: [], perspectiveCount: 0 }],
  trips: [{ id: 't1', kind: 'trip', title: 'Vietnam', placeIds: [], perspectiveCount: 4 }],
  unsupported: ['visual similarity ("find places that look like this")'],
  undetermined: ['hiddenGems'],
};

describe('MediaSearchScreen', () => {
  it('asks NOTHING until there is a criterion, then sends the submitted term to GET /api/media/search', async () => {
    respond = () => FULL_RESULTS;
    await render(<MediaSearchScreen />);
    expect(screen.getByText('Search the world by what it looks like')).toBeTruthy();
    expect(requests).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId('media-search-input'), 'rooftop');
    expect(requests).toHaveLength(0); // typing is not a request
    await fireEvent(screen.getByTestId('media-search-input'), 'submitEditing');
    await waitFor(() => expect(screen.getByTestId('media-search-results')).toBeTruthy());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/\/api\/media\/search\?q=rooftop$/);
  });

  it('renders the §38 result types — events and trips found by NAME, with "no perspectives yet" when none', async () => {
    respond = () => FULL_RESULTS;
    await render(<MediaSearchScreen initialQuery="beach" />);
    await waitFor(() => expect(screen.getByTestId('media-search-results')).toBeTruthy());
    expect(screen.getByText('Places')).toBeTruthy();
    expect(screen.getByTestId(`media-search-place-${U1}`)).toBeTruthy();
    expect(screen.getByText('Events')).toBeTruthy();
    expect(screen.getByTestId('media-search-event-e1')).toBeTruthy();
    expect(screen.getByText('No perspectives yet')).toBeTruthy();
    expect(screen.getByText('Trips')).toBeTruthy();
    expect(screen.getByTestId('media-search-trip-t1')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();
    expect(screen.getByText('@maya')).toBeTruthy();
    expect(screen.getByText('Media')).toBeTruthy();
  });

  it('an undetermined list is labelled as not checked; what search cannot do is stated', async () => {
    respond = () => FULL_RESULTS;
    await render(<MediaSearchScreen initialQuery="beach" />);
    await waitFor(() => expect(screen.getByTestId('media-search-undetermined-hiddenGems')).toBeTruthy());
    expect(screen.getByText('Hidden gems could not be checked just now.')).toBeTruthy();
    expect(screen.getByTestId('media-search-unsupported')).toBeTruthy();
  });

  it('filters are criteria: a category chip and "Right now" become category + freshOnly', async () => {
    respond = () => FULL_RESULTS;
    await render(<MediaSearchScreen />);
    await fireEvent.press(screen.getByTestId('media-search-category-nightlife'));
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await fireEvent.press(screen.getByTestId('media-search-fresh'));
    await waitFor(() => expect(requests[requests.length - 1]).toMatch(/category=nightlife&freshOnly=true$/));
  });

  it('"Where was this photo taken?" answers with the coarse place — through a mediaId query', async () => {
    respond = () => ({ ...FULL_RESULTS, criteriaUsed: ['mediaId'] });
    await render(<MediaSearchScreen mediaId={U1} />);
    await waitFor(() => expect(screen.getByTestId('media-search-taken-at')).toBeTruthy());
    expect(requests[0]).toMatch(new RegExp(`mediaId=${U1}$`));
    expect(screen.getByText(/Taken at Vertigo Rooftop · Bangkok/)).toBeTruthy();
  });

  it('§38 "Show festival media from my Vietnam Trip": a Trip result is searched WITHIN — scope=trip + its tripId', async () => {
    respond = () => FULL_RESULTS;
    await render(<MediaSearchScreen />);
    await fireEvent.changeText(screen.getByTestId('media-search-input'), 'vietnam');
    await fireEvent(screen.getByTestId('media-search-input'), 'submitEditing');
    await waitFor(() => expect(screen.getByTestId('media-search-within-trip-t1')).toBeTruthy());
    expect(screen.queryByTestId('media-search-scope-trip')).toBeNull(); // no trip chip until a trip is chosen
    await fireEvent.press(screen.getByTestId('media-search-within-trip-t1'));
    await waitFor(() => expect(screen.getByTestId('media-search-scope-trip')).toBeTruthy());
    expect(screen.getByText('In Vietnam')).toBeTruthy();
    expect(screen.getByTestId('media-search-scope-trip').props.accessibilityState.selected).toBe(true);
    await fireEvent.changeText(screen.getByTestId('media-search-input'), 'festival');
    await fireEvent(screen.getByTestId('media-search-input'), 'submitEditing');
    await waitFor(() =>
      expect(requests[requests.length - 1]).toMatch(/\/api\/media\/search\?q=festival&scope=trip&tripId=t1$/),
    );
    // Widening back to "Everywhere" drops the trip id — it is not silently kept.
    await fireEvent.press(screen.getByTestId('media-search-scope-all'));
    await waitFor(() => expect(requests[requests.length - 1]).toMatch(/\/api\/media\/search\?q=festival$/));
  });

  it('a failed search says it could not run — it does not say "nothing matched"', async () => {
    (global as { fetch: typeof fetch }).fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await render(<MediaSearchScreen initialQuery="beach" />);
    await waitFor(() => expect(screen.getByText('Search could not run')).toBeTruthy());
    expect(screen.queryByText('Nothing matched')).toBeNull();
  });
});

describe('My World — "Search my world" (§30, MD228)', () => {
  it('opens a search that is scope=me, cannot be widened, and closes back to the library', async () => {
    respond = (url) =>
      url.includes('/api/media/me')
        ? { generatedAt: '2026-09-26T00:00:00Z', buckets: [{ key: 'all', label: 'All', ownerOnly: false, count: 1, media: [{ id: 'mine', mediaType: 'image', observationClass: 'observed' }] }] }
        : FULL_RESULTS;
    await render(<MyWorldMediaScreen mode="grid" />);
    await waitFor(() => expect(screen.getByTestId('my-world-search-open')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('my-world-search-open'));
    await waitFor(() => expect(screen.getByTestId('media-search-screen')).toBeTruthy());
    expect(screen.queryByTestId('media-search-scope-all')).toBeNull(); // fixed scope
    // scope=me is itself a criterion: the owner's own world is asked for immediately.
    await waitFor(() => expect(requests.some((u) => /\/api\/media\/search\?scope=me$/.test(u))).toBe(true));
    await fireEvent.changeText(screen.getByTestId('media-search-input'), 'rooftop');
    await fireEvent(screen.getByTestId('media-search-input'), 'submitEditing');
    await waitFor(() => expect(requests.some((u) => /\/api\/media\/search\?q=rooftop&scope=me$/.test(u))).toBe(true));
    expect(requests.some((u) => /search\?q=rooftop$/.test(u))).toBe(false);
    await fireEvent.press(screen.getByTestId('my-world-search-close'));
    await waitFor(() => expect(screen.queryByTestId('media-search-screen')).toBeNull());
  });

  it('§38 "Show my Bangkok rooftop photos": the city is its own criterion — q=rooftop&city=Bangkok&scope=me', async () => {
    respond = (url) =>
      url.includes('/api/media/me')
        ? { generatedAt: '2026-09-26T00:00:00Z', buckets: [{ key: 'all', label: 'All', ownerOnly: false, count: 1, media: [{ id: 'mine', mediaType: 'image', observationClass: 'observed' }] }] }
        : FULL_RESULTS;
    await render(<MyWorldMediaScreen mode="grid" />);
    await waitFor(() => expect(screen.getByTestId('my-world-search-open')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('my-world-search-open'));
    await waitFor(() => expect(screen.getByTestId('media-search-city')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('media-search-input'), 'rooftop');
    await fireEvent.changeText(screen.getByTestId('media-search-city'), 'Bangkok');
    await fireEvent(screen.getByTestId('media-search-input'), 'submitEditing');
    await waitFor(() =>
      expect(requests.some((u) => /\/api\/media\/search\?q=rooftop&city=Bangkok&scope=me$/.test(u))).toBe(true),
    );
    // The city is not smuggled into the free text.
    expect(requests.some((u) => /q=rooftop(\+|%20)Bangkok/.test(u))).toBe(false);
    await waitFor(() => expect(screen.getByTestId('media-search-city-clear')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('media-search-city-clear'));
    await waitFor(() => expect(requests[requests.length - 1]).toMatch(/\/api\/media\/search\?q=rooftop&scope=me$/));
  });
});
