/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): useCityPulse says when it could not read today's
 * events, instead of answering an empty list that reads as "nothing today".
 *
 * A failed GET /events read set `events` to `[]` in production (resolveEventsOnError), and a cut one (`notWhole`, from
 * GET /events' `truncated`) was taken as whole, so Pulse said "No plans fit your availability yet." and Explore Today
 * "Nothing on the calendar". The hook now returns `eventsUnread`. The harness is useCityPulse.sessionId's.
 *
 *   UP1  the fetch rejects → eventsUnread 'failed' (and events stay [] in production)
 *   UP2  the fetch answers notWhole → eventsUnread 'partial'
 *   UP3  a city switch clears the mark until the new city's read answers
 *   UP0  CONTROL: a whole answer → eventsUnread null
 */
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';

// ── module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — cityPulseUtils is a pure-function module
// with no native dependencies; the three stubs below are the only exports
// called inside useCityPulse's useEffect.
jest.mock('../cityPulseUtils.ts', () => ({
  fetchCityEvents:        jest.fn(),
  resolveEventsOnSuccess: (events: unknown[]) => events,
  resolveEventsOnError:   () => [],
  mapApiEvent:            jest.fn(),
}));

// NOTE: intentionally exhaustive — apiToken exposes a single async helper;
// the stub returns a stable token so the hook never hits the no-token branch.
jest.mock('../../services/apiToken.ts', () => ({
  freshToken: jest.fn(),
}));

// NOTE: intentionally exhaustive — AvailabilityStore is a React context
// module that uses native modules under the hood; the stub returns enough
// shape for useAvailability() inside useCityPulse to run without crashing.
jest.mock('../../context/AvailabilityStore.tsx', () => ({
  useAvailabilityStore: () => ({ availability: null }),
}));

// NOTE: intentionally exhaustive — recommend / availability are pure helpers
// whose outputs feed buckets / status, neither of which affects sessionId.
jest.mock('../../lib/recommend.ts',    () => ({ filterPulse:    () => ({}) }));
jest.mock('../../lib/availability.ts', () => ({ resolveStatus: () => 'available' }));

// NOTE: intentionally exhaustive — mockEvents is only used in __DEV__ fallback
// paths that are unreachable here because EXPO_PUBLIC_API_BASE_URL is always set.
jest.mock('../../data/events.ts', () => ({ mockEvents: [] }));

// ── import hook + mocked deps after mock declarations ─────────────────────────

import { useCityPulse }    from '../useCityPulse.ts';
import { fetchCityEvents } from '../cityPulseUtils.ts';
import { freshToken }      from '../../services/apiToken.ts';

// ── constants ─────────────────────────────────────────────────────────────────

/** Long TTL so the background re-fetch timer never fires during tests. */
const TTL_LARGE = 60 * 60 * 1000;

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Provide a non-empty base URL so useCityPulse enters the real fetch path
  // instead of the __DEV__ mockEvents fallback.
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test.example.com';

  (freshToken      as jest.Mock).mockResolvedValue('test-token');
  (fetchCityEvents as jest.Mock).mockResolvedValue({ events: [], sessionId: undefined });
});

afterEach(async () => {
  delete process.env.EXPO_PUBLIC_API_BASE_URL;
  jest.clearAllMocks();
  // Drain any pending async state updates so they don't bleed into the next test.
  await act(async () => {});
});

// ── tests ─────────────────────────────────────────────────────────────────────

const open = (slug = 'lisbon') => renderHook(
  ({ s }: { s: string }) => useCityPulse({ currentCitySlug: s, ttlMs: TTL_LARGE }),
  { initialProps: { s: slug } },
);

it('UP1 the fetch rejects → eventsUnread "failed"', async () => {
  (fetchCityEvents as jest.Mock).mockRejectedValue(new Error('HTTP 503'));
  const { result } = await open();
  await waitFor(() => expect(result.current.eventsUnread).toBe('failed'), { timeout: 500 });
  expect(result.current.events).toEqual([]);
});

it('UP2 the fetch answers notWhole → eventsUnread "partial"', async () => {
  (fetchCityEvents as jest.Mock).mockResolvedValue({ events: [], sessionId: 's1', notWhole: true });
  const { result } = await open();
  await waitFor(() => expect(result.current.eventsUnread).toBe('partial'), { timeout: 500 });
});

it('UP3 a city switch clears the mark until the new read answers', async () => {
  (fetchCityEvents as jest.Mock).mockRejectedValue(new Error('HTTP 503'));
  const { result, rerender } = await open('lisbon');
  await waitFor(() => expect(result.current.eventsUnread).toBe('failed'), { timeout: 500 });
  (fetchCityEvents as jest.Mock).mockReturnValue(new Promise(() => { /* never resolves */ }));
  await rerender({ s: 'porto' });
  await waitFor(() => expect(result.current.eventsUnread).toBeNull(), { timeout: 500 });
});

it('UP4 no API token → eventsUnread "failed"', async () => {
  (freshToken as jest.Mock).mockResolvedValue(null);
  const { result } = await open();
  await waitFor(() => expect(result.current.eventsUnread).toBe('failed'), { timeout: 500 });
  expect(fetchCityEvents).not.toHaveBeenCalled();
});

it('UP5 the city is cleared after a failed read → eventsUnread null', async () => {
  (fetchCityEvents as jest.Mock).mockRejectedValue(new Error('HTTP 503'));
  const { result, rerender } = await open('lisbon');
  await waitFor(() => expect(result.current.eventsUnread).toBe('failed'), { timeout: 500 });
  await rerender({ s: '' });
  await waitFor(() => expect(result.current.eventsUnread).toBeNull(), { timeout: 500 });
});

it('UP0 CONTROL: a whole answer → eventsUnread null', async () => {
  (fetchCityEvents as jest.Mock).mockResolvedValue({ events: [], sessionId: 's1' });
  const { result } = await open();
  await waitFor(() => expect(result.current.sessionId).toBe('s1'), { timeout: 500 });
  expect(result.current.eventsUnread ?? null).toBeNull();
});
