/**
 * features/media — freshness/confidence copy tests (§10/§13/§17/§39/§46).
 *
 * The load-bearing property: cached/aged content is never labeled "live", and a
 * null age never renders a misleading "0m ago".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  relativeAgeLabel,
  freshnessFromAge,
  freshnessClassLabel,
  currentPictureLabel,
  observationClassLabel,
  isObservedEvidence,
  cachedAsOfLabel,
} from '../state/freshness.ts';

test('relativeAgeLabel formats minutes/hours/days and guards null', () => {
  assert.equal(relativeAgeLabel(null), null);
  assert.equal(relativeAgeLabel(undefined), null);
  assert.equal(relativeAgeLabel(-3), null); // never "0m ago" from a bad value
  assert.equal(relativeAgeLabel(0), 'Just now');
  assert.equal(relativeAgeLabel(2), '2m ago');
  assert.equal(relativeAgeLabel(59), '59m ago');
  assert.equal(relativeAgeLabel(60), '1h ago');
  assert.equal(relativeAgeLabel(60 * 26), '1d ago');
});

test('freshnessFromAge never calls stale content live', () => {
  assert.equal(freshnessFromAge(2), 'live');
  assert.equal(freshnessFromAge(30), 'fresh');
  assert.equal(freshnessFromAge(120), 'recent');
  assert.equal(freshnessFromAge(60 * 48), 'historical');
  assert.equal(freshnessFromAge(null), 'historical'); // unknown age is never live
});

test('freshnessClassLabel copy', () => {
  assert.equal(freshnessClassLabel('live'), 'Just now');
  assert.equal(freshnessClassLabel('historical'), 'Earlier');
});

test('currentPictureLabel maps confidence to §13 copy', () => {
  assert.equal(currentPictureLabel('strong'), 'Strong current picture');
  assert.equal(currentPictureLabel('moderate'), 'Forming current picture');
  assert.equal(currentPictureLabel('low'), 'Limited current picture');
});

test('observation class labels distinguish observed vs derived vs predicted', () => {
  assert.equal(observationClassLabel('observed'), 'Observed');
  assert.equal(observationClassLabel('predicted'), 'Likely');
  assert.equal(observationClassLabel('generated'), 'Illustrative');
  assert.equal(isObservedEvidence('observed'), true);
  assert.equal(isObservedEvidence('predicted'), false);
  assert.equal(isObservedEvidence('generated'), false);
});

test('cachedAsOfLabel always carries a last-updated time or omits itself (§39)', () => {
  assert.equal(cachedAsOfLabel(5), 'Cached · updated 5m ago');
  assert.equal(cachedAsOfLabel(null), null); // no fake freshness
});
