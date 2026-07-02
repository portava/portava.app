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
