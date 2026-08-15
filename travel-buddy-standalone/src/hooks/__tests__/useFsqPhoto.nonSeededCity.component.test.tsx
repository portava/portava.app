/**
 * useFsqPhoto — the NON-SEEDED city path, which is the one nobody ran.
 *
 * WHAT THIS FILE IS FOR
 * =====================
 * On 2026-08-15 Discovery served zero real photos for OSM-only destinations,
 * with both providers dead at once. Confirmed by direct call:
 *
 *   Google Places API (New)  403 SERVICE_DISABLED (never enabled on the project)
 *   Foursquare               429 "account has no API credits remaining"
 *
 * The reason it went unseen is the part worth pinning in a test. **Every prior
 * verification used DB-backed cities.** Those carry a pre-seeded
 * `headerImageUrl`, and `useFsqPhoto` short-circuits on it:
 *
 *     if (existingUrl) return;      // no request is made, ever
 *
 * So the live provider chain was not "tested and passing" — it was NEVER
 * EXECUTED. A fixture that bypasses the code under test is a check that
 * examines nothing, and it passed every time for exactly that reason.
 *
 * These tests therefore use a place with **no** `existingUrl`, and stub
 * `fetch` rather than the lookup functions, so the real
 * `lookupFsqPhoto` / `lookupGooglePhoto` bodies run — including the `reason`
 * handling that turns a dead provider into an observable event instead of
 * silent category artwork.
 *
 * IF YOU ARE ABOUT TO MOCK THE LOOKUPS HERE, DON'T. Mocking
 * `../../services/fsqPhotoLookup.ts` (as the sibling googleFallback test does,
 * legitimately, for its own purpose) would delete the only coverage that the
 * live chain fires at all, and this file would go green while measuring
 * nothing — the precise failure it exists to prevent.
 *
 * WHAT IS AND IS NOT ESTABLISHED
 * ==============================
 * These tests prove the CLIENT chain fires and reports honestly. They do not
 * and cannot prove the providers work — both outages are account state outside
 * this repository (enable Places API (New); restore Foursquare credits). A
 * green run here means "we would notice", not "photos load".
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFsqPhoto } from '../useFsqPhoto.ts';
import {
  classifyPhotoReason,
  getPhotoOutages,
  hasPhotoProviderOutage,
  resetPhotoOutages,
} from '../../services/photoProviderOutage.ts';

// Deliberately NOT mocking the lookup services — see the header.

const FSQ_ROUTE = '/api/places/fsq-photo';
const GOOGLE_ROUTE = '/api/places/photo';

/** Unique per test: both lookups hold a module-level 24 h cache keyed by name. */
let seq = 0;
const uniqueName = () => `Non Seeded Venue ${Date.now()}_${seq++}`;

type FetchStub = jest.Mock<Promise<unknown>, [string, unknown?]>;

function stubFetch(byRoute: Record<string, { photoUrl: string | null; reason?: string }>): FetchStub {
  const stub = jest.fn(async (url: string) => {
    const match = Object.keys(byRoute).find((route) => url.includes(route));
    if (!match) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => byRoute[match],
    };
  }) as unknown as FetchStub;
  (globalThis as unknown as { fetch: unknown }).fetch = stub;
  return stub;
}

const calledRoutes = (stub: FetchStub): string[] =>
  stub.mock.calls.map(([url]) => String(url));

