/**
 * census-layover L132 / L124 / L166 / L277 — the client read of
 * `GET /api/airport/sessions/:id/crew/location`, parsed fail-closed.
 *
 * Run: node --import tsx/esm --test src/services/__tests__/layoverCrewLocation.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROXIMITY_TEXT, parseCrewLocation, shareExpiryFor } from '../layoverCrewLocationContract.ts';

const ENDS = '2026-10-17T11:00:00.000Z';

function body(over: Record<string, unknown> = {}) {
  return {
    ok: true, available: true, inCrew: true, crewId: 'crew-1', maxShareMinutes: 240, shareEndsBy: ENDS,
    preciseControl: { enabled: false },
    mine: null,
    crewmates: [
      { userId: 'u-a', label: 'Night market', precision: 'venue', purpose: 'presence_in_context', sharedAt: '2026-10-17T10:00:00.000Z', endsAt: ENDS,
        position: null, ring: { center: { lat: 25.03, lng: 121.56 }, radiusMeters: 150 }, proximity: 'close', handle: 'ann', name: 'Ann' },
    ],
    crewmatesWithheld: null,
    ...over,
  };
}

describe('parseCrewLocation', () => {
  it('reads the off switch as a surface that does not exist', () => {
    assert.deepEqual(parseCrewLocation(200, { ok: true, available: false }), { ok: true, available: false });
  });

  it('reads a route that is not there (404 with no contract) as no surface, not as an error', () => {
    assert.deepEqual(parseCrewLocation(404, { error: 'not_found' }), { ok: true, available: false });
  });

  it('reads not-in-a-crew', () => {
    assert.deepEqual(parseCrewLocation(200, { ok: true, available: true, inCrew: false, maxShareMinutes: 240 }), { ok: true, available: true, inCrew: false });
  });

  it('a 503 is unavailable, never an empty crew', () => {
    const r = parseCrewLocation(503, { error: 'degraded_unavailable', message: 'nope' });
    assert.equal(r.ok, false);
  });

  it('reads crewmates, their ring and their proximity bucket', () => {
    const r = parseCrewLocation(200, body());
    assert.equal(r.ok && r.available && r.inCrew, true);
    if (!(r.ok && r.available && r.inCrew)) return;
    assert.equal(r.crewmates.length, 1);
    assert.equal(r.crewmates[0]!.ring?.radiusMeters, 150);
    assert.equal(r.crewmates[0]!.proximity, 'close');
    assert.equal(r.preciseControl?.enabled, false);
    assert.ok(PROXIMITY_TEXT.close.length > 0);
  });

  it('never draws a point for an area share, whatever arrives', () => {
    const r = parseCrewLocation(200, body({ crewmates: [{ ...body().crewmates[0], precision: 'area', position: { lat: 1, lng: 2 }, ring: { center: { lat: 1, lng: 2 }, radiusMeters: 150 } }] }));
    if (!(r.ok && r.available && r.inCrew)) { assert.fail('expected a crew'); return; }
    assert.equal(r.crewmates[0]!.position, null);
    assert.equal(r.crewmates[0]!.ring, null);
  });

  it('drops a crewmate entry it cannot read rather than inventing one, and an unknown bucket is no bucket', () => {
    const r = parseCrewLocation(200, body({ crewmates: [{ userId: 'u-x' }, { ...body().crewmates[0], proximity: 'next door' }] }));
    if (!(r.ok && r.available && r.inCrew)) { assert.fail('expected a crew'); return; }
    assert.equal(r.crewmates.length, 1);
    assert.equal(r.crewmates[0]!.proximity, null);
  });

  it('a contract it cannot read is refused, not read as nobody sharing', () => {
    const r = parseCrewLocation(200, body({ crewmates: 'many' }));
    assert.equal(r.ok, false);
  });
});

describe('shareExpiryFor — the sheet asks for a window, never past the server ceiling', () => {
  it('is now + minutes, capped at the server ceiling', () => {
    const now = Date.parse('2026-10-17T10:00:00.000Z');
    assert.equal(shareExpiryFor(60, now, 240), '2026-10-17T11:00:00.000Z');
    assert.equal(shareExpiryFor(600, now, 240), '2026-10-17T14:00:00.000Z');
  });
});
