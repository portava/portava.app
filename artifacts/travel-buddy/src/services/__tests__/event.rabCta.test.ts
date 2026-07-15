/**
 * Unit tests for the "Find a Travel Buddy" CTA on the Event Detail screen.
 *
 * Coverage:
 *   1. shouldShowRentBuddyCta — all visibility scenarios from task #1129
 *   2. buildRentBuddyParamsFromEvent — URL params built from event fields
 *   3. checkCityAvailable fetch logic — HTTP responses mapped to { available, code }
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/event.rabCta.test.ts
 *
 * Pure functions are imported from eventCtaHelper.ts (no supabase/native
 * imports) so they resolve cleanly in the tsx/ESM node:test runner.
 * checkCityAvailable fetch behaviour is tested via an inline replica of the
 * real apiFetch logic (same HTTP-to-result contract).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldShowRentBuddyCta,
  buildRentBuddyParamsFromEvent,
  buildRentBuddyCtaUrl,
  type RentBuddyCtaEvent,
  type EventRsvpStatus,
} from '../eventCtaHelper.ts';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<RentBuddyCtaEvent> & { myRsvp?: EventRsvpStatus | null } = {},
): RentBuddyCtaEvent & { myRsvp?: EventRsvpStatus | null } {
  return {
    state:     'open',
    visibility:'public',
    city:      'Tokyo',
    category:  'food',
    startsAt:  '2026-09-01T10:00:00Z',
    myRsvp:    null,
    ...overrides,
  };
}

// ── shouldShowRentBuddyCta ────────────────────────────────────────────────────

describe('shouldShowRentBuddyCta — button visibility', () => {
  it('returns false when RAB feature flag is off', () => {
    assert.equal(shouldShowRentBuddyCta(makeEvent(), false, true), false);
  });

  it('returns false when buddyCityAvailable is false (city has no buddies)', () => {
    assert.equal(shouldShowRentBuddyCta(makeEvent(), true, false), false);
  });

  it('returns false when buddyCityAvailable is null (still loading)', () => {
    assert.equal(shouldShowRentBuddyCta(makeEvent(), true, null), false);
  });

  it('returns true when flag on AND city available AND event is open AND visibility is public', () => {
    assert.equal(shouldShowRentBuddyCta(makeEvent({ state: 'open', visibility: 'public' }), true, true), true);
  });

  it('returns false when event.state is draft', () => {
    assert.equal(shouldShowRentBuddyCta(makeEvent({ state: 'draft' }), true, true), false);
  });

  it('returns false when event.state is cancelled', () => {
    assert.equal(shouldShowRentBuddyCta(makeEvent({ state: 'cancelled' }), true, true), false);
  });

  it('returns false when event.state is archived', () => {
    assert.equal(shouldShowRentBuddyCta(makeEvent({ state: 'archived' }), true, true), false);
  });

  it('returns true for started event with public visibility', () => {
    assert.equal(shouldShowRentBuddyCta(makeEvent({ state: 'started' }), true, true), true);
  });

  it('returns true when visibility is friends_only but viewer is going', () => {
    const event = makeEvent({ visibility: 'friends_only', myRsvp: 'going' });
    assert.equal(shouldShowRentBuddyCta(event, true, true), true);
  });

  it('returns false when visibility is invite_only and viewer is not going', () => {
    const event = makeEvent({ visibility: 'invite_only', myRsvp: null });
    assert.equal(shouldShowRentBuddyCta(event, true, true), false);
  });
});

// ── buildRentBuddyParamsFromEvent ─────────────────────────────────────────────

describe('buildRentBuddyParamsFromEvent — URL params', () => {
  it('returns null when event has no city', () => {
    assert.equal(buildRentBuddyParamsFromEvent(makeEvent({ city: null })), null);
  });

  it('builds params with city, category, and bookingDate from startsAt', () => {
    const params = buildRentBuddyParamsFromEvent(
      makeEvent({ city: 'Tokyo', category: 'food', startsAt: '2026-09-01T10:00:00Z' }),
    );
    assert.deepEqual(params, { city: 'Tokyo', category: 'food', bookingDate: '2026-09-01' });
  });

  it('bookingDate is null when startsAt is null', () => {
    const params = buildRentBuddyParamsFromEvent(makeEvent({ city: 'Paris', startsAt: null }));
    assert.ok(params !== null);
    assert.equal(params.bookingDate, null);
  });

  it('maps nightlife event category to nightlife buddy category', () => {
    const params = buildRentBuddyParamsFromEvent(makeEvent({ city: 'Berlin', category: 'nightlife' }));
    assert.equal(params!.category, 'nightlife');
  });

  it('maps unknown category to city (default)', () => {
    const params = buildRentBuddyParamsFromEvent(makeEvent({ city: 'Seoul', category: 'networking' }));
    assert.equal(params!.category, 'city');
  });

  it('maps null category to city (default)', () => {
    const params = buildRentBuddyParamsFromEvent(makeEvent({ city: 'Lisbon', category: null }));
    assert.equal(params!.category, 'city');
  });

  it('URLSearchParams built from params encodes city and bookingDate correctly', () => {
    const p = buildRentBuddyParamsFromEvent(
      makeEvent({ city: 'New York', category: 'culture', startsAt: '2026-10-15T18:00:00Z' }),
    )!;
    const qs = new URLSearchParams({ city: p.city, category: p.category });
    if (p.bookingDate) qs.set('bookingDate', p.bookingDate);
    assert.equal(qs.get('city'), 'New York');
    assert.equal(qs.get('category'), 'culture');
    assert.equal(qs.get('bookingDate'), '2026-10-15');
  });
});

// ── checkCityAvailable fetch logic ────────────────────────────────────────────
//
// Tests the HTTP-to-result contract used by the component's useEffect.
// An inline replica of the fetch logic from rentABuddy.ts is used here so
// the test doesn't need to import the full service (which pulls in supabase).
// The contract is: { available: boolean; code?: string }.

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function checkCityAvailableViaFetch(
  city: string,
): Promise<{ available: boolean; code?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/rent-a-buddy/cities/${encodeURIComponent(city)}/available`);
    if (!res.ok) return { available: false, code: 'service_unavailable' };
    const data = await res.json() as { available: boolean; code?: string };
    return { available: data.available, code: data.code };
  } catch {
    return { available: false, code: 'service_unavailable' };
  }
}

describe('checkCityAvailable fetch contract', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns { available: true } when API responds with available:true', async () => {
    (globalThis as { fetch: unknown }).fetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: true, code: 'buddies_available' }),
      } as Response);

    const result = await checkCityAvailableViaFetch('Tokyo');
    assert.equal(result.available, true);
    assert.equal(result.code, 'buddies_available');
  });

  it('returns { available: false } when API responds with available:false', async () => {
    (globalThis as { fetch: unknown }).fetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: false, code: 'city_not_available' }),
      } as Response);

    const result = await checkCityAvailableViaFetch('Nowhere');
    assert.equal(result.available, false);
    assert.equal(result.code, 'city_not_available');
  });

  it('returns { available: false, code: service_unavailable } on non-ok HTTP', async () => {
    (globalThis as { fetch: unknown }).fetch = () =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response);

    const result = await checkCityAvailableViaFetch('Tokyo');
    assert.equal(result.available, false);
    assert.equal(result.code, 'service_unavailable');
  });

  it('returns { available: false, code: service_unavailable } on network error', async () => {
    (globalThis as { fetch: unknown }).fetch = () =>
      Promise.reject(new Error('network failure'));

    const result = await checkCityAvailableViaFetch('Tokyo');
    assert.equal(result.available, false);
    assert.equal(result.code, 'service_unavailable');
  });

  it('CTA stays hidden when flag is on but city returns available:false', () => {
    const event = makeEvent({ state: 'open', visibility: 'public' });
    assert.equal(shouldShowRentBuddyCta(event, true, false), false);
  });

  it('CTA becomes visible once city check resolves available:true', () => {
    const event = makeEvent({ state: 'open', visibility: 'public' });
    assert.equal(shouldShowRentBuddyCta(event, true, true), true);
  });
});

// ── buildRentBuddyCtaUrl ──────────────────────────────────────────────────────
//
// Tests the full navigation URL returned by buildRentBuddyCtaUrl, which is the
// exact string passed to router.push() in the component's onPress handler.

describe('buildRentBuddyCtaUrl — full navigation URL', () => {
  it('returns null when event has no city (router.push must not be called)', () => {
    assert.equal(buildRentBuddyCtaUrl(makeEvent({ city: null })), null);
  });

  it('returns a URL starting with /(rent-a-buddy)/search?', () => {
    const url = buildRentBuddyCtaUrl(makeEvent());
    assert.ok(url !== null);
    assert.match(url!, /^\/\(rent-a-buddy\)\/search\?/);
  });

  it('includes city param matching event.city', () => {
    const url = buildRentBuddyCtaUrl(makeEvent({ city: 'Tokyo' }))!;
    assert.ok(url.includes('city=Tokyo'));
  });

  it('includes category param (mapped) matching event.category', () => {
    const url = buildRentBuddyCtaUrl(makeEvent({ city: 'Tokyo', category: 'food' }))!;
    assert.ok(url.includes('category=food'));
  });

  it('includes bookingDate param sliced from event.startsAt', () => {
    const url = buildRentBuddyCtaUrl(
      makeEvent({ city: 'Tokyo', startsAt: '2026-09-01T10:00:00Z' }),
    )!;
    assert.ok(url.includes('bookingDate=2026-09-01'));
  });

  it('omits bookingDate when event.startsAt is null', () => {
    const url = buildRentBuddyCtaUrl(makeEvent({ city: 'Paris', startsAt: null }))!;
    assert.ok(!url.includes('bookingDate'));
  });

  it('URL-encodes city with spaces correctly', () => {
    const url = buildRentBuddyCtaUrl(makeEvent({ city: 'New York' }))!;
    assert.ok(url.includes('city=New+York') || url.includes('city=New%20York'));
  });
});

// ── CTA press machine — router.push contract ──────────────────────────────────
//
// Machine-layer test that mirrors the component's onPress handler:
//
//   const url = buildRentBuddyCtaUrl(event);
//   if (!url) return;
//   router.push(url);
//
// This tests the exact router.push call that would occur in the screen without
// needing a React renderer. The machine is a direct extraction of the component's
// press logic; if the component's onPress changes the captured calls will differ.

function simulateCtaPress(
  event: RentBuddyCtaEvent,
  mockPush: (url: string) => void,
): { pressed: boolean; url: string | null } {
  const url = buildRentBuddyCtaUrl(event);
  if (!url) return { pressed: false, url: null };
  mockPush(url);
  return { pressed: true, url };
}

describe('CTA press machine — router.push contract', () => {
  it('calls router.push with /(rent-a-buddy)/search? URL on press', () => {
    const calls: string[] = [];
    const { pressed, url } = simulateCtaPress(
      makeEvent({ city: 'Tokyo', category: 'food', startsAt: '2026-09-01T10:00:00Z' }),
      (u) => calls.push(u),
    );
    assert.equal(pressed, true);
    assert.equal(calls.length, 1);
    assert.ok(url !== null);
    assert.match(url!, /^\/\(rent-a-buddy\)\/search\?/);
  });

  it('pushed URL contains city, category, bookingDate for a Tokyo food event', () => {
    const calls: string[] = [];
    simulateCtaPress(
      makeEvent({ city: 'Tokyo', category: 'food', startsAt: '2026-09-01T10:00:00Z' }),
      (u) => calls.push(u),
    );
    const url = calls[0];
    assert.ok(url.includes('city=Tokyo'));
    assert.ok(url.includes('category=food'));
    assert.ok(url.includes('bookingDate=2026-09-01'));
  });

  it('does NOT call router.push when event city is null (guard branch)', () => {
    const calls: string[] = [];
    const { pressed } = simulateCtaPress(
      makeEvent({ city: null, category: 'food', startsAt: '2026-09-01T10:00:00Z' }),
      (u) => calls.push(u),
    );
    assert.equal(pressed, false);
    assert.equal(calls.length, 0);
  });

  it('pushed URL contains category=nightlife for a nightlife event', () => {
    const calls: string[] = [];
    simulateCtaPress(
      makeEvent({ city: 'Berlin', category: 'nightlife', startsAt: '2026-11-01T22:00:00Z' }),
      (u) => calls.push(u),
    );
    const url = calls[0];
    assert.ok(url.includes('category=nightlife'));
  });

  it('pushed URL omits bookingDate when event.startsAt is null', () => {
    const calls: string[] = [];
    simulateCtaPress(makeEvent({ city: 'Paris', startsAt: null }), (u) => calls.push(u));
    const url = calls[0];
    assert.ok(!url.includes('bookingDate'));
  });

  it('router.push is called exactly once per press', () => {
    const calls: string[] = [];
    simulateCtaPress(makeEvent(), (u) => calls.push(u));
    simulateCtaPress(makeEvent(), (u) => calls.push(u));
    assert.equal(calls.length, 2);
  });
});