describe('useFsqPhoto — non-seeded city actually exercises the provider chain', () => {
  const realFetch = globalThis.fetch;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetPhotoOutages();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('fires BOTH provider requests when there is no pre-seeded image', async () => {
    const stub = stubFetch({
      [FSQ_ROUTE]: { photoUrl: null, reason: 'foursquare_quota_exhausted' },
      [GOOGLE_ROUTE]: { photoUrl: null, reason: 'google_places_api_new_service_disabled' },
    });

    const { result } = await renderHook(() => useFsqPhoto(uniqueName(), 10.311, 123.891));

    await waitFor(
      () => expect(calledRoutes(stub).some((u) => u.includes(GOOGLE_ROUTE))).toBe(true),
      { timeout: 3000 },
    );

    // The whole point: with no existingUrl the chain RUNS. A DB-backed city
    // would have made both of these zero and the suite would still be green.
    expect(calledRoutes(stub).some((u) => u.includes(FSQ_ROUTE))).toBe(true);
    expect(calledRoutes(stub).some((u) => u.includes(GOOGLE_ROUTE))).toBe(true);

    // Both providers down => no photo, and the card falls back to artwork.
    expect(result.current).toBeNull();
  });

  it('records BOTH outages instead of swallowing them', async () => {
    const stub = stubFetch({
      [FSQ_ROUTE]: { photoUrl: null, reason: 'foursquare_quota_exhausted' },
      [GOOGLE_ROUTE]: { photoUrl: null, reason: 'google_places_api_new_service_disabled' },
    });

    await renderHook(() => useFsqPhoto(uniqueName(), 10.311, 123.891));

    await waitFor(() => expect(getPhotoOutages().length).toBe(2), { timeout: 3000 });

    const outages = getPhotoOutages();
    expect(outages.map((o) => o.provider).sort()).toEqual(['foursquare', 'google']);
    // Every one of them is an OUTAGE — a statement about the provider, never
    // about the place.
    expect(outages.every((o) => o.kind === 'outage')).toBe(true);
    expect(hasPhotoProviderOutage()).toBe(true);

    // Loud: it reached the console rather than a counter nobody reads.
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('foursquare_quota_exhausted');
    expect(warned).toContain('google_places_api_new_service_disabled');

    void stub;
  });

  it('does NOT report an outage when the place genuinely has no photo', async () => {
    // The distinction the whole change exists to preserve. Same null result,
    // same category artwork on screen, categorically different meaning.
    stubFetch({
      [FSQ_ROUTE]: { photoUrl: null, reason: 'no_photo_found' },
      [GOOGLE_ROUTE]: { photoUrl: null, reason: 'no_photo_found' },
    });

    const { result } = await renderHook(() => useFsqPhoto(uniqueName(), 10.311, 123.891));

    await waitFor(() => expect(result.current).toBeNull(), { timeout: 3000 });
    // Give any late report a chance to land before asserting absence.
    await new Promise((r) => setTimeout(r, 150));

    expect(getPhotoOutages()).toEqual([]);
    expect(hasPhotoProviderOutage()).toBe(false);
  });
});

describe('useFsqPhoto — the seeded bypass, pinned so it stays visible', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('makes NO request at all when a pre-seeded image URL is present', async () => {
    const stub = stubFetch({
      [FSQ_ROUTE]: { photoUrl: null, reason: 'foursquare_quota_exhausted' },
      [GOOGLE_ROUTE]: { photoUrl: null, reason: 'google_places_api_new_service_disabled' },
    });

    const SEEDED = 'https://cdn.example.com/seeded-city-header.jpg';
    const { result } = await renderHook(() => useFsqPhoto(uniqueName(), 10.311, 123.891, SEEDED));

    expect(result.current).toBe(SEEDED);

    // Wait past the 500 ms debounce: if the bypass ever stops working this
    // becomes non-zero, and if the bypass ever silently WIDENS to cover
    // non-seeded places, the tests above go red instead.
    await new Promise((r) => setTimeout(r, 900));

    // THIS ZERO IS THE BUG'S ORIGIN, RECORDED AS AN ASSERTION. Verification
    // done only against cities like this one exercises none of the chain.
    expect(stub).not.toHaveBeenCalled();
    expect(result.current).toBe(SEEDED);
  });
});

describe('classifyPhotoReason — outage and absence are never conflated', () => {
  it('treats the two confirmed 2026-08-15 failures as outages', () => {
    expect(classifyPhotoReason('foursquare_quota_exhausted')).toBe('outage');
    expect(classifyPhotoReason('google_places_api_new_service_disabled')).toBe('outage');
    expect(classifyPhotoReason('foursquare_http_429')).toBe('outage');
    expect(classifyPhotoReason('foursquare_auth_error')).toBe('outage');
    expect(classifyPhotoReason('no_google_maps_key')).toBe('outage');
    // Present-but-empty is an outage too, and must never be 'unknown': an
    // unrecognised reason warns on every card, which would turn the new signal
    // into noise the first time a secret is blanked.
    expect(classifyPhotoReason('google_key_present_but_empty')).toBe('outage');
    expect(classifyPhotoReason('foursquare_key_present_but_empty')).toBe('outage');
    expect(classifyPhotoReason('request_failed')).toBe('outage');
  });

  it('treats only a real empty result as absence', () => {
    expect(classifyPhotoReason('no_photo_found')).toBe('absent');
  });

  it('refuses to guess at a reason it does not recognise', () => {
    // Not folded into either bucket: guessing is how "we could not look"
    // became "there is nothing to see" in the first place.
    expect(classifyPhotoReason('some_future_reason')).toBe('unknown');
    expect(classifyPhotoReason(null)).toBe('unknown');
  });
});
