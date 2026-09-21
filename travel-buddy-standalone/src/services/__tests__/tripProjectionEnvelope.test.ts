/**
 * §19.1 — the client's half of the consumer rule: reject a schema it does not
 * read, reject a stale projection, name the reason (Appendix B), and never
 * treat a body without the envelope as a projection.
 *
 * Run with:
 *   node --import tsx/esm --test src/services/__tests__/tripProjectionEnvelope.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acceptProjection, TRIP_PROJECTION_SCHEMA_VERSION } from '../tripProjectionEnvelope.ts';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const env = (o: Record<string, unknown> = {}) => ({
  projectionSchemaVersion: 1, generatedAt: new Date(NOW - 10_000).toISOString(), sourceTripVersion: 7, freshness: 'live', ...o,
});

describe('acceptProjection', () => {
  it('accepts the current schema and reports the lag', () => {
    const d = acceptProjection(env(), { now: NOW });
    assert.ok(d.accepted);
    assert.equal(d.lagSeconds, 10);
    assert.equal(d.envelope.sourceTripVersion, 7);
    assert.equal(TRIP_PROJECTION_SCHEMA_VERSION, 1);
  });
  it('SCHEMA_MISMATCH for another version, a missing envelope, a non-object, or a non-instant', () => {
    for (const body of [env({ projectionSchemaVersion: 2 }), { items: [] }, null, 'x', env({ generatedAt: 'soon' })]) {
      const d = acceptProjection(body, { now: NOW });
      assert.ok(!d.accepted && d.reason === 'TRIP_PROJECTION_SCHEMA_MISMATCH', JSON.stringify(body));
    }
  });
  it('STALE when the projection says so, or when older than the consumer allows', () => {
    const d1 = acceptProjection(env({ freshness: 'stale' }), { now: NOW });
    assert.ok(!d1.accepted && d1.reason === 'TRIP_PROJECTION_STALE');
    const d2 = acceptProjection(env(), { now: NOW, maxAgeSeconds: 5 });
    assert.ok(!d2.accepted && d2.reason === 'TRIP_PROJECTION_STALE');
    assert.ok(acceptProjection(env(), { now: NOW, maxAgeSeconds: 10 }).accepted);
  });
  it('unattributable is accepted and stays unattributable; an unknown freshness word is read as unattributable', () => {
    const d = acceptProjection(env({ sourceTripVersion: null, freshness: 'unattributable' }), { now: NOW });
    assert.ok(d.accepted && d.envelope.freshness === 'unattributable' && d.envelope.sourceTripVersion === null);
    const u = acceptProjection(env({ freshness: 'fresh-ish' }), { now: NOW });
    assert.ok(u.accepted && u.envelope.freshness === 'unattributable');
  });
});
