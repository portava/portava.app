/**
 * guideApplication — the Become a Local Guide screen's pure logic: the city
 * list it sends, what the server's answer means, and the words for a failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_GUIDE_CITIES,
  guideApplicationOutcome,
  guideApplyErrorCopy,
  parseCityList,
} from '../guideApplication.ts';

test('parseCityList trims, splits on commas and newlines, and drops case-insensitive duplicates', () => {
  assert.deepEqual(parseCityList(' Cebu, Manila,\n  cebu ,, Siargao  Island '), ['Cebu', 'Manila', 'Siargao Island']);
  assert.deepEqual(parseCityList(''), []);
  assert.deepEqual(parseCityList(' , ,\n'), []);
});

test('parseCityList keeps at most the number the server keeps', () => {
  const many = Array.from({ length: 14 }, (_, i) => `City ${i}`).join(',');
  const cities = parseCityList(many);
  assert.equal(cities.length, MAX_GUIDE_CITIES);
  assert.equal(cities[0], 'City 0');
});

test('guideApplicationOutcome reads the profile status the apply route answers with', () => {
  assert.equal(guideApplicationOutcome('active'), 'active');
  assert.equal(guideApplicationOutcome('applicant'), 'pending');
  assert.equal(guideApplicationOutcome(undefined), 'pending');
  assert.equal(guideApplicationOutcome('suspended'), 'paused');
  assert.equal(guideApplicationOutcome('demoted'), 'paused');
});

test('a switched-off feature is not answered with "try again"', () => {
  assert.doesNotMatch(guideApplyErrorCopy('feature_disabled'), /try again/i);
  assert.match(guideApplyErrorCopy('db_error'), /try again/i);
  assert.match(guideApplyErrorCopy(undefined), /try again/i);
});
