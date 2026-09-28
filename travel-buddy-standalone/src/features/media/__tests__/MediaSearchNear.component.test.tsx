/**
 * census-media §29 (MD288): the Search screen asks §38 "near X" as the server
 * answers it — a center and a bounded radius — and says honestly when the
 * center cannot be placed.
 *
 * The transport is stubbed at `fetch`, so each case asserts the EXACT request
 * the screen made, then what the viewer sees:
 *   • "near" is offered as one chip and never applied silently;
 *   • pressed, it sends the viewer's point (the one the World shell hands the
 *     Media Map) and a radius inside 100 m – 5 km; with no words it is itself a
 *     search;
 *   • a search opened from a place is centred on that place, not the viewer;
 *   • the server's `center_unpositioned` is "we can't place that center",
 *     never "Nothing matched" — and a real empty "near" answer still is;
 *   • with no point and no place there is no "near" chip, and the city chip
 *     is unchanged: it sends the coarse city and no radius.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaSearchScreen } from '../screens/MediaSearchScreen.tsx';
import { _setTestFreshToken, _clearTestFreshToken } from '../services/mediaProjection.ts';

// NOTE: intentionally exhaustive — the image layer is not under test.
jest.mock('../../../components/CachedImage.tsx', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});

const PLACE = '11111111-1111-4111-8111-111111111111';
const ME = { lat: 16.0544, lng: 108.2022 };
let requests: string[] = [];
let respond: (url: string) => unknown = () => ({});
const realFetch = global.fetch;

beforeEach(() => {
  requests = [];
  _setTestFreshToken('tok');
  (global as { fetch: typeof fetch }).fetch = jest.fn(async (url: string) => {
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => respond(String(url)) } as unknown as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => {
  (global as { fetch: typeof fetch }).fetch = realFetch;
  _clearTestFreshToken();
});

const EMPTY = {
  criteriaUsed: [], media: [], places: [], people: [], hiddenGems: [], experiences: [], events: [], trips: [],
  unsupported: [], undetermined: [],
};
const NEAR_RESULTS = {
  ...EMPTY,
  criteriaUsed: ['near'],
  places: [{ placeId: PLACE, label: 'An Thuong', city: 'Da Nang', perspectiveCount: 3, freshPerspectiveCount: 1, freshness: 'fresh' }],
  near: { center: 'point', radiusM: 1500, refusal: null },
};

function last(): URL {
  return new URL(requests[requests.length - 1]!, 'https://api.test');
}

describe('census-media §29 (MD288) — Search asks "near" as a center and a bounded radius', () => {
  it('"Near me" is offered, not applied; pressed, it sends the viewer\'s point and a bounded radius with the words', async () => {
    respond = () => NEAR_RESULTS;
    await render(<MediaSearchScreen initialQuery="beach" viewerPoint={ME} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(last().search).toBe('?q=beach'); // offered, never applied silently
    const chip = screen.getByTestId('media-search-near');
    expect(screen.getByText('Near me · 1.5 km')).toBeTruthy();
    expect(chip.props.accessibilityState.selected).toBe(false);

    await fireEvent.press(chip);
    await waitFor(() => expect(requests).toHaveLength(2));
    const u = last();
    expect(u.pathname).toBe('/api/media/search');
    expect(u.searchParams.get('q')).toBe('beach');
    expect(Number(u.searchParams.get('nearLat'))).toBe(ME.lat);
    expect(Number(u.searchParams.get('nearLng'))).toBe(ME.lng);
    expect(u.searchParams.get('nearPlaceId')).toBeNull();
    const r = Number(u.searchParams.get('radiusM'));
    expect(r).toBe(1500);
    expect(r).toBeGreaterThanOrEqual(100);
    expect(r).toBeLessThanOrEqual(5000);
    await waitFor(() => expect(screen.getByTestId(`media-search-place-${PLACE}`)).toBeTruthy());
    expect(screen.getByTestId('media-search-near').props.accessibilityState.selected).toBe(true);

    // Off again: the next request carries no radius.
    await fireEvent.press(screen.getByTestId('media-search-near'));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(last().search).toBe('?q=beach');
  });

  it('with no words, "Near me" is itself a search — the point and the radius, nothing else', async () => {
    respond = () => NEAR_RESULTS;
    await render(<MediaSearchScreen viewerPoint={ME} />);
    expect(screen.getByText('Search the world by what it looks like')).toBeTruthy();
    expect(requests).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('media-search-near'));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(last().search).toBe(`?nearLat=${ME.lat}&nearLng=${ME.lng}&radiusM=1500`);
    await waitFor(() => expect(screen.getByTestId(`media-search-place-${PLACE}`)).toBeTruthy());
  });

  it('a search opened from a place is centred on THAT place, not on the viewer', async () => {
    respond = () => ({ ...NEAR_RESULTS, near: { center: 'place', radiusM: 1500, refusal: null } });
    await render(<MediaSearchScreen initialQuery="rooftop" viewerPoint={ME} nearPlace={{ id: PLACE, label: 'An Thuong' }} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(screen.getByText('Near An Thuong · 1.5 km')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('media-search-near'));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(last().search).toBe(`?q=rooftop&nearPlaceId=${PLACE}&radiusM=1500`);
  });

  it('the server\'s "center_unpositioned" is said as "we can\'t place that center" — never as "Nothing matched"', async () => {
    respond = (url) =>
      url.includes('nearPlaceId')
        ? { ...EMPTY, criteriaUsed: ['q', 'near'], near: { center: 'place', radiusM: 1500, refusal: 'center_unpositioned' } }
        : NEAR_RESULTS;
    await render(<MediaSearchScreen initialQuery="rooftop" nearPlace={{ id: PLACE, label: 'An Thuong' }} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    await fireEvent.press(screen.getByTestId('media-search-near'));
    await waitFor(() => expect(screen.getByTestId('media-search-near-refused')).toBeTruthy());
    expect(screen.getByText("We can't place that center")).toBeTruthy();
    expect(screen.getByText(/The map has no position for An Thuong/)).toBeTruthy();
    expect(screen.queryByText('Nothing matched')).toBeNull();

    // The way out drops "near" and asks again without a radius.
    await fireEvent.press(screen.getByTestId('media-search-near-drop'));
    await waitFor(() => expect(last().search).toBe('?q=rooftop'));
    await waitFor(() => expect(screen.queryByTestId('media-search-near-refused')).toBeNull());
  });

  it('CONTROL: a "near" answer that is genuinely empty (no refusal) still reads "Nothing matched"', async () => {
    respond = () => ({ ...EMPTY, criteriaUsed: ['q', 'near'], near: { center: 'point', radiusM: 1500, refusal: null } });
    await render(<MediaSearchScreen initialQuery="rooftop" viewerPoint={ME} />);
    await fireEvent.press(screen.getByTestId('media-search-near'));
    await waitFor(() => expect(requests.some((u) => u.includes('radiusM=1500'))).toBe(true));
    await waitFor(() => expect(screen.getByText('Nothing matched')).toBeTruthy());
    expect(screen.queryByTestId('media-search-near-refused')).toBeNull();
  });

  it('with no point and no place there is no "near" chip; "Near <city>" is unchanged — the city, and no radius', async () => {
    respond = () => NEAR_RESULTS;
    await render(<MediaSearchScreen initialQuery="beach" nearCity="Da Nang" />);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(screen.queryByTestId('media-search-near')).toBeNull();
    await fireEvent.press(screen.getByTestId('media-search-near-city'));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(last().search).toBe('?q=beach&city=Da+Nang');
  });

  it('with both chips, the city chip still sends only the city — the radius is its own, separate choice', async () => {
    respond = () => NEAR_RESULTS;
    await render(<MediaSearchScreen initialQuery="beach" nearCity="Da Nang" viewerPoint={ME} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    await fireEvent.press(screen.getByTestId('media-search-near-city'));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(last().search).toBe('?q=beach&city=Da+Nang');
    await fireEvent.press(screen.getByTestId('media-search-near'));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(last().search).toBe(`?q=beach&city=Da+Nang&nearLat=${ME.lat}&nearLng=${ME.lng}&radiusM=1500`);
  });
});
