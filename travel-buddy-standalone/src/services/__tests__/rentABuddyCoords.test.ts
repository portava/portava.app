/**
 * Coord both-or-null contract tests for Rent-a-Buddy service functions.
 *
 * Confirms that searchBuddies, createRequest, and joinWaitlistV2 never send a
 * half-pair (lat without lng, or vice versa) to the API. A half-pair causes
 * server-side validation errors and silent geo-ranking failures.
 *
 * Uses globalThis.fetch interception to capture the serialised request body
 * without making real network calls.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx/esm --test src/services/__tests__/rentABuddyCoords.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { searchBuddies, createRequest, joinWaitlistV2 } from '../rentABuddy.ts';

// ── Fake Supabase client (returns a stable token so authHeaders doesn't throw) ─

const FAKE_SUPABASE = {
  auth: {
    async getSession() {
      return {
        data: {
          session: {
            access_token: 'test-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      };
    },
    async refreshSession() {
      return { data: { session: { access_token: 'test-token' } } };
    },
  },
};

// ── Fetch capture helpers ─────────────────────────────────────────────────────

let _savedFetch: typeof globalThis.fetch | undefined;

function installCaptureFetch(): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  _savedFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: unknown, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response;
  };
  return { bodies };
}

function restoreFetch() {
  if (_savedFetch !== undefined) {
    (globalThis as any).fetch = _savedFetch;
    _savedFetch = undefined;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  _setTestSupabase(FAKE_SUPABASE);
});

afterEach(() => {
  _resetTestSupabase();
  restoreFetch();
});

// ── searchBuddies ─────────────────────────────────────────────────────────────

describe('searchBuddies — coord both-or-null contract', () => {
  it('sends both lat and lng when both are provided', async () => {
    const { bodies } = installCaptureFetch();
    await searchBuddies({ city: 'Tokyo', lat: 35.6762, lng: 139.6503 });
    assert.equal(bodies.length, 1);
    const body = bodies[0] as any;
    assert.equal(body.lat, 35.6762, 'lat must be present when both coords are provided');
    assert.equal(body.lng, 139.6503, 'lng must be present when both coords are provided');
  });

  it('omits both lat and lng when only lat is provided', async () => {
    const { bodies } = installCaptureFetch();
    await searchBuddies({ city: 'Tokyo', lat: 35.6762 });
    assert.equal(bodies.length, 1);
    const body = bodies[0] as any;
    assert.equal('lat' in body, false, 'lat must be omitted when lng is missing');
    assert.equal('lng' in body, false, 'lng must be omitted when lng is missing');
  });

  it('omits both lat and lng when only lng is provided', async () => {
    const { bodies } = installCaptureFetch();
    await searchBuddies({ city: 'Tokyo', lng: 139.6503 });
    assert.equal(bodies.length, 1);
    const body = bodies[0] as any;
    assert.equal('lat' in body, false, 'lat must be omitted when lat is missing');
    assert.equal('lng' in body, false, 'lng must be omitted when lat is missing');
  });

  it('still forwards non-coord fields when coords are omitted', async () => {
    const { bodies } = installCaptureFetch();
    await searchBuddies({ city: 'Paris', category: 'food', groupSize: 2 });
    const body = bodies[0] as any;
    assert.equal(body.city, 'Paris');
    assert.equal(body.category, 'food');
    assert.equal(body.groupSize, 2);
  });
});

// ── createRequest ─────────────────────────────────────────────────────────────

describe('createRequest — coord both-or-null contract', () => {
  it('sends both lat and lng when both are provided', async () => {
    const { bodies } = installCaptureFetch();
    await createRequest({ city: 'Osaka', lat: 34.6937, lng: 135.5023, category: 'city' });
    assert.equal(bodies.length, 1);
    const body = bodies[0] as any;
    assert.equal(body.lat, 34.6937);
    assert.equal(body.lng, 135.5023);
  });

  it('omits both lat and lng when only lat is provided', async () => {
    const { bodies } = installCaptureFetch();
    await createRequest({ city: 'Osaka', lat: 34.6937, category: 'city' });
    assert.equal(bodies.length, 1);
    const body = bodies[0] as any;
    assert.equal('lat' in body, false, 'lat must be stripped when lng is absent');
    assert.equal('lng' in body, false, 'lng must be stripped when lng is absent');
    assert.equal(body.city, 'Osaka', 'non-coord fields must still be forwarded');
  });

  it('omits both lat and lng when only lng is provided', async () => {
    const { bodies } = installCaptureFetch();
    await createRequest({ city: 'Osaka', lng: 135.5023, category: 'city' });
    const body = bodies[0] as any;
    assert.equal('lat' in body, false);
    assert.equal('lng' in body, false);
  });

  it('cross-checks both deleted paths against storageCalls — non-coord fields survive', async () => {
    const { bodies } = installCaptureFetch();
    await createRequest({ city: 'Seoul', category: 'nightlife', groupSize: 3, notes: 'hi' });
    const body = bodies[0] as any;
    assert.equal(body.city, 'Seoul');
    assert.equal(body.category, 'nightlife');
    assert.equal(body.groupSize, 3);
    assert.equal(body.notes, 'hi');
  });
});

// ── joinWaitlistV2 ────────────────────────────────────────────────────────────

describe('joinWaitlistV2 — coord both-or-null contract', () => {
  it('sends both lat and lng when both are provided', async () => {
    const { bodies } = installCaptureFetch();
    await joinWaitlistV2({ city: 'Bangkok', lat: 13.7563, lng: 100.5018 });
    assert.equal(bodies.length, 1);
    const body = bodies[0] as any;
    assert.equal(body.lat, 13.7563);
    assert.equal(body.lng, 100.5018);
  });

  it('omits both lat and lng when only lat is provided', async () => {
    const { bodies } = installCaptureFetch();
    await joinWaitlistV2({ city: 'Bangkok', lat: 13.7563 });
    assert.equal(bodies.length, 1);
    const body = bodies[0] as any;
    assert.equal('lat' in body, false, 'lat must be stripped when lng is absent');
    assert.equal('lng' in body, false, 'lng must be stripped when lng is absent');
  });

  it('omits both lat and lng when only lng is provided', async () => {
    const { bodies } = installCaptureFetch();
    await joinWaitlistV2({ city: 'Bangkok', lng: 100.5018 });
    const body = bodies[0] as any;
    assert.equal('lat' in body, false);
    assert.equal('lng' in body, false);
  });

  it('still forwards non-coord fields when both coords are present', async () => {
    const { bodies } = installCaptureFetch();
    await joinWaitlistV2({ city: 'Bangkok', lat: 13.7563, lng: 100.5018, category: 'food', groupSize: 2 });
    const body = bodies[0] as any;
    assert.equal(body.city, 'Bangkok');
    assert.equal(body.category, 'food');
    assert.equal(body.groupSize, 2);
    assert.equal(body.lat, 13.7563);
    assert.equal(body.lng, 100.5018);
  });
});
