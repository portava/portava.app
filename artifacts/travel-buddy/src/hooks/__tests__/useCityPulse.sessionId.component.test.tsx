/**
 * useCityPulse.sessionId.component.test.tsx
 *
 * Confirms sessionId is cleared immediately when the user switches cities —
 * not carried over from the previous feed.
 *
 * Coverage:
 *   1. After a city-slug change, sessionId is undefined during the debounce
 *      window (before the next fetch resolves).
 *   2. Once the replacement fetch returns, sessionId is set to the new value.
 *
 * Strategy:
 *   Real timers + waitFor are used throughout (not fake timers).
 *   A comment in PulseLiveCarousel.component.test.tsx documents why fake
 *   timers + advanceTimersByTime inside async React 19 tests poison subsequent
 *   renders in the file — real timers + waitFor avoids that entirely.
 *
 *   For test 1 (debounce-window check), city B's fetchCityEvents returns a
 *   never-resolving promise.  That lets the debounce fire naturally (150 ms)
 *   without the fetch resolving, so sessionId stays undefined while we assert.
 *
 *   For test 2, city B's fetch resolves normally and waitFor polls until the
 *   hook has processed the result.
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

it('sessionId is undefined during the debounce window after switching cities', async () => {
  // City A fetch resolves with a known sessionId.
  (fetchCityEvents as jest.Mock).mockResolvedValue({
    events:    [],
    sessionId: 'sess-city-a',
  });

  const { result, rerender } = await renderHook(
    ({ slug }: { slug: string }) =>
      useCityPulse({ currentCitySlug: slug, ttlMs: TTL_LARGE }),
    { initialProps: { slug: 'cebu' } },
  );

  // Wait for city A's debounce + fetch to complete and sessionId to be set.
  await waitFor(() => {
    expect(result.current.sessionId).toBe('sess-city-a');
  }, { timeout: 500 });

  // City B fetch returns a never-resolving promise — sessionId stays undefined
  // for the entire duration of the test even after the debounce fires.
  (fetchCityEvents as jest.Mock).mockReturnValue(new Promise(() => { /* never resolves */ }));

  // Switch to a new city slug — the hook's useEffect cleanup runs and a new
  // effect fires, which synchronously calls setSessionId(undefined) before
  // the debounce timer or fetch has a chance to run.
  rerender({ slug: 'manila' });

  // sessionId must be cleared immediately; city B's fetch is still pending.
  await waitFor(() => {
    expect(result.current.sessionId).toBeUndefined();
  }, { timeout: 500 });
});

it('sessionId stays undefined after the city-switch fetch errors — old session is not replayed', async () => {
  // City A fetch resolves with a known sessionId.
  (fetchCityEvents as jest.Mock).mockResolvedValue({
    events:    [],
    sessionId: 'sess-city-a',
  });

  const { result, rerender } = await renderHook(
    ({ slug }: { slug: string }) =>
      useCityPulse({ currentCitySlug: slug, ttlMs: TTL_LARGE }),
    { initialProps: { slug: 'cebu' } },
  );

  // Wait for city A to complete and sessionId to be set.
  await waitFor(() => {
    expect(result.current.sessionId).toBe('sess-city-a');
  }, { timeout: 500 });

  // City B fetch rejects — simulates a network or server error.
  (fetchCityEvents as jest.Mock).mockRejectedValue(new Error('network error'));

  // Switch to city B — the hook clears sessionId synchronously then debounces.
  rerender({ slug: 'manila' });

  // After the debounce fires and city B's fetch rejects, sessionId must remain
  // undefined — it must not fall back to city A's stale 'sess-city-a' value.
  await waitFor(() => {
    expect(result.current.sessionId).toBeUndefined();
  }, { timeout: 500 });
});

it('sessionId is cleared when currentCitySlug is set to undefined', async () => {
  // City A fetch resolves with a known sessionId.
  (fetchCityEvents as jest.Mock).mockResolvedValue({
    events:    [],
    sessionId: 'sess-city-a',
  });

  const { result, rerender } = await renderHook(
    ({ slug }: { slug: string | undefined }) =>
      useCityPulse({ currentCitySlug: slug, ttlMs: TTL_LARGE }),
    { initialProps: { slug: 'cebu' as string | undefined } },
  );

  // Wait for city A's debounce + fetch to complete and sessionId to be set.
  await waitFor(() => {
    expect(result.current.sessionId).toBe('sess-city-a');
  }, { timeout: 500 });

  // Set slug to undefined (e.g. user closes the city picker).
  rerender({ slug: undefined });

  // sessionId must be cleared immediately — not frozen on the last city's value.
  await waitFor(() => {
    expect(result.current.sessionId).toBeUndefined();
  }, { timeout: 500 });
});

it('sessionId is set to the new value once the replacement fetch resolves', async () => {
  // City A fetch resolves with its own sessionId.
  (fetchCityEvents as jest.Mock).mockResolvedValue({
    events:    [],
    sessionId: 'sess-city-a',
  });

  const { result, rerender } = await renderHook(
    ({ slug }: { slug: string }) =>
      useCityPulse({ currentCitySlug: slug, ttlMs: TTL_LARGE }),
    { initialProps: { slug: 'cebu' } },
  );

  // Wait for city A to complete.
  await waitFor(() => {
    expect(result.current.sessionId).toBe('sess-city-a');
  }, { timeout: 500 });

  // Switch to city B — its fetch returns a distinct sessionId.
  (fetchCityEvents as jest.Mock).mockResolvedValue({
    events:    [],
    sessionId: 'sess-city-b',
  });

  rerender({ slug: 'manila' });

  // sessionId is cleared synchronously on city switch (before debounce fires).
  await waitFor(() => {
    expect(result.current.sessionId).toBeUndefined();
  }, { timeout: 500 });

  // After the debounce fires and city B's fetch resolves, sessionId must
  // reflect the new session — not city A's stale value.
  await waitFor(() => {
    expect(result.current.sessionId).toBe('sess-city-b');
  }, { timeout: 500 });
});
