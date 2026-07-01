/**
 * useCityPulse.test.ts
 *
 * Unit tests for the two exported pure functions in useCityPulse.ts:
 *
 *   mapApiEvent     — maps a raw /api/events response item to CityEvent
 *   fetchCityEvents — fetches and maps events; throws on non-ok status
 *
 * These cover:
 *   • the response-shape mapper (field name translation + defaults)
 *   • blockOf() time-block assignment via the `block` field
 *   • graceful error paths (non-ok HTTP, network failure)
 *   • the empty-events case (valid "no events now" state, not a fallback)
 *
 * Run:
 *   node --import tsx/esm --test src/hooks/__tests__/useCityPulse.test.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mapApiEvent, fetchCityEvents } from '../cityPulseUtils.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

type FakeFetch = (url: string | URL | Request, opts?: RequestInit) => Promise<Response>;

function makeFakeResponse(ok: boolean, body: unknown, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// ═══════════════════════════════════════════════════════════════════════════════
// mapApiEvent — response shape mapper
// ═══════════════════════════════════════════════════════════════════════════════

describe('mapApiEvent — response shape mapper', () => {
  test('maps all required CityEvent fields from a full API response item', () => {
    const raw = {
      id:             'ev1',
      kind:           'meetup',
      title:          'Sunset mixer',
      city:           'Cebu City',
      city_slug:      'cebu',
      start_time:     '2026-06-20T19:00:00+08:00',
      category:       'social',
      attendee_count: 12,
      max_capacity:   30,
    };

    const ev = mapApiEvent(raw, 'Cebu City', 'cebu');

    assert.equal(ev.id,            'ev1');
    assert.equal(ev.kind,          'meetup');
    assert.equal(ev.title,         'Sunset mixer');
    assert.equal(ev.city,          'Cebu City');
    assert.equal(ev.citySlug,      'cebu');
    assert.equal(ev.startAt,       '2026-06-20T19:00:00+08:00');
    assert.equal(ev.category,      'social');
    assert.equal(ev.attendeeCount, 12);
    assert.equal(ev.capacity,      30);
    assert.equal(ev.score,         null);
  });

  test('blockOf: assigns "morning" for start_time before 12:00', () => {
    const raw = { id: 'e', title: 'Yoga', start_time: '2026-06-20T08:00:00Z' };
    assert.equal(mapApiEvent(raw, 'Cebu', 'cebu').block, 'morning');
  });

  test('blockOf: assigns "afternoon" for start_time 12:00–16:59', () => {
    const raw = { id: 'e', title: 'Tour', start_time: '2026-06-20T14:00:00Z' };
    assert.equal(mapApiEvent(raw, 'Cebu', 'cebu').block, 'afternoon');
  });

  test('blockOf: assigns "evening" for start_time 17:00–21:59', () => {
    const raw = { id: 'e', title: 'Dinner', start_time: '2026-06-20T19:00:00Z' };
    assert.equal(mapApiEvent(raw, 'Cebu', 'cebu').block, 'evening');
  });

  test('blockOf: assigns "late" for start_time 22:00 and later', () => {
    const raw = { id: 'e', title: 'Club night', start_time: '2026-06-20T23:00:00Z' };
    assert.equal(mapApiEvent(raw, 'Cebu', 'cebu').block, 'late');
  });

  test('falls back to city and citySlug from context args when absent in response', () => {
    const raw = { id: 'e', title: 'Beach run', start_time: '2026-06-20T07:00:00Z' };
    const ev = mapApiEvent(raw, 'Manila', 'manila');
    assert.equal(ev.city,     'Manila');
    assert.equal(ev.citySlug, 'manila');
  });

  test('falls back kind to "event" when absent in response', () => {
    const raw = { id: 'e', title: 'Something', start_time: '2026-06-20T08:00:00Z' };
    assert.equal(mapApiEvent(raw, 'Bangkok', 'bangkok').kind, 'event');
  });

  test('falls back category to "social" when absent in response', () => {
    const raw = { id: 'e', title: 'Something', start_time: '2026-06-20T08:00:00Z' };
    assert.equal(mapApiEvent(raw, 'Bangkok', 'bangkok').category, 'social');
  });

  test('falls back attendeeCount to 0 when absent in response', () => {
    const raw = { id: 'e', title: 'Something', start_time: '2026-06-20T08:00:00Z' };
    assert.equal(mapApiEvent(raw, 'Bangkok', 'bangkok').attendeeCount, 0);
  });

  test('capacity is undefined (not 0) when max_capacity is absent in response', () => {
    const raw = { id: 'e', title: 'Something', start_time: '2026-06-20T08:00:00Z' };
    assert.equal(mapApiEvent(raw, 'Bangkok', 'bangkok').capacity, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fetchCityEvents — fetch + map + error paths
// ═══════════════════════════════════════════════════════════════════════════════

describe('fetchCityEvents — fetch, map, and error paths', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => { originalFetch = globalThis.fetch; });
  after(()  => { globalThis.fetch = originalFetch; });

  test('returns mapped CityEvent[] when the API responds with HTTP 200 and events', async () => {
    const apiEvent = {
      id:             'ev1',
      kind:           'plan',
      title:          'IT Park food crawl',
      city:           'Cebu',
      city_slug:      'cebu',
      start_time:     '2026-06-20T19:00:00Z',  // 19:00 UTC → blockOf returns 'evening'
      category:       'food',
      attendee_count: 7,
      max_capacity:   10,
    };
    globalThis.fetch = async () => makeFakeResponse(true, { events: [apiEvent] }) as Response;

    const results = await fetchCityEvents('https://api.example.com', 'test-token', 'Cebu', 'cebu');

    assert.equal(results.length, 1);
    assert.equal(results[0].id,            'ev1');
    assert.equal(results[0].title,         'IT Park food crawl');
    assert.equal(results[0].citySlug,      'cebu');
    assert.equal(results[0].block,         'evening');  // 19:00 UTC → evening (17–21)
    assert.equal(results[0].attendeeCount, 7);
    assert.equal(results[0].capacity,      10);
  });

  test('returns [] when the API returns an empty events array (valid no-events state)', async () => {
    globalThis.fetch = async () => makeFakeResponse(true, { events: [] }) as Response;

    const results = await fetchCityEvents('https://api.example.com', 'test-token', 'Cebu', 'cebu');
    assert.equal(results.length, 0);
  });

  test('throws on HTTP 503 so the hook can catch and fall back to mock data in dev', async () => {
    globalThis.fetch = async () => makeFakeResponse(false, { message: 'Service Unavailable' }, 503) as Response;

    await assert.rejects(
      () => fetchCityEvents('https://api.example.com', 'test-token', 'Cebu', 'cebu'),
      /HTTP 503/,
    );
  });

  test('throws on HTTP 401 (expired token) so the hook can catch and fall back', async () => {
    globalThis.fetch = async () => makeFakeResponse(false, { message: 'JWT expired' }, 401) as Response;

    await assert.rejects(
      () => fetchCityEvents('https://api.example.com', 'test-token', 'Cebu', 'cebu'),
      /HTTP 401/,
    );
  });

  test('propagates network errors so the hook can catch and fall back to mock data in dev', async () => {
    globalThis.fetch = async () => { throw new Error('network unreachable'); };

    await assert.rejects(
      () => fetchCityEvents('https://api.example.com', 'test-token', 'Cebu', 'cebu'),
      /network unreachable/,
    );
  });

  test('sends Authorization: Bearer header with the provided token', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedInit = opts;
      return makeFakeResponse(true, { events: [] }) as Response;
    };

    await fetchCityEvents('https://api.example.com', 'my-jwt-token', 'Cebu', 'cebu');

    const headers = capturedInit?.headers as Record<string, string> | undefined;
    assert.ok(
      headers?.['Authorization'] === 'Bearer my-jwt-token',
      `Expected Authorization: Bearer my-jwt-token, got: ${JSON.stringify(headers)}`,
    );
  });

  test('encodes city and state=open as query params in the request URL', async () => {
    let capturedUrl = '';
    globalThis.fetch = async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return makeFakeResponse(true, { events: [] }) as Response;
    };

    await fetchCityEvents('https://api.example.com', 'tok', 'New York', 'new-york');

    assert.ok(
      capturedUrl.includes('city=New+York') || capturedUrl.includes('city=New%20York'),
      `Expected city in URL, got: ${capturedUrl}`,
    );
    assert.ok(capturedUrl.includes('state=open'), `Expected state=open in URL, got: ${capturedUrl}`);
  });
});
