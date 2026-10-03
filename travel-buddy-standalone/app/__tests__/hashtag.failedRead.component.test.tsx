/**
 * app/hashtag/[slug].tsx — the page every Discover trending chip opens — never draws a
 * failed read as an empty tab, as "removed or blocked", or over another tab's rows.
 * census-discovery §105 (DV-83 round 9, register D-W11X2-61).
 *
 *   HS1  a failed tab read (the server's db_error since §105) is the failed state with
 *        "Try again", never "No events content yet"
 *   HS2  a tab answered AFTER the viewer moved to another tab never writes the screen
 *        (latest request wins, as DiscoveryCategoryTab, D-W11X2-38)
 *   HS3  a failed hashtag read (500 / network) is "couldn't be loaded" with a retry,
 *        never "It may have been removed or blocked"; a 404 still is
 *   HS4  a 200 carrying a Discovery refusal is a failed read, never its (empty) rows
 *   HS5  CONTROL: a successful empty tab still says "No events content yet"
 *   HS6  a load-more left pending when the viewer switches tab never leaves its spinner behind
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import HashtagFeedScreen from '../hashtag/[slug].tsx';

// NOTE: intentionally exhaustive — the real expo-router pulls in native navigation bindings.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => ({ slug: 'romejazz' }),
  usePathname: () => '/hashtag/romejazz',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
  Stack: { Screen: () => null },
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentionally exhaustive — the screen reads only the current city.
jest.mock('../../src/context/LocationContext', () => ({
  useLocationContext: () => ({ locationState: { place: { city: null } } }),
}));
// NOTE: intentionally exhaustive — the collapse handler needs Reanimated.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => undefined,
  NavBarFiller: () => null,
}));
// NOTE: intentionally exhaustive — the save button reads the saves context, which is not under test.
jest.mock('../../src/components/SaveButton', () => ({ SaveButton: () => null }));

const mockGetHashtag = jest.fn();
const mockGetFeed = jest.fn();
jest.mock('../../src/services/hashtag', () => ({
  ...jest.requireActual('../../src/services/hashtag'),
  getHashtag: (...a: unknown[]) => mockGetHashtag(...(a as [])),
  getHashtagFeed: (...a: unknown[]) => mockGetFeed(...(a as [])),
}));

const META = { id: 'ht-1', slug: 'romejazz', name: 'romejazz', usageCount: 3, isFollowing: false, topCity: null, createdAt: '2026-09-01T00:00:00Z' };
const page = (items: unknown[], tab: string, extra: object = {}) => ({ ok: true, data: { items, posts: [], hasMore: false, nextCursor: null, tab, scope: 'global', ...extra } });
const EVENT = { id: 'e1', type: 'event', name: 'Jazz night', location: 'Rome', startAt: null, endAt: null };
const PLACE = { id: 'p1', type: 'place', name: 'Caffè Greco', city: 'rome', placeType: 'cafe', imageUrl: null };

beforeEach(() => { jest.clearAllMocks(); mockGetHashtag.mockResolvedValue({ ok: true, data: META }); });

describe('hashtag feed screen (§105)', () => {
  it('HS1 a failed tab read is the failed state, never "No events content yet"', async () => {
    mockGetFeed.mockImplementation(async (_s: string, tab: string) => (tab === 'events' ? { ok: false, error: 'This hashtag feed could not be loaded just now' } : page([], tab)));
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText('Events')).not.toBeNull());
    await act(async () => { fireEvent.press(view.getByText('Events')); });
    await waitFor(() => expect(view.queryByText('Try again')).not.toBeNull());
    expect(view.queryByText('No events content yet')).toBeNull();
  });

  it('HS2 a late answer for a tab the viewer left never writes the screen', async () => {
    let releaseEvents: (v: unknown) => void = () => {};
    mockGetFeed.mockImplementation((_s: string, tab: string) => {
      if (tab === 'events') return new Promise((r) => { releaseEvents = r; });
      if (tab === 'places') return Promise.resolve(page([PLACE], 'places'));
      return Promise.resolve(page([], tab));
    });
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText('Events')).not.toBeNull());
    await act(async () => { fireEvent.press(view.getByText('Events')); });
    await act(async () => { fireEvent.press(view.getByText('Places')); });
    await waitFor(() => expect(view.queryByText('Caffè Greco')).not.toBeNull());
    await act(async () => { releaseEvents(page([EVENT], 'events')); });
    await new Promise((r) => setTimeout(r, 20));
    expect(view.queryByText('Jazz night')).toBeNull();
    expect(view.queryByText('Caffè Greco')).not.toBeNull();
  });

  it('HS3 a failed hashtag read says it could not be loaded and offers a retry; a 404 still says unavailable', async () => {
    mockGetFeed.mockResolvedValue(page([EVENT], 'recent'));
    mockGetHashtag.mockResolvedValueOnce({ ok: false, status: 500, error: 'x' });
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText('This hashtag couldn’t be loaded just now')).not.toBeNull());
    expect(view.queryByText('It may have been removed or blocked.')).toBeNull();
    mockGetHashtag.mockResolvedValueOnce({ ok: true, data: META });
    await act(async () => { fireEvent.press(view.getByText('Try again')); });
    await waitFor(() => expect(view.queryByText('#romejazz')).not.toBeNull());

    mockGetHashtag.mockResolvedValueOnce({ ok: false, status: 404, error: 'Hashtag not found' });
    const gone = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(gone.queryByText('It may have been removed or blocked.')).not.toBeNull());
  });

  it('HS4 a 200 carrying a Discovery refusal is a failed read, never its rows', async () => {
    mockGetFeed.mockResolvedValue(page([], 'recent', { refusal: { class: 'transient_db', code: 'x', route: 'r', coverage: 'nothing' } }));
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText('Try again')).not.toBeNull());
    expect(view.queryByText('No recent content yet')).toBeNull();
  });

  it('HS5 CONTROL: a successful empty tab still says "No events content yet"', async () => {
    mockGetFeed.mockImplementation(async (_s: string, tab: string) => page([], tab));
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText('Events')).not.toBeNull());
    await act(async () => { fireEvent.press(view.getByText('Events')); });
    await waitFor(() => expect(view.queryByText('No events content yet')).not.toBeNull());
  });

  it('HS6 a load-more left pending when the viewer switches tab never leaves its spinner behind', async () => {
    mockGetFeed.mockImplementation((_s: string, tab: string, _sc: string, _c: unknown, before: string | null) => {
      if (before) return new Promise(() => {});
      if (tab === 'places') return Promise.resolve(page([PLACE], 'places'));
      return Promise.resolve(page([EVENT], tab, { hasMore: true, nextCursor: 'c1' }));
    });
    const view = await render(<HashtagFeedScreen />);
    await waitFor(() => expect(view.queryByText('Jazz night')).not.toBeNull());
    await act(async () => { fireEvent(view.getByTestId('hashtag-feed-list'), 'onEndReached'); });
    expect(view.queryByTestId('hashtag-feed-loading-more')).not.toBeNull();
    await act(async () => { fireEvent.press(view.getByText('Places')); });
    await waitFor(() => expect(view.queryByText('Caffè Greco')).not.toBeNull());
    expect(view.queryByTestId('hashtag-feed-loading-more')).toBeNull();
  });
});
