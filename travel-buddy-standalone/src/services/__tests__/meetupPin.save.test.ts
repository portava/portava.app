/**
 * Meetup-spot save contract (buddy dashboard, standalone app).
 *
 * Guards the privacy contract of the "Meetup spot" screen
 * (app/(rent-a-buddy)/buddy-dashboard/meetup-pin.tsx):
 *   1. Picked coordinates are rounded to ~3 decimal places (≈110 m) so the
 *      stored pin is approximate, never an exact address.
 *   2. The save payload always carries BOTH coordinates or BOTH null —
 *      never a half-cleared pin.
 *   3. The wire call is a PATCH to /api/rent-a-buddy/me/profile whose JSON
 *      body uses the meetupBaseLat / meetupBaseLng keys.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/meetupPin.save.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { roundMeetupCoord, buildMeetupPinPatch } from '../../lib/meetupPin.ts';
import { updateMyBuddyProfile } from '../rentABuddy.ts';

// ── 1. Rounding ───────────────────────────────────────────────────────────────

describe('roundMeetupCoord', () => {
  it('rounds to exactly 3 decimal places', () => {
    assert.equal(roundMeetupCoord(35.6894875), 35.689);
    assert.equal(roundMeetupCoord(139.6917064), 139.692);
    assert.equal(roundMeetupCoord(-0.1275999), -0.128);
    assert.equal(roundMeetupCoord(-73.98554), -73.986);
  });

  it('leaves already-coarse values unchanged', () => {
    assert.equal(roundMeetupCoord(48.858), 48.858);
    assert.equal(roundMeetupCoord(0), 0);
  });

  it('never keeps more than 3 decimals (privacy: no exact addresses)', () => {
    for (const v of [51.50735092, -33.86882453, 90.00049, -179.9994999]) {
      const rounded = roundMeetupCoord(v);
      assert.equal(rounded, Math.round(v * 1000) / 1000);
      const decimals = (String(rounded).split('.')[1] ?? '').length;
      assert.ok(decimals <= 3, `${v} → ${rounded} has ${decimals} decimals`);
    }
  });
});

// ── 2. Both-or-null payload ───────────────────────────────────────────────────

describe('buildMeetupPinPatch', () => {
  it('keeps both coordinates when both are set', () => {
    assert.deepEqual(buildMeetupPinPatch(35.689, 139.692), {
      meetupBaseLat: 35.689,
      meetupBaseLng: 139.692,
    });
  });

  it('clears both when both are null (explicit clear)', () => {
    assert.deepEqual(buildMeetupPinPatch(null, null), {
      meetupBaseLat: null,
      meetupBaseLng: null,
    });
  });

  it('never produces a half-cleared pin', () => {
    for (const [lat, lng] of [
      [35.689, null],
      [null, 139.692],
      [undefined, 139.692],
      [35.689, undefined],
    ] as const) {
      assert.deepEqual(buildMeetupPinPatch(lat, lng), {
        meetupBaseLat: null,
        meetupBaseLng: null,
      });
    }
  });
});

// ── 3. Wire contract: PATCH /api/rent-a-buddy/me/profile ─────────────────────

interface CapturedRequest {
  url: string;
  method: string | undefined;
  body: Record<string, unknown>;
}

const captured: CapturedRequest[] = [];
let savedFetch: typeof globalThis.fetch;

before(() => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The service layer refreshes the Supabase token first; let any non-API
    // traffic (e.g. supabase auth) fail fast so freshToken falls back to null.
    if (!url.includes('/api/rent-a-buddy/')) {
      throw new Error('offline');
    }
    captured.push({
      url,
      method: init?.method,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = savedFetch;
});

describe('updateMyBuddyProfile wire contract', () => {
  it('PATCHes /api/rent-a-buddy/me/profile with meetupBaseLat/meetupBaseLng keys', async () => {
    captured.length = 0;
    const res = await updateMyBuddyProfile(buildMeetupPinPatch(roundMeetupCoord(35.6894875), roundMeetupCoord(139.6917064)));
    assert.equal(res.ok, true);
    assert.equal(captured.length, 1);
    const req = captured[0];
    assert.ok(req.url.endsWith('/api/rent-a-buddy/me/profile'), req.url);
    assert.equal(req.method, 'PATCH');
    assert.deepEqual(req.body, {
      meetupBaseLat: 35.689,
      meetupBaseLng: 139.692,
    });
    // Exactly these two keys — no stray exact-coordinate fields.
    assert.deepEqual(Object.keys(req.body).sort(), ['meetupBaseLat', 'meetupBaseLng']);
  });

  it('sends both nulls on clear', async () => {
    captured.length = 0;
    const res = await updateMyBuddyProfile(buildMeetupPinPatch(null, null));
    assert.equal(res.ok, true);
    assert.deepEqual(captured[0].body, { meetupBaseLat: null, meetupBaseLng: null });
  });
});
