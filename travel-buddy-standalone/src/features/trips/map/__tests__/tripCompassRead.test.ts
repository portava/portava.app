/**
 * census-discovery §108 (DV-83 round 11, D-W11X2-81, D-W11X2-82). The trip map's Compass alternatives,
 * open since §104.10, and the shared GET /compass/recommendations predicate.
 *
 * The trip map read `compassRes.ok ? data.recommendations : []`: a failed read and a refused
 * (`nothing`) body both became "Compass has no alternatives", and a `partial` body was drawn as the
 * complete set — the one /compass/recommendations consumer that did not branch on coverage. And the
 * shared predicate `compassRecommendationsFailed` took a refusal with a missing or unknown coverage
 * for a complete answer, where every other Discovery reader (TS3, RR4) takes it for a failed read.
 *
 *   TC1  a transport failure → no alternatives, read state `failed`
 *   TC2  a refused `nothing` body → no alternatives, `failed`
 *   TC3  a `partial` body → its rows, `partial`
 *   TC4  a refusal with a missing or unknown coverage → no alternatives, `failed` (never complete)
 *   TCc  CONTROL: a healthy body → its rows, no read state
 *   UC1  compassRecommendationsFailed: a missing or unknown coverage is a failed read; `partial` is not; no refusal is not
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tripCompassRecommendations, tripCompassReadState } from '../tripCompassRead.ts';
import { compassRecommendationsFailed } from '../../../../services/compassRecommendationsRefusal.ts';

const REC = { id: 'r1', type: 'place', title: 'Cafe', reason: 'r', city: 'Manila', data: {} } as never;
const refusal = (coverage: unknown) => ({ class: 'transient_db', code: 'compass_sources_unread', coverage, failedSources: ['events'] }) as never;

test('TC1 a transport failure → no alternatives, failed', () => {
  const res = { ok: false, error: 'network_error' };
  assert.deepEqual(tripCompassRecommendations(res), []);
  assert.equal(tripCompassReadState(res), 'failed');
});

test('TC2 a refused `nothing` body → no alternatives, failed', () => {
  const res = { ok: true, data: { recommendations: [], surface: 'trip', refusal: refusal('nothing') } };
  assert.deepEqual(tripCompassRecommendations(res), []);
  assert.equal(tripCompassReadState(res), 'failed');
});

test('TC3 a `partial` body → its rows, partial', () => {
  const res = { ok: true, data: { recommendations: [REC], surface: 'trip', refusal: refusal('partial') } };
  assert.deepEqual(tripCompassRecommendations(res), [REC]);
  assert.equal(tripCompassReadState(res), 'partial');
});

test('TC4 a refusal with a missing or unknown coverage → no alternatives, failed', () => {
  for (const cov of [undefined, 'some_future_value']) {
    const res = { ok: true, data: { recommendations: [REC], surface: 'trip', refusal: refusal(cov) } };
    assert.deepEqual(tripCompassRecommendations(res), [], String(cov));
    assert.equal(tripCompassReadState(res), 'failed', String(cov));
  }
});

test('TCc CONTROL: a healthy body → its rows, no read state', () => {
  const res = { ok: true, data: { recommendations: [REC], surface: 'trip' } };
  assert.deepEqual(tripCompassRecommendations(res), [REC]);
  assert.equal(tripCompassReadState(res), null);
});

test('UC1 compassRecommendationsFailed: a missing or unknown coverage is a failed read', () => {
  assert.equal(compassRecommendationsFailed({ refusal: refusal(undefined) }), true);
  assert.equal(compassRecommendationsFailed({ refusal: refusal('some_future_value') }), true);
  assert.equal(compassRecommendationsFailed({ refusal: refusal('nothing') }), true);
  assert.equal(compassRecommendationsFailed({ refusal: refusal('partial') }), false);
  assert.equal(compassRecommendationsFailed({}), false);
  assert.equal(compassRecommendationsFailed({ error: 'block_check_failed' }), true);
});
